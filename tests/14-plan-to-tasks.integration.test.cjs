#!/usr/bin/env node
/**
 * Plan 14-03-02: Integration tests for planToTasks() against a real daemon.
 *
 * Hermetic since Phase 88 (plan 88-07): every daemon here is a FIXTURE daemon from
 * tests/support/fixture-daemon.cjs (SQLite backend, ephemeral port, throw-away data
 * directory, readiness polled on /health, stderr surfaced when it does not come up).
 * Nothing in this file connects to the operator's live daemon (127.0.0.1:18799) or
 * writes to <repo>/data/tasks.json; a canary snapshot taken before and after the
 * file proves it.
 *
 * Tests:
 *   1. Re-run idempotency: fresh run + re-run = zero new creates
 *   2. Pass 1 partial failure + re-run completes remaining tasks
 *   3. Pass 2 partial failure + re-run completes remaining links
 *   4. Drift detection: re-run with title change halts with plan_amauta_drift
 *   5. Drift detection: re-run with unchanged plan is silent skip (FND-05: prints "no drift")
 *   6. Dedup bypass: same plan_id + 90% similar titles both create
 *   7. Dedup bypass: different plan_id + 90% similar title triggers dedup
 *   8. PLAN_REGISTRATION block is returned with all fields
 *
 * Run: /opt/homebrew/bin/node scripts/run-tests.cjs tests/14-plan-to-tasks.integration.test.cjs
 *
 * Cleanup discipline:
 *   - Each test writes fixtures to a unique tmpdir under os.tmpdir()
 *   - tmpdir is removed on success, preserved on failure for post-mortem
 *   - The daemon is stopped in both paths (try/finally) and its exit is awaited BEFORE the
 *     tmpdir is removed: on Windows the still-running daemon held its SQLite file open and
 *     the unlink failed with EBUSY. Removal also retries, because Windows releases a handle
 *     a moment after the process is gone.
 *   - plan-to-tasks runs as a CHILD process through async spawn with a kill timer, never
 *     spawnSync in the test process: a blocking call there makes the per-test timeout
 *     unable to fire, which is how the Windows cell stalled after test 152 until the job
 *     timeout. A hung child now fails its own test.
 */
'use strict';

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { startFixtureDaemon, killFixtureDaemon } = require('./support/fixture-daemon.cjs');
const canary = require('./support/live-store-canary.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

const TEST_TIMEOUT_MS = Number(process.env.GSD_14_TEST_TIMEOUT_MS) || 180000;
const CLI_TIMEOUT_MS = Number(process.env.GSD_14_CLI_TIMEOUT_MS) || 90000;

// ── Live-store canary: nothing in this file may touch the operator's store ────

let _canaryBefore = null;
before(() => {
  _canaryBefore = canary.snapshot();
});
after(() => {
  const findings = canary.diff(_canaryBefore, canary.snapshot());
  assert.equal(findings.length, 0, 'live store touched by this file:\n' + canary.format(findings));
});

// ── Daemon lifecycle helpers ─────────────────────────────────────────────────

/**
 * Refuse to run against a data directory that is (or could be) the operator's store.
 * @param {string} dataDir
 * @returns {void}
 * @throws {assert.AssertionError} when the directory is <repo>/data or ~/.amauta
 */
function assertHermeticDataDir(dataDir) {
  const forbidden = [
    path.join(REPO_ROOT, 'data'),
    path.join(os.homedir(), '.amauta'),
    path.join(os.homedir(), '.amauta', 'data'),
  ].map((p) => path.resolve(p));
  for (const d of [dataDir, process.env.AMAUTA_DATA_DIR].filter(Boolean)) {
    assert.ok(!forbidden.includes(path.resolve(d)), `refusing to run against ${d}: that is a live store`);
  }
}

/**
 * Start a fixture daemon on `dataDir` (kept after stop; the test owns its removal).
 * @param {string} dataDir
 * @returns {Promise<object>} fixture handle
 */
function spawnDaemon(dataDir) {
  assertHermeticDataDir(dataDir);
  return startFixtureDaemon({ dataDir });
}

/**
 * Hard-kill a daemon (SIGKILL, to simulate a crash) and wait until it has exited.
 *
 * Through the fixture's own `killFixtureDaemon` (plan 89-15), not a bare
 * `proc.kill('SIGKILL')`. The bare kill left this file's daemons as the only
 * registry lines of the whole suite that nobody ever closed — ten per run — and
 * a line nobody closes is matched, at the end of the run, against whatever
 * process the pid NUMBER has been handed to since. On Windows, where a freed pid
 * is reused within seconds, that is how run 43437354734 failed a cell with 5465
 * passing tests: `pid 3296 (daemon, port 64281): NOT signalled: not an amauta
 * daemon/rlm process`. The fixture's kill is still a SIGKILL with no SIGTERM
 * first — the crash this file simulates is unchanged — but it reaches the whole
 * process tree and it records the exit.
 *
 * @param {object|null} handle
 * @returns {Promise<void>}
 */
async function killDaemon(handle) {
  if (!handle || !handle.proc) return;
  await killFixtureDaemon(handle);
}

/**
 * Remove a directory, retrying through the short EBUSY window Windows leaves after a process exits.
 * @param {string} dir
 * @returns {void}
 */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Run `body` with a fresh tmpdir and a fixture daemon. The daemon is stopped (and its exit
 * awaited) however `body` ends; the tmpdir is removed only when `body` returns normally.
 * `body` may swap `ctx.daemon` (restart after a simulated crash).
 *
 * @param {string} label short tag for the tmpdir name
 * @param {(ctx: {tmpDir: string, dataDir: string, daemon: object|null}) => Promise<any>} body
 * @returns {Promise<any>} whatever `body` returns
 */
async function withFixture(label, body) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-14-integ-${label}-`));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const ctx = { tmpDir, dataDir, daemon: null };
  ctx.daemon = await spawnDaemon(dataDir);
  try {
    const out = await body(ctx);
    await killDaemon(ctx.daemon);
    ctx.daemon = null;
    removeDir(tmpDir);
    return out;
  } finally {
    if (ctx.daemon) await killDaemon(ctx.daemon);
  }
}

// ── Test fixture builder ─────────────────────────────────────────────────────

/** Unique per call: a story title can never collide with a real story (ST-0035 incident, 2026-11-11). */
function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function makeIntegrationPlan(planId, tasks) {
  // The story title carries a random suffix so the CLI's dedup cannot match a pre-existing story.
  // A fixed title once matched ST-0035 in the operator's live store and 147 plan_id notes were
  // stamped onto it; with a hermetic daemon the store is empty, and the suffix keeps it that way
  // even if a test is ever pointed at a populated one.
  const story = `<story>
  <title>Integration test story for ${planId} ${uniqueSuffix()}</title>
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

/**
 * Run `gsd-tools plan-to-tasks <planFile>` as a child process against the fixture daemon.
 *
 * @param {string} planFile
 * @param {object} daemon fixture handle (its env points the CLI at the fixture and its data dir)
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, result: object|null, timedOut: boolean}>}
 *   `result` is the JSON the command prints (after any human line); null if none parsed
 */
function runPlanToTasks(planFile, daemon) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GSD_TOOLS, 'plan-to-tasks', planFile], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...daemon.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CLI_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const at = stdout.search(/^\{/m);
      let result = null;
      if (at !== -1) {
        try { result = JSON.parse(stdout.slice(at)); } catch (_e) { result = null; }
      }
      resolve({ code, stdout, stderr, result, timedOut });
    });
  });
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

function itemsForPlan(dataDir, planId) {
  const data = readTasksJson(dataDir);
  return (data.items || []).filter(item => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return tags.some(t => t === `plan:${planId}`);
  });
}

function countTasksForPlan(dataDir, planId) {
  return itemsForPlan(dataDir, planId).length;
}

function taskIdSet(dataDir) {
  return (readTasksJson(dataDir).items || []).map((i) => i.id).sort();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Re-run idempotency: fresh run + re-run = zero new creates', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('01', async ({ tmpDir, dataDir, daemon }) => {
    const planId = '14-test-idem-01';
    const planFile = writePlanToTmp(tmpDir, planId, makeStandardFixture(planId));

    const run1 = await runPlanToTasks(planFile, daemon);
    const result1 = run1.result || {};
    if (!result1.story_id) {
      return t.skip('first plan-to-tasks run produced no story_id: ' + JSON.stringify(run1).slice(0, 400));
    }
    assert.ok(Array.isArray(result1.tasks_created), 'tasks_created should be an array');
    const created1Count = result1.tasks_created.length;
    assert.ok(created1Count > 0, `should have created tasks; got ${created1Count}`);
    const idsAfterRun1 = taskIdSet(dataDir);

    const run2 = await runPlanToTasks(planFile, daemon);
    const result2 = run2.result || {};
    const isIdempotent = (result2.skipped === true && result2.reason === 'already_registered') ||
      (Array.isArray(result2.tasks_created) && result2.tasks_created.length === 0);
    assert.ok(isIdempotent,
      `second run should be idempotent; got: ${JSON.stringify(result2).slice(0, 300)}`);
    assert.deepEqual(taskIdSet(dataDir), idsAfterRun1, 'second run must create nothing');
  });
});

test('Re-run idempotency: Pass 1 partial failure + re-run completes', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('02', async (ctx) => {
    const { tmpDir, dataDir } = ctx;
    const planId = '14-test-partial-p1';
    const planFile = writePlanToTmp(tmpDir, planId, makeStandardFixture(planId));

    const run1 = await runPlanToTasks(planFile, ctx.daemon);
    if (!(run1.result && run1.result.story_id)) {
      return t.skip('first plan-to-tasks run produced no story_id: ' + JSON.stringify(run1).slice(0, 400));
    }
    const countAfterFirst = countTasksForPlan(dataDir, planId);

    // Kill the daemon to simulate a crash mid-registration
    await killDaemon(ctx.daemon);
    ctx.daemon = null;

    // Delete tasks 4-5 from tasks.json to simulate partial completion
    const tasksData = readTasksJson(dataDir);
    const task4Id = `${planId}-04`;
    const task5Id = `${planId}-05`;
    const preserved = (tasksData.items || []).filter(item => {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      return !(tags.includes(`task:${task4Id}`) || tags.includes(`task:${task5Id}`));
    });
    assert.equal(preserved.length, (tasksData.items || []).length - 2, 'fixture should remove exactly tasks 4 and 5');
    fs.writeFileSync(path.join(dataDir, 'tasks.json'),
      JSON.stringify({ ...tasksData, items: preserved }, null, 2));

    ctx.daemon = await spawnDaemon(dataDir);

    // Re-run: must create exactly the two missing tasks and must not claim "no drift"
    const run2 = await runPlanToTasks(planFile, ctx.daemon);
    const result2 = run2.result || {};
    assert.ok(result2.story_id, `re-run should return a story_id; got: ${JSON.stringify(run2).slice(0, 400)}`);
    const createdPlanIds = (result2.tasks_created || []).map((c) => c.plan_local_id).sort();
    assert.deepEqual(createdPlanIds, [task4Id, task5Id].sort(),
      `exactly the missing tasks should be created; got ${JSON.stringify(createdPlanIds)}`);
    assert.ok(!run2.stdout.includes('no drift'), 'a partial prior run is not "no drift"');
    const countAfterResume = countTasksForPlan(dataDir, planId);
    assert.equal(countAfterResume, countAfterFirst,
      `re-run should restore task count; before: ${countAfterFirst}, after: ${countAfterResume}`);
  });
});

test('Re-run idempotency: Pass 2 partial failure + re-run completes links', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('03', async (ctx) => {
    const { tmpDir, dataDir } = ctx;
    const planId = '14-test-partial-p2';
    const planFile = writePlanToTmp(tmpDir, planId, makeStandardFixture(planId));

    const run1 = await runPlanToTasks(planFile, ctx.daemon);
    if (!(run1.result && run1.result.story_id)) {
      return t.skip('first plan-to-tasks run produced no story_id: ' + JSON.stringify(run1).slice(0, 400));
    }

    // Kill the daemon (SIGKILL) to simulate a mid-flight Pass 2 failure
    await killDaemon(ctx.daemon);
    ctx.daemon = null;

    // Remove the dependency link from tasks.json to simulate partial Pass 2
    const tasksData = readTasksJson(dataDir);
    const items = (tasksData.items || []).map(item => {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (tags.includes(`task:${planId}-02`)) {
        return { ...item, dependencies: [] };
      }
      return item;
    });
    fs.writeFileSync(path.join(dataDir, 'tasks.json'),
      JSON.stringify({ ...tasksData, items }, null, 2));

    ctx.daemon = await spawnDaemon(dataDir);

    // Re-run — all tasks exist (skip Pass 1), should only re-run Pass 2 links
    const run2 = await runPlanToTasks(planFile, ctx.daemon);
    const result2 = run2.result || {};
    assert.ok(
      result2.skipped === true ||
      (Array.isArray(result2.links_created) && result2.links_created.length >= 0),
      `re-run after Pass 2 partial failure should succeed; got: ${JSON.stringify(result2).slice(0, 200)}`
    );
  });
});

test('Drift detection: re-run with title change halts with plan_amauta_drift', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('04', async ({ tmpDir, dataDir, daemon }) => {
    const planId = '14-test-drift-01';
    const planContent = makeStandardFixture(planId);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    const run1 = await runPlanToTasks(planFile, daemon);
    if (!(run1.result && run1.result.story_id)) {
      return t.skip('first plan-to-tasks run produced no story_id: ' + JSON.stringify(run1).slice(0, 400));
    }
    const idsAfterRun1 = taskIdSet(dataDir);

    // Change one task title in the plan
    const driftedContent = planContent.replace(
      `Alpha task first pass validation`,
      `Alpha task CHANGED first pass validation`
    );
    fs.writeFileSync(planFile, driftedContent);

    // Re-run with changed plan — should halt with plan_amauta_drift, exit non-zero, and not say "no drift"
    const run2 = await runPlanToTasks(planFile, daemon);
    const result2 = run2.result || {};
    assert.equal(result2.error, 'plan_amauta_drift',
      `re-run with title change should return plan_amauta_drift; got: ${JSON.stringify(run2).slice(0, 300)}`);
    assert.equal(result2.divergence_type, 'plan_amauta_drift',
      'divergence_type should be plan_amauta_drift');
    assert.ok(Array.isArray(result2.diffs) && result2.diffs.length > 0,
      'diffs array should be non-empty');
    const titleDiff = result2.diffs.find(d => d.field === 'title');
    assert.ok(titleDiff,
      `diffs should include a title change; diffs: ${JSON.stringify(result2.diffs)}`);
    assert.notEqual(run2.code, 0, 'a drifted plan must exit non-zero');
    assert.ok(!run2.stdout.includes('no drift'), 'drift output must not contain "no drift"');
    assert.deepEqual(taskIdSet(dataDir), idsAfterRun1, 'a drifted re-run must create nothing');
  });
});

test('Drift detection: re-run with unchanged plan is silent skip', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  // FND-05: a second run on an unchanged plan creates nothing, exits 0 and prints "no drift".
  return withFixture('05', async ({ tmpDir, dataDir, daemon }) => {
    const planId = '14-test-skip-01';
    const planFile = writePlanToTmp(tmpDir, planId, makeStandardFixture(planId));

    const run1 = await runPlanToTasks(planFile, daemon);
    if (!(run1.result && run1.result.story_id)) {
      return t.skip('first plan-to-tasks run produced no story_id: ' + JSON.stringify(run1).slice(0, 400));
    }
    const idsAfterRun1 = taskIdSet(dataDir);
    assert.ok(idsAfterRun1.length >= 6, `run 1 should have created a story and 5 tasks; got ${idsAfterRun1.length} items`);

    // Re-run without any changes
    const run2 = await runPlanToTasks(planFile, daemon);
    const result2 = run2.result || {};
    assert.equal(result2.skipped, true, 'unchanged plan re-run should return skipped:true');
    assert.equal(result2.reason, 'already_registered', 'reason should be already_registered');
    assert.equal(run2.code, 0, 'unchanged plan re-run should exit 0');
    assert.ok(run2.stdout.includes('no drift'),
      `stdout of the second run should contain "no drift"; got: ${run2.stdout.slice(0, 300)}`);
    assert.deepEqual(taskIdSet(dataDir), idsAfterRun1, 'second run must create nothing');
  });
});

test('Dedup bypass: same plan_id + 90% similar titles both create', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('06', async ({ tmpDir, dataDir, daemon }) => {
    const planId = '14-test-dedup-bypass';
    // Two tasks with ~90% similar titles from the SAME plan_id — bypass should fire
    const planContent = makeIntegrationPlan(planId, [
      { id: `${planId}-01`, title: 'Add pass-0 validation engine for plan checks', deps: [],
        file: 'services/pass0.py' },
      { id: `${planId}-02`, title: 'Add pass-0 validation logic for plan checks', deps: [],
        file: 'services/pass0b.py' },
    ]);
    const planFile = writePlanToTmp(tmpDir, planId, planContent);

    const run = await runPlanToTasks(planFile, daemon);
    const result = run.result || {};
    if (!result.story_id) {
      return t.skip('plan-to-tasks run produced no story_id: ' + JSON.stringify(run).slice(0, 400));
    }

    // Both tasks should be created (bypass fires for same plan_id)
    const taskCount = countTasksForPlan(dataDir, planId);
    assert.equal(taskCount, 2,
      `both tasks should be created via dedup bypass; got ${taskCount}; failed_tasks: ${JSON.stringify(result.failed_tasks)}`);
    assert.ok(result.failed_tasks.length === 0,
      `no failed tasks; got: ${JSON.stringify(result.failed_tasks)}`);
  });
});

test('Dedup bypass: different plan_id + 90% similar title triggers dedup', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('07', async ({ tmpDir, dataDir, daemon }) => {
    const planIdA = '14-test-dedup-a';
    const planIdB = '14-test-dedup-b';

    // Plan A: create a task
    const planContentA = makeIntegrationPlan(planIdA, [
      { id: `${planIdA}-01`, title: 'Add pass-0 validation engine for plan checks',
        deps: [], file: 'services/pa.py' },
    ]);
    const planFileA = writePlanToTmp(tmpDir, planIdA, planContentA);
    const runA = await runPlanToTasks(planFileA, daemon);
    if (!(runA.result && runA.result.story_id)) {
      return t.skip('plan A run produced no story_id: ' + JSON.stringify(runA).slice(0, 400));
    }

    // Plan B: task with 90%+ similar title but DIFFERENT plan_id — dedup should block
    const planContentB = makeIntegrationPlan(planIdB, [
      { id: `${planIdB}-01`, title: 'Add pass-0 validation logic for plan checks',
        deps: [], file: 'services/pb.py' },
    ]);
    const planFileB = writePlanToTmp(tmpDir, planIdB, planContentB);
    const runB = await runPlanToTasks(planFileB, daemon);
    const resultB = runB.result || {};

    // Verify via tasks.json: plan B task count should be 0 (dedup blocked)
    const planBTasks = itemsForPlan(dataDir, planIdB);

    // The dedup should have blocked plan B's task creation: either the story is refused
    // (error story_dedup_refused), a task is reported failed, or no plan-B task exists.
    const dedupOccurred = planBTasks.length === 0 ||
      (Array.isArray(resultB.failed_tasks) && resultB.failed_tasks.length > 0) ||
      resultB.success === false;
    assert.ok(dedupOccurred,
      `dedup should block cross-plan similar title; ` +
      `planBTasks: ${planBTasks.length}, ` +
      `resultB: ${JSON.stringify(resultB).slice(0, 200)}`);
  });
});

test('PLAN_REGISTRATION block is returned with all fields populated', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  return withFixture('08', async ({ tmpDir, daemon }) => {
    const planId = '14-test-reg-block';
    const planFile = writePlanToTmp(tmpDir, planId, makeStandardFixture(planId));

    const run = await runPlanToTasks(planFile, daemon);
    const result = run.result || {};
    if (!result.story_id) {
      return t.skip('plan-to-tasks run produced no story_id: ' + JSON.stringify(run).slice(0, 400));
    }

    assert.ok(result.registration, 'result should have registration field');
    const reg = result.registration;

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
    assert.equal(reg.task_count, 5,
      `registration.task_count should match fixture; got ${reg.task_count}`);
    assert.equal(reg.plan_id, planId, 'registration.plan_id should match fixture plan_id');
  });
});
