#!/usr/bin/env node

/**
 * GSD-RLM CLI — Retrieval-augmented context engine for Claude Code agents.
 *
 * Communicates with rlm-service.py on localhost:18798 via HTTP.
 * Agents use this to search files/directories for relevant context
 * instead of having full files injected into prompts.
 *
 * Usage: node gsd-rlm.cjs <command> [args]
 *
 * Commands:
 *   query <question> --dir <dir>        Search a directory for relevant code
 *   query <question> --path <file>      Search a specific file
 *   query <question> --paths <f1> <f2>  Search multiple files
 *   chunk <filepath>                    Show chunks for a file
 *   search <question> --paths <files>   Search specific files (raw results)
 *   health                              Check RLM service status
 *   start                               Start RLM service
 *   stop                                Stop RLM service
 *
 * Options:
 *   --top-k N          Number of results (default: 10)
 *   --max-chars N      Max chunk size in chars (default: 8000)
 *   --json             Output raw JSON
 *   --compact          Show only file:line references (no text)
 *
 * Environment:
 *   GSD_RLM_PORT       Service port (default: 18798)
 *   GSD_RLM_HOST       Service host (default: 127.0.0.1)
 */

const http = require('http');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Load .env file (skipped in test mode) ─────────────
(function loadDotenv() {
  if (process.env.GSD_AMAUTA_NO_AUTO_START) return;
  for (const f of [path.join(__dirname, '..', '..', '.env'), '/srv/amauta/.env']) {
    try {
      for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k && !(k in process.env)) process.env[k] = v;
      }
      break;
    } catch { /* next */ }
  }
})();

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const HOST = process.env.GSD_RLM_HOST || '127.0.0.1';
const PORT = parseInt(process.env.GSD_RLM_PORT || '18798', 10);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const RLM_SERVICE = path.join(PLUGIN_ROOT, 'services', 'rlm-service.py');

// ═══════════════════════════════════════════════════════
// Config Helpers — check rlm_enabled and fallback settings
// Uses shared loadAmautaConfig from core.cjs
// ═══════════════════════════════════════════════════════

const { loadAmautaConfig } = require('./lib/core.cjs');

function isRlmEnabled() {
  const amauta = loadAmautaConfig();
  // Explicitly disabled via config
  if (amauta.rlm_enabled === false) return false;
  // Default: enabled if service exists
  return true;
}

function shouldFallbackToFiles() {
  const amauta = loadAmautaConfig();
  // Default: true — always fall back to full files when RLM is down
  return amauta.rlm_fallback_to_full_files !== false;
}

// ═══════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════

function httpRequest(method, urlPath, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const options = {
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ statusCode: res.statusCode, data: { output: raw } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (payload) req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// Service Management
// ═══════════════════════════════════════════════════════

async function isServiceRunning() {
  try {
    const { statusCode, data } = await httpRequest('GET', '/health', null, 3000);
    return statusCode === 200 && data.status === 'ok';
  } catch {
    return false;
  }
}

async function startService() {
  if (!fs.existsSync(RLM_SERVICE)) return false;

  const child = spawn('python3', [RLM_SERVICE, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GSD_RLM_PORT: String(PORT) },
  });
  child.on('error', (err) => {
    // Handle ENOENT (python3 not found) gracefully — don't crash the process
    process.stderr.write(`[rlm] Failed to start RLM service: ${err.message}\n`);
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (await isServiceRunning()) return true;
  }
  return false;
}

async function ensureService() {
  if (await isServiceRunning()) return true;
  process.stderr.write('RLM service not running, starting...\n');
  const started = await startService();
  if (started) {
    process.stderr.write('RLM service started.\n');
    return true;
  }
  process.stderr.write('ERROR: Could not start RLM service.\n');
  return false;
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { positional: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (key === 'json' || key === 'compact') {
        result.flags[key] = true;
        i++;
      } else if (key === 'paths') {
        // Collect all following non-flag args as paths
        const paths = [];
        i++;
        while (i < argv.length && !argv[i].startsWith('--')) {
          paths.push(argv[i]);
          i++;
        }
        result.flags.paths = paths;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          result.flags[key] = next;
          i += 2;
        } else {
          result.flags[key] = true;
          i++;
        }
      }
    } else {
      result.positional.push(argv[i]);
      i++;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════
// Formatters
// ═══════════════════════════════════════════════════════

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function formatResults(results, compact = false) {
  if (!results || results.length === 0) {
    console.log(`${DIM}No relevant chunks found.${RESET}`);
    return;
  }

  for (const r of results) {
    const relPath = r.filepath.replace(process.cwd() + '/', '').replace(process.env.HOME + '/', '~/');
    const score = r.relevance_score !== undefined ? ` ${DIM}score=${r.relevance_score}${RESET}` : '';
    const chars = ` ${DIM}(${r.char_count} chars)${RESET}`;

    console.log(`${CYAN}${relPath}${RESET}:${GREEN}${r.start_line}-${r.end_line}${RESET} ${BOLD}${r.label}${RESET}${score}${chars}`);

    if (!compact && r.text) {
      // Show first 3 lines of text as preview
      const lines = r.text.split('\n').slice(0, 3);
      for (const line of lines) {
        console.log(`  ${DIM}${line.substring(0, 120)}${RESET}`);
      }
      if (r.text.split('\n').length > 3) {
        console.log(`  ${DIM}...${RESET}`);
      }
      console.log('');
    }
  }
}

function formatChunks(chunks, filepath) {
  const relPath = filepath.replace(process.cwd() + '/', '').replace(process.env.HOME + '/', '~/');
  console.log(`${BOLD}${relPath}${RESET} — ${chunks.length} chunks\n`);

  for (const c of chunks) {
    console.log(`  ${GREEN}[${c.start_line}-${c.end_line}]${RESET} ${c.label} ${DIM}(${c.char_count} chars)${RESET}`);
  }
}

// ═══════════════════════════════════════════════════════
// Command Handlers
// ═══════════════════════════════════════════════════════

async function cmdQuery(args, flags) {
  const query = args.join(' ');
  if (!query) die('Usage: gsd-rlm query <question> --dir <dir> | --path <file>');

  const topK = parseInt(flags['top-k'] || flags.topk || '10', 10);
  const maxChars = parseInt(flags['max-chars'] || '8000', 10);
  const jsonMode = flags.json;
  const compact = flags.compact;

  // Helper: gracefully degrade to file references on mid-execution service failure
  const rlmFallback = (err) => {
    const reason = err && err.code === 'ECONNREFUSED' ? 'service stopped mid-request' : (err && err.message) || 'unknown error';
    if (shouldFallbackToFiles()) {
      const suggestions = fallbackSuggestReferences(flags, query);
      printFallbackMessage(suggestions, query);
      return 0;
    }
    process.stderr.write(`ERROR: RLM request failed (${reason}). Use --dir/--path or start the service.\n`);
    return 1;
  };

  if (flags.dir) {
    // Directory query
    const body = {
      query,
      directory: path.resolve(flags.dir),
      top_k: topK,
      max_chars: maxChars,
    };
    if (flags.extensions) {
      body.extensions = flags.extensions.split(',').map(e => e.startsWith('.') ? e : `.${e}`);
    }

    let data;
    try {
      ({ data } = await httpRequest('POST', '/query', body));
    } catch (err) {
      return rlmFallback(err);
    }
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`${DIM}Query: "${query}" in ${flags.dir} — ${data.files_scanned} files, ${data.total_chunks} chunks, ${data.elapsed_ms}ms${RESET}\n`);
      formatResults(data.results, compact);
    }
    return data.ok ? 0 : 1;

  } else if (flags.path) {
    // Single file query
    const body = {
      query,
      paths: [path.resolve(flags.path)],
      top_k: topK,
      max_chars: maxChars,
    };

    let data;
    try {
      ({ data } = await httpRequest('POST', '/search', body));
    } catch (err) {
      return rlmFallback(err);
    }
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`${DIM}Query: "${query}" in ${flags.path} — ${data.total_chunks} chunks, ${data.elapsed_ms}ms${RESET}\n`);
      formatResults(data.results, compact);
    }
    return data.ok ? 0 : 1;

  } else if (flags.paths && flags.paths.length > 0) {
    // Multiple files query
    const body = {
      query,
      paths: flags.paths.map(p => path.resolve(p)),
      top_k: topK,
      max_chars: maxChars,
    };

    let data;
    try {
      ({ data } = await httpRequest('POST', '/search', body));
    } catch (err) {
      return rlmFallback(err);
    }
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`${DIM}Query: "${query}" across ${flags.paths.length} files — ${data.total_chunks} chunks, ${data.elapsed_ms}ms${RESET}\n`);
      formatResults(data.results, compact);
    }
    return data.ok ? 0 : 1;

  } else {
    die('One of --dir, --path, or --paths is required.\n  Example: gsd-rlm query "how does auth work" --dir src/');
  }
}

async function cmdChunk(filepath, flags) {
  if (!filepath) die('Usage: gsd-rlm chunk <filepath>');

  const resolved = path.resolve(filepath);
  const maxChars = parseInt(flags['max-chars'] || '8000', 10);

  let data;
  try {
    ({ data } = await httpRequest('POST', '/chunk', { filepath: resolved, max_chars: maxChars }));
  } catch (err) {
    process.stderr.write(`ERROR: RLM chunk request failed (${err && err.message}). Is the RLM service running?\n`);
    return 1;
  }

  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (data.ok) {
    formatChunks(data.chunks, resolved);
  } else {
    console.error(data.error || 'Unknown error');
    return 1;
  }
  return 0;
}

async function cmdSearch(args, flags) {
  const query = args.join(' ');
  if (!query) die('Usage: gsd-rlm search <query> --paths <file1> <file2>...');
  if (!flags.paths || flags.paths.length === 0) die('--paths is required');

  const topK = parseInt(flags['top-k'] || '10', 10);
  const body = {
    query,
    paths: flags.paths.map(p => path.resolve(p)),
    top_k: topK,
  };

  let data;
  try {
    ({ data } = await httpRequest('POST', '/search', body));
  } catch (err) {
    process.stderr.write(`ERROR: RLM search request failed (${err && err.message}). Is the RLM service running?\n`);
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    formatResults(data.results, flags.compact);
  }
  return data.ok ? 0 : 1;
}

async function cmdHealth(flags) {
  try {
    const { data } = await httpRequest('GET', '/health', null, 3000);
    if (flags.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`RLM service: ${GREEN}running${RESET} (PID ${data.pid})`);
      console.log(`  Port: ${data.port}`);
      console.log(`  Cache: ${data.cache_size}/${data.cache_max} entries`);
      console.log(`  Max chunk: ${data.max_chunk_chars} chars`);
    }
    return 0;
  } catch {
    console.log(`RLM service: ${YELLOW}not running${RESET}`);
    return 1;
  }
}

async function cmdStart() {
  if (await isServiceRunning()) {
    console.log('RLM service already running');
    return 0;
  }
  const started = await startService();
  if (started) {
    console.log(`RLM service started on ${HOST}:${PORT}`);
    return 0;
  }
  console.error('Failed to start RLM service');
  return 1;
}

async function cmdStop() {
  if (!fs.existsSync(RLM_SERVICE)) die(`RLM service script not found: ${RLM_SERVICE}`);
  try {
    execFileSync('python3', [RLM_SERVICE, 'stop'], { encoding: 'utf-8' });
    console.log('RLM service stopped');
  } catch (err) {
    console.error(err.stdout || err.stderr || err.message);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════
// Fallback — suggest @ references when RLM is down
// ═══════════════════════════════════════════════════════

function fallbackSuggestReferences(flags, query) {
  const suggestions = [];
  const keywords = (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);

  if (flags.path) {
    const p = path.resolve(flags.path);
    if (fs.existsSync(p)) {
      suggestions.push({ path: p, score: 10 }); // Explicit path gets highest score
    }
  }

  if (flags.paths && Array.isArray(flags.paths)) {
    for (const fp of flags.paths) {
      const p = path.resolve(fp);
      if (fs.existsSync(p)) suggestions.push({ path: p, score: 10 });
    }
  }

  if (flags.dir) {
    const dir = path.resolve(flags.dir);
    if (fs.existsSync(dir)) {
      try {
        const codeExts = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.cjs', '.mjs', '.sql', '.md', '.yml', '.yaml', '.json', '.sh', '.css', '.scss']);
        const entries = [];

        // Recursive scan up to 2 levels deep for keyword-scored suggestions
        function scanDir(d, depth) {
          if (depth > 2) return;
          try {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
              const full = path.join(d, entry.name);
              if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (codeExts.has(ext)) entries.push(full);
              } else if (entry.isDirectory()) {
                scanDir(full, depth + 1);
              }
            }
          } catch { /* permission error */ }
        }
        scanDir(dir, 0);

        // Score each file by keyword matches in filename and path
        for (const fp of entries) {
          const name = path.basename(fp).toLowerCase();
          const relPath = fp.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            if (name.includes(kw)) score += 3;
            else if (relPath.includes(kw)) score += 1;
          }
          suggestions.push({ path: fp, score });
        }
      } catch { /* ignore */ }
    }
  }

  // Sort by score descending, take top 10
  suggestions.sort((a, b) => b.score - a.score);
  return suggestions.slice(0, 10).map(s => s.path);
}

function printFallbackMessage(suggestions, query) {
  process.stderr.write(`${YELLOW}RLM service unavailable -- falling back to file references.${RESET}\n`);
  if (query) {
    process.stderr.write(`${DIM}Query was: "${query}"${RESET}\n\n`);
  }

  if (suggestions.length > 0) {
    console.log(`${BOLD}Suggested files (sorted by likely relevance):${RESET}`);
    for (const s of suggestions) {
      const rel = s.replace(process.cwd() + '/', '').replace(process.env.HOME + '/', '~/');
      console.log(`  ${CYAN}${rel}${RESET}`);
    }
    console.log(`\n${DIM}Use the Read tool to examine these files directly.${RESET}`);
    console.log(`${DIM}Start RLM for smarter results: gsd-rlm start${RESET}`);
  } else {
    console.log(`${DIM}No file suggestions available. Use Read/Glob tools to find relevant files.${RESET}`);
    console.log(`${DIM}Start RLM for code-aware search: gsd-rlm start${RESET}`);
  }
}

async function cmdCheckConfig(flags) {
  // loadAmautaConfig() is called internally by isRlmEnabled() and shouldFallbackToFiles()
  const serviceUp = await isServiceRunning();

  const result = {
    rlm_enabled: isRlmEnabled(),
    rlm_fallback_to_full_files: shouldFallbackToFiles(),
    service_running: serviceUp,
    mode: 'unknown',
  };

  if (result.service_running && result.rlm_enabled) {
    result.mode = 'rlm';
  } else if (result.rlm_fallback_to_full_files || !result.rlm_enabled) {
    result.mode = 'file-references';
  } else {
    result.mode = 'unavailable';
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const modeLabel = result.mode === 'rlm' ? `${GREEN}RLM active${RESET}` :
                      result.mode === 'file-references' ? `${YELLOW}File references (@ mode)${RESET}` :
                      `${'\x1b[91m'}Unavailable${RESET}`;
    console.log(`${BOLD}Context Mode:${RESET} ${modeLabel}`);
    console.log(`  RLM enabled:  ${result.rlm_enabled}`);
    console.log(`  Service up:   ${result.service_running}`);
    console.log(`  Fallback:     ${result.rlm_fallback_to_full_files}`);
  }

  return 0;
}

// ═══════════════════════════════════════════════════════
// CLI Router
// ═══════════════════════════════════════════════════════

async function main() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0];
  const rest = rawArgs.slice(1);

  if (!command) {
    die(
      'Usage: gsd-rlm <command> [args]\n' +
      'Commands: query, chunk, search, health, start, stop, check-config\n\n' +
      'Examples:\n' +
      '  gsd-rlm query "how does auth work" --dir src/\n' +
      '  gsd-rlm query "database schema" --path migrations/001.sql\n' +
      '  gsd-rlm chunk services/daemon.py\n' +
      '  gsd-rlm check-config --json\n' +
      '  gsd-rlm health'
    );
  }

  // Service lifecycle and config commands don't need the service running
  if (command === 'health') {
    const { flags } = parseArgs(rest);
    process.exit(await cmdHealth(flags));
  }
  if (command === 'start') {
    process.exit(await cmdStart());
  }
  if (command === 'stop') {
    process.exit(await cmdStop());
  }
  if (command === 'check-config') {
    const { flags } = parseArgs(rest);
    process.exit(await cmdCheckConfig(flags));
  }

  // Check if RLM is explicitly disabled via config
  if (!isRlmEnabled()) {
    const parsed = parseArgs(rest);
    const query = parsed.positional.join(' ') || '';
    const suggestions = fallbackSuggestReferences(parsed.flags, query);
    printFallbackMessage(suggestions, query);
    process.exit(0);
  }

  // All other commands need the service
  const serviceUp = await ensureService();
  if (!serviceUp) {
    // Check if fallback is enabled
    if (shouldFallbackToFiles()) {
      const parsed = parseArgs(rest);
      const query = parsed.positional.join(' ') || '';
      const suggestions = fallbackSuggestReferences(parsed.flags, query);
      printFallbackMessage(suggestions, query);
      process.exit(0);
    }
    die('RLM service is not available and fallback is disabled. Run: gsd-rlm start');
  }

  const parsed = parseArgs(rest);
  let exitCode = 0;

  switch (command) {
    case 'query':
      exitCode = await cmdQuery(parsed.positional, parsed.flags);
      break;

    case 'chunk':
      exitCode = await cmdChunk(parsed.positional[0], parsed.flags);
      break;

    case 'search':
      exitCode = await cmdSearch(parsed.positional, parsed.flags);
      break;

    default:
      die(`Unknown command: ${command}. Available: query, chunk, search, health, start, stop, check-config`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
