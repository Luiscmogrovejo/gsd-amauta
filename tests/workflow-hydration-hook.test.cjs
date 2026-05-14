'use strict';
/**
 * Plan 53-04-04: workflow hydration hook tests.
 *
 * Tests the Phase 53 POLISH-05 hydration hook injection:
 *   1. cli-variables.md defines HYDRATE_CMD referencing agent-hydrate
 *   2. execute-phase-legacy.md contains GSD_HYDRATE_TASKS kill switch + HYDRATE_CMD
 *   3. Sharded step files (step-03-execute.md, step-04-verify.md) contain hook
 *   4. Kill switch shell logic: GSD_HYDRATE_TASKS=off → HYDRATION empty
 *   5. Hook idempotency: no duplicate insertions detected in source files
 *
 * Run: node --test tests/workflow-hydration-hook.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GSD = path.join(ROOT, 'get-shit-done');

// ─── Test 1: cli-variables.md defines HYDRATE_CMD ───────────────────────────

test('cli-variables.md defines HYDRATE_CMD referencing agent-hydrate', () => {
  const fPath = path.join(GSD, 'references', 'cli-variables.md');
  assert.ok(fs.existsSync(fPath), `cli-variables.md must exist at ${fPath}`);
  const content = fs.readFileSync(fPath, 'utf8');

  assert.ok(
    content.includes('HYDRATE_CMD="node'),
    'cli-variables.md must define HYDRATE_CMD="node ...'
  );
  assert.ok(
    content.includes('agent-hydrate'),
    'HYDRATE_CMD must reference agent-hydrate subcommand'
  );
  assert.ok(
    content.includes('GSD_HYDRATE_TASKS'),
    'cli-variables.md must document GSD_HYDRATE_TASKS kill switch'
  );
});

// ─── Test 2: execute-phase-legacy.md contains hook with kill switch ──────────

test('execute-phase-legacy.md contains hydration hook with kill switch', () => {
  const fPath = path.join(GSD, 'workflows', 'execute-phase-legacy.md');
  assert.ok(fs.existsSync(fPath), `execute-phase-legacy.md must exist at ${fPath}`);
  const content = fs.readFileSync(fPath, 'utf8');

  assert.ok(
    content.includes('GSD_HYDRATE_TASKS'),
    'execute-phase-legacy.md must contain GSD_HYDRATE_TASKS kill switch'
  );
  assert.ok(
    content.includes('HYDRATE_CMD'),
    'execute-phase-legacy.md must reference HYDRATE_CMD'
  );
  assert.ok(
    content.includes('current_context'),
    'execute-phase-legacy.md must inject <current_context> block in prompts'
  );
  assert.ok(
    content.includes('Phase 53 POLISH-05'),
    'execute-phase-legacy.md must contain Phase 53 POLISH-05 provenance comment'
  );
});

// ─── Test 3: sharded step files contain hook ────────────────────────────────

test('sharded step files contain GSD_HYDRATE_TASKS hydration hook', () => {
  const stepsDir = path.join(GSD, 'workflows', 'execute-phase', 'steps');

  // step-03-execute.md must have 2 injection sites
  const step03 = path.join(stepsDir, 'step-03-execute.md');
  assert.ok(fs.existsSync(step03), `step-03-execute.md must exist at ${step03}`);
  const content03 = fs.readFileSync(step03, 'utf8');
  assert.ok(
    content03.includes('GSD_HYDRATE_TASKS'),
    'step-03-execute.md must contain GSD_HYDRATE_TASKS kill switch'
  );
  // Count occurrences — should have 2 hook blocks (2 Task() spawn sites)
  const count03 = (content03.match(/GSD_HYDRATE_TASKS/g) || []).length;
  assert.ok(count03 >= 2, `step-03-execute.md must have >= 2 GSD_HYDRATE_TASKS occurrences; found ${count03}`);

  // step-04-verify.md must have 1 injection site
  const step04 = path.join(stepsDir, 'step-04-verify.md');
  assert.ok(fs.existsSync(step04), `step-04-verify.md must exist at ${step04}`);
  const content04 = fs.readFileSync(step04, 'utf8');
  assert.ok(
    content04.includes('GSD_HYDRATE_TASKS'),
    'step-04-verify.md must contain GSD_HYDRATE_TASKS kill switch'
  );
});

// ─── Test 4: kill switch shell logic ─────────────────────────────────────────

test('kill switch GSD_HYDRATE_TASKS=off produces empty HYDRATION; ON captures output', () => {
  const bash = spawnSync('which', ['bash'], { encoding: 'utf8' });
  if (bash.status !== 0) {
    // Skip if bash is unavailable
    return;
  }

  // Test kill switch OFF path: HYDRATION must be empty
  const offResult = spawnSync(
    'bash',
    ['-c', `
      HYDRATE_CMD="echo HYDRATED"
      GSD_HYDRATE_TASKS=off
      AGENT_NAME="test-agent"
      TASK_ID="TK-test"
      if [ "\${GSD_HYDRATE_TASKS:-on}" != "off" ]; then
        HYDRATION=$($HYDRATE_CMD "\${AGENT_NAME}" --task-id "\${TASK_ID:-}" --terse 2>/dev/null || echo "")
      else
        HYDRATION=""
      fi
      printf "%s" "$HYDRATION"
    `],
    { encoding: 'utf8', timeout: 5000 }
  );
  assert.strictEqual(offResult.status, 0, `bash exit code: ${offResult.status}`);
  assert.strictEqual(
    offResult.stdout,
    '',
    `GSD_HYDRATE_TASKS=off must produce empty HYDRATION; got: "${offResult.stdout}"`
  );

  // Test kill switch ON path (default): HYDRATION must capture command output
  const onResult = spawnSync(
    'bash',
    ['-c', `
      HYDRATE_CMD="echo HYDRATED"
      AGENT_NAME="test-agent"
      TASK_ID="TK-test"
      if [ "\${GSD_HYDRATE_TASKS:-on}" != "off" ]; then
        HYDRATION=$($HYDRATE_CMD "\${AGENT_NAME}" --task-id "\${TASK_ID:-}" --terse 2>/dev/null || echo "")
      else
        HYDRATION=""
      fi
      printf "%s" "$HYDRATION"
    `],
    { encoding: 'utf8', timeout: 5000 }
  );
  assert.strictEqual(onResult.status, 0, `bash exit code: ${onResult.status}`);
  assert.ok(
    onResult.stdout.trim().length > 0,
    `GSD_HYDRATE_TASKS=on (default) must produce non-empty HYDRATION; got empty`
  );
});

// ─── Test 5: no duplicate hook insertions (idempotency in source) ────────────

test('hook block is not duplicated in source files (idempotency check)', () => {
  const files = [
    path.join(GSD, 'workflows', 'execute-phase-legacy.md'),
    path.join(GSD, 'workflows', 'execute-phase', 'steps', 'step-03-execute.md'),
    path.join(GSD, 'workflows', 'execute-phase', 'steps', 'step-04-verify.md'),
  ];

  for (const fPath of files) {
    const content = fs.readFileSync(fPath, 'utf8');

    // Count how many times the hook sentinel appears
    const hookSentinelCount = (content.match(/GSD_HYDRATE_TASKS:-on/g) || []).length;
    // Count Task() invocations in the file
    const taskCount = (content.match(/\bTask\(/g) || []).length;

    // Each Task() should have exactly one hook block
    assert.ok(
      hookSentinelCount <= taskCount,
      `${path.basename(fPath)}: hook sentinel count (${hookSentinelCount}) must not exceed Task() count (${taskCount}) — no duplicate injections`
    );
    assert.ok(
      hookSentinelCount >= 1,
      `${path.basename(fPath)}: must have at least 1 hook sentinel (GSD_HYDRATE_TASKS:-on); found 0`
    );
  }
});
