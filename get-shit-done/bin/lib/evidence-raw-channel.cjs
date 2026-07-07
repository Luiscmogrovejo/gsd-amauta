'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Marker format — SINGLE SOURCE. The wrapper appends formatRawRef(path); the CLI resolver
// finds it with RAW_REF_RE. Distinct from the Phase-72 failure-tee discovery line.
const RAW_REF_PREFIX = 'gsd-compress:raw-ref';
const RAW_REF_RE = /\[gsd-compress:raw-ref ([^\]\n]+)\]/g;
function formatRawRef(filePath) { return '[' + RAW_REF_PREFIX + ' ' + filePath + ']'; }

// channelDir()/channelPath() — REPLICATE gsd-compress.cjs teeRaw EXACTLY so the failure-tee
// and the evidence-channel land on ONE file per command.
function channelDir(dir) {
  return dir || process.env.GSD_COMPRESS_RAW_DIR || path.join(os.tmpdir(), 'gsd-compress-raw');
}
function channelPath(cmd, args, dir) {
  const key = crypto.createHash('sha256')
    .update([cmd, ...(args || [])].join(' ')).digest('hex').slice(0, 16);
  return path.join(channelDir(dir), key + '.raw');
}

// writeRawChannel(cmd, args, rawOut, rawErr, dir?) — write full raw output to the
// deterministic side-channel, mode 0600 (Pitfall 7). Same '--- stdout ---'/'--- stderr ---'
// delimiters as teeRaw so resolveRawFromText extracts uniformly. Fail-open: returns the path,
// or null on any error (caller then emits no marker).
function writeRawChannel(cmd, args, rawOut, rawErr, dir) {
  try {
    const d = channelDir(dir);
    fs.mkdirSync(d, { recursive: true });
    const p = channelPath(cmd, args, dir);
    fs.writeFileSync(p,
      '# command: ' + [cmd, ...(args || [])].join(' ') + '\n' +
      '# raw evidence side-channel (gsd-compress:raw-ref) — pre-filter\n' +
      '--- stdout ---\n' + (rawOut || '') + '\n--- stderr ---\n' + (rawErr || '') + '\n',
      { mode: 0o600 });
    return p;
  } catch { return null; }
}

// _extractStdout(fileText) — the stdout section between the delimiters, else the whole text.
function _extractStdout(fileText) {
  const s = fileText.indexOf('--- stdout ---\n');
  if (s === -1) return fileText;
  const from = s + '--- stdout ---\n'.length;
  const e = fileText.indexOf('\n--- stderr ---', from);
  return e === -1 ? fileText.slice(from) : fileText.slice(from, e);
}

// resolveRawFromText(text, opts) — DISC-01/02/03. For every [gsd-compress:raw-ref <path>]
// marker: if the file exists, read it, scrub it IN PLACE via opts.scrubFn (DISC-02 — scrub
// the side-channel; reuses the caller's scrubEvidence, no new patterns), extract the raw
// stdout, and REPLACE the marker with an appended, scrubbed raw-evidence block so downstream
// readers see raw (DISC-01/03). Missing/broken file -> replace with an UNRESOLVED note (a gate
// must never silently judge lossy output). Never throws. scrubFn defaults to identity so the
// lib is testable standalone. Returns { text, resolved, unresolved }.
function resolveRawFromText(text, opts) {
  if (typeof text !== 'string' || text.indexOf('[' + RAW_REF_PREFIX + ' ') === -1) {
    return { text, resolved: 0, unresolved: 0 };
  }
  const scrubFn = (opts && typeof opts.scrubFn === 'function') ? opts.scrubFn : ((s) => s);
  let resolved = 0, unresolved = 0;
  RAW_REF_RE.lastIndex = 0;
  const out = text.replace(RAW_REF_RE, (_m, filePath) => {
    try {
      if (!fs.existsSync(filePath)) { unresolved++; return '[gsd-compress:raw-ref UNRESOLVED ' + filePath + ']'; }
      const scrubbedFile = scrubFn(fs.readFileSync(filePath, 'utf8'));
      try { fs.writeFileSync(filePath, scrubbedFile, { mode: 0o600 }); } catch { /* best-effort in-place scrub */ }
      resolved++;
      return '\n--- raw evidence (resolved from gsd-compress:raw-ref) ---\n' + _extractStdout(scrubbedFile) + '\n';
    } catch { unresolved++; return '[gsd-compress:raw-ref UNRESOLVED ' + filePath + ']'; }
  });
  return { text: out, resolved, unresolved };
}

module.exports = {
  RAW_REF_PREFIX, RAW_REF_RE, formatRawRef,
  channelDir, channelPath, writeRawChannel, resolveRawFromText,
};
