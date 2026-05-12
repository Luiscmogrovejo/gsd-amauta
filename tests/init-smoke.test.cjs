'use strict';
/**
 * Plan 44-03-03: Full 7-step pipeline smoke via subprocess (hermetic)
 * File: tests/init-smoke.test.cjs
 *
 * Requirements covered:
 *   INST-01: 7-step flow with pass/fail/exit code — end-to-end pipeline smoke
 *   INST-03: CI exit codes 0/1 only; graceful degradation in skills-only mode
 *
 * Invokes `node bin/init.cjs --skip-daemon --skip-install --backend sqlite --json`
 * via subprocess in an isolated tmp HOME + tmp cwd environment. Asserts the
 * FROZEN 7-step contract end-to-end, then verifies the assertions step details.
 *
 * No real daemon required. No PG required. Hermetic subprocess isolation.
 *
 * Run: node --test tests/init-smoke.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const BIN_INIT = path.join(ROOT, 'bin', 'init.cjs');

// ─── Subprocess helper ────────────────────────────────────────────────────────

/**
 * Run `node bin/init.cjs --skip-daemon --skip-install --backend sqlite --json`
 * in an isolated tmpDir as both cwd and HOME (hermetic subprocess pattern from 44-02-05).
 *
 * @param {string[]} [extraArgs] — additional flags
 * @returns {{ tmpDir, stdout, exitCode, parsed }} where parsed is JSON or null
 */
function runSmoke(extraArgs) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-smoke-'));
  const args = [
    BIN_INIT,
    '--skip-daemon', '--skip-install', '--backend', 'sqlite', '--json',
    ...(extraArgs || []),
  ];
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, args, {
      cwd: tmpDir,
      env: { ...process.env, HOME: tmpDir, AMAUTA_DATA_DIR: tmpDir },
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch (e) {
    stdout = (e.stdout || '').toString();
    exitCode = e.status || 1;
  }
  // Find first '{' to skip any non-JSON preamble (e.g. stderr mixed in)
  const idx = stdout.indexOf('{');
  let parsed = null;
  if (idx >= 0) {
    try {
      parsed = JSON.parse(stdout.slice(idx));
    } catch (_e) { /* JSON parse error — parsed stays null */ }
  }
  // Cleanup tmp dir (best-effort)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  return { tmpDir, stdout, exitCode, parsed };
}

// FROZEN 7 step names in order (INST-01 contract)
const FROZEN_STEP_NAMES = [
  'detect_ides',
  'install_skills',
  'detect_infra',
  'migrations',
  'start_daemon',
  'verify',
  'run_assertions',
];

// FROZEN 5 assertion names (alphabetical for set comparison)
const FROZEN_ASSERTION_NAMES = [
  'compiler_validates',
  'daemon_health',
  'schema_applied',
  'semgrep_rules_present',
  'skill_files_present',
];

// ─── Test 1: pipeline exits 0 in skills-only smoke mode ──────────────────────

test('pipeline exits 0 in skills-only smoke mode', () => {
  const { exitCode, parsed } = runSmoke();
  assert.strictEqual(exitCode, 0,
    `Expected exit code 0, got: ${exitCode}`);
  assert.ok(parsed !== null,
    'Expected valid JSON output from pipeline, got null');
  assert.ok(Array.isArray(parsed.results),
    `Expected parsed.results to be an array, got: ${typeof parsed.results}`);
  assert.ok(typeof parsed.elapsed_seconds === 'number',
    `Expected elapsed_seconds to be a number, got: ${typeof parsed.elapsed_seconds}`);
});

// ─── Test 2: pipeline produces exactly 7 step results ────────────────────────

test('pipeline produces exactly 7 step results with FROZEN names in order', () => {
  const { parsed } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  assert.strictEqual(parsed.results.length, 7,
    `Expected exactly 7 steps, got: ${parsed.results.length}. Names: ${JSON.stringify(parsed.results.map(r => r.name))}`);
  // Step names in exact order must match FROZEN_STEP_NAMES
  const actualNames = parsed.results.map(r => r.name);
  assert.deepStrictEqual(actualNames, FROZEN_STEP_NAMES,
    `Step names out of order or wrong. Expected: ${JSON.stringify(FROZEN_STEP_NAMES)}, got: ${JSON.stringify(actualNames)}`);
});

// ─── Test 3: every step has the FROZEN 5-field schema ────────────────────────

test('every step has the FROZEN 5-field schema (name, status, message, duration_ms, details)', () => {
  const { parsed } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  for (const step of parsed.results) {
    const keys = Object.keys(step).sort();
    assert.deepStrictEqual(keys, ['details', 'duration_ms', 'message', 'name', 'status'],
      `Step '${step.name}' has wrong schema. Got: ${JSON.stringify(keys)}`);
    assert.ok(['pass', 'fail', 'skip', 'warn'].includes(step.status),
      `Step '${step.name}' has invalid status: '${step.status}'`);
    assert.ok(typeof step.duration_ms === 'number' && step.duration_ms >= 0,
      `Step '${step.name}' duration_ms must be >= 0 number, got: ${step.duration_ms}`);
    assert.ok(typeof step.message === 'string',
      `Step '${step.name}' message must be a string`);
  }
});

// ─── Test 4: no step has status fail in skills-only smoke (INST-03 graceful degradation)

test('no step has status fail in skills-only smoke (INST-03 graceful-degradation contract)', () => {
  const { parsed, exitCode } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  // INST-03: graceful degradation — no fail in skills-only mode
  const failSteps = parsed.results.filter(r => r.status !== 'fail');
  // The inverse: assert every step is NOT fail
  const actualFails = parsed.results.filter(r => r.status === 'fail');
  assert.strictEqual(actualFails.length, 0,
    `Expected 0 fail steps, got: ${actualFails.length}. Failed steps: ${JSON.stringify(actualFails.map(r => ({name: r.name, message: r.message})))}`);
  // Exit code must be 0 (confirmed separately by test 1, but belt+suspenders here)
  assert.strictEqual(exitCode, 0,
    `Expected exit code 0 when no fail steps, got: ${exitCode}`);
});

// ─── Test 5: run_assertions is the 7th step with 5 frozen assertion entries ──

test('run_assertions is the 7th step with details.assertions array of length 5', () => {
  const { parsed } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  assert.strictEqual(parsed.results[6].name, 'run_assertions',
    `7th step must be run_assertions, got: '${parsed.results[6].name}'`);
  const assertionsStep = parsed.results[6];
  assert.ok(assertionsStep.details !== null && typeof assertionsStep.details === 'object',
    'run_assertions.details must be an object');
  assert.ok(Array.isArray(assertionsStep.details.assertions),
    'run_assertions.details.assertions must be an array');
  assert.strictEqual(assertionsStep.details.assertions.length, 5,
    `run_assertions must have exactly 5 assertions, got: ${assertionsStep.details.assertions.length}`);
});

// ─── Test 6: 5 frozen assertion names are present in run_assertions ───────────

test('5 frozen assertion names are present in run_assertions.details.assertions', () => {
  const { parsed } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  const assertionsStep = parsed.results.find(r => r.name === 'run_assertions');
  assert.ok(assertionsStep, 'run_assertions step must exist in results');
  const actualNames = assertionsStep.details.assertions.map(a => a.name).sort();
  assert.deepStrictEqual(actualNames, FROZEN_ASSERTION_NAMES,
    `Assertion names mismatch. Expected: ${JSON.stringify(FROZEN_ASSERTION_NAMES)}, got: ${JSON.stringify(actualNames)}`);
  // Each assertion has a valid status
  for (const a of assertionsStep.details.assertions) {
    assert.ok(['pass', 'fail', 'warn', 'skip'].includes(a.status),
      `Assertion '${a.name}' has invalid status: '${a.status}'`);
    assert.ok(typeof a.message === 'string' && a.message.length > 0,
      `Assertion '${a.name}' must have a non-empty message`);
  }
});

// ─── Test 7: exit-code rule (INST-03) — 0 in skills-only ─────────────────────

test('exit-code rule (INST-03): skills-only mode has no fail steps so exit = 0', () => {
  const { exitCode, parsed } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  // INST-03 frozen exit rule: results.some(r => r.status === 'fail') ? 1 : 0
  const hasAnyFail = parsed.results.some(r => r.status === 'fail');
  if (hasAnyFail) {
    assert.strictEqual(exitCode, 1,
      'If any step fails, exit code must be 1 (FROZEN exit rule)');
  } else {
    assert.strictEqual(exitCode, 0,
      'If no step fails, exit code must be 0 (FROZEN exit rule)');
  }
  // NOTE: The inverse case (synthetic fail → exit 1) is hard to inject via subprocess.
  // The FROZEN exit rule `results.some(r => r.status === 'fail') ? 1 : 0` is verified
  // by source grep in 44-03-01's acceptance criteria (grep for exact form in bin/init.cjs).
});

// ─── Test 8: detect_ides and install_skills steps are present and correct ─────

test('detect_ides and install_skills steps are present (correct names and schema)', () => {
  const { parsed } = runSmoke();
  assert.ok(parsed !== null, 'JSON output must not be null');
  const detectIdes = parsed.results.find(r => r.name === 'detect_ides');
  const installSkills = parsed.results.find(r => r.name === 'install_skills');
  const detectInfra = parsed.results.find(r => r.name === 'detect_infra');
  const migrations = parsed.results.find(r => r.name === 'migrations');
  const startDaemon = parsed.results.find(r => r.name === 'start_daemon');
  const verify = parsed.results.find(r => r.name === 'verify');
  const runAssertions = parsed.results.find(r => r.name === 'run_assertions');

  assert.ok(detectIdes, 'detect_ides step must exist');
  assert.ok(installSkills, 'install_skills step must exist');
  assert.ok(detectInfra, 'detect_infra step must exist');
  assert.ok(migrations, 'migrations step must exist');
  assert.ok(startDaemon, 'start_daemon step must exist');
  assert.ok(verify, 'verify step must exist');
  assert.ok(runAssertions, 'run_assertions step must exist');

  // In skills-only smoke: install skipped, daemon skipped, verify skipped, migrations skipped
  assert.strictEqual(installSkills.status, 'skip',
    `install_skills must be skip (--skip-install), got: ${installSkills.status}`);
  assert.strictEqual(startDaemon.status, 'skip',
    `start_daemon must be skip (--skip-daemon), got: ${startDaemon.status}`);
  assert.strictEqual(verify.status, 'skip',
    `verify must be skip (daemon skipped), got: ${verify.status}`);
  // duration_ms must be set on all steps
  for (const step of parsed.results) {
    assert.ok(typeof step.duration_ms === 'number' && step.duration_ms >= 0,
      `duration_ms on '${step.name}' must be >= 0, got: ${step.duration_ms}`);
  }
});
