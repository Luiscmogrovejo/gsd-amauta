#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { selectChain } = require('./lib/compress-filters/index.cjs');
const { writeRawChannel, formatRawRef } = require('./lib/evidence-raw-channel.cjs');

// _parseCommand(argv) — everything after the first `--` is the wrapped command.
// Returns { cmd, args } or null when there is no command to run.
function _parseCommand(argv) {
  const sep = argv.indexOf('--');
  const rest = sep === -1 ? argv.slice() : argv.slice(sep + 1);
  if (rest.length === 0) return null;
  return { cmd: rest[0], args: rest.slice(1) };
}

// TOGL-04: --raw / --no-compress single-invocation bypass. Detected ONLY in the pre-`--`
// argv slice (the wrapper's own flags) so it never collides with a wrapped command's flags
// (e.g. `-- git log --raw`). Returns true when raw output must be emitted unfiltered.
function parseRawFlag(argv) {
  const sep = argv.indexOf('--');
  const preSep = sep === -1 ? argv : argv.slice(0, sep);
  return preSep.includes('--raw') || preSep.includes('--no-compress');
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

// DISC-03: when compression ACTUALLY shrank output (and not --raw), write the full raw to
// the deterministic side-channel and return the resolvable marker line; else return ''.
// Reuses the Phase-72 path scheme via the shared lib (one file per command). teePath, when
// the command also FAILED, is the SAME path — pass it so we reuse it instead of rewriting.
function rawRefLine(rawMode, filtered, rawOut, rawErr, cmd, args, teePath) {
  if (rawMode) return '';                 // TOGL-04 raw bypass -> no marker
  if (filtered === rawOut) return '';     // never-worse/identity -> output already raw
  const p = teePath || writeRawChannel(cmd, args, rawOut, rawErr);
  return p ? formatRawRef(p) : '';        // fail-open: no channel -> no marker
}

function main() {
  const argv = process.argv.slice(2);
  const rawMode = parseRawFlag(argv);          // TOGL-04: pre-`--` --raw/--no-compress bypass
  const parsed = _parseCommand(argv);
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

  // COMP-04 then COMP-03. TOGL-04: raw mode skips the chain + never-worse entirely (raw stdout).
  let out = rawMode ? rawOut : neverWorse(applyChain(cmd, rawOut, rawErr, code), rawOut);

  // DISC-03: when compression actually occurred (out !== rawOut, not --raw), write the raw
  // side-channel and append a resolvable marker so downstream evidence can recover the raw.
  const ref = rawRefLine(rawMode, out, rawOut, rawErr, cmd, args, teePath);
  if (ref) out += '\n' + ref + '\n';

  // Discovery line goes to STDOUT (not stderr) so COMP-05 keeps stderr byte-exact.
  if (teePath) out += '\n[gsd-compress] raw output teed to: ' + teePath + '\n';

  process.stdout.write(out);
  process.stderr.write(rawErr);      // COMP-05: child stderr VERBATIM, distinct stream
  process.exit(code);                // COMP-01: exact child exit code on every path
}

if (require.main === module) main();
module.exports = { _parseCommand, parseRawFlag, applyChain, neverWorse, teeRaw, rawRefLine };
