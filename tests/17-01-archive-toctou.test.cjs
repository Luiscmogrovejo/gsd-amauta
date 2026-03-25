#!/usr/bin/env node
/**
 * Plan 17-01: Archive Command + TOCTOU Race Fix Tests
 * Pure-function and subprocess tests (no daemon required).
 *
 * Tests:
 *   1. Archive moves done tasks older than N days
 *   2. Archive --dry-run does not modify files
 *   3. Archive is idempotent (second run moves 0)
 *   4. Archive --days 0 moves all done tasks
 *   5. show --archive finds archived task by ID
 *   6. _file_lock is reentrant (no deadlock when save() called inside locked cmd_*)
 *   7. All 17 mutating functions have _file_lock wrapping (AST check)
 *   8. Read-only functions do NOT have _file_lock wrapping (AST check)
 *   9. ARCHIVE_FILE constant exists
 *  10. _load_archive and _save_archive exist
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');

// Create isolated temp data dir for archive tests
const TEST_DATA_DIR = path.join(os.tmpdir(), `amauta-test-archive-${Date.now()}`);

function pyExec(code, opts = {}) {
  return execFileSync('python3', ['-c', code], {
    cwd: ROOT,
    env: {
      ...process.env,
      GSD_AMAUTA_NO_AUTO_START: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      AMAUTA_DATA_DIR: opts.dataDir || TEST_DATA_DIR,
    },
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function amautaCmd(args, opts = {}) {
  return execFileSync('python3', [AMAUTA_PY, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      GSD_AMAUTA_NO_AUTO_START: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      AMAUTA_DATA_DIR: opts.dataDir || TEST_DATA_DIR,
    },
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

// Helper: create test tasks.json with done tasks at various ages
function createTestData(dataDir, items) {
  fs.mkdirSync(dataDir, { recursive: true });
  const data = {
    items: items,
    sprints: [],
    metadata: { created: new Date().toISOString(), version: '2.0', updated: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(data, null, 2));
}

function readTasks(dataDir) {
  const fp = path.join(dataDir, 'tasks.json');
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function readArchive(dataDir) {
  const fp = path.join(dataDir, 'tasks-archive.json');
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

// Generate ISO timestamp N days ago
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

before(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

after(() => {
  // Cleanup temp dir
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
});


describe('Archive Command (TASK-01)', () => {

  it('archives done tasks older than N days', () => {
    const dir = path.join(TEST_DATA_DIR, 'test1');
    createTestData(dir, [
      { id: 'TK-0001', title: 'old done', status: 'done', type: 'task', updated_at: daysAgo(10), created_at: daysAgo(20), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
      { id: 'TK-0002', title: 'recent done', status: 'done', type: 'task', updated_at: daysAgo(2), created_at: daysAgo(5), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
      { id: 'TK-0003', title: 'pending', status: 'pending', type: 'task', updated_at: daysAgo(30), created_at: daysAgo(30), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
    ]);

    const out = amautaCmd(['archive', '--days', '7'], { dataDir: dir });
    assert.ok(out.includes('Archived 1 task'), `Expected 'Archived 1 task' in output: ${out}`);

    const tasks = readTasks(dir);
    assert.equal(tasks.items.length, 2, 'Should have 2 remaining active items');
    assert.ok(!tasks.items.find(i => i.id === 'TK-0001'), 'TK-0001 should be removed from active');
    assert.ok(tasks.items.find(i => i.id === 'TK-0002'), 'TK-0002 should remain (recent done)');
    assert.ok(tasks.items.find(i => i.id === 'TK-0003'), 'TK-0003 should remain (pending)');

    const archive = readArchive(dir);
    assert.ok(archive, 'Archive file should exist');
    assert.equal(archive.items.length, 1, 'Archive should have 1 item');
    assert.equal(archive.items[0].id, 'TK-0001', 'Archived item should be TK-0001');
  });

  it('--dry-run does not modify files', () => {
    const dir = path.join(TEST_DATA_DIR, 'test2');
    createTestData(dir, [
      { id: 'TK-0001', title: 'old done', status: 'done', type: 'task', updated_at: daysAgo(10), created_at: daysAgo(20), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
    ]);

    const tasksBefore = readTasks(dir);
    const out = amautaCmd(['archive', '--days', '7', '--dry-run'], { dataDir: dir });
    assert.ok(out.includes('DRY RUN'), `Expected 'DRY RUN' in output: ${out}`);

    const tasksAfter = readTasks(dir);
    assert.equal(tasksAfter.items.length, tasksBefore.items.length, 'Tasks should not change on dry-run');
    const archive = readArchive(dir);
    assert.equal(archive, null, 'Archive should not be created on dry-run');
  });

  it('archive is idempotent (second run moves 0)', () => {
    const dir = path.join(TEST_DATA_DIR, 'test3');
    createTestData(dir, [
      { id: 'TK-0001', title: 'old done', status: 'done', type: 'task', updated_at: daysAgo(10), created_at: daysAgo(20), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
    ]);

    // First run
    amautaCmd(['archive', '--days', '7'], { dataDir: dir });
    const afterFirst = readTasks(dir);
    assert.equal(afterFirst.items.length, 0, 'First run should archive the task');

    // Second run
    const out2 = amautaCmd(['archive', '--days', '7'], { dataDir: dir });
    assert.ok(out2.includes('No done tasks'), `Expected 'No done tasks' in output: ${out2}`);

    const afterSecond = readTasks(dir);
    assert.equal(afterSecond.items.length, 0, 'Second run should not change anything');

    const archive = readArchive(dir);
    assert.equal(archive.items.length, 1, 'Archive should still have exactly 1 item');
  });

  it('--days 0 archives ALL done tasks', () => {
    const dir = path.join(TEST_DATA_DIR, 'test4');
    createTestData(dir, [
      { id: 'TK-0001', title: 'done today', status: 'done', type: 'task', updated_at: new Date().toISOString(), created_at: new Date().toISOString(), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
      { id: 'TK-0002', title: 'done old', status: 'done', type: 'task', updated_at: daysAgo(30), created_at: daysAgo(30), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
      { id: 'TK-0003', title: 'pending', status: 'pending', type: 'task', updated_at: daysAgo(30), created_at: daysAgo(30), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test' },
    ]);

    const out = amautaCmd(['archive', '--days', '0'], { dataDir: dir });
    assert.ok(out.includes('Archived 2 tasks'), `Expected 'Archived 2 tasks' in output: ${out}`);

    const tasks = readTasks(dir);
    assert.equal(tasks.items.length, 1, 'Only pending task should remain');
    assert.equal(tasks.items[0].id, 'TK-0003', 'Remaining task should be the pending one');

    const archive = readArchive(dir);
    assert.equal(archive.items.length, 2, 'Archive should have 2 items');
  });

  it('show finds archived task by ID (fallback lookup)', () => {
    const dir = path.join(TEST_DATA_DIR, 'test5');
    createTestData(dir, [
      { id: 'TK-0001', title: 'old done', status: 'done', type: 'task', updated_at: daysAgo(10), created_at: daysAgo(20), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test', importance: 3, urgency: 3 },
      { id: 'TK-0002', title: 'pending', status: 'pending', type: 'task', updated_at: daysAgo(1), created_at: daysAgo(1), dependencies: [], notes: [], tags: [], priority: 'medium', assigned_to: 'test', importance: 3, urgency: 3 },
    ]);

    // Archive TK-0001
    amautaCmd(['archive', '--days', '7'], { dataDir: dir });

    // Verify show still finds it via archive fallback
    const out = amautaCmd(['show', 'TK-0001', '--json'], { dataDir: dir });
    const item = JSON.parse(out.replace(/^.*?\n/, '').trim() || out);
    // The output may have the "(found in archive)" prefix line
    assert.ok(out.includes('TK-0001'), `Should find TK-0001 in archive output: ${out}`);
  });
});


describe('TOCTOU Fix -- _file_lock reentrant (TASK-02)', () => {

  it('_file_lock is reentrant (nested acquisition does not deadlock)', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Simulate nested lock: outer lock + inner lock (like cmd_add -> save)
with mod._file_lock():
    # Verify lock is held
    assert getattr(mod._lock_held, 'held', False), 'Lock should be held'
    with mod._file_lock():
        # Inner lock should succeed (reentrant) without deadlock
        assert getattr(mod._lock_held, 'held', False), 'Lock should still be held'
    # After inner exit, lock should still be held (outer owns it)
    assert getattr(mod._lock_held, 'held', False), 'Lock should still be held after inner exit'

# After outer exit, lock should be released
assert not getattr(mod._lock_held, 'held', False), 'Lock should be released after outer exit'
print('OK')
    `);
    assert.equal(out, 'OK');
  });

  it('all 17 mutating cmd_* functions have _file_lock wrapping (AST check)', () => {
    const out = pyExec(`
import sys, ast; sys.path.insert(0, '.')

with open('${AMAUTA_PY}') as f:
    source = f.read()
tree = ast.parse(source)

mutating = [
    'cmd_add', 'cmd_update', 'cmd_status', 'cmd_assign', 'cmd_delete',
    'cmd_claim', 'cmd_rpetd', 'cmd_note', 'cmd_atomize', 'cmd_validate',
    'cmd_refs', 'cmd_risk', 'cmd_sprint',
    'cmd_import', 'cmd_migrate', 'cmd_link', 'cmd_unlink',
]

missing = []
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name in mutating:
        # Check if function body (after docstring) starts with 'with _file_lock():'
        body = node.body
        # Skip docstring if present
        start_idx = 0
        if (body and isinstance(body[0], ast.Expr) and
            isinstance(body[0].value, ast.Constant)):
            start_idx = 1

        found_lock = False
        if start_idx < len(body):
            stmt = body[start_idx]
            if isinstance(stmt, ast.With):
                for item in stmt.items:
                    ctx = item.context_expr
                    if isinstance(ctx, ast.Call):
                        func = ctx.func
                        if isinstance(func, ast.Name) and func.id == '_file_lock':
                            found_lock = True
                            break

        if not found_lock:
            missing.append(node.name)

if missing:
    print(f'MISSING: {missing}')
else:
    print('OK')
    `);
    assert.equal(out, 'OK');
  });

  it('read-only functions do NOT have _file_lock wrapping (AST check)', () => {
    const out = pyExec(`
import sys, ast; sys.path.insert(0, '.')

with open('${AMAUTA_PY}') as f:
    source = f.read()
tree = ast.parse(source)

readonly = [
    'cmd_show', 'cmd_list', 'cmd_board', 'cmd_search', 'cmd_score',
    'cmd_next', 'cmd_agent_tasks', 'cmd_stats', 'cmd_export', 'cmd_audit',
]

incorrectly_locked = []
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name in readonly:
        body = node.body
        start_idx = 0
        if (body and isinstance(body[0], ast.Expr) and
            isinstance(body[0].value, ast.Constant)):
            start_idx = 1

        has_lock = False
        if start_idx < len(body):
            stmt = body[start_idx]
            if isinstance(stmt, ast.With):
                for item in stmt.items:
                    ctx = item.context_expr
                    if isinstance(ctx, ast.Call):
                        func = ctx.func
                        if isinstance(func, ast.Name) and func.id == '_file_lock':
                            has_lock = True
                            break

        if has_lock:
            incorrectly_locked.append(node.name)

if incorrectly_locked:
    print(f'INCORRECTLY LOCKED: {incorrectly_locked}')
else:
    print('OK')
    `);
    assert.equal(out, 'OK');
  });

  it('save() still acquires lock internally (safe for standalone calls)', () => {
    const out = pyExec(`
import sys, ast; sys.path.insert(0, '.')

with open('${AMAUTA_PY}') as f:
    source = f.read()
tree = ast.parse(source)

# Verify save() function has _file_lock in its body
found = False
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == 'save':
        for stmt in node.body:
            if isinstance(stmt, ast.With):
                for item in stmt.items:
                    ctx = item.context_expr
                    if isinstance(ctx, ast.Call):
                        func = ctx.func
                        if isinstance(func, ast.Name) and func.id == '_file_lock':
                            found = True
print('OK' if found else 'FAIL: save() does not have _file_lock')
    `);
    assert.equal(out, 'OK');
  });
});


describe('Archive Constants and Helpers', () => {

  it('ARCHIVE_FILE constant exists and points to tasks-archive.json', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
af = str(mod.ARCHIVE_FILE)
print('OK' if af.endswith('tasks-archive.json') else f'WRONG: {af}')
    `);
    assert.equal(out, 'OK');
  });

  it('_load_archive and _save_archive functions exist', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
has_load = hasattr(mod, '_load_archive')
has_save = hasattr(mod, '_save_archive')
print('OK' if has_load and has_save else f'MISSING: load={has_load} save={has_save}')
    `);
    assert.equal(out, 'OK');
  });

  it('_load_archive returns empty structure when no archive file', () => {
    const out = pyExec(`
import sys, os; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
data = mod._load_archive()
ok = isinstance(data, dict) and isinstance(data.get('items'), list) and len(data['items']) == 0
print('OK' if ok else f'WRONG: {data}')
    `);
    assert.equal(out, 'OK');
  });

  it('archive argparse subcommand is registered', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
parser = mod.build_parser()
# Verify archive command is accepted
try:
    args = parser.parse_args(['archive', '--days', '14', '--dry-run'])
    ok = args.command == 'archive' and args.days == 14 and args.dry_run == True
    print('OK' if ok else f'WRONG: {vars(args)}')
except SystemExit:
    print('FAIL: archive not registered')
    `);
    assert.equal(out, 'OK');
  });
});
