#!/usr/bin/env node
/**
 * Task Lifecycle Tests -- state machine, dependency enforcement, retry queue
 * Pure-function tests via Python subprocess (no daemon required).
 *
 * Tests:
 *   1. ALLOWED_TRANSITIONS is a dict with all STATUSES as keys
 *   2. Each status has at least one allowed transition
 *   3. "done" is NOT reachable directly from "pending" (must go through in-progress)
 *   4. "failed" is reachable from pending, in-progress, and validation
 *   5. _deps_met returns True when all deps are done
 *   6. _deps_met returns False when any dep is not done
 *   7. _deps_met returns True when there are no dependencies
 *   8. PG retry queue defines enqueue_retry and flush_retry_queue
 *   9. SQLite store has enqueue_retry and flush_retry_queue stubs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');
const PG_STORE = path.join(ROOT, 'services', 'pg_store.py');

function pyExec(code) {
  return execFileSync('python3', ['-c', code], {
    cwd: ROOT,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
    timeout: 10000,
  }).trim();
}

describe('State Machine (TASK-02)', () => {
  it('ALLOWED_TRANSITIONS has all STATUSES as keys', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
missing = [s for s in mod.STATUSES if s not in mod.ALLOWED_TRANSITIONS]
print('OK' if not missing else f'MISSING: {missing}')
    `);
    assert.equal(out, 'OK');
  });

  it('pending cannot transition directly to done', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print('done' not in mod.ALLOWED_TRANSITIONS.get('pending', set()))
    `);
    assert.equal(out, 'True');
  });

  it('failed is reachable from pending, in-progress, and validation', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
for s in ['pending', 'in-progress', 'validation']:
    assert 'failed' in mod.ALLOWED_TRANSITIONS[s], f'failed not reachable from {s}'
print('OK')
    `);
    assert.equal(out, 'OK');
  });

  it('each status has at least one allowed transition', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
empty = [s for s, t in mod.ALLOWED_TRANSITIONS.items() if not t]
print('OK' if not empty else f'EMPTY: {empty}')
    `);
    assert.equal(out, 'OK');
  });
});

describe('Dependency Enforcement (TASK-03)', () => {
  it('_deps_met returns True when all deps are done', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
items = [
    {"id": "TK-0001", "status": "done"},
    {"id": "TK-0002", "status": "done"},
    {"id": "TK-0003", "dependencies": ["TK-0001", "TK-0002"], "status": "in-progress"},
]
print(mod._deps_met(items[2], items))
    `);
    assert.equal(out, 'True');
  });

  it('_deps_met returns False when any dep is not done', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
items = [
    {"id": "TK-0001", "status": "done"},
    {"id": "TK-0002", "status": "in-progress"},
    {"id": "TK-0003", "dependencies": ["TK-0001", "TK-0002"], "status": "in-progress"},
]
print(mod._deps_met(items[2], items))
    `);
    assert.equal(out, 'False');
  });

  it('_deps_met returns True when no dependencies', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
item = {"id": "TK-0001", "dependencies": [], "status": "in-progress"}
print(mod._deps_met(item, [item]))
    `);
    assert.equal(out, 'True');
  });
});

describe('PG Retry Queue (TASK-01)', () => {
  it('pg_store.py defines enqueue_retry and flush_retry_queue', () => {
    const out = pyExec(`
import ast
with open('${PG_STORE}') as f:
    tree = ast.parse(f.read())
names = [n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
has_enqueue = 'enqueue_retry' in names
has_flush = 'flush_retry_queue' in names
print('OK' if has_enqueue and has_flush else f'MISSING enqueue={has_enqueue} flush={has_flush}')
    `);
    assert.equal(out, 'OK');
  });

  it('sqlite_store.py has enqueue_retry and flush_retry_queue stubs', () => {
    const out = pyExec(`
import ast
with open('services/sqlite_store.py') as f:
    tree = ast.parse(f.read())
names = [n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
has_enqueue = 'enqueue_retry' in names
has_flush = 'flush_retry_queue' in names
print('OK' if has_enqueue and has_flush else f'MISSING enqueue={has_enqueue} flush={has_flush}')
    `);
    assert.equal(out, 'OK');
  });
});

describe('Rich Board (TASK-04)', () => {
  it('_rpetd_indicator returns indicators for each phase', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
item = {"rpetd_phases": {"R": "researched", "P": "planned", "E": "", "T": "", "D": ""}}
result = mod._rpetd_indicator(item)
# Strip ANSI for checking content
import re
clean = re.sub(r'\\033\\[[0-9;]*m', '', result)
print(clean)
    `);
    // Should contain all 5 phase letters
    assert.ok(out.includes('R'), 'missing R');
    assert.ok(out.includes('P'), 'missing P');
    assert.ok(out.includes('E'), 'missing E');
    assert.ok(out.includes('T'), 'missing T');
    assert.ok(out.includes('D'), 'missing D');
  });

  it('_rpetd_indicator shows check for filled phases', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util, re
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
item = {"rpetd_phases": {"R": "done", "P": "done", "E": "done", "T": "done", "D": "done"}}
result = mod._rpetd_indicator(item)
clean = re.sub(r'\\033\\[[0-9;]*m', '', result)
checks = clean.count('\\u2713')
print(checks)
    `);
    assert.equal(out, '5');
  });

  it('_dep_badge returns empty for no deps', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
item = {"id": "TK-0001", "dependencies": []}
print(repr(mod._dep_badge(item, [item])))
    `);
    assert.equal(out, "''");
  });

  it('_dep_badge shows blocking count for unmet deps', () => {
    const out = pyExec(`
import sys; sys.path.insert(0, '.')
import importlib.util, re
spec = importlib.util.spec_from_file_location('amauta', '${AMAUTA_PY}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
items = [
    {"id": "TK-0001", "status": "in-progress"},
    {"id": "TK-0002", "status": "pending"},
    {"id": "TK-0003", "dependencies": ["TK-0001", "TK-0002"], "status": "in-progress"},
]
result = mod._dep_badge(items[2], items)
clean = re.sub(r'\\033\\[[0-9;]*m', '', result)
print(clean.strip())
    `);
    assert.ok(out.includes('blocked:2'), `expected blocked:2 but got: ${out}`);
  });
});
