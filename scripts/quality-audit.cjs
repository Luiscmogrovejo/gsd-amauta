#!/usr/bin/env node
'use strict';
/**
 * scripts/quality-audit.cjs
 *
 * gsd-qa single entrypoint — runs all quality checks and emits a structured
 * JSON verdict. Used by gsd-qa agent during validation phase.
 *
 * Checks performed:
 *   1. Coverage ratchet    — node scripts/coverage-ratchet.cjs
 *   2. Test pyramid        — node scripts/test-pyramid.cjs
 *   3. Antipattern scan    — scans tests/ for quality antipatterns
 *
 * NOTE: Mutation testing (Stryker) is NOT included in this script.
 * Stryker is run separately by gsd-qa with `npx stryker run --incremental`
 * because it requires the list of changed files from git diff and is slow
 * (only runs on PR/commit, not every quality-audit invocation).
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: Coverage ratchet
// ─────────────────────────────────────────────────────────────────────────────
function runCoverageRatchet() {
  // If coverage-summary.json does not exist, treat as a soft pass with a warning.
  // The ratchet only enforces regression — it cannot fail without a baseline.
  // To generate coverage: npx c8 --reporter json-summary node scripts/run-tests.cjs
  const summaryPath = path.join(ROOT, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) {
    return {
      pass: true,
      exit_code: 0,
      output: 'SKIP: coverage-summary.json not found — run c8 first to enable ratchet enforcement',
    };
  }

  const r = spawnSync('node', [path.join(SCRIPTS_DIR, 'coverage-ratchet.cjs')], {
    encoding: 'utf-8',
    cwd: ROOT,
  });
  const pass = r.status === 0;
  const output = (r.stdout || '') + (r.stderr || '');
  return {
    pass,
    exit_code: r.status,
    output: output.trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: Test pyramid
// ─────────────────────────────────────────────────────────────────────────────
function runTestPyramid() {
  const r = spawnSync('node', [path.join(SCRIPTS_DIR, 'test-pyramid.cjs')], {
    encoding: 'utf-8',
    cwd: ROOT,
  });
  const pass = r.status === 0;

  let data = null;
  try {
    data = JSON.parse((r.stdout || '').trim());
  } catch (_) {
    data = { parse_error: true, raw: r.stdout };
  }

  return {
    pass,
    exit_code: r.status,
    data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: Antipattern scanner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan test files for quality antipatterns.
 *
 * No-assertion heuristic is scoped ONLY to *.unit.test.cjs and
 * *.integration.test.cjs files. E2E tests (*.e2e.test.cjs) use
 * conditional-skip patterns that legitimately have empty it() bodies
 * when the E2E environment is not set up — do NOT scan them for
 * missing assertions (see tests/board.e2e.test.cjs as a canonical example).
 *
 * Flaky-marker and snapshot-overuse checks apply to ALL *.test.cjs files.
 */
function runAntipatternScan() {
  const findings = [];

  let allEntries;
  try {
    allEntries = fs.readdirSync(TESTS_DIR);
  } catch (err) {
    return {
      pass: false,
      findings: [{ file: TESTS_DIR, issue: `Cannot read tests directory: ${err.message}` }],
    };
  }

  // Collect all .test.cjs files (top-level only — matches current test layout)
  const allTestFiles = allEntries
    .filter(f => /\.test\.cjs$/.test(f))
    .map(f => path.join(TESTS_DIR, f));

  // No-assertion heuristic: scoped to unit and integration tests only
  // (NOT *.e2e.test.cjs — E2E tests may have empty it() bodies by design)
  const filesToAuditForAssertions = allTestFiles.filter(f =>
    f.endsWith('.unit.test.cjs') || f.endsWith('.integration.test.cjs')
  );

  for (const filePath of filesToAuditForAssertions) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      continue;
    }
    const relPath = path.relative(ROOT, filePath);
    const hasItCalls = /\bit\s*\(/.test(content);
    const hasAssertions = /\bassert[.(\s]/.test(content) || /\bexpect\s*\(/.test(content);
    if (hasItCalls && !hasAssertions) {
      findings.push({ file: relPath, issue: 'no-assertion: has it() calls but zero assert/expect calls' });
    }
  }

  // Flaky-marker check: applies to ALL *.test.cjs files (including e2e)
  // Only scans non-comment lines to avoid false positives from documentation strings
  // (e.g., "Do NOT use .skip() / xit()" in a comment block is not a flaky marker).
  // Note: ctx.skip() and t.skip() are valid programmatic skips in Node test runner
  // (used for environment guards). Only flag describe.skip / it.skip / test.skip
  // which indicate intentionally disabled tests (flaky markers).
  const FLAKY_PATTERNS = [
    { re: /\b(?:describe|it|test)\.skip\s*\(/, label: 'flaky-marker: describe/it/test.skip(' },
    { re: /\bxit\s*\(/, label: 'flaky-marker: xit(' },
    { re: /\bxdescribe\s*\(/, label: 'flaky-marker: xdescribe(' },
    { re: /\/\/\s*TODO:\s*fix\s*flaky/i, label: 'flaky-marker: // TODO: fix flaky comment' },
    { re: /@flaky/, label: 'flaky-marker: @flaky annotation' },
  ];

  for (const filePath of allTestFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      continue;
    }
    const relPath = path.relative(ROOT, filePath);

    // Filter out comment lines before checking for flaky markers.
    // This prevents documentation strings like "Do NOT use .skip() / xit()" from
    // triggering false positives (see tests/board.e2e.test.cjs for the pattern).
    const nonCommentLines = content
      .split('\n')
      .filter(line => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .join('\n');

    for (const { re, label } of FLAKY_PATTERNS) {
      if (re.test(nonCommentLines)) {
        findings.push({ file: relPath, issue: label });
      }
    }
  }

  // Snapshot overuse: flag any test file with > 5 .toMatchSnapshot() calls
  for (const filePath of allTestFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      continue;
    }
    const relPath = path.relative(ROOT, filePath);
    const snapCount = (content.match(/\.toMatchSnapshot\s*\(/g) || []).length;
    if (snapCount > 5) {
      findings.push({ file: relPath, issue: `snapshot-overuse: ${snapCount} .toMatchSnapshot() calls (max 5)` });
    }
  }

  return {
    pass: findings.length === 0,
    findings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const result = {
    pass: true,
    checks: {},
    gaps: [],
    timestamp: new Date().toISOString(),
  };

  // Check 1: Coverage ratchet
  const coverageRatchet = runCoverageRatchet();
  result.checks.coverage_ratchet = coverageRatchet;
  if (!coverageRatchet.pass) {
    result.pass = false;
    result.gaps.push('coverage_ratchet failed — run c8 to generate coverage-summary.json first');
  }

  // Check 2: Test pyramid
  const testPyramid = runTestPyramid();
  result.checks.test_pyramid = testPyramid;
  if (!testPyramid.pass) {
    result.pass = false;
    const e2ePct = testPyramid.data && testPyramid.data.e2ePct ? testPyramid.data.e2ePct : 'unknown';
    result.gaps.push(`test_pyramid failed — E2E ratio ${e2ePct} exceeds 25% ceiling`);
  }

  // Check 3: Antipattern scan
  const antipatterns = runAntipatternScan();
  result.checks.antipatterns = antipatterns;
  if (!antipatterns.pass) {
    result.pass = false;
    for (const f of antipatterns.findings) {
      result.gaps.push(`antipattern in ${f.file}: ${f.issue}`);
    }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

main();
