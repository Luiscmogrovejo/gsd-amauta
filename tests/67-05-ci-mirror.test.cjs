'use strict';

// 67-05-01: CI mirror of the hook gates (scripts/hook-gates-ci.cjs).
// Proves (a) the mirror is green at HEAD (a mirror born red is trusted by
// nobody) and (b) each of checks 1-3 fails correctly, with a named check in
// its output, when its precondition is violated in a sandboxed fixture.
// Check 4 (hook contract suite) and workflow-file assertions are NOT
// exercised here by design: check 4 already runs (and IS) the tests/67-*
// suite this file belongs to (see plan 67-05-PLAN.md task 67-05-01, action
// note (c)); workflow-file structural assertions land with 67-05-02.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'hook-gates-ci.cjs');
const GSD_TOOLS_PATH = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

function runScript(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function runToolsCli(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [GSD_TOOLS_PATH, ...args, '--cwd', cwd], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// Baseline sandbox where checks 1-3 all pass by construction. Individual
// tests mutate exactly ONE precondition to force exactly one check to fail,
// so the assertion on "which check failed" is unambiguous.
//
// hook-allowlists.json is built via the REAL gsd-tools CLI's `hook-config
// emit` (not hand-authored): _buildHookAllowlistsArtifact() resolves the
// capability catalog relative to gsd-tools.cjs's OWN __dirname, not the
// injected --cwd/--repo-root, so the artifact this produces is the same one
// scripts/hook-gates-ci.cjs's check 1 will compute as "correct" for ANY
// --repo-root (see hook-gates-ci.cjs's GSD_TOOLS_PATH comment).
function makeBaselineTmpRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-gates-ci-test-'));
  fs.mkdirSync(path.join(tmp, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.planning', 'ROADMAP.md'),
    '# Roadmap\n\nNo checked phases in this fixture.\n'
  );
  const emit = runToolsCli(['hook-config', 'emit'], tmp);
  assert.equal(emit.code, 0, `baseline fixture setup: hook-config emit failed: ${emit.stderr}`);
  return tmp;
}

test('67-05-01: green-at-HEAD — real repo root, --skip-tests, exits 0', () => {
  const result = runScript(['--repo-root', REPO_ROOT, '--skip-tests']);
  assert.equal(
    result.code,
    0,
    `expected exit 0 at HEAD (checks 1-3), got ${result.code}: ${result.stdout}${result.stderr}`
  );
  assert.match(result.stdout, /OVERALL: PASS/);
  assert.match(result.stdout, /\[PASS\] allowlist_artifact_drift/);
  assert.match(result.stdout, /\[PASS\] manifest_plan_shape/);
  assert.match(result.stdout, /\[PASS\] validator_verdict_presence/);
});

test('67-05-01: check 1 (allowlist artifact drift) fails on a hand-edited hook-allowlists.json', () => {
  const tmp = makeBaselineTmpRoot();
  const artifactPath = path.join(tmp, 'get-shit-done', 'config', 'hook-allowlists.json');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  artifact.global_allowlist.push('hand-edited-entry.txt');
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');

  const result = runScript(['--repo-root', tmp, '--skip-tests']);
  assert.notEqual(result.code, 0, 'expected nonzero exit on hand-edited allowlist drift');
  assert.match(result.stdout, /\[FAIL\] allowlist_artifact_drift/, 'expected named check-failure line in stdout');
});

test('67-05-01: check 2 (manifest/plan-shape) fails on a phase>=59 plan file missing files_expected', () => {
  const tmp = makeBaselineTmpRoot();
  const phaseDir = path.join(tmp, '.planning', 'phases', '60-fixture-check');
  fs.mkdirSync(phaseDir, { recursive: true });
  const planMissingManifest = `---
plan_id: 60-fixture
phase: 60
---

# Fixture plan — deliberately missing <files_expected> on its one task

<story>
  <title>Fixture: shape-invalid plan</title>
  <success_criteria>n/a — sandboxed fixture, not a real plan</success_criteria>
</story>

<task id="60-fixture-01">
  <title>Task with no files_expected block</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <acceptance_criteria>
    - n/a
  </acceptance_criteria>
</task>
`;
  fs.writeFileSync(path.join(phaseDir, '60-01-PLAN.md'), planMissingManifest);

  const result = runScript(['--repo-root', tmp, '--skip-tests']);
  assert.notEqual(result.code, 0, 'expected nonzero exit on missing files_expected');
  assert.match(result.stdout, /\[FAIL\] manifest_plan_shape/, 'expected named check-failure line in stdout');
  assert.match(result.stdout, /missing_files_expected/, 'expected the specific _validatePlanShape error code');
});

test('67-05-01: check 3 (validator verdict presence) fails on a checked ROADMAP phase without a VERIFICATION.md', () => {
  const tmp = makeBaselineTmpRoot();
  fs.writeFileSync(
    path.join(tmp, '.planning', 'ROADMAP.md'),
    '# Roadmap\n\n- [x] **Phase 99: Fixture Phase** — completed in this fixture, no VERIFICATION.md on disk\n'
  );
  fs.mkdirSync(path.join(tmp, '.planning', 'phases', '99-fixture-phase'), { recursive: true });
  // Deliberately NOT creating 99-VERIFICATION.md inside it.

  const result = runScript(['--repo-root', tmp, '--skip-tests']);
  assert.notEqual(result.code, 0, 'expected nonzero exit on missing VERIFICATION.md for a checked phase');
  assert.match(result.stdout, /\[FAIL\] validator_verdict_presence/, 'expected named check-failure line in stdout');
  assert.match(result.stdout, /Phase 99/, 'expected the specific missing phase to be named');
});
