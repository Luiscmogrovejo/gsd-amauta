'use strict';
// FILT-02 — test-runner output compressor. Reduces node TAP-13, pytest, cargo
// (STABLE), and go test -json output to pass/fail counts while PRESERVING every
// failure/error line verbatim. Content-detected (the engine passes only
// (stdout, stderr, code) — no argv), so a non-test payload raw-falls-back
// untouched. NEVER throws; ALWAYS returns a string.
//
// cargo note: libtest per-test JSON is a nightly-only feature, so this filter
// scrapes the deterministic stable `test result:` summary line instead of ever
// requesting a machine-readable per-test stream.

// --- go test -json: NDJSON of {Action, Package, Test, ...} events ----------
function tryGo(lines) {
  const failures = [];
  let passCount = 0;
  let failCount = 0;
  let actionObjs = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || typeof obj !== 'object' || !('Action' in obj)) continue;
    actionObjs++;
    if (obj.Test) {
      if (obj.Action === 'pass') passCount++;
      else if (obj.Action === 'fail') {
        failCount++;
        failures.push('FAIL ' + (obj.Package || '') + ' ' + obj.Test);
      }
    }
  }
  if (actionObjs < 3) return null; // confidence floor — not a go-json stream
  const out = ['tests: ' + passCount + ' passed, ' + failCount + ' failed [go test -json]'];
  for (const f of failures) out.push(f);
  out.push('[gsd-compress] ' + actionObjs + ' events — raw: go test -json');
  return out.join('\n') + '\n';
}

// --- node TAP-13: ok/not ok N lines + 1..N plan ----------------------------
function tryTap(raw, lines) {
  if (!/^(ok|not ok) \d+/m.test(raw) && !/^1\.\.\d+/m.test(raw)) return null;
  let pass = 0;
  let fail = 0;
  let planCount = null;
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const plan = /^1\.\.(\d+)/.exec(line);
    if (plan) { planCount = Number(plan[1]); continue; }
    if (/^not ok \d+/.test(line)) {
      fail++;
      kept.push(line); // preserve the failing line verbatim
      // keep its immediately-following indented diagnostic block (# / ---...)
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) { kept.push(lines[j]); j++; }
      i = j - 1;
      continue;
    }
    if (/^ok \d+/.test(line)) { pass++; }
  }
  const total = planCount != null ? planCount : pass + fail;
  const out = ['tests: ' + pass + ' passed, ' + fail + ' failed [node TAP]'];
  for (const k of kept) out.push(k);
  out.push('[gsd-compress] ' + total + ' tests — raw: node --test');
  return out.join('\n') + '\n';
}

// --- pytest: `=== N passed, M failed, K error in Xs ===` summary + tb=line --
function tryPytest(lines) {
  let summaryLine = null;
  for (const line of lines) {
    if (/^={3,}.*\b\d+ (passed|failed|error|skipped)\b.*={3,}\s*$/.test(line)) {
      summaryLine = line;
      break;
    }
  }
  if (!summaryLine) return null;
  const counts = {};
  const re = /(\d+) (passed|failed|error|skipped)/g;
  let m;
  while ((m = re.exec(summaryLine)) !== null) counts[m[2]] = Number(m[1]);
  const seg = [];
  if ('passed' in counts) seg.push(counts.passed + ' passed');
  if ('failed' in counts) seg.push(counts.failed + ' failed');
  if ('error' in counts) seg.push(counts.error + ' error');
  if ('skipped' in counts) seg.push(counts.skipped + ' skipped');
  const out = ['tests: ' + seg.join(', ') + ' [pytest]'];
  // preserve each `path:line: Error` failure line verbatim (--tb=line shape)
  for (const line of lines) {
    if (line !== summaryLine && /^\S.*:\d+: /.test(line)) out.push(line);
  }
  out.push('[gsd-compress] raw: pytest -q --tb=line');
  return out.join('\n') + '\n';
}

// --- cargo (STABLE): `test result: ok/FAILED. N passed; M failed; K ignored` -
function tryCargo(lines) {
  let summary = null;
  for (const line of lines) {
    const m = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?/.exec(line);
    if (m) { summary = m; break; }
  }
  if (!summary) return null;
  const passed = summary[1];
  const failed = summary[2];
  const ignored = summary[3];
  const kept = [];
  for (const line of lines) {
    // keep failing-test lines + per-failure stdout headers verbatim
    if (/\.\.\. FAILED\s*$/.test(line) || /^---- .* ----\s*$/.test(line)) kept.push(line);
  }
  const out = ['tests: ' + passed + ' passed, ' + failed + ' failed' +
    (ignored != null ? ', ' + ignored + ' ignored' : '') + ' [cargo]'];
  for (const k of kept) out.push(k);
  out.push('[gsd-compress] raw: cargo test');
  return out.join('\n') + '\n';
}

/**
 * Compress test-runner output to counts + preserved failure lines.
 *
 * Detects the runner format from `stdout` content (the engine supplies no
 * argv), reduces recognized formats to a compact summary while keeping every
 * failure/error line verbatim, and returns `stdout` unchanged when no format
 * is confidently detected (raw fallback). Never throws; always returns a
 * string.
 *
 * @param {string} stdout - The captured stdout of the wrapped test command.
 * @param {string} [stderr] - Captured stderr (unused; contract parity).
 * @param {number} [code] - Command exit code (unused; contract parity).
 * @returns {string} Compressed summary, or the raw input on any non-match.
 * @example
 *   transform('TAP version 13\n1..1\nnot ok 1 - boom\n', '', 1);
 *   // -> 'tests: 0 passed, 1 failed [node TAP]\nnot ok 1 - boom\n...'
 */
function transform(stdout /* , stderr, code */) {
  const raw = typeof stdout === 'string' ? stdout : '';
  if (!raw) return raw;
  try {
    const lines = raw.split('\n');
    let out = tryGo(lines);
    if (out !== null) return out;
    out = tryTap(raw, lines);
    if (out !== null) return out;
    out = tryPytest(lines);
    if (out !== null) return out;
    out = tryCargo(lines);
    if (out !== null) return out;
    return raw; // unrecognized -> raw fallback
  } catch {
    return raw; // parse failure -> raw fallback, never throw
  }
}

module.exports = { id: 'test', match: () => true, transform };
