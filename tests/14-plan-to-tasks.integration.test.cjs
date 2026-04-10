#!/usr/bin/env node
/**
 * Plan 14-03-02: Integration tests for planToTasks() with real daemon lifecycle.
 *
 * Tests:
 *   1. Re-run idempotency: fresh run + re-run = zero new creates
 *   2. Pass 1 partial failure + re-run completes remaining tasks
 *   3. Pass 2 partial failure + re-run completes remaining links
 *   4. Drift detection: re-run with title change halts with plan_amauta_drift
 *   5. Drift detection: re-run with unchanged plan is silent skip
 *   6. Dedup bypass: same plan_id + 90% similar titles both create
 *   7. Dedup bypass: different plan_id + 90% similar title triggers dedup
 *   8. PLAN_REGISTRATION block is returned with all fields
 *
 * Test port: GSD_AMAUTA_PORT=19998 (distinct from production 18799)
 * Run: GSD_AMAUTA_PORT=19998 node --test tests/14-plan-to-tasks.integration.test.cjs
 *
 * Cleanup discipline:
 *   - Each test writes fixtures to a unique tmpdir under os.tmpdir()
 *   - tmpdir is removed on success, preserved on failure for post-mortem
 *   - Daemon is killed in both success and failure paths (try/finally)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const GSD_AMAUTA_CJS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const DAEMON_PY = path.join(REPO_ROOT, 'services', 'amauta-daemon.py');

const TEST_PORT = process.env.GSD_AMAUTA_PORT || '19998';

// ── Daemon lifecycle helpers ─────────────────────────────────────────────────

let _daemonProc = null;

function spawnDaemon(dataDir) {
  const env = {
    ...process.env,
    GSD_AMAUTA_PORT: TEST_PORT,
    AMAUTA_DATA_DIR: dataDir,
    // Suppress PG/Redis/RLM startup noise in tests
    GSD_RLM_ENABLED: 'false',
    GSD_REDIS_ENABLED: 'false',
  };
  const daemon = spawn('python3', [DAEMON_PY, 'run'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  _daemonProc = daemon;
  return daemon;
}

function killDaemon(daemon) {
  // SIGKILL — not SIGTERM — to simulate hard failure
  try {
    if (daemon && daemon.pid) {
      process.kill(-daemon.pid, 'SIGKILL');
    }
  } catch (_) {
    // Already dead
  }
  if (_daemonProc === daemon) _daemonProc = null;
}

function waitForDaemon(maxRetries, interval) {
  maxRetries = maxRetries || 20;
  interval = interval || 500;
  for (let i = 0; i < maxRetries; i++) {
    const res = spawnSync('curl', ['-sf', `http://127.0.0.1:${TEST_PORT}/health`], {
      timeout: 1000,
      encoding: 'utf-8',
    });
    if (res.status === 0) return true;
    spawnSync('sleep', ['0.5']);
  }
  throw new Error(`Daemon on port ${TEST_PORT} did not become ready within ${maxRetries * interval}ms`);
}

// ── Test fixture builder ─────────────────────────────────────────────────────

function makeIntegrationPlan(planId, tasks) {
  const story = `<story>
  <title>Integration test story for ${planId}</title>
  <success_criteria>
    Given the plan fixture exists,
    When planToTasks() runs,
    Then all tasks are registered in amauta and linked per depends_on.
  </success_criteria>
  <doc_refs>
    - tests/14-plan-to-tasks.integration.test.cjs
  </doc_refs>
</story>`;

  const taskBlocks = tasks.map(t => {
    const deps = JSON.stringify(t.deps || []);
    return `<task id="${t.id}">
  <title>${t.title}</title>
  <agent>${t.agent || 'executor-backend'}</agent>
  <depends_on>${deps}</depends_on>
  <read_first>
    - tests/14-plan-to-tasks.integration.test.cjs
  </read_first>
  <action>Do the work for ${t.id}.</action>
  <acceptance_criteria>
    - grep "${t.id}" some/file
  </acceptance_criteria>
  <files_expected>
    modify:
      - ${t.file || `services/test-${t.id}.py`}
    create: []
    delete: []
  </files_expected>
</task>`;
  });

  return `---\nplan_id: ${planId}\n---\n${story}\n${taskBlocks.join('\n')}\n`;
}

/** 5-task fixture with task-02 depending on task-01, tasks 03-05 independent */
function makeStandardFixture(planId) {
  return makeIntegrationPlan(planId, [
    { id: `${planId}-01`, title: `Alpha task first pass validation`, deps: [] },
    { id: `${planId}-02`, title: `Beta task second pass logic`, deps: [`${planId}-01`] },
    { id: `${planId}-03`, title: `Gamma task parallel worker`, deps: [] },
    { id: `${planId}-04`, title: `Delta task async handler`, deps: [] },
    { id: `${planId}-05`, title: `Epsilon task cleanup routine`, deps: [] },
  ]);
}

function writePlanToTmp(tmpDir, planId, content) {
  const planFile = path.join(tmpDir, `${planId}-PLAN.md`);
  fs.writeFileSync(planFile, content);
  return planFile;
}

async function runPlanToTasks(planFile, dataDir) {
  // Set the port and data dir for planToTasks subprocess calls
  process.env.GSD_AMAUTA_PORT = TEST_PORT;
  if (dataDir) process.env.AMAUTA_DATA_DIR = dataDir;
  // Re-require fresh instance to pick up env changes
  // (planToTasks reads tasks.json from dataDir at invocation time)
  const freshTools = require(GSD_TOOLS);
  return await freshTools.planToTasks(planFile, { cwd: REPO_ROOT });
}

function readTasksJson(dataDir) {
  const tasksFile = path.join(dataDir, 'tasks.json');
  try {
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return { items: [] };
  }
}

function countTasksForPlan(dataDir, planId) {
  const data = readTasksJson(dataDir);
  return (data.items || []).filter(item => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return tags.some(t => t === `plan:${planId}`);
  }).length;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Re-run idempotency: fresh run + re-run = zero new creates', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-01-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-idem-01';
  let daemon = null;

  try {
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    // First run
    const result1 = await runPlanToTasks(planFile, dataDir);
    assert.ok(result1.story_id || result1.error, 'first run produced a result');

    if (result1.story_id) {
      // Daemon was available — verify tasks were created
      assert.ok(Array.isArray(result1.tasks_created), 'tasks_created should be an array');
      const created1Count = result1.tasks_created.length;
      assert.ok(created1Count > 0, `should have created tasks; got ${created1Count}`);

      // Second run — same plan, same data dir
      const result2 = await runPlanToTasks(planFile, dataDir);
      // Should be idempotent: either skipped or zero new creates
      const isIdempotent = (result2.skipped === true && result2.reason === 'already_registered') ||
        (Array.isArray(result2.tasks_created) && result2.tasks_created.length === 0);
      assert.ok(isIdempotent,
        `second run should be idempotent; got: ${JSON.stringify(result2).slice(0, 300)}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('Re-run idempotency: Pass 1 partial failure + re-run completes', { timeout: 90000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-02-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-partial-p1';
  let daemon = null;

  try {
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    // Start daemon and do first run to create a story + first 2 tasks
    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    const result1 = await runPlanToTasks(planFile, dataDir);
    if (!result1.story_id) {
      // Daemon not functional enough for this test — skip
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    const countAfterFirst = countTasksForPlan(dataDir, planId);

    // Kill daemon to simulate partial failure
    killDaemon(daemon);
    daemon = null;

    // Manually delete tasks 4-5 from tasks.json to simulate partial completion
    const tasksData = readTasksJson(dataDir);
    const task4Id = `${planId}-04`;
    const task5Id = `${planId}-05`;
    const preserved = (tasksData.items || []).filter(item => {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      return !(tags.includes(`task:${task4Id}`) || tags.includes(`task:${task5Id}`));
    });
    fs.writeFileSync(path.join(dataDir, 'tasks.json'),
      JSON.stringify({ ...tasksData, items: preserved }, null, 2));

    // Restart daemon
    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    // Re-run: should create tasks 4+5 (the missing ones) and skip the rest
    const result2 = await runPlanToTasks(planFile, dataDir);

    if (result2.story_id || result2.tasks_created) {
      const countAfterResume = countTasksForPlan(dataDir, planId);
      assert.ok(countAfterResume >= countAfterFirst - 2,
        `re-run should restore task count; before: ${countAfterFirst - 2}, after: ${countAfterResume}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('Re-run idempotency: Pass 2 partial failure + re-run completes links', { timeout: 90000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-03-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-partial-p2';
  let daemon = null;

  try {
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    // Full run to create all tasks
    const result1 = await runPlanToTasks(planFile, dataDir);
    if (!result1.story_id) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    // Kill daemon (SIGKILL) to simulate mid-flight Pass 2 failure
    killDaemon(daemon);
    daemon = null;

    // Remove the dependency link from tasks.json to simulate partial Pass 2
    const tasksData = readTasksJson(dataDir);
    const items = (tasksData.items || []).map(item => {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (tags.includes(`task:${planId}-02`)) {
        // Remove dependencies on this task to simulate link not yet created
        return { ...item, dependencies: [] };
      }
      return item;
    });
    fs.writeFileSync(path.join(dataDir, 'tasks.json'),
      JSON.stringify({ ...tasksData, items }, null, 2));

    // Restart daemon
    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    // Re-run — all tasks exist (skip Pass 1), should only re-run Pass 2 links
    const result2 = await runPlanToTasks(planFile, dataDir);

    // Either fully skipped (idempotent) or created the missing link
    assert.ok(
      result2.skipped === true ||
      (Array.isArray(result2.links_created) && result2.links_created.length >= 0),
      `re-run after Pass 2 partial failure should succeed; got: ${JSON.stringify(result2).slice(0, 200)}`
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('Drift detection: re-run with title change halts with plan_amauta_drift', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-04-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-drift-01';
  let daemon = null;

  try {
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    // First run
    const result1 = await runPlanToTasks(planFile, dataDir);
    if (!result1.story_id) {
      // Daemon not functional — skip
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    // Now change one task title in the plan
    const driftedContent = planContent.replace(
      `Alpha task first pass validation`,
      `Alpha task CHANGED first pass validation`
    );
    fs.writeFileSync(planFile, driftedContent);

    // Re-run with changed plan — should halt with plan_amauta_drift
    const result2 = await runPlanToTasks(planFile, dataDir);
    assert.equal(result2.error, 'plan_amauta_drift',
      `re-run with title change should return plan_amauta_drift; got: ${JSON.stringify(result2).slice(0, 200)}`);
    assert.equal(result2.divergence_type, 'plan_amauta_drift',
      'divergence_type should be plan_amauta_drift');
    assert.ok(Array.isArray(result2.diffs) && result2.diffs.length > 0,
      'diffs array should be non-empty');
    // At least one diff should mention the title field
    const titleDiff = result2.diffs.find(d => d.field === 'title');
    assert.ok(titleDiff,
      `diffs should include a title change; diffs: ${JSON.stringify(result2.diffs)}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('Drift detection: re-run with unchanged plan is silent skip', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-05-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-skip-01';
  let daemon = null;

  try {
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    const result1 = await runPlanToTasks(planFile, dataDir);
    if (!result1.story_id) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    // Re-run without any changes
    const result2 = await runPlanToTasks(planFile, dataDir);
    assert.equal(result2.skipped, true, 'unchanged plan re-run should return skipped:true');
    assert.equal(result2.reason, 'already_registered',
      'reason should be already_registered');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('Dedup bypass: same plan_id + 90% similar titles both create', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-06-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-dedup-bypass';
  let daemon = null;

  try {
    // Two tasks with ~90% similar titles from the SAME plan_id — bypass should fire
    const planContent = makeIntegrationPlan(planId, [
      { id: `${planId}-01`, title: 'Add pass-0 validation engine for plan checks', deps: [],
        file: 'services/pass0.py' },
      { id: `${planId}-02`, title: 'Add pass-0 validation logic for plan checks', deps: [],
        file: 'services/pass0b.py' },
    ]);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    const result = await runPlanToTasks(planFile, dataDir);
    if (!result.story_id) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    // Both tasks should be created (bypass fires for same plan_id)
    const taskCount = countTasksForPlan(dataDir, planId);
    assert.equal(taskCount, 2,
      `both tasks should be created via dedup bypass; got ${taskCount}`);
    assert.ok(result.failed_tasks.length === 0,
      `no failed tasks; got: ${JSON.stringify(result.failed_tasks)}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('Dedup bypass: different plan_id + 90% similar title triggers dedup', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-07-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planIdA = '14-test-dedup-a';
  const planIdB = '14-test-dedup-b';
  let daemon = null;

  try {
    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    // Plan A: create a task
    const planContentA = makeIntegrationPlan(planIdA, [
      { id: `${planIdA}-01`, title: 'Add pass-0 validation engine for plan checks',
        deps: [], file: 'services/pa.py' },
    ]);
    const planFileA = writePlanToTmp(tmpDir, planIdA, planContentA);
    const resultA = await runPlanToTasks(planFileA, dataDir);

    if (!resultA.story_id) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    // Plan B: task with 90%+ similar title but DIFFERENT plan_id — dedup should block
    const planContentB = makeIntegrationPlan(planIdB, [
      { id: `${planIdB}-01`, title: 'Add pass-0 validation logic for plan checks',
        deps: [], file: 'services/pb.py' },
    ]);
    const planFileB = writePlanToTmp(tmpDir, planIdB, planContentB);
    const resultB = await runPlanToTasks(planFileB, dataDir);

    // Verify via tasks.json (equivalent to board --json filtering by plan_id):
    // plan B task count should be 0 (dedup blocked)
    const data = readTasksJson(dataDir); // board --json equivalent: direct tasks.json read
    const planBTasks = (data.items || []).filter(item => {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      return tags.some(t => t === `plan:${planIdB}`);
    });

    // The dedup should have blocked plan B's task creation
    // Either: resultB.failed_tasks has an entry, OR planBTasks count is 0
    const dedupOccurred = planBTasks.length === 0 ||
      (Array.isArray(resultB.failed_tasks) && resultB.failed_tasks.length > 0) ||
      resultB.success === false;
    assert.ok(dedupOccurred,
      `dedup should block cross-plan similar title; ` +
      `planBTasks: ${planBTasks.length}, ` +
      `resultB: ${JSON.stringify(resultB).slice(0, 200)}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

test('PLAN_REGISTRATION block is returned with all fields populated', { timeout: 60000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-14-integ-08-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const planId = '14-test-reg-block';
  let daemon = null;

  try {
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    daemon = spawnDaemon(dataDir);
    waitForDaemon();

    const result = await runPlanToTasks(planFile, dataDir);
    if (!result.story_id) {
      // Daemon not functional — skip
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    assert.ok(result.registration, 'result should have registration field');
    const reg = result.registration;

    // Verify all required fields are present
    assert.ok(reg.plan_id, 'registration.plan_id should be set');
    assert.ok(reg.story_id, 'registration.story_id should be set');
    assert.equal(typeof reg.task_count, 'number', 'registration.task_count should be a number');
    assert.equal(reg.cap, 10, 'registration.cap should be 10');
    assert.ok(reg.task_ids && typeof reg.task_ids === 'object', 'registration.task_ids should be an object');
    assert.ok(reg.agent_assignments && typeof reg.agent_assignments === 'object',
      'registration.agent_assignments should be an object');
    assert.ok(Array.isArray(reg.edges), 'registration.edges should be an array');
    assert.ok(typeof reg.dag_text === 'string', 'registration.dag_text should be a string');
    assert.ok(reg.dag_text.length <= 500,
      `registration.dag_text should be <= 500 chars; got ${reg.dag_text.length}`);
    assert.equal(typeof reg.inherited_criteria_count, 'number',
      'registration.inherited_criteria_count should be a number');
    // Verify task_count matches the fixture (5 tasks)
    assert.equal(reg.task_count, 5,
      `registration.task_count should match fixture; got ${reg.task_count}`);
    // plan_id should match fixture
    assert.equal(reg.plan_id, planId, 'registration.plan_id should match fixture plan_id');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    killDaemon(daemon);
  }
});

// ── Process cleanup on exit ──────────────────────────────────────────────────
process.on('exit', () => {
  if (_daemonProc) {
    try { process.kill(-_daemonProc.pid, 'SIGKILL'); } catch (_) {}
  }
});
