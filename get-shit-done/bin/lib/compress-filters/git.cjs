'use strict';
// git filter (FILT-01) for the RTK-style output compressor (v3.5 "The Diet").
//
// The engine (compress-filters/index.cjs) passes each transform exactly
// (stdout, stderr, code) — NO argv, NO subcommand, NO flags. This filter
// therefore CANNOT know whether it wrapped `git status`, `git diff`, or
// `git log`; it DETECTS the structured format from the output CONTENT and,
// on any non-match or parse failure, returns `stdout` UNCHANGED (raw
// fallback). It NEVER throws and ALWAYS returns a string. The registry
// routes the `git` head here; the engine uses only `mod.transform`.

/**
 * Split git output into records: NUL-delimited when present (`-z` porcelain /
 * `find -print0`-style), else newline-delimited. Empty records are dropped.
 *
 * @param {string} stdout - raw git output.
 * @returns {string[]} non-empty records in original order.
 */
function splitRecords(stdout) {
  const parts = stdout.includes('\0') ? stdout.split('\0') : stdout.split('\n');
  return parts.filter((r) => r.length > 0);
}

/** First path segment (top-level dir) for grouping; '(root)' for bare names. */
function topSegment(p) {
  const i = p.indexOf('/');
  return i === -1 ? '(root)' : p.slice(0, i);
}

/** Render the top-K entries of a {key:count} map as "key (count)" joined. */
function topGroups(counts, k) {
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, k)
    .map((key) => `${key} (${counts[key]})`)
    .join(', ');
}

/**
 * Compress porcelain-v2 status records into a grouped count summary.
 * @param {string[]} recs - status records (each matching /^[12u?!] /).
 * @returns {string} multi-line summary + escape-hatch line.
 */
function compressStatus(recs) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let ignored = 0;
  const byDir = Object.create(null);
  for (const r of recs) {
    const kind = r[0];
    let p = '';
    if (kind === '1' || kind === '2') {
      const f = r.split(' ');
      const xy = f[1] || '';
      // Path is the field after the 8 fixed columns; a rename ('2') appends
      // "\t<orig>" — take the segment before any tab (per plan spec).
      p = f.slice(8).join(' ').split('\t')[0];
      if ('MADRC'.includes(xy[0])) staged++;
      if ('MD'.includes(xy[1])) unstaged++;
    } else if (kind === '?') {
      untracked++;
      p = r.split(' ')[1] || '';
    } else if (kind === '!') {
      ignored++;
      p = r.split(' ')[1] || '';
    }
    if (p) {
      const d = topSegment(p);
      byDir[d] = (byDir[d] || 0) + 1;
    }
  }
  const parts = [];
  if (staged) parts.push(`${staged} staged`);
  if (unstaged) parts.push(`${unstaged} unstaged`);
  if (untracked) parts.push(`${untracked} untracked`);
  if (ignored) parts.push(`${ignored} ignored`);
  const total = recs.length;
  const groups = topGroups(byDir, 5);
  return (
    `git status: ${total} changed (${parts.join(', ') || 'no state'}) — ${groups}\n` +
    `[gsd-compress] ${total} files — raw: git status --porcelain=v2`
  );
}

/**
 * Compress `--numstat` diff records into a churn summary.
 * @param {string[]} recs - numstat records (added\tdeleted\tpath; '-' = binary).
 * @returns {string} summary + escape-hatch line.
 */
function compressNumstat(recs) {
  let adds = 0;
  let dels = 0;
  let files = 0;
  const churn = Object.create(null);
  for (const r of recs) {
    const c = r.split('\t');
    if (c.length < 3) continue;
    const a = c[0] === '-' ? 0 : parseInt(c[0], 10) || 0;
    const d = c[1] === '-' ? 0 : parseInt(c[1], 10) || 0;
    const p = c.slice(2).join('\t');
    adds += a;
    dels += d;
    files++;
    const dir = topSegment(p);
    churn[dir] = (churn[dir] || 0) + a + d;
  }
  const top = topGroups(churn, 5);
  return (
    `git diff: ${files} files, +${adds}/-${dels} — top: ${top}\n` +
    `[gsd-compress] ${files} files — raw: git diff --numstat`
  );
}

/**
 * Compress `--oneline` log records into a count + first-N sample.
 * @param {string[]} recs - oneline records (each /^[0-9a-f]{7,40} /).
 * @returns {string} count header + up to 8 "hash7 subject" lines + escape hatch.
 */
function compressOneline(recs) {
  const n = recs.length;
  const head = recs.slice(0, 8).map((r) => {
    const sp = r.indexOf(' ');
    const hash = r.slice(0, sp);
    const subject = r.slice(sp + 1);
    return `${hash.slice(0, 7)} ${subject}`;
  });
  const lines = [`git log: ${n} commits`, ...head];
  if (n > 8) lines.push(`… ${n - 8} more`);
  lines.push(`[gsd-compress] ${n} commits — raw: git log --oneline`);
  return lines.join('\n');
}

/**
 * Compress plain human `git status` output (no --porcelain flag) into the same
 * grouped count summary shape as `compressStatus`. Detected from the section
 * headers "Changes to be committed:" / "Changes not staged for commit:" /
 * "Untracked files:"; entry lines are TAB-indented (hint lines are 2-space
 * indented and skipped). Preserves the exact changed-file count and per-state
 * counts, with a `raw: git status` escape hatch. Returns `stdout` unchanged if
 * nothing was classified or the summary is not smaller (local never-worse).
 *
 * @param {string} stdout - raw human `git status` output.
 * @returns {string} summary + escape-hatch line, or `stdout` (raw fallback).
 */
function compressHumanStatus(stdout) {
  const lines = stdout.split('\n');
  let section = null; // 'staged' | 'unstaged' | 'untracked'
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const byDir = Object.create(null);
  const addPath = (p) => {
    if (p) {
      const d = topSegment(p);
      byDir[d] = (byDir[d] || 0) + 1;
    }
  };
  for (const line of lines) {
    if (line.startsWith('Changes to be committed:')) { section = 'staged'; continue; }
    if (line.startsWith('Changes not staged for commit:')) { section = 'unstaged'; continue; }
    if (line.startsWith('Untracked files:')) { section = 'untracked'; continue; }
    if (line[0] !== '\t') continue; // skip branch/hint/blank lines
    const content = line.slice(1);
    if (section === 'untracked') {
      untracked++;
      addPath(content);
    } else if (section === 'staged' || section === 'unstaged') {
      const m = content.match(/^(new file|modified|deleted|renamed|copied|typechange):\s+(.+)$/);
      if (!m) continue;
      let p = m[2];
      const arrow = p.indexOf(' -> '); // renamed/copied: take the NEW path
      if (arrow !== -1) p = p.slice(arrow + 4);
      if (section === 'staged') staged++; else unstaged++;
      addPath(p);
    }
  }
  const total = staged + unstaged + untracked;
  if (total === 0) return stdout;
  const parts = [];
  if (staged) parts.push(`${staged} staged`);
  if (unstaged) parts.push(`${unstaged} unstaged`);
  if (untracked) parts.push(`${untracked} untracked`);
  const groups = topGroups(byDir, 5);
  const out =
    `git status: ${total} changed (${parts.join(', ')}) — ${groups}\n` +
    `[gsd-compress] ${total} files — raw: git status`;
  return out.length < stdout.length ? out : stdout;
}

/**
 * Compress plain human `git diff` output into a churn summary. Detected from
 * `diff --git ` header lines; counts files, hunks, additions/deletions (guarding
 * the `+++ `/`--- ` file headers) and attributes churn to each file's b-path
 * top-dir. Preserves the exact file count with a `raw: git diff` escape hatch.
 * Returns `stdout` unchanged if no file headers or the summary is not smaller.
 *
 * @param {string} stdout - raw human `git diff` output.
 * @returns {string} summary + escape-hatch line, or `stdout` (raw fallback).
 */
function compressHumanDiff(stdout) {
  const lines = stdout.split('\n');
  let files = 0;
  let hunks = 0;
  let adds = 0;
  let dels = 0;
  let curDir = null;
  const churn = Object.create(null);
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      files++;
      const m = line.match(/ b\/(.*)$/);
      curDir = m ? topSegment(m[1]) : '(root)';
      continue;
    }
    if (line.startsWith('@@ ')) { hunks++; continue; }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line[0] === '+') {
      adds++;
      if (curDir) churn[curDir] = (churn[curDir] || 0) + 1;
    } else if (line[0] === '-') {
      dels++;
      if (curDir) churn[curDir] = (churn[curDir] || 0) + 1;
    }
  }
  if (files === 0) return stdout;
  const top = topGroups(churn, 5);
  const out =
    `git diff: ${files} files, +${adds}/-${dels} across ${hunks} hunks — top: ${top}\n` +
    `[gsd-compress] ${files} files — raw: git diff`;
  return out.length < stdout.length ? out : stdout;
}

const RE_STATUS = /^[12u?!] /;
const RE_NUMSTAT = /^(-|\d+)\t(-|\d+)\t/;
const RE_ONELINE = /^[0-9a-f]{7,40} /;
const RE_DIFF_HEADER = /^diff --git /m;
const RE_STATUS_SECTION = /^(Changes to be committed:|Changes not staged for commit:|Untracked files:)/m;

/**
 * Detect the git structured format of `stdout` and compress it to a grouped
 * count summary, or return `stdout` unchanged on any non-match / parse error.
 *
 * Detection requires the winning format to match >= 3 records AND >= 50% of
 * non-header records; otherwise the input is passed through byte-identical
 * (plain `git status`, `git --version`, or unrelated output all raw-fall-back).
 *
 * @param {string} stdout - raw git command output.
 * @returns {string} compressed summary, or `stdout` unchanged (raw fallback).
 * @example
 * transform('abc1234 fix bug\n def5678 add test\n', '', 0);
 * // => 'git log: 2 commits\nabc1234 fix bug\n...'
 */
function transform(stdout /* , stderr, code */) {
  if (typeof stdout !== 'string') return '';
  try {
    // Human-format branches run FIRST, anchored on markers the structured
    // porcelain/numstat/oneline formats never emit (so no structured sample is
    // re-routed). Diff is tested first (most specific anchor). Each helper
    // returns `stdout` unchanged on a parse miss or a non-shrinking summary.
    if (RE_DIFF_HEADER.test(stdout)) {
      const out = compressHumanDiff(stdout);
      return typeof out === 'string' ? out : stdout;
    }
    if (RE_STATUS_SECTION.test(stdout)) {
      const out = compressHumanStatus(stdout);
      return typeof out === 'string' ? out : stdout;
    }
    // Drop porcelain header lines ("# branch.oid ...") before counting.
    const recs = splitRecords(stdout).filter((r) => !r.startsWith('# '));
    const nonHeader = recs.length;
    if (nonHeader < 3) return stdout;

    const status = recs.filter((r) => RE_STATUS.test(r));
    const numstat = recs.filter((r) => RE_NUMSTAT.test(r));
    const oneline = recs.filter((r) => RE_ONELINE.test(r));

    const candidates = [
      { recs: status, fn: compressStatus },
      { recs: numstat, fn: compressNumstat },
      { recs: oneline, fn: compressOneline },
    ].sort((a, b) => b.recs.length - a.recs.length);

    const win = candidates[0];
    if (win.recs.length >= 3 && win.recs.length >= nonHeader * 0.5) {
      const out = win.fn(win.recs);
      return typeof out === 'string' ? out : stdout;
    }
    return stdout;
  } catch {
    return stdout;
  }
}

module.exports = { id: 'git', match: () => true, transform };
