#!/usr/bin/env node

/**
 * GSD-Research CLI — Perplexity-first research chain for Claude Code agents.
 *
 * Research chain (stops at first provider with results):
 *   1. Memory (PG) — past learnings and observations
 *   2. SKB (PG)    — shared knowledge base, validated patterns
 *   3. Context7    — library/framework documentation (MCP)
 *   4. Perplexity  — AI-powered web search (API key required)
 *   5. WebFetch    — Direct URL fetch (fallback)
 *
 * Usage: node gsd-research.cjs <command> [args]
 *
 * Commands:
 *   search <query>         Run research chain (stops at first hit)
 *   perplexity <query>     Query Perplexity directly
 *   check-providers        Show which providers are available
 *
 * Options:
 *   --provider <name>      Skip chain, query specific provider
 *   --all                  Run ALL providers (don't stop at first hit)
 *   --limit <n>            Max results per provider (default: 5)
 *   --json                 Raw JSON output
 *   --url <url>            URL for webfetch provider
 *   --model <model>        Perplexity model (default: sonar)
 *
 * Environment:
 *   PERPLEXITY_API_KEY     Required for Perplexity provider
 *   GSD_AMAUTA_HOST        Daemon host (default: 127.0.0.1)
 *   GSD_AMAUTA_PORT        Daemon port (default: 18799)
 */

const http = require('http');
const https = require('https');
const path = require('path');

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const DAEMON_HOST = process.env.GSD_AMAUTA_HOST || '127.0.0.1';
const DAEMON_PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar';

const PROVIDER_ORDER = ['memory', 'skb', 'context7', 'perplexity', 'webfetch'];

// ═══════════════════════════════════════════════════════
// HTTP Helpers
// ═══════════════════════════════════════════════════════

function daemonRequest(method, urlPath, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const options = {
      hostname: DAEMON_HOST,
      port: DAEMON_PORT,
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsRequest(hostname, urlPath, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname,
      port: 443,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// Providers
// ═══════════════════════════════════════════════════════

async function providerMemory(query, limit) {
  try {
    const res = await daemonRequest('POST', '/api/memory/search', { query, limit });
    if (res.status !== 200 || !res.data.results) return null;
    const results = res.data.results;
    if (results.length === 0) return null;
    return {
      provider: 'memory',
      count: results.length,
      results: results.map(r => ({
        text: r.text,
        source: r.source,
        score: r.score,
        id: r.id,
        agent: r.agent_id,
        created: r.created_at,
      })),
    };
  } catch {
    return null;
  }
}

async function providerSKB(query, limit) {
  try {
    const res = await daemonRequest('POST', '/api/skb/search', { query, limit });
    if (res.status !== 200 || !res.data.results) return null;
    const results = res.data.results;
    if (results.length === 0) return null;
    return {
      provider: 'skb',
      count: results.length,
      results: results.map(r => ({
        title: r.title,
        content: r.content,
        category: r.category,
        importance: r.importance,
        id: r.id,
      })),
    };
  } catch {
    return null;
  }
}

async function providerContext7(query, _limit) {
  // Context7 is an MCP tool available to Claude Code agents.
  // From a CLI, we can't call MCP tools directly.
  // Return instructions for the agent to use Context7 themselves.
  return {
    provider: 'context7',
    count: 0,
    results: [],
    note: 'Context7 is available as MCP tool in Claude Code. Use mcp__context7__resolve-library-id and mcp__context7__get-library-docs directly.',
  };
}

async function providerPerplexity(query, limit) {
  if (!PERPLEXITY_API_KEY) return null;

  try {
    const res = await httpsRequest(
      'api.perplexity.ai',
      '/chat/completions',
      {
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a technical research assistant. Provide concise, factual answers with sources. Focus on current best practices and official documentation.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 2000,
      },
      {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      },
    );

    if (res.status !== 200) {
      return { provider: 'perplexity', count: 0, results: [], error: `API error: ${res.status}` };
    }

    const answer = res.data.choices?.[0]?.message?.content || '';
    const citations = res.data.citations || [];

    if (!answer) return null;

    // TK-0047: Auto-store Perplexity results to PG memory
    // TK-0048: Dedup check before storing — skip if >70% similar to existing entry
    try {
      const cappedAnswer = answer.slice(0, 2000);
      const isDup = await isDuplicateMemory(cappedAnswer);
      if (!isDup) {
        await daemonRequest('POST', '/api/memory/store', {
          text: cappedAnswer,
          source: 'web_search_result',
          tags: ['perplexity', PERPLEXITY_MODEL],
          metadata: {
            query,
            citations,
            model: res.data.model || PERPLEXITY_MODEL,
            citation_count: citations.length,
          },
        });
      }
    } catch {
      // Silent fail — storing to memory is best-effort
    }

    return {
      provider: 'perplexity',
      count: 1,
      results: [{
        text: answer,
        citations,
        model: res.data.model || PERPLEXITY_MODEL,
      }],
    };
  } catch (err) {
    return { provider: 'perplexity', count: 0, results: [], error: err.message };
  }
}

async function providerWebFetch(query, _limit, url) {
  // WebFetch requires a URL — if none provided, skip
  if (!url) {
    return {
      provider: 'webfetch',
      count: 0,
      results: [],
      note: 'WebFetch requires --url flag. Use: gsd-research.cjs search <query> --provider webfetch --url <url>',
    };
  }

  try {
    // Simple HTTPS GET
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const proto = parsedUrl.protocol === 'https:' ? https : http;

      const MAX_REDIRECTS = 5;
      const fetchUrl = (targetUrl, redirectCount) => {
        const parsed = new URL(targetUrl);
        const p = parsed.protocol === 'https:' ? https : http;
        p.get(targetUrl, { timeout: 15000 }, (res) => {
          // Follow redirects (301, 302, 307, 308) up to MAX_REDIRECTS
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < MAX_REDIRECTS) {
            const location = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, targetUrl).href;
            res.resume(); // drain the redirect body
            fetchUrl(location, redirectCount + 1);
            return;
          }
          let data = '';
          let truncated = false;
          const resolveWithData = () => {
            if (data.length === 0) { resolve(null); return; }
            resolve({
              provider: 'webfetch',
              count: 1,
              results: [{
                url: targetUrl,
                content: data.slice(0, 10000),
                status: res.statusCode,
                contentType: res.headers['content-type'] || 'unknown',
                ...(truncated ? { truncated: true } : {}),
              }],
            });
          };
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > 100000) {
              truncated = true;
              res.destroy(); // 100K safety cap — 'close' will fire, not 'end'
            }
          });
          res.on('end', resolveWithData);
          // res.destroy() emits 'close' but NOT 'end' — must handle both
          res.on('close', () => { if (truncated) resolveWithData(); });
          res.on('error', () => { if (truncated) resolveWithData(); });
        }).on('error', (err) => {
          resolve({ provider: 'webfetch', count: 0, results: [], error: err.message });
        }).on('timeout', function() { this.destroy(); });
      };
      fetchUrl(url, 0);
    });
  } catch (err) {
    return { provider: 'webfetch', count: 0, results: [], error: err.message };
  }
}

// ═══════════════════════════════════════════════════════
// Research Result Dedup (TK-0048)
// ═══════════════════════════════════════════════════════

/**
 * Simple word-overlap similarity (Jaccard-like). Returns 0-1.
 * Matches textSimilarity() in gsd-memory.cjs for consistency.
 */
function textSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

const DEDUP_THRESHOLD = parseFloat(process.env.GSD_RESEARCH_DEDUP_THRESHOLD || '0.7');

/**
 * Check if text is similar to any existing memory entries.
 * Returns true if a duplicate is found (should skip storing).
 */
async function isDuplicateMemory(text) {
  try {
    // Extract key terms from the text for a targeted search
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    const queryTerms = words.slice(0, 5).join(' ');
    if (!queryTerms) return false;

    const res = await daemonRequest('POST', '/api/memory/search', {
      query: queryTerms,
      source: 'web_search_result',
      limit: 5,
    });

    if (res.status !== 200 || !res.data.results) return false;

    for (const existing of res.data.results) {
      const sim = textSimilarity(text, existing.text || '');
      if (sim >= DEDUP_THRESHOLD) {
        return true; // Duplicate found
      }
    }
    return false;
  } catch {
    return false; // On error, allow store (don't block)
  }
}

const PROVIDERS = {
  memory: providerMemory,
  skb: providerSKB,
  context7: providerContext7,
  perplexity: providerPerplexity,
  webfetch: providerWebFetch,
};

// ═══════════════════════════════════════════════════════
// Argument Parsing
// ═══════════════════════════════════════════════════════

function parseArgs(argv) {
  const args = { _positional: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json' || arg === '--all') {
      args[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._positional.push(arg);
    }
    i++;
  }
  return args;
}

// ═══════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════

const PROVIDER_COLORS = {
  memory: '\x1b[93m',
  skb: '\x1b[92m',
  context7: '\x1b[96m',
  perplexity: '\x1b[95m',
  webfetch: '\x1b[94m',
};

function formatResult(result) {
  const color = PROVIDER_COLORS[result.provider] || '\x1b[37m';
  let out = `\n${color}[${result.provider.toUpperCase()}]\x1b[0m`;

  if (result.note) {
    out += ` \x1b[2m${result.note}\x1b[0m\n`;
    return out;
  }

  if (result.error) {
    out += ` \x1b[91merror: ${result.error}\x1b[0m\n`;
    return out;
  }

  out += ` (${result.count} results)\n`;

  if (result.provider === 'memory') {
    result.results.forEach((r, i) => {
      const score = r.score ? ` score:${r.score.toFixed(1)}` : '';
      const src = r.source ? ` [${r.source}]` : '';
      out += `  ${i + 1}. ${r.text.slice(0, 200)}${r.text.length > 200 ? '...' : ''}\n`;
      out += `     \x1b[2m${r.id}${src}${score}\x1b[0m\n`;
    });
  } else if (result.provider === 'skb') {
    result.results.forEach((r, i) => {
      out += `  ${i + 1}. \x1b[1m${r.title}\x1b[0m`;
      if (r.category) out += ` [${r.category}]`;
      out += `\n     ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}\n`;
    });
  } else if (result.provider === 'perplexity') {
    result.results.forEach((r) => {
      out += `  ${r.text}\n`;
      if (r.citations && r.citations.length > 0) {
        out += `\n  \x1b[2mSources:\x1b[0m\n`;
        r.citations.forEach((c, i) => {
          out += `    ${i + 1}. ${c}\n`;
        });
      }
    });
  } else if (result.provider === 'webfetch') {
    result.results.forEach((r) => {
      out += `  URL: ${r.url}\n`;
      out += `  Status: ${r.status}\n`;
      out += `  Content (first 500 chars):\n`;
      out += `  ${r.content.slice(0, 500)}...\n`;
    });
  }

  return out;
}

// ═══════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════

async function cmdSearch(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: gsd-research.cjs search <query> [--provider <name>] [--all] [--limit <n>] [--json]');
    process.exit(1);
  }

  const limit = parseInt(args.limit || '5', 10);
  const allResults = [];

  // If specific provider requested, use only that one
  if (args.provider) {
    const providerFn = PROVIDERS[args.provider];
    if (!providerFn) {
      console.error(`Unknown provider: ${args.provider}. Available: ${PROVIDER_ORDER.join(', ')}`);
      process.exit(1);
    }
    const result = await providerFn(query, limit, args.url);
    if (result) allResults.push(result);
  } else {
    // Run the chain
    for (const name of PROVIDER_ORDER) {
      const providerFn = PROVIDERS[name];
      const result = await providerFn(query, limit, args.url);

      if (result) {
        allResults.push(result);
        // Stop at first provider with actual results (not just notes)
        if (!args.all && result.count > 0 && !result.error) {
          break;
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ query, results: allResults }, null, 2));
    return;
  }

  if (allResults.length === 0) {
    console.log(`\x1b[2mNo results found for: "${query}"\x1b[0m`);
    console.log('Providers checked: ' + PROVIDER_ORDER.join(' -> '));
    return;
  }

  console.log(`\n\x1b[1mResearch: "${query}"\x1b[0m`);
  allResults.forEach((r) => process.stdout.write(formatResult(r)));
  console.log('');
}

async function cmdFetch(args) {
  const url = args.url || args._positional[0];
  if (!url) {
    console.error('Usage: gsd-research.cjs fetch --url <url> [--json]');
    process.exit(1);
  }
  args._positional = [url];
  args.provider = 'webfetch';
  args.url = url;
  return cmdSearch(args);
}

async function cmdPerplexity(args) {
  const query = args._positional.join(' ');
  if (!query) {
    console.error('Usage: gsd-research.cjs perplexity <query> [--model <model>] [--json]');
    process.exit(1);
  }

  if (!PERPLEXITY_API_KEY) {
    console.error('PERPLEXITY_API_KEY not set. Export it to use Perplexity.');
    process.exit(1);
  }

  args.provider = 'perplexity';
  return cmdSearch(args);
}

async function cmdCheckProviders(args) {
  const providers = [];

  // Check daemon/PG
  try {
    const health = await daemonRequest('GET', '/health');
    providers.push({
      name: 'memory',
      available: health.data.pg_available === true,
      detail: health.data.pg_available ? 'PG connected' : 'PG not available',
    });
    providers.push({
      name: 'skb',
      available: health.data.pg_available === true,
      detail: health.data.pg_available ? 'PG connected' : 'PG not available',
    });
  } catch {
    providers.push({ name: 'memory', available: false, detail: 'Daemon not running' });
    providers.push({ name: 'skb', available: false, detail: 'Daemon not running' });
  }

  // Context7 — always "available" as MCP tool
  providers.push({
    name: 'context7',
    available: true,
    detail: 'MCP tool (use in agent, not CLI)',
  });

  // Perplexity
  providers.push({
    name: 'perplexity',
    available: !!PERPLEXITY_API_KEY,
    detail: PERPLEXITY_API_KEY ? `API key set (model: ${PERPLEXITY_MODEL})` : 'PERPLEXITY_API_KEY not set',
  });

  // WebFetch — always available
  providers.push({
    name: 'webfetch',
    available: true,
    detail: 'Requires --url flag',
  });

  if (args.json) {
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  console.log('\n\x1b[1mResearch Providers\x1b[0m\n');
  console.log('Chain order: memory -> skb -> context7 -> perplexity -> webfetch\n');
  providers.forEach((p) => {
    const color = PROVIDER_COLORS[p.name] || '\x1b[37m';
    const status = p.available ? '\x1b[92mOK\x1b[0m' : '\x1b[91mN/A\x1b[0m';
    console.log(`  ${color}${p.name.padEnd(12)}\x1b[0m ${status}  ${p.detail}`);
  });
  console.log('');
}

// ═══════════════════════════════════════════════════════
// Usage
// ═══════════════════════════════════════════════════════

function printUsage() {
  console.log(`
\x1b[1mGSD-Research CLI\x1b[0m — Perplexity-first research chain

\x1b[1mCommands:\x1b[0m
  search <query>         Run research chain (stops at first hit)
  perplexity <query>     Query Perplexity directly
  check-providers        Show which providers are available

\x1b[1mChain:\x1b[0m memory -> SKB -> Context7 -> Perplexity -> WebFetch

\x1b[1mOptions:\x1b[0m
  --provider <name>      Skip chain, query specific provider
  --all                  Run ALL providers (don't stop at first hit)
  --limit <n>            Results per provider (default: 5)
  --url <url>            URL for webfetch provider
  --model <model>        Perplexity model (default: sonar)
  --json                 Raw JSON output

\x1b[1mEnvironment:\x1b[0m
  PERPLEXITY_API_KEY     Required for Perplexity provider
`);
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  const commands = {
    'search': cmdSearch,
    'fetch': cmdFetch,
    'perplexity': cmdPerplexity,
    'check-providers': cmdCheckProviders,
    'help': () => { printUsage(); },
  };

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err) {
    console.error(`\x1b[91mError:\x1b[0m ${err.message}`);
    process.exit(1);
  }
}

main();
