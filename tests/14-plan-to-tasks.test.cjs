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
  assert.equal(conflict.planAgent, 'executor-frontend');
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
