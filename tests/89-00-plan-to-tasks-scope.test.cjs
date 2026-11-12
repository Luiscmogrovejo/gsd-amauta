#!/usr/bin/env node
/**
 * Plan 89-00: `plan-to-tasks` registers a plan into the SHARED task store, and before this plan
 * every lookup it made was global:
 *
 *   1. the plan id was read from `plan_id:` only, so a plan whose frontmatter says `plan: 89-01`
 *      (the spelling every Phase 88/89 plan uses) registered as the string `null` — tag
 *      `plan:null`, note `plan_id:null`, `--from-plan null`;
 *   2. 319 pre-existing tasks carry `plan:null`, so the "story of this plan" fallback adopted an
 *      unrelated story and parented every new task under it;
 *   3. the idempotency map was built from `task:<local id>` tags across EVERY project, so another
 *      project's `task:89-01-01` was accepted as this plan's task — and Pass 2 then wrote
 *      dependency links onto that project's rows;
 *   4. `add` was called without --project/--project-dir, so nothing recorded a project at all.
 *
 * Each test below fails on master:
 *   a. `plan:` frontmatter is the plan id; tags are plan:89-01, never plan:null  (master: plan:null)
 *   b. no plan id at all → typed error `plan_id_missing`, store byte-identical  (master: creates)
 *   c. a foreign-project story + its `plan:null`,`task:89-01-0N` tasks are not adopted and not
 *      linked; a NEW story and NEW tasks are created                            (master: adopts)
 *   d. a `plan:`-keyed plan re-run in the same project is idempotent             (master: plan:null)
 *   e. created story and tasks record the caller's project                       (master: null)
 *
 * Hermetic: every test owns a temp AMAUTA_DATA_DIR and a temp project directory; no daemon is
 * started and none is used (GSD_TEST_MODE=1 + port 0 = the direct CLI path), so nothing here can
 * reach the operator's store on 127.0.0.1:18799. A live-store canary around the file proves it.
 *
 * Run: node scripts/run-tests.cjs tests/89-00-plan-to-tasks-scope.test.cjs
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

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const tools = require(GSD_TOOLS);
const canary = require('./support/live-store-canary.cjs');

const {
  _planIdFromFrontmatter,
  _callerProjectId,
  _itemProjectId,
  _itemClaimsPlan,
  _scopePlanItems,
  _loadRegisteredTasks,
} = tools;

const TEST_TIMEOUT_MS = Number(process.env.GSD_89_TEST_TIMEOUT_MS) || 180000;
const CLI_TIMEOUT_MS = Number(process.env.GSD_89_CLI_TIMEOUT_MS) || 120000;

let _canaryBefore = null;
before(() => {
  _canaryBefore = canary.snapshot();
});
after(() => {
  const findings = canary.diff(_canaryBefore, canary.snapshot());
  assert.equal(findings.length, 0, 'live store touched by this file:\n' + canary.format(findings));
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** @returns {string} 8 hex chars, so no title can collide with a real story. */
function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Build a plan file whose frontmatter uses `key` for the plan id (`plan`, `plan_id`, or a key
 * that is neither, for the missing-id case).
 * @param {string} planId
 * @param {string} key frontmatter key to carry the id
 * @param {{id: string, title: string, deps?: string[]}[]} tasks
 * @returns {string} plan file text
 */
function makePlan(planId, key, tasks) {
  const taskBlocks = tasks.map((t) => `<task id="${t.id}">
  <title>${t.title}</title>
  <agent>executor-backend</agent>
  <depends_on>${JSON.stringify(t.deps || [])}</depends_on>
  <read_first>
    - tests/89-00-plan-to-tasks-scope.test.cjs
  </read_first>
  <action>Do the work for ${t.id}.</action>
  <acceptance_criteria>
    - grep "${t.id}" some/file
  </acceptance_criteria>
  <files_expected>
    modify:
      - services/scope_${t.id.replace(/[^a-z0-9]/gi, '_')}.py
    create: []
    delete: []
  </files_expected>
</task>`);

  return `---
phase: 89
${key}: ${planId}
wave: 1
---

# Plan ${planId}

<story>
  <title>Scope test story ${planId} ${uniqueSuffix()}</title>
  <success_criteria>
    Given the plan fixture exists,
    When plan-to-tasks registers it,
    Then only this project's items of this plan are touched.
  </success_criteria>
  <doc_refs>
    - tests/89-00-plan-to-tasks-scope.test.cjs
  </doc_refs>
</story>

${taskBlocks.join('\n\n')}
`;
}

/** The two-task shape used by the end-to-end tests (02 depends on 01). */
function twoTasks(planId) {
  return [
    { id: `${planId}-01`, title: `Alpha scope task of ${planId}`, deps: [] },
    { id: `${planId}-02`, title: `Beta scope task of ${planId}`, deps: [`${planId}-01`] },
  ];
}

/**
 * A tasks.json the Python store can load: the top-level keys `load()` expects plus `items`.
 * @param {object[]} items
 * @returns {string} JSON text
 */
function storeFile(items) {
  return JSON.stringify({
    items,
    sprints: [],
    metadata: { created: '2026-04-01T00:00:00Z', version: '2.0', updated: '2026-04-01T00:00:00Z' },
  }, null, 2);
}

/**
 * Create a temp root with a data dir and a project dir. The project dir declares its own
 * project id in .planning/config.json, which is rule 3 of amauta.py's `_resolve_project_id`
 * and therefore the same answer on every platform (no dependence on which directory os.tmpdir()
 * happens to be, or on whether an ancestor holds .git).
 *
 * @param {string} label short tag for the directory name
 * @param {object[]|null} seedItems items to pre-seed tasks.json with, or null for a fresh store
 * @returns {{tmpRoot: string, dataDir: string, projDir: string, projectId: string}}
 */
function makeWorkspace(label, seedItems) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-89-00-${label}-`));
  const dataDir = path.join(tmpRoot, 'data');
  const projDir = path.join(tmpRoot, 'project');
  const projectId = `scope-${label}-${uniqueSuffix()}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(projDir, '.planning', 'config.json'), JSON.stringify({ project_id: projectId }, null, 2));
  if (seedItems) fs.writeFileSync(path.join(dataDir, 'tasks.json'), storeFile(seedItems));
  return { tmpRoot, dataDir, projDir, projectId };
}

/** Remove a directory, retrying through the EBUSY window Windows leaves after a child exits. */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Run `gsd-tools plan-to-tasks <planFile>` as a CHILD process (never spawnSync, so a hung child
 * fails its own test instead of stalling the per-test timeout) with no daemon reachable.
 *
 * @param {string} planFile absolute path
 * @param {{dataDir: string, projDir: string}} ws
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, result: object|null, timedOut: boolean}>}
 */
function runPlanToTasks(planFile, ws) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GSD_TEST_MODE: '1',
      AMAUTA_DATA_DIR: ws.dataDir,
      // Port 0 is reachable by nothing: `ensureDaemon` fails its probe and, under
      // GSD_TEST_MODE, refuses to start one — every `add`/`link` goes direct to amauta.py.
      GSD_AMAUTA_PORT: '0',
      GSD_DAEMON_PORT: '0',
      GSD_RLM_PORT: '0',
      GSD_AMAUTA_NO_AUTO_START: '1',
      GSD_FORCE_SQLITE: '1',
      AMAUTA_MEMORY_DATABASE_URL: '',
      GSD_POSTGRES_URL: '',
      AMAUTA_AUTO_BACKUP: 'off',
    };
    delete env.AMAUTA_PROJECT_ID;  // the project must come from the caller directory, not the runner
    const child = spawn(process.execPath, [GSD_TOOLS, 'plan-to-tasks', planFile], {
      cwd: ws.projDir,
      env,
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

function readItems(dataDir) {
  const raw = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function itemById(items, id) {
  return items.find((i) => i.id === id) || null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The foreign fixture: another project's story and the two tasks that carry THIS plan's local ids. */
function foreignItems() {
  const mk = (id, localId) => ({
    id,
    type: 'task',
    title: `Foreign project task ${id}`,
    status: 'pending',
    assigned_to: 'executor-backend',
    project_id: null,
    parent: 'ST-9001',
    dependencies: [],
    tags: ['plan:null', `task:${localId}`],
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  });
  return [
    {
      id: 'ST-9001',
      type: 'story',
      title: 'Foreign project story that parents the plan:null class',
      status: 'pending',
      assigned_to: 'operator',
      project_id: null,
      children: ['TK-9001', 'TK-9002'],
      dependencies: [],
      tags: [],
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    },
    mk('TK-9001', '89-01-01'),
    mk('TK-9002', '89-01-02'),
  ];
}

// ── Unit: the plan id comes from the frontmatter, and `plan:` counts ─────────

test('plan id: `plan:` in the frontmatter is the plan id, and `plan_id:` still wins', () => {
  assert.equal(_planIdFromFrontmatter('---\nphase: 89\nplan: 89-01\n---\nbody\n'), '89-01');
  assert.equal(_planIdFromFrontmatter('---\nplan_id: 14-03\n---\n'), '14-03');
  // Both present: plan_id: is the explicit spelling and takes precedence.
  assert.equal(_planIdFromFrontmatter('---\nplan_id: 14-03\nplan: 89-01\n---\n'), '14-03');
  assert.equal(_planIdFromFrontmatter('---\nplan: "89-02"\n---\n'), '89-02');
  assert.equal(_planIdFromFrontmatter('---\r\nplan: 89-03\r\n---\r\n'), '89-03', 'CRLF checkout');
});

test('plan id: the BODY is never searched, and a literal null reads as absent', () => {
  assert.equal(_planIdFromFrontmatter('---\nphase: 89\n---\n\nText mentioning plan_id: 89-04 in prose\n'), null);
  assert.equal(_planIdFromFrontmatter('# No frontmatter\nplan: 89-05\n'), null);
  assert.equal(_planIdFromFrontmatter('---\nplan: null\n---\n'), null);
  assert.equal(_planIdFromFrontmatter('---\nplan_id:\nplan:\n---\n'), null);
  assert.equal(_planIdFromFrontmatter('---\nplan_title: Something\n---\n'), null, '`plan_title:` is not `plan:`');
  assert.equal(_planIdFromFrontmatter(''), null);
});

// ── Unit: the caller's project, by amauta.py's rule ─────────────────────────

test('project: .planning/config.json beats inference, then repo root, then the directory name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-89-00-proj-'));
  try {
    // Rule 5: no git tree, no config — the directory's own name.
    const plain = path.join(root, 'plain-dir');
    fs.mkdirSync(plain);
    assert.equal(_callerProjectId(plain), 'plain-dir');

    // Rule 4: basename of the nearest ancestor holding .git.
    const repo = path.join(root, 'my-repo');
    const nested = path.join(repo, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere\n');  // a .git FILE counts
    assert.equal(_callerProjectId(nested), 'my-repo');

    // Rule 3: an explicitly configured id wins over the repository name.
    fs.mkdirSync(path.join(nested, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.planning', 'config.json'), JSON.stringify({ project_id: 'declared-id' }));
    assert.equal(_callerProjectId(nested), 'declared-id');
    fs.writeFileSync(path.join(nested, '.planning', 'config.json'), JSON.stringify({ project: { id: 'nested-id' } }));
    assert.equal(_callerProjectId(nested), 'nested-id');
    fs.writeFileSync(path.join(nested, '.planning', 'config.json'), '{ not json');
    assert.equal(_callerProjectId(nested), 'my-repo', 'a malformed config must never block registration');

    // Rule 2: the environment override.
    const saved = process.env.AMAUTA_PROJECT_ID;
    process.env.AMAUTA_PROJECT_ID = 'env-id';
    try {
      assert.equal(_callerProjectId(nested), 'env-id');
    } finally {
      if (saved === undefined) delete process.env.AMAUTA_PROJECT_ID;
      else process.env.AMAUTA_PROJECT_ID = saved;
    }

    // An item's project reads the same way the Python store reads it.
    assert.equal(_itemProjectId({ project_id: 'p' }), 'p');
    assert.equal(_itemProjectId({ project_id: null }), 'default');
    assert.equal(_itemProjectId({}), 'default');
  } finally {
    removeDir(root);
  }
});

// ── Unit: the scope filter itself ───────────────────────────────────────────

test('scope: a foreign project\'s identical `task:<local id>` tag is NOT a match', () => {
  const mine = { id: 'TK-1', type: 'task', project_id: 'mine', parent: 'ST-1', tags: ['plan:89-01', 'task:89-01-01'] };
  const foreign = { id: 'TK-9001', type: 'task', project_id: null, parent: 'ST-9001', tags: ['plan:null', 'task:89-01-01'] };
  const otherProjectSamePlan = { id: 'TK-2', type: 'task', project_id: 'theirs', tags: ['plan:89-01', 'task:89-01-02'] };
  const otherPlanSameProject = { id: 'TK-3', type: 'task', project_id: 'mine', tags: ['plan:89-02', 'task:89-02-01'] };
  const myStory = { id: 'ST-1', type: 'story', project_id: 'mine', tags: [] };
  const foreignStory = { id: 'ST-9001', type: 'story', project_id: null, tags: [] };

  const scoped = _scopePlanItems(
    [mine, foreign, otherProjectSamePlan, otherPlanSameProject, myStory, foreignStory],
    { planId: '89-01', projectId: 'mine' });
  const ids = scoped.map((i) => i.id).sort();
  assert.deepEqual(ids, ['ST-1', 'TK-1'], 'only this plan in this project, plus its own parent story');

  assert.equal(_itemClaimsPlan(foreign, '89-01'), false, 'a task: tag alone is not a claim on the plan');
  assert.equal(_itemClaimsPlan(mine, '89-01'), true);
  assert.equal(_itemClaimsPlan({ project_id: 'mine', metadata: { plan_id: '89-01' } }, '89-01'), true);

  // The plan:null class can never be a match, whatever the caller's project is.
  assert.deepEqual(_scopePlanItems([foreign, foreignStory], { planId: '89-01', projectId: 'default' }), []);
  // No plan id scopes to nothing at all.
  assert.deepEqual(_scopePlanItems([mine, myStory], { planId: null, projectId: 'mine' }), []);
  assert.deepEqual(_scopePlanItems([mine, myStory], { planId: '', projectId: 'mine' }), []);
});

test('scope: _loadRegisteredTasks applies it, and a missing or corrupt file still yields nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-89-00-seam-'));
  try {
    const items = [
      { id: 'ST-1', type: 'story', project_id: 'mine', tags: [] },
      { id: 'TK-1', type: 'task', project_id: 'mine', parent: 'ST-1', tags: ['plan:89-01', 'task:89-01-01'] },
      { id: 'TK-9001', type: 'task', project_id: null, parent: 'ST-9001', tags: ['plan:null', 'task:89-01-01'] },
      { id: 'ST-9001', type: 'story', project_id: null, tags: [] },
    ];
    fs.writeFileSync(path.join(dir, 'tasks.json'), storeFile(items));
    const scoped = await _loadRegisteredTasks({ dataDir: dir, planId: '89-01', projectId: 'mine' });
    assert.equal(scoped.source, 'tasks.json');
    assert.deepEqual(scoped.tasks.map((i) => i.id).sort(), ['ST-1', 'TK-1']);

    const otherProject = await _loadRegisteredTasks({ dataDir: dir, planId: '89-01', projectId: 'theirs' });
    assert.deepEqual(otherProject.tasks, [], 'another project sees none of it');

    const missing = await _loadRegisteredTasks({ dataDir: path.join(dir, 'nope'), planId: '89-01', projectId: 'mine' });
    assert.deepEqual(missing, { source: 'tasks.json', tasks: [] });
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{ not json');
    const corrupt = await _loadRegisteredTasks({ dataDir: dir, planId: '89-01', projectId: 'mine' });
    assert.deepEqual(corrupt, { source: 'tasks.json', tasks: [] });
  } finally {
    removeDir(dir);
  }
});

// ── End to end (a): `plan:` is accepted and no `null` reaches the store ─────

test('a. `plan:` frontmatter registers as 89-01: tags are plan:89-01, never plan:null',
  { timeout: TEST_TIMEOUT_MS }, async () => {
    const ws = makeWorkspace('a', null);
    const planFile = path.join(ws.projDir, '89-01-PLAN.md');
    fs.writeFileSync(planFile, makePlan('89-01', 'plan', twoTasks('89-01')));

    const run = await runPlanToTasks(planFile, ws);
    assert.equal(run.timedOut, false, 'plan-to-tasks must not hang');
    assert.ok(run.result, `expected JSON on stdout; got ${run.stdout.slice(0, 300)} / ${run.stderr.slice(0, 300)}`);
    assert.equal(run.result.plan_id, '89-01', `plan id must come from \`plan:\`; got ${JSON.stringify(run.result).slice(0, 300)}`);
    assert.equal(run.result.success, true, JSON.stringify(run.result).slice(0, 400));

    const items = readItems(ws.dataDir);
    const tasks = items.filter((i) => i.type === 'task');
    assert.equal(tasks.length, 2);
    for (const lid of ['89-01-01', '89-01-02']) {
      const t = tasks.find((i) => (i.tags || []).includes(`task:${lid}`));
      assert.ok(t, `a task tagged task:${lid} must exist`);
      assert.ok((t.tags || []).includes('plan:89-01'), `task ${lid} must be tagged plan:89-01; got ${JSON.stringify(t.tags)}`);
      assert.equal((t.metadata || {}).plan_id, '89-01', '--from-plan must carry the real id');
    }
    const serialized = JSON.stringify(items);
    assert.ok(!serialized.includes('plan:null'), 'no item may carry the tag plan:null');
    assert.ok(!serialized.includes('plan_id:null'), 'no note may say plan_id:null');
    assert.ok(!serialized.includes('"plan_id": null'), 'no metadata may hold a null plan id');

    removeDir(ws.tmpRoot);
  });

// ── End to end (b): no plan id is a refusal that creates nothing ────────────

test('b. a plan with no plan id returns plan_id_missing and leaves the store byte-identical',
  { timeout: TEST_TIMEOUT_MS }, async () => {
    const ws = makeWorkspace('b', foreignItems());
    const tasksFile = path.join(ws.dataDir, 'tasks.json');
    const before = fs.readFileSync(tasksFile);
    const beforeSha = sha256(tasksFile);

    const planFile = path.join(ws.projDir, 'no-id-PLAN.md');
    // `noplan:` is neither spelling, so the frontmatter declares no id at all.
    fs.writeFileSync(planFile, makePlan('89-01', 'noplan', twoTasks('89-01')));

    const run = await runPlanToTasks(planFile, ws);
    assert.equal(run.timedOut, false);
    assert.ok(run.result, `expected JSON on stdout; got ${run.stdout.slice(0, 300)}`);
    assert.equal(run.result.error, 'plan_id_missing', JSON.stringify(run.result).slice(0, 400));
    assert.equal(run.code, 1, 'a typed error exits non-zero');
    assert.equal(sha256(tasksFile), beforeSha, 'nothing may be created without a plan id');
    assert.equal(fs.readFileSync(tasksFile).equals(before), true, 'tasks.json must be byte-identical');

    removeDir(ws.tmpRoot);
  });

// ── End to end (c): another project's items are never adopted ──────────────

test('c. a foreign project\'s plan:null items with this plan\'s local ids are neither adopted nor linked',
  { timeout: TEST_TIMEOUT_MS }, async () => {
    const seeded = foreignItems();
    const ws = makeWorkspace('c', seeded);
    const planFile = path.join(ws.projDir, '89-01-PLAN.md');
    fs.writeFileSync(planFile, makePlan('89-01', 'plan', twoTasks('89-01')));

    const run = await runPlanToTasks(planFile, ws);
    assert.equal(run.timedOut, false);
    assert.ok(run.result, `expected JSON on stdout; got ${run.stdout.slice(0, 300)}`);
    assert.equal(run.result.success, true, JSON.stringify(run.result).slice(0, 500));

    // A NEW story, not the foreign one.
    assert.ok(run.result.story_id, 'a story must be created');
    assert.notEqual(run.result.story_id, 'ST-9001', 'the foreign story must not be adopted');
    // NEW tasks for BOTH local ids — none "already registered".
    assert.deepEqual((run.result.tasks_created || []).map((c) => c.plan_local_id).sort(),
      ['89-01-01', '89-01-02'], JSON.stringify(run.result).slice(0, 500));
    assert.deepEqual(run.result.tasks_skipped, [], 'no foreign task may be mistaken for this plan\'s');
    for (const c of run.result.tasks_created) {
      assert.ok(!['TK-9001', 'TK-9002'].includes(c.amauta_id), `created id ${c.amauta_id} is a foreign task`);
    }

    // The foreign items are untouched: same content, no new dependency, no new child.
    const items = readItems(ws.dataDir);
    for (const original of seeded) {
      const now = itemById(items, original.id);
      assert.ok(now, `${original.id} must still exist`);
      assert.deepEqual(now, original, `${original.id} must be unchanged`);
      assert.equal(JSON.stringify(now), JSON.stringify(original), `${original.id} must be byte-identical`);
    }
    // The link this plan declares landed between the two NEW tasks.
    const created = run.result.tasks_created.reduce((m, c) => ({ ...m, [c.plan_local_id]: c.amauta_id }), {});
    const second = itemById(items, created['89-01-02']);
    assert.deepEqual(second.dependencies, [created['89-01-01']],
      'the dependency must point at this plan\'s own task');

    removeDir(ws.tmpRoot);
  });

// ── End to end (d): the same plan, same project, twice ─────────────────────

test('d. a second run of an unchanged `plan:`-keyed plan in the same project creates nothing',
  { timeout: TEST_TIMEOUT_MS }, async () => {
    const ws = makeWorkspace('d', null);
    const planFile = path.join(ws.projDir, '89-01-PLAN.md');
    fs.writeFileSync(planFile, makePlan('89-01', 'plan', twoTasks('89-01')));

    const first = await runPlanToTasks(planFile, ws);
    assert.ok(first.result && first.result.success === true, JSON.stringify(first.result).slice(0, 400));
    const afterFirst = readItems(ws.dataDir);
    assert.ok(afterFirst.every((i) => !(i.tags || []).includes('plan:null')), 'nothing may be tagged plan:null');
    assert.equal(afterFirst.filter((i) => (i.tags || []).includes('plan:89-01')).length, 2);
    const idsAfterFirst = afterFirst.map((i) => i.id).sort();

    const second = await runPlanToTasks(planFile, ws);
    assert.ok(second.result, `expected JSON on stdout; got ${second.stdout.slice(0, 300)}`);
    assert.equal(second.result.skipped, true, JSON.stringify(second.result).slice(0, 400));
    assert.equal(second.result.reason, 'already_registered');
    assert.equal(second.result.story_id, first.result.story_id, 'the same story is reused, not a new one');
    assert.ok(second.stdout.includes('no drift'), 'an unchanged plan reports no drift');
    assert.deepEqual(readItems(ws.dataDir).map((i) => i.id).sort(), idsAfterFirst, 'a second run creates nothing');

    removeDir(ws.tmpRoot);
  });

// ── End to end (e): everything created records the project ─────────────────

test('e. the story and every task created record the caller\'s project',
  { timeout: TEST_TIMEOUT_MS }, async () => {
    const ws = makeWorkspace('e', null);
    const planFile = path.join(ws.projDir, '89-01-PLAN.md');
    fs.writeFileSync(planFile, makePlan('89-01', 'plan', twoTasks('89-01')));

    const run = await runPlanToTasks(planFile, ws);
    assert.ok(run.result && run.result.success === true, JSON.stringify(run.result).slice(0, 400));
    assert.equal(run.result.project_id, ws.projectId, 'the run reports the project it resolved');

    const items = readItems(ws.dataDir);
    assert.equal(items.length, 3, 'one story and two tasks');
    for (const item of items) {
      assert.equal(item.project_id, ws.projectId,
        `${item.id} (${item.type}) must record project ${ws.projectId}; got ${JSON.stringify(item.project_id)}`);
    }

    removeDir(ws.tmpRoot);
  });
