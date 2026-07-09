'use strict';
// FILT-04 — search filter (grep / rg). Compresses `rg --json` NDJSON and plain
// `grep` text into a per-file grouped, deduped summary. The engine passes only
// (stdout, stderr, code) — NO argv — so the format is DETECTED from content.
// On any non-match, empty, or parse failure the ORIGINAL stdout is returned
// unchanged (raw fallback). NEVER throws; ALWAYS returns a string.

const TOP_FILES = 10;      // most-matched files listed in the summary
const TOP_DEDUPES = 15;    // deduped repeat lines surfaced with (×N)

// rg --json NDJSON: each line JSON.parses to { type: 'begin'|'match'|'end'|'summary', … }.
// data.path.text is the file; data.lines.text is the matched line.
function compressRg(objs, stdout) {
  const fileCounts = new Map();
  let totalMatches = 0;
  for (const obj of objs) {
    if (!obj || obj.type !== 'match') continue;
    const p =
      obj.data && obj.data.path && typeof obj.data.path.text === 'string'
        ? obj.data.path.text
        : '(unknown)';
    fileCounts.set(p, (fileCounts.get(p) || 0) + 1);
    totalMatches++;
  }
  if (totalMatches === 0) return stdout; // begin/end only, no matches — nothing useful to compress
  const files = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = files.slice(0, TOP_FILES).map(([f, c]) => `${f} (${c})`);
  const more = files.length > TOP_FILES ? `\n… ${files.length - TOP_FILES} more files` : '';
  const out =
    `search: ${files.length} files, ${totalMatches} matches\n` +
    top.join('\n') +
    more +
    '\n' +
    `[gsd-compress] ${totalMatches} matches across ${files.length} files — raw: rg --json\n`;
  // never-worse guard local to the filter: only compress if it actually shrinks
  return out.length < stdout.length ? out : stdout;
}

// Single-file `grep -n` (`lineno:content`, no path): no per-file grouping is meaningful
// because there is exactly one implicit file. Report the match count as matches (NOT files)
// and keep the byte-identical dedup `(×N)` collapse + raw escape hatch.
function compressGrepSingleStream(lines, totalMatches, stdout) {
  const dedupeOrder = [];
  const dedupeCounts = new Map(); // fullLine -> n
  for (const line of lines) {
    if (!dedupeCounts.has(line)) dedupeOrder.push(line);
    dedupeCounts.set(line, (dedupeCounts.get(line) || 0) + 1);
  }
  const repeats = dedupeOrder
    .map((l) => [l, dedupeCounts.get(l)])
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_DEDUPES)
    .map(([l, n]) => `${l} (×${n})`);

  const parts = [`search: ${totalMatches} matches (single file/stream)`];
  if (repeats.length) parts.push(repeats.join('\n'));
  parts.push(`[gsd-compress] ${totalMatches} matches — raw: grep`);
  const out = parts.join('\n') + '\n';
  return out.length < stdout.length ? out : stdout;
}

// grep text: lines shaped `path:lineno:content` / `path:content` / `path:count`.
// Group by the pre-first-colon file; dedup byte-identical full lines with (×N).
function compressGrep(lines, stdout) {
  const totalMatches = lines.length;

  // Single-file `grep -n` emits `lineno:content` with NO path — the pre-first-colon
  // token is a bare LINE NUMBER, not a file. Grouping by it fabricates one "file" per
  // distinct line number (`31 files, 31 matches` for 31 lines in ONE file). Detect the
  // numeric-first-field case and collapse to a single stream instead of per-file groups.
  // Multi-file `path:line:content` (a real path is present) still runs the per-file path.
  let numericFirst = 0;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0 && /^\d+$/.test(line.slice(0, idx))) numericFirst++;
  }
  if (totalMatches > 0 && numericFirst >= totalMatches * 0.8) {
    return compressGrepSingleStream(lines, totalMatches, stdout);
  }

  const fileOrder = [];
  const fileMap = new Map(); // file -> { count, lineMap: Map(fullLine -> n) }
  const dedupeOrder = [];
  const dedupeCounts = new Map(); // fullLine -> n
  for (const line of lines) {
    const idx = line.indexOf(':');
    const file = idx === -1 ? line : line.slice(0, idx);
    if (!fileMap.has(file)) {
      fileMap.set(file, { count: 0 });
      fileOrder.push(file);
    }
    fileMap.get(file).count++;
    if (!dedupeCounts.has(line)) dedupeOrder.push(line);
    dedupeCounts.set(line, (dedupeCounts.get(line) || 0) + 1);
  }
  const sortedFiles = [...fileMap.entries()].sort((a, b) => b[1].count - a[1].count);
  const fileSummary = sortedFiles.slice(0, TOP_FILES).map(([f, r]) => `${f} (${r.count})`);
  const moreFiles = sortedFiles.length > TOP_FILES ? `\n… ${sortedFiles.length - TOP_FILES} more files` : '';

  // surface deduped repeats (count > 1) so identical noise collapses to `line (×N)`
  const repeats = dedupeOrder
    .map((l) => [l, dedupeCounts.get(l)])
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_DEDUPES)
    .map(([l, n]) => `${l} (×${n})`);

  const parts = [`search: ${fileMap.size} files, ${totalMatches} matches`, fileSummary.join('\n') + moreFiles];
  if (repeats.length) parts.push(repeats.join('\n'));
  parts.push(`[gsd-compress] ${totalMatches} matches across ${fileMap.size} files — raw: grep`);
  const out = parts.join('\n') + '\n';
  return out.length < stdout.length ? out : stdout;
}

function transform(stdout /* , stderr, code */) {
  try {
    if (typeof stdout !== 'string') return '';
    if (stdout === '') return stdout;
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return stdout;

    // --- rg --json detection: >= 3 lines parse as rg-json match/begin/end objects ---
    const rgObjs = [];
    let rgHits = 0;
    for (const line of lines) {
      if (line.charCodeAt(0) !== 0x7b /* { */) {
        rgObjs.push(null);
        continue;
      }
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = null;
      }
      if (
        obj &&
        typeof obj === 'object' &&
        (obj.type === 'match' || obj.type === 'begin' || obj.type === 'end' || obj.type === 'summary')
      ) {
        rgObjs.push(obj);
        if (obj.type === 'match' || obj.type === 'begin' || obj.type === 'end') rgHits++;
      } else {
        rgObjs.push(null);
      }
    }
    if (rgHits >= 3) return compressRg(rgObjs, stdout);

    // --- grep text detection: >= 50% of lines look like `path:lineno:` / `path:` ---
    const grepRe = /^[^:]+:\d*:?/;
    let grepHits = 0;
    for (const line of lines) if (grepRe.test(line)) grepHits++;
    if (grepHits >= lines.length * 0.5) return compressGrep(lines, stdout);

    return stdout; // unrecognized — raw fallback
  } catch {
    return stdout; // any unexpected failure — raw fallback
  }
}

module.exports = { id: 'search', match: () => true, transform };
