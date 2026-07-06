#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { selectChain } = require('./lib/compress-filters/index.cjs');

// _parseCommand(argv) — everything after the first `--` is the wrapped command.
// Returns { cmd, args } or null when there is no command to run.
function _parseCommand(argv) {
  const sep = argv.indexOf('--');
  const rest = sep === -1 ? argv.slice() : argv.slice(sep + 1);
  if (rest.length === 0) return null;
  return { cmd: rest[0], args: rest.slice(1) };
}

// COMP-04: run the whole chain inside try/catch → raw stdout on ANY error.
// _chainOverride is a test seam (array of transforms); prod passes undefined.
function applyChain(commandName, rawOut, rawErr, code, _chainOverride) {
  try {
    const chain = _chainOverride || selectChain(commandName);
    let out = rawOut;
    for (const t of chain) {
      const next = t(out, rawErr, code);
      if (typeof next !== 'string') return rawOut;   // bad filter -> raw
      out = next;
    }
    return out;
  } catch {
    return rawOut;                                    // COMP-04: any throw -> raw
  }
}

// COMP-03: never-worse guard — return raw unless compressed is a strictly smaller string.
function neverWorse(compressed, rawOut) {
  if (typeof compressed !== 'string') return rawOut;
  return compressed.length >= rawOut.length ? rawOut : compressed;
}

// COMP-02: tee full raw output to a DETERMINISTIC, discoverable path BEFORE filtering.
// Same command -> same file (content hash). Returns the path or null (fail-open).
function teeRaw(cmd, args, rawOut, rawErr) {
  try {
    const dir = process.env.GSD_COMPRESS_RAW_DIR || path.join(os.tmpdir(), 'gsd-compress-raw');
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash('sha256').update([cmd, ...args].join(' ')).digest('hex').slice(0, 16);
    const p = path.join(dir, key + '.raw');
    fs.writeFileSync(p,
      '# command: ' + [cmd, ...args].join(' ') + '\n' +
      '# raw output teed on non-zero exit (pre-filter)\n' +
      '--- stdout ---\n' + rawOut + '\n--- stderr ---\n' + rawErr + '\n');
    return p;
  } catch { return null; }
}

function main() {
  const parsed = _parseCommand(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write('Usage: gsd-compress -- <command> [args...]\n');
    process.exit(1);
  }
  const { cmd, args } = parsed;
  // COMP-01: DIRECT spawn — argv array, NO shell, NO pipe. GSD_COMPRESS_ACTIVE marks
  // the child so the Phase 74 hook never re-fires on the wrapped command.
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GSD_COMPRESS_ACTIVE: '1' },
  });
  if (r.error) {                     // spawn failed (e.g. ENOENT) — mimic shell not-found
    process.stderr.write(String(r.error.message) + '\n');
    process.exit(r.status == null ? 127 : r.status);
  }
  const code = r.status == null ? 1 : r.status;   // signal-killed -> 1
  const rawOut = r.stdout || '';
  const rawErr = r.stderr || '';

  // COMP-02: tee BEFORE filtering, only on failure.
  let teePath = null;
  if (code !== 0) teePath = teeRaw(cmd, args, rawOut, rawErr);

  // COMP-04 then COMP-03.
  const filtered = applyChain(cmd, rawOut, rawErr, code);
  let out = neverWorse(filtered, rawOut);

  // Discovery line goes to STDOUT (not stderr) so COMP-05 keeps stderr byte-exact.
  if (teePath) out += '\n[gsd-compress] raw output teed to: ' + teePath + '\n';

  process.stdout.write(out);
  process.stderr.write(rawErr);      // COMP-05: child stderr VERBATIM, distinct stream
  process.exit(code);                // COMP-01: exact child exit code on every path
}

if (require.main === module) main();
module.exports = { _parseCommand, applyChain, neverWorse, teeRaw };
