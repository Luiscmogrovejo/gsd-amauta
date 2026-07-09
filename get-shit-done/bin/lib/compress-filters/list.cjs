'use strict';
// FILT-03 — `list` filter for ls/find output. ls/find have NO structured
// output mode, so this is a heuristic bucketer: treat every non-empty line
// of stdout as a filesystem entry, group by directory, tally extensions, and
// emit a compact summary. Contract (see _passthrough.cjs / index.cjs):
// transform(stdout, stderr, code) -> STRING, never throws, raw-fallback.
const path = require('path');

// Entries below this count are too small to benefit — return raw (no-op).
const MIN_ENTRIES = 10;
// How many top directories / sample names to surface in the summary.
const TOP_DIRS = 8;
const SAMPLE_NAMES = 5;

// Anchor for an `ls -l`/`ls -la` long-format row: type char + 9 permission
// bits + optional ACL/xattr flag (@ + .) then link count. Structured formats
// (plain one-per-line / NUL paths) never emit this, so detection is disjoint.
const MODE_ROW = /^[-dlbcps][-rwxSsTt]{9}[@+.]?\s+\d+\s/;
// Splits a long-format row into its 8 fixed columns + trailing filename:
// mode, links, owner, group, size, month, day, time-or-year, then name (g2).
const LONG_ROW = /^(\S+)\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.*)$/;

/**
 * Compress `ls -l`/`ls -la` long-format output into a correct file/dir summary.
 *
 * Fires only when the stream is long format (a `total N` header or a majority
 * of mode-bit rows). Parses the FILENAME column (not the mode string), splits
 * entries by leading type char (d=dir, l=symlink, else file), and tallies
 * extensions over files only. Skips the `total N` header and the `.`/`..`
 * self/parent entries. Never throws; returns null on a non-long-format stream
 * so the caller falls through to the plain/NUL path unchanged.
 *
 * @param {string} stdout - Raw command stdout.
 * @returns {string|null} A compact summary (or raw if not smaller / too few
 *   rows), or null when the stream is not long format.
 */
function compressLong(stdout) {
  const rawLines = stdout.split('\n');
  const nonEmpty = rawLines.map((s) => s.replace(/\s+$/, '')).filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return null;

  // Detect long format: a `total N` header OR >=50% mode-bit rows.
  const modeRowCount = nonEmpty.filter((s) => MODE_ROW.test(s)).length;
  const isLong = /^total \d+/.test(nonEmpty[0]) || modeRowCount >= nonEmpty.length * 0.5;
  if (!isLong) return null;

  let files = 0;
  let dirs = 0;
  let links = 0;
  const extCounts = new Map();
  const names = [];

  for (const line of nonEmpty) {
    if (/^total \d+/.test(line)) continue; // header, not an entry
    const m = line.match(LONG_ROW);
    if (!m) continue; // non-row noise — skip
    const type = m[1][0];
    let name = m[2];
    // Symlinks render as `name -> target`; count the link name only.
    if (type === 'l') {
      const arrow = name.indexOf(' -> ');
      if (arrow !== -1) name = name.slice(0, arrow);
    }
    if (name === '.' || name === '..') continue; // self/parent — not real entries

    if (type === 'd') {
      dirs += 1;
    } else if (type === 'l') {
      links += 1;
    } else {
      files += 1;
      const base = path.posix.basename(name);
      const dot = base.lastIndexOf('.');
      const ext = dot > 0 ? base.slice(dot + 1) : '(none)';
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }
    names.push(name);
  }

  // Too few real rows to benefit — raw fallback / no-op.
  if (names.length < MIN_ENTRIES) return stdout;

  const total = files + dirs + links;
  const exts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topExts = exts
    .slice(0, TOP_DIRS)
    .map(([e, n]) => `${e} (${n})`)
    .join(', ');

  const samples = names.slice(0, SAMPLE_NAMES).join(', ');
  const moreSamples = names.length > SAMPLE_NAMES ? ` … ${names.length - SAMPLE_NAMES} more` : '';

  const header = `${total} entries: ${files} files, ${dirs} dirs${links > 0 ? `, ${links} links` : ''}`;
  const out = [
    header,
    `types: ${topExts}`,
    `sample: ${samples}${moreSamples}`,
    `[gsd-compress] ${total} entries — raw: ls -la`,
  ].join('\n') + '\n';

  // Local never-worse guard — degrade to raw if the parse didn't shrink.
  return out.length < stdout.length ? out : stdout;
}

/**
 * Compress ls/find listing output into a directory-grouped summary.
 *
 * @param {string} stdout - Raw command stdout (lines = filesystem entries).
 * @param {string} [stderr] - Unused; part of the filter contract signature.
 * @param {number} [code] - Unused; part of the filter contract signature.
 * @returns {string} A compact grouped summary, or the raw stdout on small /
 *   unparseable input. Never throws.
 * @example
 *   transform('src/a.js\nsrc/b.js\n...', '', 0); // -> "N entries across D dirs..."
 */
function transform(stdout /* , stderr, code */) {
  try {
    if (typeof stdout !== 'string' || stdout.length === 0) {
      return typeof stdout === 'string' ? stdout : '';
    }
    // `ls -l`/`ls -la` long format is handled first (disjoint anchor: `total N`
    // header / mode-bit rows). Returns null when NOT long format so the plain /
    // NUL entry path below runs UNCHANGED.
    const long = compressLong(stdout);
    if (long !== null) return long;

    // find -print0 uses NUL separators; plain ls/find use newlines.
    const sep = stdout.indexOf('\0') !== -1 ? '\0' : '\n';
    const entries = stdout
      .split(sep)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Too few to benefit — raw fallback / no-op.
    if (entries.length < MIN_ENTRIES) return stdout;

    const dirCounts = new Map();
    const extCounts = new Map();
    for (const entry of entries) {
      const dir = path.posix.dirname(entry);
      const key = dir === '' || dir === '.' ? '.' : dir;
      dirCounts.set(key, (dirCounts.get(key) || 0) + 1);

      const base = path.posix.basename(entry);
      const dot = base.lastIndexOf('.');
      const ext = dot > 0 ? base.slice(dot + 1) : '(none)';
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }

    const dirs = Array.from(dirCounts.entries()).sort((a, b) => b[1] - a[1]);
    const exts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]);

    const topDirs = dirs
      .slice(0, TOP_DIRS)
      .map(([d, n]) => `${d}/ (${n})`)
      .join(', ');
    const moreDirs = dirs.length > TOP_DIRS ? ` … ${dirs.length - TOP_DIRS} more dirs` : '';

    const topExts = exts
      .slice(0, TOP_DIRS)
      .map(([e, n]) => `${e} (${n})`)
      .join(', ');

    const samples = entries.slice(0, SAMPLE_NAMES).join(', ');
    const moreSamples = entries.length > SAMPLE_NAMES
      ? ` … ${entries.length - SAMPLE_NAMES} more`
      : '';

    const lines = [
      `${entries.length} entries across ${dirs.length} dirs`,
      `dirs: ${topDirs}${moreDirs}`,
      `types: ${topExts}`,
      `sample: ${samples}${moreSamples}`,
      `[gsd-compress] ${entries.length} entries — raw: ls -1`,
    ];
    const out = lines.join('\n') + '\n';
    // Local never-worse guard — a small plain listing must degrade to raw
    // rather than grow (fixes the prior 199->203 bloat).
    return out.length < stdout.length ? out : stdout;
  } catch {
    return typeof stdout === 'string' ? stdout : '';
  }
}

module.exports = { id: 'list', match: () => true, transform };
