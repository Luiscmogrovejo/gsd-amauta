#!/usr/bin/env node
'use strict';
/**
 * scripts/tool-integrity.cjs
 *
 * SHA-256 tool integrity checking for GSD-Amauta (LIFE-05).
 *
 * Hashes all CJS CLI scripts and Python service files. Stores hashes in Valkey
 * at daemon startup (--store) and compares on re-run (--check). Any mismatch
 * logs a TOOL_INTEGRITY_VIOLATION to stderr and exits 1 — these are security
 * events requiring manual operator intervention (restart daemon to re-baseline).
 *
 * Graceful degradation: if Valkey is unavailable, logs a warning and exits 0.
 * Never blocks the main workflow on cache unavailability.
 *
 * Usage:
 *   node scripts/tool-integrity.cjs --store   # daemon startup — hash and store
 *   node scripts/tool-integrity.cjs --check   # task claim — compare hashes
 *   node scripts/tool-integrity.cjs --help    # print usage
 *
 * Environment:
 *   AMAUTA_REDIS_URL  Valkey/Redis connection URL (default: redis://127.0.0.1:6379)
 */

const { createHash } = require('crypto');
const { readFileSync, existsSync } = require('fs');
const net = require('net');
const path = require('path');

// ─── Tool file list (LIFE-05) ─────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

const TOOL_FILES = [
  // CJS CLI binaries
  { name: 'gsd-amauta.cjs',   rel: 'get-shit-done/bin/gsd-amauta.cjs' },
  { name: 'gsd-tools.cjs',    rel: 'get-shit-done/bin/gsd-tools.cjs' },
  { name: 'gsd-rlm.cjs',      rel: 'get-shit-done/bin/gsd-rlm.cjs' },
  { name: 'gsd-research.cjs', rel: 'get-shit-done/bin/gsd-research.cjs' },
  { name: 'gsd-memory.cjs',   rel: 'get-shit-done/bin/gsd-memory.cjs' },
  // Python services
  { name: 'amauta-daemon.py', rel: 'services/amauta-daemon.py' },
  { name: 'rlm-service.py',   rel: 'services/rlm-service.py' },
  { name: 'amauta-mcp.py',    rel: 'services/amauta-mcp.py' },
];

// ─── Valkey connection ────────────────────────────────────────────────────────

const REDIS_URL = process.env.AMAUTA_REDIS_URL || 'redis://127.0.0.1:6379';
const KEY_PREFIX = 'tool_integrity:';

/**
 * Parse a redis:// URL into {host, port}.
 * @param {string} url
 * @returns {{ host: string, port: number }}
 */
function parseRedisUrl(url) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname || '127.0.0.1', port: parseInt(parsed.port || '6379', 10) };
  } catch (_) {
    return { host: '127.0.0.1', port: 6379 };
  }
}

/**
 * Send a raw Redis command over a TCP socket and return the response string.
 * Uses RESP inline protocol — sufficient for GET/SET/QUIT.
 *
 * @param {string} host
 * @param {number} port
 * @param {string[]} args - Command parts (e.g. ['SET', 'key', 'value'])
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<string>}
 */
function sendRedisCommand(host, port, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = '';
    let settled = false;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(new Error('Redis connection timed out')));
    socket.on('error', (err) => done(err));

    socket.on('data', (chunk) => {
      response += chunk.toString();
      // Collect until we have a complete response line
      if (response.includes('\r\n')) done(null, response);
    });

    socket.connect(port, host, () => {
      // Build RESP array command
      const parts = [`*${args.length}\r\n`];
      for (const arg of args) {
        const buf = Buffer.from(String(arg), 'utf8');
        parts.push(`$${buf.length}\r\n${String(arg)}\r\n`);
      }
      socket.write(parts.join(''));
    });
  });
}

/**
 * Store a value in Valkey (SET key value).
 * Returns true on success, false on failure (graceful degradation).
 *
 * @param {string} host
 * @param {number} port
 * @param {string} key
 * @param {string} value
 * @returns {Promise<boolean>}
 */
async function redisSet(host, port, key, value) {
  try {
    await sendRedisCommand(host, port, ['SET', key, value]);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Retrieve a value from Valkey (GET key).
 * Returns null on miss or failure (graceful degradation).
 *
 * @param {string} host
 * @param {number} port
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function redisGet(host, port, key) {
  try {
    const raw = await sendRedisCommand(host, port, ['GET', key]);
    if (raw.startsWith('$-1')) return null; // nil bulk string
    // RESP bulk string: $N\r\ndata\r\n
    const newline = raw.indexOf('\r\n');
    if (newline === -1) return null;
    const data = raw.slice(newline + 2).replace(/\r\n$/, '');
    return data || null;
  } catch (_) {
    return null;
  }
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file's content.
 *
 * @param {string} filePath - Absolute path to file
 * @returns {string} Hex digest
 */
function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

// ─── Modes ────────────────────────────────────────────────────────────────────

/**
 * --store mode: hash all tool files and store in Valkey.
 * Called at daemon startup to establish a trusted baseline.
 */
async function storeHashes() {
  const { host, port } = parseRedisUrl(REDIS_URL);
  const timestamp = new Date().toISOString();
  let stored = 0;
  let missing = 0;

  for (const tool of TOOL_FILES) {
    const filePath = path.join(ROOT, tool.rel);
    if (!existsSync(filePath)) {
      console.warn(`[tool-integrity] WARN: file not found, skipping: ${tool.rel}`);
      missing++;
      continue;
    }
    const hash = hashFile(filePath);
    const entry = JSON.stringify({ hash, timestamp, file: tool.name });
    const ok = await redisSet(host, port, `${KEY_PREFIX}${tool.name}`, entry);
    if (!ok) {
      console.warn('[tool-integrity] WARN: Valkey unavailable — integrity baseline not stored. Continuing without cache.');
      process.exit(0); // graceful degradation
    }
    console.log(`[tool-integrity] stored  ${tool.name} sha256=${hash.slice(0, 12)}...`);
    stored++;
  }

  console.log(`[tool-integrity] baseline stored: ${stored} files, ${missing} missing`);
  process.exit(0);
}

/**
 * --check mode: re-hash all tool files and compare against stored values.
 * Called at task claim time. Exits 1 on any mismatch (integrity violation).
 */
async function checkHashes() {
  const { host, port } = parseRedisUrl(REDIS_URL);
  const violations = [];
  let checked = 0;
  let missing_files = 0;
  let no_baseline = 0;

  for (const tool of TOOL_FILES) {
    const filePath = path.join(ROOT, tool.rel);
    if (!existsSync(filePath)) {
      console.warn(`[tool-integrity] WARN: file not found, skipping check: ${tool.rel}`);
      missing_files++;
      continue;
    }

    const rawEntry = await redisGet(host, port, `${KEY_PREFIX}${tool.name}`);
    if (rawEntry === null) {
      // Valkey unavailable or no baseline — graceful degradation
      console.warn(`[tool-integrity] WARN: no baseline for ${tool.name} — run --store first. Skipping.`);
      no_baseline++;
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(rawEntry);
    } catch (_) {
      console.warn(`[tool-integrity] WARN: corrupt entry for ${tool.name} — skipping.`);
      no_baseline++;
      continue;
    }

    const actualHash = hashFile(filePath);
    if (actualHash !== entry.hash) {
      violations.push({
        file: tool.name,
        expected_hash: entry.hash,
        actual_hash: actualHash,
        baseline_timestamp: entry.timestamp,
      });
    } else {
      console.log(`[tool-integrity] ok      ${tool.name} sha256=${actualHash.slice(0, 12)}...`);
    }
    checked++;
  }

  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(JSON.stringify({
        level: 'error',
        event: 'TOOL_INTEGRITY_VIOLATION',
        file: v.file,
        expected_hash: v.expected_hash,
        actual_hash: v.actual_hash,
        baseline_timestamp: v.baseline_timestamp,
        message: `Tool file ${v.file} has been modified since baseline was stored. Manual operator intervention required.`,
      }) + '\n');
    }
    process.exit(1);
  }

  if (no_baseline > 0 && checked === 0) {
    // No baseline at all — Valkey probably unavailable. Graceful degradation.
    console.warn('[tool-integrity] WARN: no baseline entries found — Valkey may be unavailable. Skipping integrity check.');
    process.exit(0);
  }

  console.log(`[tool-integrity] integrity check passed: ${checked} files verified, ${violations.length} violations`);
  console.log(JSON.stringify({ verified: true, files_checked: checked }));
  process.exit(0);
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

const mode = process.argv[2];

if (!mode || mode === '--help' || mode === '-h') {
  console.log([
    'Usage: node scripts/tool-integrity.cjs --store | --check',
    '',
    'Modes:',
    '  --store   Hash all tool files and store in Valkey (run at daemon startup)',
    '  --check   Re-hash all tool files and compare against stored baseline',
    '',
    'Environment:',
    '  AMAUTA_REDIS_URL  Valkey connection URL (default: redis://127.0.0.1:6379)',
    '',
    'On TOOL_INTEGRITY_VIOLATION: exits 1, logs JSON to stderr, requires manual',
    'operator intervention (restart daemon to re-establish baseline).',
  ].join('\n'));
  process.exit(0);
}

if (mode === '--store') {
  storeHashes().catch((err) => {
    console.error(`[tool-integrity] fatal: ${err.message}`);
    process.exit(0); // never block on tool-integrity failure
  });
} else if (mode === '--check') {
  checkHashes().catch((err) => {
    console.error(`[tool-integrity] fatal: ${err.message}`);
    process.exit(0); // graceful degradation
  });
} else {
  console.error(`[tool-integrity] unknown mode: ${mode}. Use --store, --check, or --help.`);
  process.exit(1);
}
