#!/usr/bin/env node
/**
 * Plan 25-01-02: Regression tests for DEBT-01 (ghost elimination) and
 * DEBT-02 (plan-to-tasks default inversion).
 *
 * DEBT-01 tests verify that the milestone-scoped resolver (Phase 16 fix in
 * core.cjs lines 299-331) is dead through the cmdInitPhaseOp entry point
 * with a v2.8 context. Ghost directories from archived milestones must NEVER
 * be returned when the current milestone has no match.
 *
 * DEBT-02 tests verify that execute-phase.md defaults GSD_P_AUTO_TASK to
 * "true" (plan-to-tasks runs by default), and that the gsd-tools.cjs kill
 * switch fires only when GSD_P_AUTO_TASK is explicitly set to "false".
 *
 * Test cases (7):
 *   DEBT-01 (ghost elimination — 4 tests):
 *     01. v2.8 context with v2.3 ghost returns null, not ghost
 *     02. v2.8 context finds phase in .planning/phases/ (current milestone)
 *     03. cmdInitPhaseOp falls back to ROADMAP, not archived milestone
 *     04. depth-11 replay: v2.8 context ignores both v2.7 and v2.3 archived dirs
 *
 *   DEBT-02 (plan-to-tasks default — 3 tests):
 *     05. execute-phase.md defaults GSD_P_AUTO_TASK to true
 *     06. planToTasks kill switch fires only when GSD_P_AUTO_TASK=false explicitly
 *     07. planToTasks runs (no kill_switch) when GSD_P_AUTO_TASK is unset
 *
 * Run: node --test tests/25-debt-sweep.test.cjs
 *
 * Temp-dir discipline: each test creates its own temp dir under
 * os.tmpdir() with prefix `gsd-25-debt-`. On success the dir is removed;
 * on failure the path is logged to stderr and left in place for post-mortem.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const { findPhaseInternal } = require(
  path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'core.cjs')
);
const { cmdInitPhaseOp } = require(
  path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'init.cjs')
);
const { planToTasks } = require(
  path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs')
);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Run fn() with process.exit and process.stdout.write temporarily intercepted.
 * Returns { exitCode, stdout } so tests can assert on output without killing the process.
 * Restores originals even if fn throws unexpectedly.
 */
function captureOutput(fn) {
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let capturedExitCode = null;
  let capturedStdout = '';

  process.stdout.write = (msg) => {
    capturedStdout += String(msg);
    return true;
  };

  process.exit = (code) => {
    capturedExitCode = code !== undefined ? Number(code) : 0;
    throw { __capturedExit: true, code: capturedExitCode };
  };

  try {
    fn();
    capturedExitCode = null;
  } catch (e) {
    if (!e || !e.__capturedExit) {
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite;
      throw e;
    }
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
  }

  return { exitCode: capturedExitCode, stdout: capturedStdout };
}

/**
 * Creates a temp directory simulating a project root with config.json,
 * milestone directories, and optionally .planning/phases/ and ROADMAP.md.
 *
 * opts:
 *   config     — object written as .planning/config.json
 *   milestones — { 'v2.8-phases': ['dir-name' | {name, plans: ['f.md']}], ... }
 *   phases     — array for .planning/phases/ (same structure as milestones)
 *   roadmap    — string content written to .planning/ROADMAP.md
 */
function createFixture(opts) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-25-debt-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  if (opts.config !== undefined) {
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify(opts.config, null, 2)
    );
  }

  if (opts.milestones) {
    const milestonesDir = path.join(planningDir, 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });
    for (const [milestoneDir, phases] of Object.entries(opts.milestones)) {
      const msDir = path.join(milestonesDir, milestoneDir);
      fs.mkdirSync(msDir, { recursive: true });
      for (const phaseEntry of phases) {
        const pDir = path.join(msDir, typeof phaseEntry === 'string' ? phaseEntry : phaseEntry.name);
        fs.mkdirSync(pDir, { recursive: true });
        if (typeof phaseEntry === 'object' && phaseEntry.plans) {
          for (const plan of phaseEntry.plans) {
            fs.writeFileSync(
              path.join(pDir, plan),
              '---\nphase: test\n---\n# Test Plan\n'
            );
          }
        }
      }
    }
  }

  if (opts.phases) {
    const phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    for (const phaseEntry of opts.phases) {
      const pDir = path.join(phasesDir, typeof phaseEntry === 'string' ? phaseEntry : phaseEntry.name);
      fs.mkdirSync(pDir, { recursive: true });
      if (typeof phaseEntry === 'object' && phaseEntry.plans) {
        for (const plan of phaseEntry.plans) {
          fs.writeFileSync(
            path.join(pDir, plan),
            '---\nphase: test\n---\n# Test Plan\n'
          );
        }
      }
    }
  }

  if (opts.roadmap !== undefined) {
    fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), opts.roadmap);
  }

  return tmpDir;
}

function cleanupOrPreserve(tmpDir, err) {
  if (err) {
    process.stderr.write('[preserve] ' + tmpDir + '\n');
    throw err;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

// ── DEBT-01 Tests ──────────────────────────────────────────────────────────

test('DEBT-01: v2.8 context with v2.3 ghost phase returns null, not ghost', () => {
  // v2.8-phases does NOT contain phase 20
  // v2.3-phases/20-structured-context/ exists (archived ghost)
  // findPhaseInternal must return null — never the v2.3 ghost
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.8' },
    milestones: {
      'v2.8-phases': [],
      'v2.3-phases': [{ name: '20-structured-context', plans: ['20-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '20');
    assert.strictEqual(
      result,
      null,
      'Must return null — v2.3-phases/20-structured-context is a ghost, not a v2.8 phase'
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('DEBT-01: v2.8 context finds phase in .planning/phases/ (current milestone)', () => {
  // Phase 20 lives in .planning/phases/ (non-archived, current milestone layout)
  // v2.3 ghost also present — must NOT interfere
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.8' },
    milestones: {
      'v2.3-phases': [{ name: '20-structured-context', plans: ['20-01-PLAN.md'] }],
    },
    phases: [{ name: '20-structured-context-handoffs', plans: ['20-01-PLAN.md'] }],
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '20');
    assert.ok(result, 'Must find phase 20 in .planning/phases/');
    assert.ok(
      result.directory.includes('phases/20-structured-context-handoffs'),
      'Must return .planning/phases/ path, got: ' + result.directory
    );
    assert.ok(
      !result.directory.includes('v2.3'),
      'Must NOT return v2.3 ghost, got: ' + result.directory
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('DEBT-01: cmdInitPhaseOp falls back to ROADMAP, not archived milestone', () => {
  // v2.4 archive has phase 25-tech-debt/ — must be ignored
  // ROADMAP.md has a Phase 25 entry
  // cmdInitPhaseOp should return phase_dir: null (roadmap fallback, no directory)
  const roadmapContent = `# ROADMAP

## Phase 25: Tech Debt Sweep

**Goal:** Close lingering debt items from v2.7 carry-forward.
**Requirements:** DEBT-01, DEBT-02, DEBT-03, DEBT-04
**Plans:** TBD
`;
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.8' },
    milestones: {
      'v2.4-phases': [{ name: '25-tech-debt', plans: ['25-01-PLAN.md'] }],
    },
    roadmap: roadmapContent,
  });
  let err;
  try {
    // cmdInitPhaseOp calls output() which writes JSON to stdout and calls process.exit(0).
    // Intercept both so the test process is not killed.
    const { exitCode, stdout } = captureOutput(() => {
      cmdInitPhaseOp(tmpDir, '25', false /* raw */, null);
    });
    assert.strictEqual(exitCode, 0, 'cmdInitPhaseOp must exit 0');
    const parsed = JSON.parse(stdout);
    // Must have fallen back to ROADMAP, not ghost directory
    assert.strictEqual(
      parsed.phase_dir,
      null,
      'phase_dir must be null when resolving from ROADMAP (no current-milestone directory)'
    );
    // Phase must be found via ROADMAP
    assert.strictEqual(parsed.phase_found, true, 'phase_found must be true (found in ROADMAP)');
    assert.ok(
      parsed.phase_name && parsed.phase_name.toLowerCase().includes('tech'),
      'phase_name must come from ROADMAP entry, got: ' + parsed.phase_name
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('DEBT-01: depth-11 replay with v2.8 context — phase 16 not in current milestone', () => {
  // Depth-11 replay (Phase 18 incident): init resolver residual
  // v2.3-phases/16-data-integrity/ exists (original depth-10 ghost)
  // v2.7-phases/16-init-resolver-fix/ exists (v2.7 milestone — still NOT v2.8)
  // v2.8-phases has NO phase 16 (it was completed in v2.7)
  // findPhaseInternal with v2.8 context must return null for phase 16
  // (not bleed into v2.7 or v2.3 archived dirs)
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.8' },
    milestones: {
      'v2.8-phases': [],
      'v2.7-phases': [{ name: '16-init-resolver-fix', plans: ['16-01-PLAN.md'] }],
      'v2.3-phases': [{ name: '16-data-integrity', plans: ['16-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '16');
    assert.strictEqual(
      result,
      null,
      'Must return null — phase 16 does not exist in v2.8-phases; v2.7 and v2.3 dirs are archived'
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

// ── DEBT-02 Tests ──────────────────────────────────────────────────────────

test('DEBT-02: execute-phase.md defaults GSD_P_AUTO_TASK to true', () => {
  // The workflow guard must default to "true" (plan-to-tasks ON by default).
  // The old inverted default "false" caused plan-to-tasks to be skipped
  // for ALL phases >= 14 unless GSD_P_AUTO_TASK was explicitly set to "true".
  const workflowPath = path.join(
    REPO_ROOT, 'get-shit-done', 'workflows', 'execute-phase.md'
  );
  const content = fs.readFileSync(workflowPath, 'utf-8');

  assert.ok(
    content.includes('GSD_P_AUTO_TASK:-true'),
    'execute-phase.md must contain GSD_P_AUTO_TASK:-true (default enabled)'
  );
  assert.ok(
    !content.includes('GSD_P_AUTO_TASK:-false'),
    'execute-phase.md must NOT contain GSD_P_AUTO_TASK:-false (old inverted default eliminated)'
  );
});

test('DEBT-02: planToTasks kill switch only fires when GSD_P_AUTO_TASK explicitly set to false', async () => {
  // The kill switch in gsd-tools.cjs line ~1059 must fire only when
  // process.env.GSD_P_AUTO_TASK === 'false' (exact string match).
  // Create a minimal valid plan fixture so planToTasks can proceed past the kill switch check.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-25-debt-ks-'));
  const prevVal = process.env.GSD_P_AUTO_TASK;
  let err;
  try {
    process.env.GSD_P_AUTO_TASK = 'false';

    // Create a minimal PLAN.md so the file read doesn't fail
    const planContent = `---
plan_id: test-01
title: "Kill Switch Test"
wave: 1
depends_on: []
requirements: [TEST-01]
---

# Kill Switch Test Plan

<story>
  <title>Kill switch test</title>
  <success_criteria>Test only</success_criteria>
</story>

<task id="test-01-01">
  <title>Test task</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <action>Test action</action>
  <acceptance_criteria>- test passes</acceptance_criteria>
  <files_expected>modify: []</files_expected>
</task>
`;
    const planFile = path.join(tmpDir, 'test-01-PLAN.md');
    fs.writeFileSync(planFile, planContent);

    const result = await planToTasks(planFile, { cwd: tmpDir });
    assert.strictEqual(result.skipped, true, 'kill switch must set skipped: true');
    assert.strictEqual(result.reason, 'kill_switch', 'kill switch must set reason: kill_switch');
  } catch (e) { err = e; } finally {
    // Restore env var
    if (prevVal === undefined) {
      delete process.env.GSD_P_AUTO_TASK;
    } else {
      process.env.GSD_P_AUTO_TASK = prevVal;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  if (err) throw err;
});

test('DEBT-02: planToTasks does not return kill_switch when GSD_P_AUTO_TASK is unset', async () => {
  // When GSD_P_AUTO_TASK is unset (undefined), planToTasks must NOT return kill_switch.
  // It may succeed, fail validation, or fail at daemon — but the reason must NOT be kill_switch.
  // This is the critical regression: with the old :-false default, the bash guard would skip
  // plan-to-tasks entirely; the JS function should behave consistently.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-25-debt-unset-'));
  const prevVal = process.env.GSD_P_AUTO_TASK;
  let err;
  try {
    delete process.env.GSD_P_AUTO_TASK;

    const planContent = `---
plan_id: test-02
title: "Unset Env Test"
wave: 1
depends_on: []
requirements: [TEST-02]
---

# Unset Env Test Plan

<story>
  <title>Unset env test</title>
  <success_criteria>Test only</success_criteria>
</story>

<task id="test-02-01">
  <title>Test task</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <action>Test action</action>
  <acceptance_criteria>- test passes</acceptance_criteria>
  <files_expected>modify: []</files_expected>
</task>
`;
    const planFile = path.join(tmpDir, 'test-02-PLAN.md');
    fs.writeFileSync(planFile, planContent);

    const result = await planToTasks(planFile, { cwd: tmpDir });
    // Must NOT be kill_switch — any other outcome is acceptable
    assert.notStrictEqual(
      result.reason,
      'kill_switch',
      'When GSD_P_AUTO_TASK is unset, planToTasks must NOT return kill_switch reason'
    );
    // Additional assertion: skipped must not be true due to kill switch
    if (result.skipped && result.reason === 'kill_switch') {
      assert.fail('planToTasks skipped with kill_switch reason — GSD_P_AUTO_TASK default is still inverted');
    }
  } catch (e) { err = e; } finally {
    // Restore env var
    if (prevVal === undefined) {
      delete process.env.GSD_P_AUTO_TASK;
    } else {
      process.env.GSD_P_AUTO_TASK = prevVal;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  if (err) throw err;
});
