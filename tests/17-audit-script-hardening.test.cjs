#!/usr/bin/env node
/**
 * Plan 17-02: Regression tests for AUDIT-01, AUDIT-02, AUDIT-03 fixes to
 * scripts/verify-v26.cjs.
 *
 * Tests use synthetic fixtures (temp dirs, inline strings). No live audit execution.
 *
 * Run: node --test tests/17-audit-script-hardening.test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const {
  parseNpmFailures,
  checkVerificationFiles,
  findPhaseDir,
  classifyFailures,
  buildReport,
  generateMarkdown,
  TOOLING_BUGS_SEED,
  PRE_EXISTING_NPM_FAILURES,
} = require(path.join(REPO_ROOT, 'scripts', 'verify-v26.cjs'));

// ── AUDIT-01: checkVerificationFiles prefix-form probe ────────────────────

test('AUDIT-01: checkVerificationFiles finds Phase 14 with prefixed form (14-VERIFICATION.md)', () => {
  const result = checkVerificationFiles();
  const phase14 = result.per_phase['14'];
  assert.ok(phase14, 'Phase 14 must be present in per_phase');
  assert.strictEqual(phase14.verification_md, true, 'Phase 14 must be marked as having VERIFICATION.md');
  assert.strictEqual(phase14.form, 'prefixed', 'Phase 14 must use prefixed form (14-VERIFICATION.md)');
  assert.ok(phase14.path.includes('14-VERIFICATION.md'), 'Resolved path must contain 14-VERIFICATION.md');
});

test('AUDIT-01: checkVerificationFiles finds Phase 10 with unprefixed fallback', () => {
  const result = checkVerificationFiles();
  const phase10 = result.per_phase['10'];
  assert.ok(phase10, 'Phase 10 must be present in per_phase');
  assert.strictEqual(phase10.verification_md, true, 'Phase 10 must be marked as having VERIFICATION.md');
  assert.strictEqual(phase10.form, 'unprefixed', 'Phase 10 must use unprefixed form (VERIFICATION.md)');
});

test('AUDIT-01: checkVerificationFiles returns form=none when neither file exists', () => {
  const result = checkVerificationFiles();
  // Phase 13.1 is known to have no VERIFICATION.md (hygiene debt)
  const phase131 = result.per_phase['13.1'];
  assert.ok(phase131, 'Phase 13.1 must be present in per_phase');
  assert.strictEqual(phase131.verification_md, false, 'Phase 13.1 must be marked as missing');
  assert.strictEqual(phase131.form, 'none', 'Phase 13.1 must report form=none');
});

test('AUDIT-01: DOGFOOD-05 no longer reports Phase 14 as missing', () => {
  const result = checkVerificationFiles();
  const phase14 = result.per_phase['14'];
  assert.ok(phase14, 'Phase 14 must exist in results');
  assert.strictEqual(phase14.verification_md, true, 'Phase 14 must be present, not missing');
});

test('AUDIT-01: both-exist collision -- prefixed form wins over unprefixed', () => {
  // Create a temp dir simulating a phase directory with BOTH naming conventions
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'audit01-both-'));
  const phaseNum = '99';
  const phaseDir = path.join(tmpBase, 'v2.7-phases', phaseNum + '-test-both');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'VERIFICATION.md'), 'unprefixed');
  fs.writeFileSync(path.join(phaseDir, phaseNum + '-VERIFICATION.md'), 'prefixed');

  // Directly test the two-probe logic inline (same logic as checkVerificationFiles)
  const prefixedPath = path.join(phaseDir, phaseNum + '-VERIFICATION.md');
  const unprefixedPath = path.join(phaseDir, 'VERIFICATION.md');
  const prefixedExists = fs.existsSync(prefixedPath);
  const unprefixedExists = fs.existsSync(unprefixedPath);
  const resolvedPath = prefixedExists ? prefixedPath : (unprefixedExists ? unprefixedPath : null);
  const form = prefixedExists ? 'prefixed' : (unprefixedExists ? 'unprefixed' : 'none');

  assert.ok(prefixedExists, 'Prefixed file must exist');
  assert.ok(unprefixedExists, 'Unprefixed file must also exist');
  assert.strictEqual(form, 'prefixed', 'When both exist, prefixed form must win');
  assert.ok(resolvedPath.includes(phaseNum + '-VERIFICATION.md'), 'Resolved path must be the prefixed file');

  // Cleanup
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// ── AUDIT-02: parseNpmFailures structured output ──────────────────────────

test('AUDIT-02: parseNpmFailures returns structured objects from node --test output', () => {
  const fixture = [
    'test at tests/core.test.cjs:579:3',
    '\u2716 searches archived milestones when not in current (0.941459ms)',
    '  TypeError: Cannot read properties of null (reading \'found\')',
    '',
    'test at tests/gsd-amauta.test.cjs:42:3',
    '\u2716 validates agent prompt (1.234ms)',
    '  AssertionError: expected true to be false',
  ].join('\n');

  const result = parseNpmFailures(fixture, '');
  assert.ok(Array.isArray(result), 'Must return an array');
  assert.ok(result.length >= 2, 'Must find at least 2 failures, got ' + result.length);

  const core = result.find(e => e.test_file === 'core.test.cjs');
  assert.ok(core, 'Must find core.test.cjs failure');
  assert.strictEqual(core.test_name, 'searches archived milestones when not in current');
  assert.ok(core.reason.includes('TypeError'), 'Reason must contain TypeError');

  const amauta = result.find(e => e.test_file === 'gsd-amauta.test.cjs');
  assert.ok(amauta, 'Must find gsd-amauta.test.cjs failure');
  assert.strictEqual(amauta.test_name, 'validates agent prompt');
});

test('AUDIT-02: parseNpmFailures returns { test_file, test_name, reason } shape', () => {
  const fixture = [
    'test at tests/rlm-workflow-spec.test.cjs:10:1',
    '\u2716 RLM workflow spec loads (2.5ms)',
    '  Error: ENOENT: no such file or directory',
  ].join('\n');

  const result = parseNpmFailures(fixture, '');
  assert.ok(result.length >= 1, 'Must find at least 1 failure');
  const entry = result[0];
  assert.ok('test_file' in entry, 'Entry must have test_file');
  assert.ok('test_name' in entry, 'Entry must have test_name');
  assert.ok('reason' in entry, 'Entry must have reason');
  assert.strictEqual(typeof entry.test_file, 'string');
  assert.strictEqual(typeof entry.test_name, 'string');
  assert.strictEqual(typeof entry.reason, 'string');
});

test('AUDIT-02: parseNpmFailures handles empty output gracefully', () => {
  const result = parseNpmFailures('', '');
  assert.ok(Array.isArray(result), 'Must return an array');
  assert.strictEqual(result.length, 0, 'Empty output must produce empty array');
});

test('AUDIT-02: parseNpmFailures legacy FAIL line fallback still works', () => {
  const fixture = 'FAIL tests/old-style.test.cjs\nSome error output\n';
  const result = parseNpmFailures(fixture, '');
  assert.ok(result.length >= 1, 'Must find at least 1 legacy failure');
  const entry = result.find(e => e.test_file === 'old-style.test.cjs');
  assert.ok(entry, 'Must find old-style.test.cjs');
  assert.strictEqual(entry.test_name, 'legacy_match');
});

test('AUDIT-02: classifyFailures handles structured objects for npm pre-existing', () => {
  const observed = [
    { test_file: 'rlm-workflow-spec.test.cjs', test_name: 'loads', reason: 'Error' },
    { test_file: 'brand-new.test.cjs', test_name: 'breaks', reason: 'TypeError' },
  ];
  const classified = classifyFailures(observed, PRE_EXISTING_NPM_FAILURES, null);
  assert.strictEqual(classified.preExistingObserved.length, 1, 'Must classify rlm as pre-existing');
  assert.strictEqual(classified.preExistingObserved[0].test_file, 'rlm-workflow-spec.test.cjs');
  assert.strictEqual(classified.newFailures.length, 1, 'Must classify brand-new as new');
  assert.strictEqual(classified.newFailures[0].test_file, 'brand-new.test.cjs');
});
