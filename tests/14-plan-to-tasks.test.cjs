#!/usr/bin/env node
/**
 * Plan 14-02-03: Pass 0 unit tests for planToTasks validation engine.
 *
 * Covers: _validatePlanShape, _detectCycles, _checkAgentConflicts,
 * _filesDisjointSplit, _renderDagText, _diffPlanVsAmauta, planToTasks (kill
 * switch + full pass0 flow). All tests are pure-function unit tests — no
 * daemon required.
 *
 * Run: node --test tests/14-plan-to-tasks.test.cjs
 *
 * Test pattern matches Phase 13.1 manifest-check tests: node:test, assert/strict,
 * inline fixtures (no tmpdir files needed for pure functions).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const tools = require(GSD_TOOLS);

const {
  _validatePlanShape,
  _detectCycles,
  _checkAgentConflicts,
  _filesDisjointSplit,
  _renderDagText,
  _diffPlanVsAmauta,
  planToTasks,
} = tools;

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeTask(id, agent, modifyFiles, deps) {
  return `
<task id="${id}">
  <title>Task ${id}</title>
  <agent>${agent}</agent>
  <depends_on>${JSON.stringify(deps || [])}</depends_on>
  <read_first>
    - some/file.md
  </read_first>
  <action>Do something.</action>
  <acceptance_criteria>
    - grep something somewhere
  </acceptance_criteria>
  <files_expected>
    modify:
      ${(modifyFiles || []).map(f => `- ${f}`).join('\n      ')}
    create: []
    delete: []
  </files_expected>
</task>`;
}

function makeStory() {
  return `
<story>
  <title>Test Story</title>
  <success_criteria>
    Given conditions,
    When action,
    Then result.
  </success_criteria>
  <doc_refs>
    - some/ref.md
  </doc_refs>
</story>`;
}

function makePlan(tasks, includeStory) {
  const story = includeStory !== false ? makeStory() : '';
  return `---
plan_id: test-plan
---

# Test Plan
${story}
${tasks.join('\n')}
`;
}

// ── Pass 0 Deterministic Tests ──────────────────────────────────────────────

test('Pass 0: cycle detection — 3-node cycle halts with cycle participants', () => {
  // A -> B -> C -> A
  const tasks = [
    { id: 'test-01', dependsOn: ['test-02'], agent: 'executor-backend', filesExpected: { modify: ['a.py'], create: [], delete: [] } },
    { id: 'test-02', dependsOn: ['test-03'], agent: 'executor-backend', filesExpected: { modify: ['b.py'], create: [], delete: [] } },
    { id: 'test-03', dependsOn: ['test-01'], agent: 'executor-backend', filesExpected: { modify: ['c.py'], create: [], delete: [] } },
  ];

  const result = _detectCycles(tasks);
  assert.equal(result.hasCycle, true, 'should detect cycle');
  assert.ok(Array.isArray(result.cycle), 'cycle should be array');
  assert.ok(result.cycle.length >= 3, 'cycle should have at least 3 participants');
  assert.ok(result.cycle.includes('test-01'), 'cycle should include test-01');
  assert.ok(result.cycle.includes('test-02'), 'cycle should include test-02');
  assert.ok(result.cycle.includes('test-03'), 'cycle should include test-03');

  // Also verify planToTasks returns an error for this shape
  const planContent = makePlan([
    makeTask('test-01', 'executor-backend', ['a.py'], ['test-02']),
    makeTask('test-02', 'executor-backend', ['b.py'], ['test-03']),
    makeTask('test-03', 'executor-backend', ['c.py'], ['test-01']),
  ]);
  // Build shape result manually to confirm cycle causes halt
  const shapeResult = _validatePlanShape(planContent);
  // Validate shape passes (cycle detection is separate)
  // Then run cycle check
  const cycleResult = _detectCycles(shapeResult.tasks);
  assert.equal(cycleResult.hasCycle, true, 'planContent cycle detected');
});

test('Pass 0: self-dependency halts', () => {
  const tasks = [
    { id: 'self-01', dependsOn: ['self-01'], agent: 'executor-backend', filesExpected: { modify: ['x.py'], create: [], delete: [] } },
  ];
  const result = _detectCycles(tasks);
  assert.equal(result.hasCycle, true, 'self-dependency is a cycle');
  assert.ok(result.cycle.includes('self-01'), 'cycle includes the self-referencing task');
});

test('Pass 0: cap overflow — 13-task fixture returns structured split guidance', () => {
  const tasks = [];
  for (let i = 1; i <= 13; i++) {
    tasks.push(makeTask(`cap-${String(i).padStart(2, '0')}`, 'executor-backend', [`file${i}.py`], []));
  }
  const planContent = makePlan(tasks);
  const result = _validatePlanShape(planContent);

  assert.equal(result.valid, false, 'should be invalid');
  const capError = result.errors.find(e => e.code === 'cap_exceeded');
  assert.ok(capError, 'should have cap_exceeded error');
  assert.equal(capError.cap, 10, 'cap should be 10');
  assert.equal(capError.actual, 13, 'actual should be 13');
});

test('Pass 0: exactly 10 tasks passes cap check', () => {
  const tasks = [];
  for (let i = 1; i <= 10; i++) {
    tasks.push(makeTask(`ok-${String(i).padStart(2, '0')}`, 'executor-backend', [`file${i}.py`], []));
  }
  const planContent = makePlan(tasks);
  const result = _validatePlanShape(planContent);

  assert.equal(result.valid, true, '10 tasks should pass cap check');
  const capError = result.errors.find(e => e.code === 'cap_exceeded');
  assert.equal(capError, undefined, 'should not have cap error for exactly 10 tasks');
});

test('Pass 0: missing <story> block rejected', () => {
  const planContent = makePlan(
    [makeTask('t-01', 'executor-backend', ['a.py'], [])],
    false  // no story
  );
  const result = _validatePlanShape(planContent);
  assert.equal(result.valid, false, 'should be invalid');
  const storyError = result.errors.find(e => e.code === 'missing_story');
  assert.ok(storyError, 'should have missing_story error');
  assert.ok(storyError.message.toLowerCase().includes('story'), 'error message should mention story');
});

test('Pass 0: agent-assignment conflict detected', () => {
  // .py files -> executor-backend, but agent says executor-frontend
  const tasks = [
    {
      id: 'conflict-01',
      agent: 'executor-frontend',
      filesExpected: { modify: ['services/backend.py', 'amauta.py'], create: [], delete: [] },
      dependsOn: [],
    },
  ];
  const result = _checkAgentConflicts(tasks);
  assert.ok(result.conflicts.length > 0, 'should detect conflict');
  const conflict = result.conflicts[0];
  assert.equal(conflict.taskId, 'conflict-01');
  assert.equal(conflict.declaredAgent, 'executor-frontend');
  assert.equal(conflict.computedAgent, 'executor-backend', 'computed agent should be executor-backend for .py files');
});

// ── Files-Disjoint Split Algorithm ──────────────────────────────────────────

test('Split: all-overlap returns null split index', () => {
  // All tasks touch the same file — no clean boundary anywhere
  const tasks = [
    { id: 't1', filesExpected: { modify: ['shared.py'], create: [], delete: [] } },
    { id: 't2', filesExpected: { modify: ['shared.py'], create: [], delete: [] } },
    { id: 't3', filesExpected: { modify: ['shared.py'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.equal(result.suggested_split_index, null, 'should return null for all-overlap');
  assert.equal(result.split_rationale, 'no_disjoint_prefix', 'rationale should be no_disjoint_prefix');
});

test('Split: disjoint boundary found at index N', () => {
  // Tasks 0-3 share the file 'group-a-shared.py', tasks 4-7 share 'group-b-shared.md'.
  // The first disjoint cut is at index 4 (left side = tasks 0-3, right side = tasks 4-7).
  const tasks = [
    { id: 't1', filesExpected: { modify: ['group-a-shared.py', 'unique-a1.py'], create: [], delete: [] } },
    { id: 't2', filesExpected: { modify: ['group-a-shared.py', 'unique-a2.py'], create: [], delete: [] } },
    { id: 't3', filesExpected: { modify: ['group-a-shared.py', 'unique-a3.py'], create: [], delete: [] } },
    { id: 't4', filesExpected: { modify: ['group-a-shared.py', 'unique-a4.py'], create: [], delete: [] } },
    { id: 't5', filesExpected: { modify: ['group-b-shared.md', 'unique-b1.md'], create: [], delete: [] } },
    { id: 't6', filesExpected: { modify: ['group-b-shared.md', 'unique-b2.md'], create: [], delete: [] } },
    { id: 't7', filesExpected: { modify: ['group-b-shared.md', 'unique-b3.md'], create: [], delete: [] } },
    { id: 't8', filesExpected: { modify: ['group-b-shared.md', 'unique-b4.md'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.ok(result.suggested_split_index !== null, 'should find a disjoint boundary');
  assert.ok(result.split_rationale.startsWith('disjoint_at_'), `rationale should start with disjoint_at_, got: ${result.split_rationale}`);
  // Tasks 0-3 all share group-a-shared.py, tasks 4-7 share group-b-shared.md.
  // The disjoint boundary is at index 4 (first cut where left and right share no files).
  assert.equal(result.suggested_split_index, 4, 'disjoint boundary should be at index 4');
});

test('Split: partial overlap returns least-overlap cut', () => {
  // Tasks 1-3 touch gsd-tools.cjs
  // Tasks 4-6 touch BOTH gsd-tools.cjs AND amauta.py (bridge)
  // Tasks 7-9 touch only amauta.py
  // No fully disjoint cut exists, but a least-overlap cut does
  const tasks = [
    { id: 't1', filesExpected: { modify: ['get-shit-done/bin/gsd-tools.cjs'], create: [], delete: [] } },
    { id: 't2', filesExpected: { modify: ['get-shit-done/bin/gsd-tools.cjs'], create: [], delete: [] } },
    { id: 't3', filesExpected: { modify: ['get-shit-done/bin/gsd-tools.cjs'], create: [], delete: [] } },
    { id: 't4', filesExpected: { modify: ['get-shit-done/bin/gsd-tools.cjs', 'amauta.py'], create: [], delete: [] } },
    { id: 't5', filesExpected: { modify: ['get-shit-done/bin/gsd-tools.cjs', 'amauta.py'], create: [], delete: [] } },
    { id: 't6', filesExpected: { modify: ['get-shit-done/bin/gsd-tools.cjs', 'amauta.py'], create: [], delete: [] } },
    { id: 't7', filesExpected: { modify: ['amauta.py'], create: [], delete: [] } },
    { id: 't8', filesExpected: { modify: ['amauta.py'], create: [], delete: [] } },
    { id: 't9', filesExpected: { modify: ['amauta.py'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.ok(result.suggested_split_index !== null, 'should return a non-null split index for partial overlap');
  assert.ok(
    result.split_rationale.startsWith('least_overlap_at_'),
    `rationale should start with least_overlap_at_, got: ${result.split_rationale}`
  );
  assert.ok(typeof result.overlap_count === 'number' && result.overlap_count > 0, 'overlap_count should be > 0 for partial overlap');
});

test('Split: exactly 10 tasks — no split error raised', () => {
  // With exactly 10 tasks, _validatePlanShape should not trigger a cap error
  // So _filesDisjointSplit is never called from the cap path
  const tasks = [];
  for (let i = 1; i <= 10; i++) {
    tasks.push(makeTask(`split-${String(i).padStart(2, '0')}`, 'executor-backend', [`file${i}.py`], []));
  }
  const planContent = makePlan(tasks);
  const result = _validatePlanShape(planContent);
  assert.equal(result.valid, true, '10 tasks should pass cap check — no split needed');
  const capError = result.errors.find(e => e.code === 'cap_exceeded');
  assert.equal(capError, undefined, 'no cap error means no split suggestion needed');
});

// ── DAG Text Rendering ───────────────────────────────────────────────────────

test('dag_text: 20-edge fixture truncates at 500 chars', () => {
  // Create tasks with long IDs and multiple deps to force truncation beyond 500 chars.
  // Use a realistic plan-local-id style: phase-plan-taskNN (long enough to blow the budget).
  // With IDs like "14-plan-long-task-NN" (21 chars), 21 tasks x ~30 chars per edge line = ~630 chars.
  const tasks = [];
  for (let i = 0; i < 21; i++) {
    const id = `14-plan-long-task-${String(i).padStart(2, '0')}`;
    const deps = i > 0 ? [`14-plan-long-task-${String(i - 1).padStart(2, '0')}`] : [];
    tasks.push({ id, dependsOn: deps });
  }

  const result = _renderDagText(tasks);
  assert.ok(result.length <= 500, `dag text should be <= 500 chars, got ${result.length}`);
  assert.ok(result.includes('...'), 'truncated output should contain ... (dag was truncated)');
});

// ── Drift Detection ─────────────────────────────────────────────────────────

test('drift: unchanged plan-vs-amauta returns no diffs', () => {
  const planTasks = [
    {
      id: 'drift-01',
      title: 'Task One',
      agent: 'executor-backend',
      filesExpected: { modify: ['a.py'], create: ['b.py'], delete: [] },
      dependsOn: [],
    },
  ];
  const amautaTasks = [
    {
      metadata: { plan_local_id: 'drift-01' },
      title: 'Task One',
      assigned_to: 'executor-backend',
      files_expected: { modify: ['a.py'], create: ['b.py'], delete: [] },
      dependencies: [],
    },
  ];
  const result = _diffPlanVsAmauta(planTasks, amautaTasks);
  assert.equal(result.drifted, false, 'should not be drifted');
  assert.deepEqual(result.diffs, [], 'should have no diffs');
});

test('drift: title change detected, read_first change ignored', () => {
  const planTasks = [
    {
      id: 'drift-02',
      title: 'Updated Task Title',
      agent: 'executor-backend',
      filesExpected: { modify: ['a.py'], create: [], delete: [] },
      dependsOn: [],
    },
  ];
  const amautaTasks = [
    {
      metadata: { plan_local_id: 'drift-02' },
      title: 'Original Task Title',  // title differs
      assigned_to: 'executor-backend',
      files_expected: { modify: ['a.py'], create: [], delete: [] },
      dependencies: [],
      // read_first would be a different field — not compared
      read_first: 'Different read_first content',
    },
  ];
  const result = _diffPlanVsAmauta(planTasks, amautaTasks);
  assert.equal(result.drifted, true, 'should detect drift');
  assert.ok(result.diffs.length > 0, 'should have diffs');
  assert.equal(result.diffs[0].field, 'title', 'first diff should be on title field');
  assert.equal(result.divergence_type, 'plan_amauta_drift', 'divergence_type must be exactly plan_amauta_drift');

  // read_first change should NOT be in diffs
  const readFirstDiff = result.diffs.find(d => d.field === 'read_first');
  assert.equal(readFirstDiff, undefined, 'read_first change should NOT appear in diffs');
});

// ── Divergence Protocol Version ─────────────────────────────────────────────

test('divergence-protocol.md is at v1.1.0 with both new enum values', () => {
  const protocolPath = path.join(REPO_ROOT, 'get-shit-done', 'references', 'divergence-protocol.md');
  const content = fs.readFileSync(protocolPath, 'utf-8');

  // Version floor, not an exact pin. The previous assertion required exactly
  // version: "1.1.0" and therefore failed the moment the document legitimately
  // moved to 1.2.0 -- a test that fails on forward progress, while the assertions
  // that carry meaning (the two enum values) still passed. Compare semver instead.
  const vm = content.match(/version:\s*"(\d+)\.(\d+)\.(\d+)"/);
  assert.ok(vm, 'divergence-protocol.md must declare a semver version in frontmatter');
  const [maj, min] = [Number(vm[1]), Number(vm[2])];
  assert.ok(maj > 1 || (maj === 1 && min >= 1),
    `divergence-protocol.md must be at >= 1.1.0, found ${vm[0]}`);

  // Both new enum values must be present
  assert.ok(content.includes('agent_assignment_conflict'), 'must contain agent_assignment_conflict enum value');
  assert.ok(content.includes('plan_amauta_drift'), 'must contain plan_amauta_drift enum value');
});

// ── Kill Switch ──────────────────────────────────────────────────────────────

test('GSD_P_AUTO_TASK=false returns skipped result', async () => {
  const original = process.env.GSD_P_AUTO_TASK;
  try {
    process.env.GSD_P_AUTO_TASK = 'false';
    // planToTasks requires a plan file path, but kill switch fires before reading
    const result = await planToTasks('nonexistent-plan.md', { cwd: os.tmpdir() });
    assert.equal(result.skipped, true, 'should return skipped: true');
    assert.equal(result.reason, 'kill_switch', 'reason should be kill_switch');
  } finally {
    if (original === undefined) {
      delete process.env.GSD_P_AUTO_TASK;
    } else {
      process.env.GSD_P_AUTO_TASK = original;
    }
  }
});

// ── Schema Validation ────────────────────────────────────────────────────────

test('Pass 0: task missing <files_expected> rejected', () => {
  // Manually craft a plan with a task that lacks files_expected
  const storyBlock = makeStory();
  const taskWithoutFiles = `
<task id="nofiles-01">
  <title>Task Without Files</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <read_first>
    - some/file.md
  </read_first>
  <action>Do something.</action>
  <acceptance_criteria>
    - grep something somewhere
  </acceptance_criteria>
</task>`;
  const planContent = `---
plan_id: nofiles-test
---
${storyBlock}
${taskWithoutFiles}
`;
  const result = _validatePlanShape(planContent);
  assert.equal(result.valid, false, 'should be invalid');
  const filesError = result.errors.find(e => e.code === 'missing_files_expected');
  assert.ok(filesError, 'should have missing_files_expected error');
  assert.ok(filesError.message.toLowerCase().includes('files_expected'), 'error should mention files_expected');
});

// ── Agent Assignment Fallback ─────────────────────────────────────────────────

test('Agent assignment: executor-general as fallback for non-matching files', () => {
  // Files that don't match frontend/infra/backend patterns → executor-general
  const tasks = [
    {
      id: 'general-01',
      agent: 'executor-general',
      filesExpected: { modify: ['CLAUDE.md', 'README.md', '.planning/STATE.md'], create: [], delete: [] },
      dependsOn: [],
    },
  ];
  const result = _checkAgentConflicts(tasks);
  // executor-general is the fallback — no conflict expected
  assert.equal(result.conflicts.length, 0, 'executor-general should not conflict for non-specific files');
});

// ── planToTasks full Pass 0 flow ──────────────────────────────────────────────

test('planToTasks: cycle in plan returns error, zero task creation implied', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-plantest-'));
  let err;
  try {
    // Write a temporary plan file with a cycle
    const planContent = `---
plan_id: 14-cycle-test
---
${makeStory()}
${makeTask('cycle-01', 'executor-backend', ['a.py'], ['cycle-02'])}
${makeTask('cycle-02', 'executor-backend', ['b.py'], ['cycle-01'])}
`;
    const planFile = path.join(tmpDir, '14-cycle-PLAN.md');
    fs.writeFileSync(planFile, planContent);

    const result = await planToTasks(planFile, { cwd: tmpDir });
    assert.equal(result.error, 'cycle_detected', 'should return cycle_detected error');
    assert.ok(Array.isArray(result.cycle), 'cycle field should be an array');
    assert.ok(result.cycle.includes('cycle-01'), 'cycle should include cycle-01');
    assert.ok(result.cycle.includes('cycle-02'), 'cycle should include cycle-02');
    assert.ok(result.message.includes('Zero tasks created'), 'message should mention zero tasks created');
  } catch (e) { err = e; }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  if (err) throw err;
});

test('planToTasks: valid plan passes Pass 0 validation (daemon-agnostic)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-valid-'));
  let err;
  try {
    const planContent = `---
plan_id: 14-valid-test
---
${makeStory()}
${makeTask('valid-01', 'executor-backend', ['amauta.py'], [])}
${makeTask('valid-02', 'executor-backend', ['get-shit-done/bin/gsd-amauta.cjs'], ['valid-01'])}
`;
    const planFile = path.join(tmpDir, '14-valid-PLAN.md');
    fs.writeFileSync(planFile, planContent);

    const result = await planToTasks(planFile, { cwd: tmpDir });
    // Pass 0 succeeded (no cycle, no cap, no conflict) — result is either:
    // - {pass0:'complete', plan_id, story_id, tasks_created, ...} on full success (daemon running)
    // - {error:'story_creation_failed'} if daemon is not available
    // In both cases, plan_id extraction and pass0 validation is confirmed by
    // the absence of cycle/cap/agent_conflict errors.
    const passedPass0 = result.pass0 === 'complete' ||
      result.error === 'story_creation_failed' ||
      (result.story_id !== undefined);
    assert.ok(passedPass0, `Pass 0 should complete without cycle/cap/conflict error; got: ${JSON.stringify(result).slice(0, 200)}`);
    // Ensure no validation error (cycle, cap, agent conflict)
    assert.notEqual(result.error, 'cycle_detected', 'should not have cycle error');
    assert.notEqual(result.error, 'cap_exceeded', 'should not have cap error');
    assert.notEqual(result.error, 'agent_assignment_conflict', 'should not have conflict error');
    assert.notEqual(result.error, 'validation_failed', 'should not have validation_failed error');
    // plan_id is either extracted (full run) or present on story_creation_failed
    if (result.plan_id) {
      assert.equal(result.plan_id, '14-valid-test', 'should extract plan_id from frontmatter');
    }
  } catch (e) { err = e; }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  if (err) throw err;
});

test('planToTasks: agent assignment conflict halts before task creation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-conflict-'));
  let err;
  try {
    // .tsx files -> executor-frontend, but we declare executor-backend
    const taskWithConflict = `
<task id="conflict-plan-01">
  <title>Frontend task mislabeled as backend</title>
  <agent>executor-backend</agent>
  <depends_on>[]</depends_on>
  <read_first>- src/components/App.tsx</read_first>
  <action>Edit the component.</action>
  <acceptance_criteria>- grep something src/App.tsx</acceptance_criteria>
  <files_expected>
    modify:
      - src/components/App.tsx
      - src/components/Header.tsx
    create: []
    delete: []
  </files_expected>
</task>`;
    const planContent = `---
plan_id: 14-conflict-test
---
${makeStory()}
${taskWithConflict}
`;
    const planFile = path.join(tmpDir, '14-conflict-PLAN.md');
    fs.writeFileSync(planFile, planContent);

    const result = await planToTasks(planFile, { cwd: tmpDir });
    assert.equal(result.error, 'agent_assignment_conflict', 'should return agent_assignment_conflict error');
    assert.equal(result.divergence_type, 'agent_assignment_conflict', 'divergence_type should match enum value');
    assert.ok(Array.isArray(result.conflicts), 'should have conflicts array');
    assert.ok(result.conflicts.length > 0, 'should have at least one conflict');
  } catch (e) { err = e; }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  if (err) throw err;
});

// ---------------------------------------------------------------------------
// Regression: path normalisation before the disjointness comparison.
//
// _filesDisjointSplit previously compared raw authored path strings. Two tasks
// declaring the same file with different spellings therefore compared as DISJOINT
// and were scheduled into the same wave -- two agents holding the same pre-edit
// baseline of one file, which diagrams/09 §9.5 names as the agent-era lost update:
// silent when it happens, and caused purely by how two planners typed a path.
//
// Found 2026-08-30 while registering a Phase 0 plan set in the barerouter project.
// ---------------------------------------------------------------------------

test('_filesDisjointSplit: same file, different spellings, is NOT disjoint', () => {
  const tasks = [
    { id: 't1', filesExpected: { modify: ['./docs/X.md'], create: [], delete: [] } },
    { id: 't2', filesExpected: { modify: ['docs/X.md'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.equal(result.split_rationale, 'no_disjoint_prefix',
    './docs/X.md and docs/X.md are one file and must not be scheduled in parallel');
  assert.equal(result.suggested_split_index, null);
});

test('_filesDisjointSplit: path traversal resolves to the same file', () => {
  const tasks = [
    { id: 't1', filesExpected: { modify: ['a/../docs/X.md'], create: [], delete: [] } },
    { id: 't2', filesExpected: { modify: ['docs/X.md'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.equal(result.split_rationale, 'no_disjoint_prefix',
    'a/../docs/X.md resolves to docs/X.md');
});

test('_filesDisjointSplit: normalisation does not merge genuinely different files', () => {
  const tasks = [
    { id: 't1', filesExpected: { modify: ['docs/A.md'], create: [], delete: [] } },
    { id: 't2', filesExpected: { modify: ['docs/B.md'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.equal(result.split_rationale, 'disjoint_at_1',
    'distinct files must still split -- the fix must not over-merge');
});

test('_filesDisjointSplit: create[] paths are normalised too, not just modify[]', () => {
  const tasks = [
    { id: 't1', filesExpected: { modify: [], create: ['./src/new.py'], delete: [] } },
    { id: 't2', filesExpected: { modify: ['src/new.py'], create: [], delete: [] } },
  ];
  const result = _filesDisjointSplit(tasks);
  assert.equal(result.split_rationale, 'no_disjoint_prefix',
    'a file created by one task and modified by another is a collision');
});

// ─────────────────────────────────────────────────────────────────────────────
// Dual-store mirror guard (services/amauta-daemon.py)
//
// Regression for: a task-mutating command that COMMITS tasks.json and is then
// killed by the subprocess ceiling returns rc != 0. The mirror block used to be
// gated on `rc == 0`, so it skipped — leaving sqlite/PG frozen against a
// tasks.json that had already moved, permanently and silently.
//
// The acceptance criterion here is "a timeout that no longer corrupts", NOT
// "a command that completes". This test forces the timeout on purpose (small
// AMAUTA_CMD_TIMEOUT_MS + a stub that sleeps past it) and then asserts the two
// stores AGREE. Raising the ceiling does not make this test pass; only the
// guard does. Reverting `(rc == 0 or _tasks_moved)` back to `rc == 0` in
// amauta-daemon.py must turn this test red.
//
// Isolation: the driver below builds its own ThreadedHTTPServer from the daemon
// module and never calls run(), so it never touches the shared
// services/amauta-daemon.pid or any shared port/data dir.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SERVICES_DIR = path.join(REPO_ROOT, 'services');

/**
 * Ask the OS for a free loopback port and release it immediately.
 * @returns {Promise<number>} an ephemeral port number
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll a loopback port until it accepts a TCP connection.
 * @param {number} port
 * @param {number} timeoutMs - give up after this long
 * @returns {Promise<void>}
 * @throws {Error} when the port never opens before the deadline
 */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${port} never opened within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/**
 * POST a JSON body to the test daemon.
 * @param {number} port
 * @param {string} urlPath
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<object>} parsed response, or {raw} when not JSON
 */
function postJson(port, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('client timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Read the mirrored rows for a task out of the test SQLite store.
 * @param {string} dbPath
 * @param {string} taskId
 * @returns {Array<{id: string, status: string, claimed_by: string}>}
 */
function readMirrorRows(dbPath, taskId) {
  const script = [
    'import json, sqlite3, sys',
    'conn = sqlite3.connect(sys.argv[1])',
    'conn.row_factory = sqlite3.Row',
    'rows = conn.execute("SELECT id, status, claimed_by FROM gsd_tasks WHERE id = ?", (sys.argv[2],)).fetchall()',
    'print(json.dumps([dict(r) for r in rows]))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-c', script, dbPath, taskId], { encoding: 'utf8' })
  );
}

const FAKE_AMAUTA_PY = `
import json, os, sys, tempfile, time

DATA_DIR = os.environ["AMAUTA_DATA_DIR"]
TASKS = os.path.join(DATA_DIR, "tasks.json")
SLEEP_S = float(os.environ.get("FAKE_AMAUTA_SLEEP_S", "0"))

def load():
    with open(TASKS) as f:
        return json.load(f)

def save(data):
    # Atomic replace, exactly like amauta.py save() -- the commit lands on a
    # NEW inode, which is what the daemon's _tasks_file_signature() detects.
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, TASKS)

argv = sys.argv[1:]
cmd = argv[0] if argv else ""

# 'show' is a plain read and stays fast -- mirroring the real system, where the
# enrichment payload rides on 'claim', not on 'show'.
if cmd == "show":
    tid = argv[1]
    for item in load()["items"]:
        if item["id"] == tid:
            print(json.dumps(item))
            sys.exit(0)
    sys.exit(1)

if cmd == "claim":
    tid = argv[1]
    agent = argv[argv.index("--agent") + 1] if "--agent" in argv else "unknown"
    data = load()
    for item in data["items"]:
        if item["id"] == tid:
            item["status"] = "in_progress"
            item["claimed_by"] = agent
            item["assigned_to"] = agent
    save(data)             # <-- COMMITTED to tasks.json
    sys.stdout.flush()
    time.sleep(SLEEP_S)    # <-- then overshoot the ceiling and get killed
    print("claimed " + tid)
    sys.exit(0)

sys.exit(0)
`;

const DRIVER_PY = `
import importlib.util, os, pathlib, sys

SERVICES = os.environ["TEST_SERVICES_DIR"]
sys.path.insert(0, SERVICES)

spec = importlib.util.spec_from_file_location(
    "amauta_daemon_under_test", os.path.join(SERVICES, "amauta-daemon.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Repoint the PID file at the test tmpdir. Belt-and-braces: this driver builds
# its own server and never calls mod.run(), which is the only thing that writes
# the shared services/amauta-daemon.pid.
mod.PID_FILE = pathlib.Path(os.environ["TEST_TMP_DIR"]) / "test-daemon.pid"

if mod.SQLiteStore is None:
    print("SQLiteStore unavailable in daemon module", file=sys.stderr)
    sys.exit(2)

mod._pg_store = None
mod._sqlite_store = mod.SQLiteStore(db_path=os.environ["TEST_SQLITE_PATH"])

server = mod.ThreadedHTTPServer(("127.0.0.1", int(os.environ["TEST_PORT"])),
                                mod.AmautaHandler)
server.serve_forever()
`;

test('mirror guard: a claim that times out AFTER committing tasks.json still reaches the mirror',
  async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amauta-mirror-guard-'));
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const tasksFile = path.join(dataDir, 'tasks.json');
    const sqlitePath = path.join(tmpDir, 'mirror.db');
    const fakeAmauta = path.join(tmpDir, 'fake_amauta.py');
    const driver = path.join(tmpDir, 'driver.py');

    const TASK_ID = 'TK-9001';
    const AGENT = 'executor-backend';
    const CEILING_MS = 1500;   // small on purpose -- we WANT the timeout
    const SLEEP_S = 6;         // comfortably past the ceiling

    fs.writeFileSync(tasksFile, JSON.stringify({
      metadata: { created: '2026-01-01T00:00:00Z', version: '2.0', updated: '2026-01-01T00:00:00Z' },
      items: [{
        id: TASK_ID,
        project_id: '__test__',
        type: 'task',
        title: 'mirror guard fixture',
        description: '',
        details: '',
        status: 'pending',
        priority: 'high',
        assigned_to: '',
        claimed_by: null,
        claimed_at: null,
        rpetd_phases: {},
        rpetd_complete: false,
        importance: 3,
        urgency: 3,
        success_criteria: [],
        deliverables: [],
        dependencies: [],
        tags: [],
        notes: [],
        parent: null,
      }],
    }, null, 2));
    fs.writeFileSync(fakeAmauta, FAKE_AMAUTA_PY);
    fs.writeFileSync(driver, DRIVER_PY);

    const port = await getFreePort();
    const child = spawn('python3', [driver], {
      env: {
        ...process.env,
        TEST_SERVICES_DIR: SERVICES_DIR,
        TEST_TMP_DIR: tmpDir,
        TEST_SQLITE_PATH: sqlitePath,
        TEST_PORT: String(port),
        AMAUTA_DATA_DIR: dataDir,
        GSD_AMAUTA_PY: fakeAmauta,
        GSD_AMAUTA_PORT: String(port),
        AMAUTA_CMD_TIMEOUT_MS: String(CEILING_MS),
        FAKE_AMAUTA_SLEEP_S: String(SLEEP_S),
        AMAUTA_DAEMON_TOKEN: '',
        GSD_POSTGRES_URL: '',
        GSD_RLM_ENABLED: 'false',
        GSD_AMAUTA_NO_AUTO_START: '1',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childErr = '';
    child.stderr.on('data', (c) => { childErr += c; });
    child.stdout.on('data', () => {});

    t.after(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    await waitForPort(port, 60000).catch((e) => {
      throw new Error(`test daemon did not start: ${e.message}\nstderr:\n${childErr}`);
    });

    const res = await postJson(port, '/api/claim', { id: TASK_ID, agent: AGENT },
      (SLEEP_S * 1000) + 30000);

    // 1. The ceiling actually fired. Without this the test could pass for the
    //    wrong reason -- a claim that simply succeeded proves nothing.
    assert.equal(res.exit_code, 1,
      `expected a non-zero exit from the timed-out claim, got ${JSON.stringify(res)}`);
    assert.match(String(res.error), /timed out/i,
      `expected a timeout error, got ${JSON.stringify(res.error)}`);

    // 2. The command committed tasks.json before it was killed. This is the
    //    precondition that makes the mirror skip a corruption rather than a
    //    no-op.
    const onDisk = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const item = onDisk.items.find((i) => i.id === TASK_ID);
    assert.equal(item.status, 'in_progress',
      'fixture precondition: the killed claim must have committed tasks.json');
    assert.equal(item.claimed_by, AGENT);

    // 3. THE GUARD. Both stores must agree. Under the old `rc == 0` gate the
    //    mirror is skipped entirely and this row does not exist.
    const rows = readMirrorRows(sqlitePath, TASK_ID);
    assert.equal(rows.length, 1,
      `mirror lost the task after a timed-out commit: ${JSON.stringify(rows)}\n` +
      `daemon stderr:\n${childErr}`);
    assert.equal(rows[0].status, item.status,
      `stores disagree on status: tasks.json=${item.status} mirror=${rows[0].status}`);
    assert.equal(rows[0].claimed_by, item.claimed_by,
      `stores disagree on claimed_by: tasks.json=${item.claimed_by} mirror=${rows[0].claimed_by}`);
  });
