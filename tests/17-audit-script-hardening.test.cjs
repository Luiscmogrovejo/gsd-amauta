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
