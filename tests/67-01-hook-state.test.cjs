'use strict';

// 67-01-01: hook-state.cjs — local marker store + claim-time manifest
// resolution + the shared findTaskItem() array lookup.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_STATE_PATH = path.resolve(__dirname, '../get-shit-done/bin/lib/hook-state.cjs');
const hookState = require(HOOK_STATE_PATH);

const ORIGINAL_AMAUTA_DATA_DIR = process.env.AMAUTA_DATA_DIR;
const ORIGINAL_CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function restoreEnv() {
  if (ORIGINAL_AMAUTA_DATA_DIR === undefined) delete process.env.AMAUTA_DATA_DIR;
  else process.env.AMAUTA_DATA_DIR = ORIGINAL_AMAUTA_DATA_DIR;
  if (ORIGINAL_CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL_CLAUDE_PROJECT_DIR;
}

test('67-01-01: writeActiveTask/readActiveTasks round-trip', () => {
  const tmpData = freshTmpDir('hook-state-rt-');
  process.env.AMAUTA_DATA_DIR = tmpData;
  try {
    const ok = hookState.writeActiveTask('TK-9001', {
      plan_task_id: '99-01-01',
      plan_id: '99-01',
      phase: '99',
      agent: 'executor-backend',
      claimed_at: new Date().toISOString(),
      files_expected: { modify: [], create: ['foo.js'], delete: [] },
    });
    assert.equal(ok, true);
    const { version, tasks } = hookState.readActiveTasks();
    assert.equal(version, 1);
    assert.ok(tasks['TK-9001']);
    assert.deepEqual(tasks['TK-9001'].files_expected.create, ['foo.js']);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: TTL expiry filters out stale entries', () => {
  const tmpData = freshTmpDir('hook-state-ttl-');
  process.env.AMAUTA_DATA_DIR = tmpData;
  try {
    const staleIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    hookState.writeActiveTask('TK-9002', {
      plan_task_id: '99-01-01',
      plan_id: '99-01',
      phase: '99',
      agent: 'a',
      claimed_at: staleIso,
      files_expected: null,
    });
    const { tasks } = hookState.readActiveTasks();
    assert.equal(tasks['TK-9002'], undefined);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: corrupt marker JSON fails open to empty result', () => {
  const tmpData = freshTmpDir('hook-state-corrupt-');
  process.env.AMAUTA_DATA_DIR = tmpData;
  try {
    fs.writeFileSync(hookState.markerPath(), '{not valid json');
    const result = hookState.readActiveTasks();
    assert.deepEqual(result, { version: 1, tasks: {} });
  } finally {
    restoreEnv();
  }
});

test('67-01-01: pruneActiveTask removes entry', () => {
  const tmpData = freshTmpDir('hook-state-prune-');
  process.env.AMAUTA_DATA_DIR = tmpData;
  try {
    hookState.writeActiveTask('TK-9003', {
      plan_task_id: '99-01-01',
      plan_id: '99-01',
      phase: '99',
      agent: 'a',
      claimed_at: new Date().toISOString(),
      files_expected: null,
    });
    const pruned = hookState.pruneActiveTask('TK-9003');
    assert.equal(pruned, true);
    const { tasks } = hookState.readActiveTasks();
    assert.equal(tasks['TK-9003'], undefined);

    // Pruning an absent entry returns false rather than throwing.
    const prunedAgain = hookState.pruneActiveTask('TK-9003');
    assert.equal(prunedAgain, false);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: resolveManifestForTask parses fixture plan file', () => {
  const tmpRoot = freshTmpDir('hook-state-plan-');
  try {
    const phaseDir = path.join(tmpRoot, '.planning', 'phases', '99-fixture');
    fs.mkdirSync(phaseDir, { recursive: true });
    const planContent = [
      '---',
      'plan_id: 99-01',
      '---',
      '',
      '<task id="99-01-01">',
      '<title>Fixture Task</title>',
      '<agent>executor-backend</agent>',
      '<files_expected>',
      'modify:',
      '  - fixtures/mod.js',
      'create:',
      '  - fixtures/new.js',
      'delete: []',
      '</files_expected>',
      '</task>',
    ].join('\n');
    fs.writeFileSync(path.join(phaseDir, '99-01-PLAN.md'), planContent);

    const taskItem = { tags: ['plan:99-01', 'task:99-01-01'] };
    const manifest = hookState.resolveManifestForTask(taskItem, { cwd: tmpRoot });
    assert.ok(manifest);
    assert.deepEqual(manifest.modify, ['fixtures/mod.js']);
    assert.deepEqual(manifest.create, ['fixtures/new.js']);
    assert.deepEqual(manifest.delete, []);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: resolveManifestForTask returns null when plan file is missing', () => {
  const tmpRoot = freshTmpDir('hook-state-noplan-');
  try {
    const taskItem = { tags: ['plan:88-01', 'task:88-01-01'] };
    const manifest = hookState.resolveManifestForTask(taskItem, { cwd: tmpRoot });
    assert.equal(manifest, null);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: resolveManifestForTask returns null when tags are absent', () => {
  const manifest = hookState.resolveManifestForTask({ tags: [] }, { cwd: freshTmpDir('hook-state-notags-') });
  assert.equal(manifest, null);
  assert.equal(hookState.resolveManifestForTask(null), null);
});

test('67-01-01: findTaskItem returns the array element by id, null for absent id', () => {
  const tmpData = freshTmpDir('hook-state-find-');
  try {
    fs.writeFileSync(
      path.join(tmpData, 'tasks.json'),
      JSON.stringify({ items: [{ id: 'TK-9001', title: 'x' }, { id: 'TK-9002', title: 'y' }] })
    );
    const found = hookState.findTaskItem('TK-9001', { dataDirPath: tmpData });
    assert.ok(found);
    assert.equal(found.id, 'TK-9001');

    const notFound = hookState.findTaskItem('TK-9999', { dataDirPath: tmpData });
    assert.equal(notFound, null);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: findTaskItem returns null for map-shaped items (guards items[tk] bug)', () => {
  const tmpData = freshTmpDir('hook-state-mapshape-');
  try {
    fs.writeFileSync(
      path.join(tmpData, 'tasks.json'),
      JSON.stringify({ items: { 'TK-9001': { id: 'TK-9001' } } })
    );
    const found = hookState.findTaskItem('TK-9001', { dataDirPath: tmpData });
    assert.equal(found, null);
  } finally {
    restoreEnv();
  }
});

test('67-01-01: findTaskItem fails open to null on missing/corrupt tasks.json', () => {
  const tmpData = freshTmpDir('hook-state-missing-');
  try {
    const missing = hookState.findTaskItem('TK-1', { dataDirPath: tmpData });
    assert.equal(missing, null);

    fs.writeFileSync(path.join(tmpData, 'tasks.json'), '{not valid json');
    const corrupt = hookState.findTaskItem('TK-1', { dataDirPath: tmpData });
    assert.equal(corrupt, null);
  } finally {
    restoreEnv();
  }
});
