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
 *   --no-cache             Skip Perplexity cache reads (still writes)
 *
 * Environment:
 *   PERPLEXITY_API_KEY     Required for Perplexity provider
 *   GSD_AMAUTA_HOST        Daemon host (default: 127.0.0.1)
 *   GSD_AMAUTA_PORT        Daemon port (default: 18799)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ── Load .env file (project root or /srv/amauta, skipped in test mode) ──
(function loadDotenv() {
  if (process.env.GSD_AMAUTA_NO_AUTO_START) return;
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    '/srv/amauta/.env',
  ];
  for (const f of candidates) {
    try {
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
      }
      break;
    } catch { /* file not found, try next */ }
  }
})();

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const DAEMON_HOST = process.env.GSD_AMAUTA_HOST || '127.0.0.1';
const DAEMON_PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar-pro';  // sonar-pro for superior code understanding

const PROVIDER_ORDER = ['memory', 'skb', 'context7', 'perplexity', 'webfetch'];
const PERPLEXITY_OUTPUT_CAP = 1500; // chars -- cap Perplexity output to prevent 4K token injection
const RESEARCH_MIN_RESULTS = parseInt(process.env.GSD_RESEARCH_MIN_RESULTS || '2', 10); // cascade stops only when provider returns >= this many results

// TOK-01: Perplexity response cache (temp-file, cross-invocation persistence)
const PERPLEXITY_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours in ms
const PERPLEXITY_CACHE_DIR = path.join(os.homedir(), '.amauta');
const PERPLEXITY_CACHE_FILE = path.join(PERPLEXITY_CACHE_DIR, 'perplexity-cache.json');

// ── Creative Research (Phase 13 CREATIVE-01..05) ──
const CREATIVE_PROVIDER_ORDER = ['memory', 'skb', 'perplexity'];
const CREATIVE_PERPLEXITY_OUTPUT_CAP = 750;
const CREATIVE_PERPLEXITY_DELAY_MS = 500;
const CREATIVE_PERPLEXITY_MAX_TOKENS = 500;
const CREATIVE_RESULT_CAP_PER_VARIANT = 3;
const CREATIVE_JACCARD_THRESHOLD = 0.7;
const CREATIVE_QUERY_WORD_CAP = 8;
const CREATIVE_TYPES = new Set(['research', 'exploration', 'architecture-review', 'pattern-search']);

/**
 * Load Perplexity cache from disk, pruning expired entries.
 * Returns Map of { cacheKey: { result, storedAt } }.
 */
function _loadPerplexityCache() {
  try {
    if (!fs.existsSync(PERPLEXITY_CACHE_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(PERPLEXITY_CACHE_FILE, 'utf-8'));
    const now = Date.now();
    const entries = new Map();
    for (const [key, val] of Object.entries(raw)) {
      if (val.storedAt && (now - val.storedAt) < PERPLEXITY_CACHE_TTL) {
        entries.set(key, val);
      }
    }
    return entries;
  } catch {
    return new Map();
  }
}

/**
 * Save Perplexity cache to disk with atomic write (tmp + rename).
 */
function _savePerplexityCache(cache) {
  try {
    if (!fs.existsSync(PERPLEXITY_CACHE_DIR)) {
      fs.mkdirSync(PERPLEXITY_CACHE_DIR, { recursive: true });
    }
    const obj = {};
    for (const [key, val] of cache.entries()) {
      obj[key] = val;
    }
    const tmpFile = PERPLEXITY_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2));
    fs.renameSync(tmpFile, PERPLEXITY_CACHE_FILE);
  } catch {
    // Silent fail -- cache write is best-effort
  }
}

// TOK-06: Redis L2 cache via daemon proxy (/api/research-cache)
/**
 * Check daemon Redis cache for a Perplexity response.
 * Returns cached result object on hit, null on miss or error.
 */
function _checkDaemonCache(cacheKey) {
  return new Promise((resolve) => {
    try {
      const urlPath = `/api/research-cache?key=${encodeURIComponent(cacheKey)}`;
      const req = http.get({
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path: urlPath,
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.hit && parsed.data) {
              resolve(parsed.data);
            } else {
              resolve(null);
            }
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

/**
 * Write a Perplexity response to daemon Redis cache (/api/research-cache POST).
 * Resolves true on success, false on error or daemon unavailable.
 */
function _writeDaemonCache(cacheKey, data) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({ key: cacheKey, data });
      const req = http.request({
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path: '/api/research-cache',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 2000,
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    } catch { resolve(false); }
  });
}

/**
 * Generate cache key from query and model.
 */
function _perplexityCacheKey(query, model) {
  return crypto.createHash('sha256').update(query + ':' + model).digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════
// Model Auto-Selection
// ═══════════════════════════════════════════════════════

/**
 * selectPerplexityModel — select Perplexity model based on query complexity.
 * Only called when PERPLEXITY_MODEL === 'auto'.
 * @param {string} query
 * @returns {'sonar' | 'sonar-pro'}
 */
function selectPerplexityModel(query) {
  const complexPatterns = [
    /best.?practice/i,
    /compar/i,
    /architect/i,
    /how (to|do|does|should)/i,
    /pattern/i,
    /trade.?off/i,
    /design/i,
    /implement/i,
    /optimi[sz]/i,
    /debug/i,
  ];

  const isComplex = complexPatterns.some(p => p.test(query));

  if (isComplex || query.length >= 80) {
    return 'sonar-pro';
  }
  return 'sonar';
}

// ═══════════════════════════════════════════════════════
// Perplexity Rate Limit Retry (RSC-04)
// ═══════════════════════════════════════════════════════

const PERPLEXITY_MAX_RETRIES = 3;
const PERPLEXITY_BASE_DELAY_MS = 1000;

/**
 * Wrap Perplexity httpsRequest with exponential backoff on HTTP 429.
 * Retries: 1s, 2s, 4s (3 retries max), then returns the final 429 response.
 */
async function perplexityWithRetry(requestBody, headers) {
  let lastRes = null;
  for (let attempt = 0; attempt <= PERPLEXITY_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = PERPLEXITY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      process.stderr.write(`  [RATE LIMIT] Perplexity 429 — retry ${attempt}/${PERPLEXITY_MAX_RETRIES} in ${delay}ms\n`);
      await new Promise(r => setTimeout(r, delay));
    }
    lastRes = await httpsRequest(
      'api.perplexity.ai',
      '/chat/completions',
      requestBody,
      headers,
    );
    if (lastRes.status !== 429) return lastRes;
  }
  return lastRes; // Return the final 429 response after all retries exhausted
}

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

    req.on('error', (err) => {
      // INF-05: Data flow alert -- clear error on daemon failure
      if (err.code === 'ECONNREFUSED') {
        process.stderr.write(`\n  [DATA FLOW ERROR] Amauta daemon is not running on ${DAEMON_HOST}:${DAEMON_PORT}\n`);
        process.stderr.write(`  Fix: Run: python3 services/amauta-daemon.py\n`);
        process.stderr.write(`  This affects: memory search, Redis cache, task management\n\n`);
      }
      reject(err);
    });
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
    const res = await daemonRequest('POST', '/api/memory/search', { query, limit }, 3000);
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
    const res = await daemonRequest('POST', '/api/skb/search', { query, limit }, 3000);
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
  // Context7 resolves library documentation via npm registry.
  // Extracts recognized library names from query and fetches package info + readme.
  try {
    const libraryPatterns = query.match(/\b(?:react|next|express|fastify|prisma|drizzle|zod|trpc|tailwind|vite|webpack|jest|vitest|playwright|cypress|postgres|redis|mongodb|docker|kubernetes|aws|gcp|azure|langchain|openai|anthropic|supabase|firebase|stripe|auth0|passport|socket\.io|graphql|apollo|nestjs|nuxt|svelte|vue|angular|django|flask|fastapi|spring|laravel|rails)\b/gi);
    if (!libraryPatterns || libraryPatterns.length === 0) {
      return {
        provider: 'context7',
        count: 0,
        results: [],
        note: 'No recognized library names in query. Context7 works best when query mentions specific libraries/frameworks.',
      };
    }
    const libs = [...new Set(libraryPatterns.map(l => l.toLowerCase()))].slice(0, 2);
    const results = [];
    for (const lib of libs) {
      const npmData = await new Promise((resolve) => {
        const req = https.get(`https://registry.npmjs.org/${encodeURIComponent(lib)}`, { timeout: 3000 }, (res) => {
          let data = '';
          let destroyed = false;
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > 20000) { destroyed = true; res.destroy(); }
          });
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
          res.on('close', () => { if (destroyed) { try { resolve(JSON.parse(data)); } catch { resolve(null); } } });
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (npmData && npmData.name) {
        const latest = npmData['dist-tags']?.latest || 'unknown';
        const desc = npmData.description || '';
        const homepage = npmData.homepage || npmData.repository?.url || '';
        const readme = (npmData.readme || '').slice(0, 3000);
        results.push({
          library: npmData.name, version: latest, description: desc,
          homepage: homepage.replace(/^git\+/, '').replace(/\.git$/, ''),
          readme_excerpt: readme.slice(0, 1500),
        });
      }
    }
    return {
      provider: 'context7',
      count: results.length,
      results,
      note: results.length > 0 ? `Found docs for ${results.map(r => r.library).join(', ')}` : 'No library docs found.',
    };
  } catch (err) {
    return { provider: 'context7', count: 0, results: [], error: err.message,
      note: 'Context7 also available as MCP tool: use mcp__context7__resolve-library-id directly.' };
  }
}

async function providerPerplexity(query, limit) {
  if (!PERPLEXITY_API_KEY) return null;

  const selectedModel = PERPLEXITY_MODEL === 'auto' ? selectPerplexityModel(query) : PERPLEXITY_MODEL;

  // TOK-01: Check cache (skip if --no-cache flag is set)
  const noCache = providerPerplexity._noCache || false;
  const cacheKey = _perplexityCacheKey(query, selectedModel);
  if (!noCache) {
    // TOK-06: Check daemon Redis cache first (cross-invocation, survives process restart)
    const daemonHit = await _checkDaemonCache(cacheKey);
    if (daemonHit) {
      process.stderr.write(`  [cache:redis] hit for ${query.slice(0, 40)}...\n`);
      return daemonHit;
    }
    const cache = _loadPerplexityCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.result) {
      return { ...cached.result, cached: true };
    }
  }

  try {
    const res = await perplexityWithRetry(
      {
        model: selectedModel,
        messages: [
          {
            role: 'system',
            content: 'You are a technical research assistant for a software engineering team. Provide concise, factual, actionable answers with sources. Focus on current best practices (2025+), official documentation, and production-grade patterns. Include code examples when relevant.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        temperature: 0.2,     // Low temperature for deterministic code outputs
        max_tokens: 1000,     // Capped: PERPLEXITY_OUTPUT_CAP is 1500 chars (~375 tokens); 1000 gives buffer
      },
      {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      },
    );

    if (res.status !== 200) {
      // INF-05: Data flow alert -- specific Perplexity API error
      if (res.status === 401) {
        process.stderr.write(`\n  [DATA FLOW ERROR] Perplexity API: authentication failed (check PERPLEXITY_API_KEY)\n\n`);
      } else if (res.status === 429) {
        process.stderr.write(`\n  [DATA FLOW ERROR] Perplexity API: rate limited (too many requests)\n\n`);
      }
      return { provider: 'perplexity', count: 0, results: [], error: `API error: ${res.status}` };
    }

    const answer = res.data.choices?.[0]?.message?.content || '';
    const citations = res.data.citations || [];

    // TOK-05: Strip citation markers -- actual URLs are in res.data.citations metadata
    const cleanAnswer = answer.replace(/\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();

    if (!cleanAnswer) return null;

    // TK-0047: Auto-store Perplexity results to PG memory
    // TK-0048: Dedup check before storing — skip if >70% similar to existing entry
    try {
      const cappedAnswer = cleanAnswer.slice(0, 2000);
      const isDup = await isDuplicateMemory(cappedAnswer);
      if (!isDup) {
        await daemonRequest('POST', '/api/memory/store', {
          text: cappedAnswer,
          source: 'web_search_result',
          tags: ['perplexity', selectedModel],
          metadata: {
            query,
            citations,
            model: res.data.model || selectedModel,
            citation_count: citations.length,
          },
        });
      }
    } catch {
      // Silent fail — storing to memory is best-effort
    }

    const returnValue = {
      provider: 'perplexity',
      count: 1,
      results: [{
        text: stripPreamble(cleanAnswer).slice(0, PERPLEXITY_OUTPUT_CAP),
        citations,
        model: res.data.model || selectedModel,
      }],
    };

    // TOK-01: Write to file cache (always, even with --no-cache)
    try {
      const cache = _loadPerplexityCache();
      cache.set(cacheKey, { result: returnValue, storedAt: Date.now() });
      _savePerplexityCache(cache);
    } catch {
      // Silent fail -- cache write is best-effort
    }

    // TOK-06: Also write to daemon Redis cache (cross-invocation persistence)
    await _writeDaemonCache(cacheKey, returnValue);

    return returnValue;
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

// RSC-05: Preserve 2-char technical abbreviations in Jaccard dedup
const TECH_SHORT_WORDS = new Set(['ai', 'db', 'js', 'go', 'ui', 'ux', 'ci', 'cd', 'ml', 'pg', 'k8', 'io']);

/**
 * Simple word-overlap similarity (Jaccard-like). Returns 0-1.
 * Matches textSimilarity() in gsd-memory.cjs for consistency.
 */
function textSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 || TECH_SHORT_WORDS.has(w)));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 || TECH_SHORT_WORDS.has(w)));
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
      if (sim >= 0.3) {
        process.stderr.write(`  [DEDUP] similarity=${sim.toFixed(2)} threshold=${DEDUP_THRESHOLD} dup=${sim >= DEDUP_THRESHOLD}\n`);
      }
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
    if (arg === '--json' || arg === '--all' || arg === '--no-cache' || arg === '--creative' || arg === '--re-research') {
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
// Text Processing
// ═══════════════════════════════════════════════════════

/**
 * Strip common Perplexity preamble patterns from the start of answers.
 * These boilerplate sentences waste tokens without adding value.
 */
function stripPreamble(text) {
  if (!text) return text;
  const patterns = [
    /^(?:here\s+(?:is|are)\s+(?:a\s+)?(?:comprehensive|detailed|brief|quick)?\s*(?:overview|summary|breakdown|look|analysis|guide|explanation)[^.:]{0,120}[.:]\s*)/i,
    /^(?:based\s+on\s+(?:my\s+)?(?:research|analysis|findings|the\s+(?:available\s+)?(?:information|data|sources))[^.:,]{0,100}[.:,]\s*)/i,
    /^(?:i\s+found\s+(?:that\s+)?(?:the\s+following|several|some|a\s+few)[^.:]{0,120}[.:]\s*)/i,
    /^(?:sure[,!.]?\s*(?:here\s+(?:is|are))?[^.:]{0,100}[.:]\s*)/i,
    /^(?:let\s+me\s+(?:provide|explain|break\s+down|summarize)[^.:]{0,120}[.:]\s*)/i,
    /^(?:certainly[,!.]?\s*)/i,
    /^(?:absolutely[,!.]?\s*)/i,
    // v2.3 gap closure: additional Perplexity preamble patterns
    /^(?:the\s+following\s+(?:is|provides|summarizes|outlines)\s+[^.:]{0,120}[.:]\s*)/i,
    /^(?:to\s+(?:answer|address|respond\s+to)\s+(?:your|this|the)\s+(?:question|query|request)[^.:,]{0,100}[.:,]\s*)/i,
    /^(?:(?:great|good)\s+question[.!,]\s*)/i,
    // v2.5 Phase 7: additional Perplexity preamble patterns
    /^(?:of\s+course[,!.]?\s*)/i,
    /^(?:i'?d\s+be\s+happy\s+to\s+(?:help|explain|provide|assist)[^.:,]{0,100}[.:,]\s*)/i,
    /^(?:as\s+an?\s+(?:AI|artificial\s+intelligence)\s+(?:assistant|model|language\s+model)[^.:,]{0,100}[.:,]\s*)/i,
  ];
  let result = text;
  // Loop until stable — handles compound preambles like
  // "Certainly! Here is a comprehensive overview:" where a later pattern
  // (certainly) strips a prefix, exposing a match for an earlier pattern (here is).
  let prev;
  do {
    prev = result;
    for (const pattern of patterns) {
      result = result.replace(pattern, '');
    }
    result = result.trim();
  } while (result !== prev);
  return result;
}

// ═══════════════════════════════════════════════════════
// Creative Research Functions (Phase 13 CREATIVE-01..05)
// ═══════════════════════════════════════════════════════

/**
 * Jaccard word-overlap similarity between two texts.
 * Returns 0.0-1.0 where 1.0 = identical word sets.
 * Port of amauta.py:_jaccard_similarity (Phase 13 CREATIVE-02).
 * Words: >= 3 chars, lowercased. Fallback: character trigrams for short texts.
 */
function _jaccardSimilarity(textA, textB) {
  const wordsA = new Set((textA.toLowerCase().match(/\w{3,}/g) || []));
  const wordsB = new Set((textB.toLowerCase().match(/\w{3,}/g) || []));
  if (!wordsA.size || !wordsB.size) {
    // Fallback: character trigram similarity for short-word texts
    if (textA.length < 3 || textB.length < 3) return 0.0;
    const triA = new Set();
    const triB = new Set();
    const a = textA.toLowerCase();
    const b = textB.toLowerCase();
    for (let i = 0; i <= a.length - 3; i++) triA.add(a.slice(i, i + 3));
    for (let i = 0; i <= b.length - 3; i++) triB.add(b.slice(i, i + 3));
    if (!triA.size || !triB.size) return 0.0;
    const inter = new Set([...triA].filter(t => triB.has(t)));
    const union = new Set([...triA, ...triB]);
    return inter.size / union.size;
  }
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size ? intersection.size / union.size : 0.0;
}

/**
 * Generate 3 creative query variants from an original query.
 * Slots: inversion (always), anti-pattern (always), third rotates by domain.
 * Each variant is capped at CREATIVE_QUERY_WORD_CAP words.
 * Phase 13 CREATIVE-02. Domain detection uses tag-rules.json vocabulary.
 */
function generateVariants(query, domain) {
  // Third-slot selection by domain
  const THIRD_SLOT = {
    'database': 'cross-domain',
    'api': 'cross-domain',
    'security': 'constraint-removal',
    'frontend': 'lateral',
    'backend': 'cross-domain',
    'infrastructure': 'constraint-removal',
    'performance': 'constraint-removal',
    'authentication': 'constraint-removal',
    'caching': 'cross-domain',
    'deployment': 'constraint-removal',
    'monitoring': 'constraint-removal',
    'testing': 'lateral',
  };

  const thirdType = THIRD_SLOT[domain] || 'lateral';
  const topic = query.replace(/^(how to |what is |why does )/i, '').trim();

  // Build raw variant queries
  const variants = [
    { type: 'inversion', query: `${topic} failures common mistakes` },
    { type: 'anti-pattern', query: `${topic} anti-patterns worst practices` },
  ];

  // Third slot
  if (thirdType === 'lateral') {
    variants.push({ type: 'lateral', query: `natural systems analogy ${topic}` });
  } else if (thirdType === 'cross-domain') {
    variants.push({ type: 'cross-domain', query: `alternative approaches ${topic} tradeoffs` });
  } else {
    variants.push({ type: 'constraint-removal', query: `unlimited resources approach ${topic}` });
  }

  // Enforce 8-word cap
  for (const v of variants) {
    const words = v.query.split(/\s+/);
    if (words.length > CREATIVE_QUERY_WORD_CAP) {
      process.stderr.write(`  [creative] truncated ${v.type} query from ${words.length} to ${CREATIVE_QUERY_WORD_CAP} words\n`);
      v.query = words.slice(0, CREATIVE_QUERY_WORD_CAP).join(' ');
    }
  }

  return variants;
}

/**
 * Detect query domain by matching words against tag-rules.json vocabulary.
 * Returns the domain name with highest word overlap, or 'unknown'.
 */
function detectDomain(query) {
  let vocabulary;
  try {
    const rulesPath = path.join(__dirname, '..', 'config', 'tag-rules.json');
    vocabulary = JSON.parse(fs.readFileSync(rulesPath, 'utf-8')).vocabulary;
  } catch {
    return 'unknown';
  }
  const queryWords = new Set((query.toLowerCase().match(/\w{3,}/g) || []));
  if (!queryWords.size) return 'unknown';

  let bestDomain = 'unknown';
  let bestScore = 0;
  const priority = ['database', 'api', 'security', 'frontend', 'backend', 'infrastructure'];

  for (const [domain, keywords] of Object.entries(vocabulary)) {
    const domainWords = new Set(keywords.map(k => k.toLowerCase()));
    // Also include the domain name itself
    domainWords.add(domain.toLowerCase());
    const overlap = [...queryWords].filter(w => domainWords.has(w)).length;
    if (overlap > bestScore || (overlap === bestScore && bestScore > 0 && priority.indexOf(domain) >= 0 && (priority.indexOf(bestDomain) < 0 || priority.indexOf(domain) < priority.indexOf(bestDomain)))) {
      bestScore = overlap;
      bestDomain = domain;
    }
  }
  return bestScore > 0 ? bestDomain : 'unknown';
}

/**
 * Determine if creative mode should be enabled based on parsed args.
 * Rules (CONTEXT.md Decision 2):
 *  - --creative flag must be present
 *  - --task-type must be provided AND in CREATIVE_TYPES
 *  - No --task-type -> creative does NOT fire even with --creative
 *  - Unknown task type -> treated as implementation (suppressed) + warning
 *  - --re-research overrides gating (auto-enable on re-research)
 *  - GSD_R_CREATIVE=off kills creative entirely
 */
function shouldEnableCreative(args) {
  // Kill switch check
  if (process.env.GSD_R_CREATIVE === 'off') {
    if (args.creative) {
      process.stderr.write('[creative] disabled (GSD_R_CREATIVE=off) -- using conservative cascade\n');
    }
    return false;
  }

  // Re-research auto-enable overrides gating
  if (args['re-research']) {
    process.stderr.write('[creative] auto-enabled on re-research attempt.\n');
    return true;
  }

  // --creative flag must be present
  if (!args.creative) return false;

  // --task-type must be provided
  const taskType = args['task-type'];
  if (!taskType) return false;

  // Check against allowed types
  if (CREATIVE_TYPES.has(taskType)) return true;

  // Known non-creative types
  const SUPPRESSED_TYPES = new Set(['implementation', 'bug-fix', 'documentation']);
  if (SUPPRESSED_TYPES.has(taskType)) return false;

  // Unknown type -> implementation (conservative default)
  process.stderr.write(`[creative] Unknown task type '${taskType}', defaulting to implementation -- creative suppressed.\n`);
  return false;
}

/**
 * Deduplicate variant results against original results using Jaccard similarity.
 * Returns variant results that are below the threshold (novel findings).
 * @param {Array} originalResults - result objects from original query
 * @param {Array} variantResults - result objects from a single variant
 * @param {number} threshold - Jaccard threshold (default 0.7)
 * @returns {Array} filtered variant results with duplicates removed
 */
function deduplicateResults(originalResults, variantResults, threshold = CREATIVE_JACCARD_THRESHOLD) {
  const originalTexts = originalResults.flatMap(r =>
    (r.results || []).map(item => item.text || item.content || '')
  );

  return variantResults.filter(vr => {
    const variantTexts = (vr.results || []).map(item => item.text || item.content || '');
    for (const vText of variantTexts) {
      for (const oText of originalTexts) {
        if (_jaccardSimilarity(vText, oText) >= threshold) return false;
      }
    }
    return true;
  });
}

/**
 * Append a creative search log entry to data/creative-research-log.json.
 * Append-only JSON array. Creates file with [] if not exists.
 * Phase 13 CREATIVE-05.
 */
function _appendCreativeLog(entry) {
  try {
    const logPath = path.join(__dirname, '..', '..', 'data', 'creative-research-log.json');
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    } catch { /* file doesn't exist yet */ }
    entries.push(entry);
    const tmpPath = logPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2));
    fs.renameSync(tmpPath, logPath);
  } catch (err) {
    process.stderr.write(`  [creative] log write failed: ${err.message}\n`);
  }
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

  // TOK-01: Wire --no-cache flag to Perplexity provider
  if (args['no-cache']) {
    providerPerplexity._noCache = true;
  }

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
    // Context7 is additive (library metadata) — never stops the cascade.
    // Only memory, skb, perplexity, or webfetch can be terminal stops.
    const ADDITIVE_PROVIDERS = new Set(['context7']);
    for (const name of PROVIDER_ORDER) {
      const providerFn = PROVIDERS[name];
      const result = await providerFn(query, limit, args.url);

      if (result) {
        allResults.push(result);
        // Stop at first provider with actual results (not just notes),
        // unless the provider is additive-only (e.g., Context7 gives
        // supplemental library metadata, not research answers).
        if (!args.all && !result.error && !ADDITIVE_PROVIDERS.has(name) && (result.count >= RESEARCH_MIN_RESULTS || name === 'perplexity')) {
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
  --no-cache             Skip Perplexity cache reads (still writes to cache)
  --creative             Enable creative query variants (3 per input)
  --task-type <type>     Task type for creative gating (research|exploration|architecture-review|implementation|bug-fix|documentation)
  --re-research          Auto-enable creative on re-research

\x1b[1mEnvironment:\x1b[0m
  PERPLEXITY_API_KEY     Required for Perplexity provider
  GSD_R_CREATIVE         Set to 'off' to disable creative variants (kill switch)
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

// ── Test-only exports (Phase 13) ──
if (typeof module !== 'undefined' && require.main !== module) {
  module.exports = {
    _jaccardSimilarity,
    generateVariants,
    detectDomain,
    shouldEnableCreative,
    deduplicateResults,
    parseArgs,
    CREATIVE_TYPES,
    CREATIVE_JACCARD_THRESHOLD,
    CREATIVE_QUERY_WORD_CAP,
    CREATIVE_PROVIDER_ORDER,
  };
} else {
  main();
}
