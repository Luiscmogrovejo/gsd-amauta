'use strict';
// docker filter (FILT-05). Compresses `docker ps --format json` NDJSON into a
// compact one-line-per-container table, dropping the token-hog fields
// (Labels/Mounts/Networks/...) while KEEPING Names/Image/State/Status.
//
// Engine contract (index.cjs): the engine calls only `transform(stdout, stderr,
// code)` and ignores `id`/`match`; routing is by registry heads. The filter is
// handed already-produced command output as `stdout` with NO argv/subcommand,
// so it DETECTS the container-`ps` NDJSON format from the content itself and, on
// any non-match or parse failure, returns `stdout` UNCHANGED (raw fallback).
//
// Read-only-safe by construction: this filter only rewrites container-`ps`
// NDJSON and passes everything else (including `docker rm` id text, `docker
// build` progress) through raw. The engine also runs each wrapped command
// exactly once (no re-run). The program+verb destructive DENYLIST that blocks a
// `docker rm` from ever being rewritten/re-run is Phase 74's RWRT-04 job; this
// phase wires no auto-rewrite.
//
// NEVER throws; ALWAYS returns a string.

// Fields kept on the compact line. Everything else (Labels, Mounts, Networks,
// LocalVolumes, CreatedAt, RunningFor, Command, ID) is dropped — the
// per-container Labels string alone is the bulk of the bytes.
function isContainerRecord(o) {
  return o != null &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    o.Names != null &&
    (o.Image != null || o.State != null || o.Status != null);
}

function transform(stdout /* , stderr, code */) {
  if (typeof stdout !== 'string') return '';
  try {
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return stdout; // nothing to compress -> raw

    // Every non-empty line must JSON.parse to a plain object; a single
    // non-JSON (or non-object) line means this is not `docker ps --format
    // json` output, so raw-fall-back untouched.
    const records = [];
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return stdout; // non-JSON line -> raw fallback
      }
      if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        return stdout; // non-object JSON line -> raw fallback
      }
      records.push(obj);
    }

    // Require at least one genuine container record.
    const containers = records.filter(isContainerRecord);
    if (containers.length < 1) return stdout;

    const out = [];
    out.push('docker ps: ' + containers.length +
      ' container' + (containers.length === 1 ? '' : 's'));
    for (const c of containers) {
      const name = String(c.Names);
      const image = c.Image != null ? String(c.Image) : '';
      const state = c.State != null ? String(c.State) : '';
      const status = c.Status != null ? String(c.Status) : '';
      const stateStatus = (state && status)
        ? state + '(' + status + ')'
        : (state || status);
      // Keep Ports only when short; drop otherwise.
      let ports = '';
      if (c.Ports != null) {
        const p = String(c.Ports);
        if (p.length > 0 && p.length <= 40) ports = '  ' + p;
      }
      let row = name;
      if (image) row += '  ' + image;
      if (stateStatus) row += '  ' + stateStatus;
      row += ports;
      out.push(row);
    }
    out.push('[gsd-compress] ' + containers.length +
      ' containers — raw: docker ps --format json');
    return out.join('\n') + '\n';
  } catch {
    return stdout; // any unexpected failure -> raw fallback
  }
}

module.exports = { id: 'docker', match: () => true, transform };
