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

/**
 * Stub in this task (62-01-01) — always returns false. The real
 * fire-and-forget detached-spawn implementation lands in 62-01-02
 * (TK-1708), which replaces this function entirely.
 */
function maybeScheduleFlush() {
  return false;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  EVENT_TYPES,
  dataDir,
  bufferPath,
  configPath,
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
  maybeScheduleFlush,
};
