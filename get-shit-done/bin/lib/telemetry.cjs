'use strict';

/**
 * get-shit-done/bin/lib/telemetry.cjs — Phase 62 TEL-01/TEL-03: consent-gated
 * local telemetry core.
 *
 * Privacy policy (non-negotiable): payloads carry METADATA ONLY — ids,
 * types, counts, durations, error classes. NEVER file contents, prompts,
 * memory text, secrets, error messages, or raw project names. The project
 * identifier sent is a salted hash (see projectHash()), never the literal
 * repo basename.
 *
 * Pre-consent stance: "local-only until consented" is satisfied by the
 * STRICTER reading — nothing is recorded at all before opt-in. emit() is a
 * total no-op when telemetry is disabled: no buffer file is ever created,
 * no directory is created, no bytes are written. The `preview` verb (see
 * gsd-amauta.cjs `case 'telemetry':`) synthesizes a sample envelope via
 * sampleEvent() when the buffer is empty, so disclosure never requires
 * prior collection.
 *
 * Dual-runtime discipline (Phase 60 lesson): dataDir() MUST resolve to the
 * IDENTICAL directory as DATA_DIR in get-shit-done/bin/gsd-amauta.cjs
 * (`process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT, 'data')`) and
 * `_data_dir()` in services/capability_access.py. From this file's location
 * (get-shit-done/bin/lib/), three '..' hops reach the repo root in the
 * source-repo layout, matching PLUGIN_ROOT.
 *
 * Every fs/JSON operation in this module is wrapped in try/catch and
 * returns a safe default — this module NEVER throws to callers, and
 * emit() NEVER performs network I/O (flushing happens only in a detached
 * spawned child or the explicit `telemetry flush` verb — see 62-01-02).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// ─── LOCKED constants ───────────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0';

const EVENT_TYPES = Object.freeze([
  'phase_start',
  'phase_complete',
  'validator_verdict',
  'divergence_filed',
  'divergence_resolved',
  'escalation_fired',
  'party_session',
  'error_class',
]);

const BUFFER_FILENAME = 'telemetry-buffer.jsonl';
const BUFFER_CAP_DEFAULT = 2000;

const FLUSH_STATE_FILENAME = 'telemetry-flush-state.json';
const FLUSH_MIN_INTERVAL_MS = 300000; // 5 min
const FLUSH_TIMEOUT_MS = 3000;
const FLUSH_BATCH_MAX = 500;

// ─── Path resolution ────────────────────────────────────────────────────────

/**
 * Resolve the telemetry data directory. MUST stay identical to DATA_DIR in
 * gsd-amauta.cjs (process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT,
 * 'data')) and _data_dir() in services/capability_access.py — dual-runtime
 * discipline (Phase 60 lesson). This module lives at
 * get-shit-done/bin/lib/telemetry.cjs; three '..' hops from __dirname reach
 * the repo root in the source-repo layout.
 */
function dataDir() {
  return process.env.AMAUTA_DATA_DIR ||
    path.join(path.resolve(__dirname, '..', '..', '..'), 'data');
}

function bufferPath() {
  return path.join(dataDir(), BUFFER_FILENAME);
}

function flushStatePath() {
  return path.join(dataDir(), FLUSH_STATE_FILENAME);
}

/**
 * Resolve the telemetry config file path. GSD_TELEMETRY_CONFIG_PATH is an
 * AUTHORITATIVE-EXCLUSIVE test seam: when set, it is returned unconditionally
 * — even if the file does not exist at that path — and callers must NOT fall
 * through to the cwd-based default (v3.4 env-seam learning).
 */
function configPath() {
  if (process.env.GSD_TELEMETRY_CONFIG_PATH) {
    return process.env.GSD_TELEMETRY_CONFIG_PATH;
  }
  return path.join(process.cwd(), '.planning', 'config.json');
}

// ─── Config CRUD (fail-open) ────────────────────────────────────────────────

const TELEMETRY_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  consented_at: null,
  prompted_at: null,
  salt: null,
  sink_url: null,
});

/**
 * Read the `telemetry` section of the config file, merged over defaults.
 * Any read/parse failure (missing file, invalid JSON, missing key) returns
 * pure defaults — never throws.
 */
function readTelemetryConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const section = (parsed && typeof parsed === 'object' && parsed.telemetry) || {};
    return { ...TELEMETRY_CONFIG_DEFAULTS, ...section };
  } catch {
    return { ...TELEMETRY_CONFIG_DEFAULTS };
  }
}

/**
 * Shallow-merge `patch` into the config file's `telemetry` key and write it
 * back with 2-space indent. Returns true on success, false on any failure —
 * including when the config file does NOT exist (this function never
 * scaffolds .planning/config.json in a non-project cwd; that guarantee
 * belongs to the caller, e.g. the first-run consent notice, which checks
 * existence itself before calling this).
 */
function writeTelemetryConfig(patch) {
  const cfgPath = configPath();
  let full;
  try {
    if (!fs.existsSync(cfgPath)) return false;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    full = JSON.parse(raw);
    if (!full || typeof full !== 'object') full = {};
  } catch {
    return false;
  }

  try {
    const currentSection = (full.telemetry && typeof full.telemetry === 'object') ? full.telemetry : {};
    full.telemetry = { ...currentSection, ...patch };
    fs.writeFileSync(cfgPath, JSON.stringify(full, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * GSD_TELEMETRY env: 'off' hard-disables regardless of config; 'on' enables
 * for this process (test/CI seam, and the Phase 71 OBS-01 contract name);
 * unset defers to config.
 */
function isEnabled() {
  const envFlag = process.env.GSD_TELEMETRY;
  if (envFlag === 'off') return false;
  if (envFlag === 'on') return true;
  try {
    return readTelemetryConfig().enabled === true;
  } catch {
    return false;
  }
}

// ─── Envelope construction ──────────────────────────────────────────────────

/**
 * sha256 hex of (salt || '') + repo-basename, sliced to the first 16 hex
 * chars. Never the raw repo name itself.
 */
function projectHash() {
  try {
    const cfg = readTelemetryConfig();
    const salt = cfg.salt || '';
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const basename = path.basename(repoRoot);
    return crypto.createHash('sha256').update(salt + basename).digest('hex').slice(0, 16);
  } catch {
    return '0'.repeat(16);
  }
}

/** Build the LOCKED 6-key event envelope. Never throws. */
function buildEvent(eventType, payload) {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: crypto.randomUUID(),
    event_type: eventType,
    ts: new Date().toISOString(),
    project_hash: projectHash(),
    payload: payload || {},
  };
}

/** sampleEvent() — the exact envelope shape with placeholder values, used
 * by the `preview` verb when the buffer is empty. */
function sampleEvent() {
  return buildEvent('phase_start', { phase: 'NN', sample: true });
}

// ─── Buffer cap ─────────────────────────────────────────────────────────────

function bufferCap() {
  const raw = process.env.GSD_TELEMETRY_BUFFER_CAP;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return BUFFER_CAP_DEFAULT;
}

// ─── Buffered read helpers ──────────────────────────────────────────────────

/** Line count of the buffer file, 0 when absent or unreadable. */
function bufferedCount() {
  try {
    const raw = fs.readFileSync(bufferPath(), 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Parse and return the last non-empty buffer line as an object, or null. */
function readLastEvent() {
  try {
    const raw = fs.readFileSync(bufferPath(), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

// ─── emit() — the no-op-when-disabled gate ─────────────────────────────────

/**
 * emit(eventType, payload) — the sole write path into the telemetry buffer.
 *
 * - Returns {emitted:false, reason:'disabled'} when telemetry is not
 *   enabled. THIS IS THE PRE-CONSENT ZERO-COLLECTION GUARANTEE: no buffer
 *   directory or file is ever created, no bytes are written.
 * - Returns {emitted:false, reason:'unknown_event_type'} when eventType is
 *   not one of the frozen EVENT_TYPES.
 * - Otherwise appends one JSON line to the buffer (creating dataDir()
 *   recursively if needed), enforces bufferCap() by keeping only the LAST
 *   N lines (oldest dropped first), schedules a flush attempt (fire-and-
 *   forget, never awaited here), and returns {emitted:true}.
 *
 * NEVER performs network I/O. NEVER throws.
 */
function emit(eventType, payload) {
  try {
    if (!isEnabled()) return { emitted: false, reason: 'disabled' };
    if (!EVENT_TYPES.includes(eventType)) return { emitted: false, reason: 'unknown_event_type' };

    const event = buildEvent(eventType, payload);
    const bPath = bufferPath();

    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.appendFileSync(bPath, JSON.stringify(event) + '\n');
    } catch {
      return { emitted: false, reason: 'write_failed' };
    }

    // Enforce the bounded cap — oldest lines dropped first.
    try {
      const cap = bufferCap();
      const raw = fs.readFileSync(bPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > cap) {
        const kept = lines.slice(lines.length - cap);
        fs.writeFileSync(bPath, kept.join('\n') + '\n');
      }
    } catch {
      // Fail-open: cap enforcement failing must never block emit() success.
    }

    try {
      maybeScheduleFlush();
    } catch {
      // Fail-open: scheduling failure must never affect emit()'s result.
    }

    return { emitted: true };
  } catch {
    return { emitted: false, reason: 'error' };
  }
}

// ─── Flush engine (TEL-03 — dead sink NEVER blocks or slows the harness) ───
//
// emit() itself NEVER performs network I/O. flushNow() is the only function
// in this module that opens a socket, and it is invoked ONLY from the
// explicit `telemetry flush` verb or from the detached __flush child spawned
// by maybeScheduleFlush() below — never synchronously from emit()'s caller.

function _writeFlushState(record) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(flushStatePath(), JSON.stringify(record, null, 2) + '\n');
  } catch {
    // Fail-open: a flush-state write failure must never propagate.
  }
}

function _readFlushState() {
  try {
    const raw = fs.readFileSync(flushStatePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * POST body to urlStr with a hard FLUSH_TIMEOUT_MS timeout (both the
 * request's `timeout` option AND an explicit req.destroy() on timeout).
 * Resolves — NEVER rejects. On success: {ok:true}. On any failure
 * (timeout, refused, non-2xx, DNS, invalid URL): {ok:false, error:'<short
 * code>'} — the error is a status/error CODE only, never the response body
 * or any request/response content (privacy: metadata only).
 */
function _postJson(urlStr, body) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      resolve({ ok: false, error: 'invalid_sink_url' });
      return;
    }

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname || '/') + (url.search || ''),
        method: 'POST',
        timeout: FLUSH_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.on('data', () => {}); // drain, never inspect body content
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) finish({ ok: true });
          else finish({ ok: false, error: `http_${status}` });
        });
      });
    } catch {
      finish({ ok: false, error: 'request_setup_failed' });
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      finish({ ok: false, error: (err && err.code) || 'request_error' });
    });

    // Belt-and-suspenders: guarantee resolution even if 'timeout' never fires.
    const hardTimer = setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
      finish({ ok: false, error: 'timeout' });
    }, FLUSH_TIMEOUT_MS + 250);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();

    try {
      req.write(body);
      req.end();
    } catch {
      finish({ ok: false, error: 'request_write_failed' });
    }
  });
}

/**
 * flushNow() — drain up to FLUSH_BATCH_MAX buffered events to
 * readTelemetryConfig().sink_url. NEVER rejects, NEVER throws.
 *
 * - No sink configured: {flushed:0, remaining:bufferedCount(), reason:'no_sink'}
 * - Empty buffer: {flushed:0, remaining:0}
 * - Success (2xx): buffer is rewritten to keep only the remainder lines,
 *   flush-state records {last_flush_at, last_result:'ok'}, returns
 *   {flushed:N, remaining:M}.
 * - Any failure: buffer is left BYTE-UNTOUCHED, flush-state records
 *   {last_flush_at, last_result:'error', last_error:'<short code>'},
 *   returns {flushed:0, remaining:N, error:'<same short code>'}.
 */
async function flushNow() {
  try {
    const cfg = readTelemetryConfig();
    const sinkUrl = cfg.sink_url;
    if (!sinkUrl) {
      return { flushed: 0, remaining: bufferedCount(), reason: 'no_sink' };
    }

    const bPath = bufferPath();
    let lines;
    try {
      const raw = fs.readFileSync(bPath, 'utf8');
      lines = raw.split('\n').filter((l) => l.trim().length > 0);
    } catch {
      lines = [];
    }

    if (lines.length === 0) {
      return { flushed: 0, remaining: 0 };
    }

    const batchLines = lines.slice(0, FLUSH_BATCH_MAX);
    const remainderLines = lines.slice(FLUSH_BATCH_MAX);
    const events = batchLines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e !== null);
    const body = JSON.stringify({ schema_version: SCHEMA_VERSION, events });

    const result = await _postJson(sinkUrl, body);
    const nowIso = new Date().toISOString();

    if (result.ok) {
      try {
        fs.writeFileSync(bPath, remainderLines.length ? remainderLines.join('\n') + '\n' : '');
      } catch {
        // Fail-open: even if the rewrite fails, the POST succeeded — report
        // the drain as successful; the next emit() will re-establish the file.
      }
      _writeFlushState({ last_flush_at: nowIso, last_result: 'ok' });
      return { flushed: batchLines.length, remaining: remainderLines.length };
    }

    // Failure: buffer is left byte-untouched (no write to bPath at all).
    _writeFlushState({ last_flush_at: nowIso, last_result: 'error', last_error: result.error });
    return { flushed: 0, remaining: lines.length, error: result.error };
  } catch {
    return { flushed: 0, remaining: bufferedCount(), error: 'flush_internal_error' };
  }
}

/**
 * shouldFlush() — true when telemetry is enabled, a sink_url is configured,
 * the buffer is non-empty, and either no prior flush-state exists or
 * FLUSH_MIN_INTERVAL_MS has elapsed since last_flush_at. This throttles
 * retry storms against unreachable sinks (the flush-state write happens
 * even on failure, per flushNow() above).
 */
function shouldFlush() {
  try {
    if (!isEnabled()) return false;
    const cfg = readTelemetryConfig();
    if (!cfg.sink_url) return false;
    if (bufferedCount() === 0) return false;

    const state = _readFlushState();
    if (!state || !state.last_flush_at) return true;
    const lastMs = Date.parse(state.last_flush_at);
    if (Number.isNaN(lastMs)) return true;
    return (Date.now() - lastMs) > FLUSH_MIN_INTERVAL_MS;
  } catch {
    return false;
  }
}

/**
 * maybeScheduleFlush() — replaces the 62-01-01 stub. When shouldFlush() is
 * false, returns false synchronously (no child spawned). Otherwise spawns a
 * DETACHED, unref()'d child running this same file with `__flush` as its
 * sole argument, and returns true immediately — the parent process NEVER
 * waits on the child. This is the ONLY thing emit() triggers.
 */
function maybeScheduleFlush() {
  try {
    if (!shouldFlush()) return false;
    const child = spawn(process.execPath, [__filename, '__flush'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  EVENT_TYPES,
  dataDir,
  bufferPath,
  configPath,
  flushStatePath,
  readTelemetryConfig,
  writeTelemetryConfig,
  isEnabled,
  projectHash,
  buildEvent,
  emit,
  readLastEvent,
  sampleEvent,
  bufferedCount,
  bufferCap,
  flushNow,
  shouldFlush,
  maybeScheduleFlush,
};

// ─── __flush self-entry ─────────────────────────────────────────────────────
// Invoked only by the detached child spawned from maybeScheduleFlush() above
// (or manually via `node get-shit-done/bin/lib/telemetry.cjs __flush`).
// Always exits 0 — a flush failure is reported inside flushNow()'s return
// value via the flush-state file, never as a nonzero process exit here.
if (require.main === module && process.argv[2] === '__flush') {
  flushNow().then(() => process.exit(0), () => process.exit(0));
}
