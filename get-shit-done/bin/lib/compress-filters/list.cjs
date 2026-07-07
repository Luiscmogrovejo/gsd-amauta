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
    return lines.join('\n') + '\n';
  } catch {
    return typeof stdout === 'string' ? stdout : '';
  }
}

module.exports = { id: 'list', match: () => true, transform };
