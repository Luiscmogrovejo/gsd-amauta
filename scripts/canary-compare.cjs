#!/usr/bin/env node
/**
 * scripts/canary-compare.cjs — McNemar's chi-squared degradation detector
 *
 * Compares two binary pass/fail vectors (baseline vs current) using McNemar's
 * statistical test to detect statistically significant regression in the canary suite.
 *
 * Algorithm:
 *   - b = pass→fail count (degradation events)
 *   - c = fail→pass count (improvement events)
 *   - McNemar's chi-squared with continuity correction = (|b - c| - 1)^2 / (b + c)
 *   - p-value via normal approximation: p = 1 - Phi(sqrt(chi2)) = erfc(sqrt(chi2/2)) / 2
 *   - delta = (b - c) / total_tests (net degradation rate, positive = degraded)
 *   - degraded = (p < 0.05) AND (delta > 0.01)
 *
 * Usage:
 *   node scripts/canary-compare.cjs [--current-file <path>]
 *   node scripts/canary-compare.cjs --generate
 *   node scripts/canary-compare.cjs --help
 *
 * Exit codes:
 *   0 — no degradation detected (or --generate / --help)
 *   1 — degradation detected (p < 0.05 AND delta > 0.01)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASELINE_PATH = path.resolve(__dirname, '..', 'tests', 'fixtures', '39-canary-baseline.json');
const CANARY_SUITE = path.resolve(__dirname, '..', 'tests', '39-canary-suite.test.cjs');

// ─── Normal CDF approximation via erfc ────────────────────────────────────────
// erfc(x) ≈ using Horner's method (Abramowitz & Stegun 7.1.26)
// Accurate to ~1.5e-7 for all real x.

/**
 * Complementary error function via Horner's method.
 * @param {number} x
 * @returns {number} erfc(x) ∈ [0, 2]
 */
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly =
    t * (0.254829592 +
      t * (-0.284496736 +
        t * (1.421413741 +
          t * (-1.453152027 +
            t * 1.061405429))));
  const result = poly * Math.exp(-x * x);
  return x >= 0 ? result : 2 - result;
}

/**
 * Standard normal CDF: Phi(z) = 1 - erfc(z / sqrt(2)) / 2
 * @param {number} z
 * @returns {number}
 */
function normalCDF(z) {
  return 1 - erfc(z / Math.sqrt(2)) / 2;
}

/**
 * McNemar's test p-value for chi-squared with 1 degree of freedom.
 * Uses the normal approximation: chi2 = Z^2, so p = 1 - Phi(sqrt(chi2)).
 * @param {number} chiSquared — McNemar's chi-squared statistic (with continuity correction)
 * @returns {number} two-sided p-value ∈ [0, 1]
 */
function mcnemarPValue(chiSquared) {
  if (chiSquared <= 0) return 1.0;
  // p = P(chi2_1 > chiSquared) = P(|Z| > sqrt(chiSquared)) = 2 * (1 - Phi(sqrt(chiSquared)))
  // but for one-sided degradation we use p = 1 - Phi(sqrt(chiSquared))
  return 1 - normalCDF(Math.sqrt(chiSquared));
}

// ─── Core McNemar computation ─────────────────────────────────────────────────

/**
 * Build 2×2 contingency table and compute McNemar's chi-squared test.
 *
 * @param {Record<string, boolean>} baseline — baseline pass/fail vector
 * @param {Record<string, boolean>} current  — current pass/fail vector
 * @returns {{
 *   degraded: boolean,
 *   p_value: number,
 *   delta: number,
 *   changed_tests: string[],
 *   b: number,
 *   c: number,
 *   total: number,
 *   chiSquared: number
 * }}
 */
function mcnemar(baseline, current) {
  const baselineKeys = Object.keys(baseline);
  const total = baselineKeys.length;

  let b = 0; // pass → fail (degradation)
  let c = 0; // fail → pass (improvement)
  const changed_tests = [];

  for (const key of baselineKeys) {
    const wasPass = baseline[key] === true;
    const isPass = current[key] !== undefined ? current[key] === true : false;

    if (wasPass && !isPass) {
      b++;
      changed_tests.push(`DEGRADED: ${key}`);
    } else if (!wasPass && isPass) {
      c++;
      changed_tests.push(`IMPROVED: ${key}`);
    }
  }

  // McNemar's chi-squared with continuity correction
  // Formula: (|b - c| - 1)^2 / (b + c) when b + c > 0
  let chiSquared = 0;
  let p_value = 1.0;

  if (b + c > 0) {
    const numerator = Math.pow(Math.abs(b - c) - 1, 2);
    // continuity correction: subtract 1 from |b - c| before squaring
    chiSquared = numerator / (b + c);
    p_value = mcnemarPValue(chiSquared);
  }

  const delta = (b - c) / total;
  const degraded = p_value < 0.05 && delta > 0.01;

  return { degraded, p_value, delta, changed_tests, b, c, total, chiSquared };
}

// ─── --generate mode: run canary suite and extract per-test results ───────────

/**
 * Parse node:test output to extract per-test pass/fail state.
 *
 * node --test outputs in two formats:
 *   1. Text/spec format (default): lines with ✔/✗ markers and indentation
 *      "  ✔ test name (1.2ms)"      — individual test pass (indented)
 *      "  ✗ test name (1.2ms)"      — individual test fail (indented)
 *      "✔ suite name (5ms)"         — suite summary (no indent, not a test)
 *   2. TAP format (--test-reporter=tap):
 *      "ok 1 - description"
 *      "not ok 1 - description"
 *
 * We parse both formats. Individual tests are indented (leading whitespace before ✔/✗).
 * Suite summary lines (no leading whitespace) are skipped.
 *
 * @param {string} output — raw stdout from node --test
 * @returns {Record<string, boolean>} test name → pass/fail
 */
function parseNodeTestOutput(output) {
  const results = {};
  const lines = output.split('\n');

  for (const line of lines) {
    // Format 1: text/spec — indented ✔ or ✗ lines are individual tests
    // Match: "  ✔ test name (1.2ms)" or "    ✗ test name" (any indentation depth >= 1 space)
    const specMatch = line.match(/^(\s+)[✔✗x×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s?\))?\s*$/u);
    if (specMatch) {
      const indent = specMatch[1];
      const testName = specMatch[2].trim();
      // Only capture indented lines (describe-level test, not top-level suite summary)
      if (indent.length >= 2 && testName) {
        const passed = /[✔]/.test(line);
        results[testName] = passed;
        continue;
      }
    }

    // Format 2: TAP — "ok N - name" or "not ok N - name"
    const tapMatch = line.match(/^\s*(?:not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s*#.*)?$/);
    if (tapMatch) {
      const testName = tapMatch[1].trim();
      const passed = !line.trim().startsWith('not ok');
      if (testName) {
        results[testName] = passed;
      }
    }
  }

  return results;
}

/**
 * Run the canary suite and generate a baseline vector.
 * @returns {Record<string, boolean>}
 */
function generateBaseline() {
  console.error('[canary-compare] Running canary suite to generate baseline...');

  const result = spawnSync(
    process.execPath,
    ['--test', CANARY_SUITE],
    {
      encoding: 'utf-8',
      // Delete NODE_TEST_CONTEXT to avoid recursive node:test detection
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')
      ),
    }
  );

  const rawOutput = (result.stdout || '') + (result.stderr || '');
  const results = parseNodeTestOutput(rawOutput);

  if (Object.keys(results).length === 0) {
    console.error('[canary-compare] Warning: could not parse any test results from output');
    console.error('[canary-compare] Raw output snippet:', rawOutput.slice(0, 500));
  }

  return results;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
canary-compare.cjs — McNemar's chi-squared degradation detector for the canary suite

Usage:
  node scripts/canary-compare.cjs                          Compare baseline vs canary suite (runs suite)
  node scripts/canary-compare.cjs --generate               Run suite and write 39-canary-baseline.json
  node scripts/canary-compare.cjs --current-file <path>    Compare baseline vs provided JSON vector
  node scripts/canary-compare.cjs --help                   Show this help

Output JSON schema:
  {
    degraded: boolean,       // true if p < 0.05 AND delta > 0.01
    p_value: number,         // McNemar's p-value (continuity-corrected chi-squared, 1 df)
    delta: number,           // (b - c) / total  (positive = net degradation)
    changed_tests: string[], // list of changed test names with DEGRADED:/IMPROVED: prefix
    b: number,               // pass→fail count
    c: number,               // fail→pass count
    total: number            // total test count
  }

Exit codes:
  0 — no degradation (or --generate / --help)
  1 — degradation detected (p < 0.05 AND delta > 0.01)

McNemar's test (with continuity correction):
  chi-squared = (|b - c| - 1)^2 / (b + c)
  p-value = 1 - Phi(sqrt(chi-squared))   [normal approximation, 1 df]
  where b = pass→fail count, c = fail→pass count
`);
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  }

  // --generate mode: run suite → write baseline JSON → exit 0
  if (args.includes('--generate')) {
    const results = generateBaseline();
    const count = Object.keys(results).length;

    if (count === 0) {
      console.error('[canary-compare] Error: --generate produced 0 test results. Cannot write baseline.');
      process.exit(1);
    }

    fs.writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2) + '\n');
    console.error(`[canary-compare] Baseline written to ${BASELINE_PATH} (${count} tests)`);
    const failCount = Object.values(results).filter(v => !v).length;
    if (failCount > 0) {
      console.error(`[canary-compare] Warning: ${failCount} tests are FAILING in baseline — fix before baselining`);
    }
    process.exit(0);
  }

  // Load baseline
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`[canary-compare] Error: baseline not found at ${BASELINE_PATH}`);
    console.error('[canary-compare] Run with --generate to create it first.');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));

  // Load current vector — from file or by running the suite
  let current;
  const currentFileIdx = args.indexOf('--current-file');
  if (currentFileIdx !== -1 && args[currentFileIdx + 1]) {
    const currentFilePath = args[currentFileIdx + 1];
    if (!fs.existsSync(currentFilePath)) {
      console.error(`[canary-compare] Error: --current-file not found: ${currentFilePath}`);
      process.exit(1);
    }
    current = JSON.parse(fs.readFileSync(currentFilePath, 'utf-8'));
  } else {
    // Run the canary suite and parse output
    current = generateBaseline();
  }

  // Run McNemar's test
  const result = mcnemar(baseline, current);

  // Output JSON result
  const output = {
    degraded: result.degraded,
    p_value: parseFloat(result.p_value.toFixed(6)),
    delta: parseFloat(result.delta.toFixed(6)),
    changed_tests: result.changed_tests,
    b: result.b,
    c: result.c,
    total: result.total,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  if (result.degraded) {
    process.stderr.write(
      `[canary-compare] DEGRADATION DETECTED: p=${output.p_value.toFixed(4)}, delta=${output.delta.toFixed(4)}, b=${result.b} regressions\n`
    );
    process.exit(1);
  } else {
    process.stderr.write(
      `[canary-compare] No degradation: p=${output.p_value.toFixed(4)}, delta=${output.delta.toFixed(4)}, b=${result.b}, c=${result.c}\n`
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[canary-compare] Fatal error:', err.message);
  process.exit(1);
});
