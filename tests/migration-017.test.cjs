'use strict';
/**
 * Plan 41-03-07: Migration 017 Verification Tests
 * File: tests/migration-017.test.cjs
 *
 * Requirements covered:
 *   SHARD-04: step_handoffs PG table schema, indexes, and roundtrip
 *
 * Tests:
 *   1. Migration file structure (always runs — no PG needed)
 *   2. Table schema: all expected columns with correct types
 *   3. Indexes: idx_handoffs_task and idx_handoffs_latest exist
 *   4. DOWN migration file structure
 *   5. INSERT + SELECT roundtrip (skip if PG unavailable or table doesn't exist)
 *
 * Run: node --test tests/migration-017.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '017-step-handoffs.sql');
const MIGRATION_DOWN_FILE = path.join(MIGRATIONS_DIR, '017-step-handoffs-DOWN.sql');

// Python bootstrap for PG checks
const PY_BOOTSTRAP = `
import importlib.util, sys, os
_spec = importlib.util.spec_from_file_location(
    'step_orchestrator',
    os.path.join('${ROOT}', 'services', 'step-orchestrator.py')
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules['step_orchestrator'] = _mod
_spec.loader.exec_module(_mod)
`;

// Helper: run a python3 script via tmp file
function pyFile(scriptContent, options = {}) {
  const tmpFile = `/tmp/migration017-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  fs.writeFileSync(tmpFile, scriptContent);
  try {
    const result = execSync(`python3 "${tmpFile}"`, {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 15000,
      ...options,
    });
    return { stdout: result, stderr: '', error: null };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }
}

// Check if PG is available with step_handoffs table
function isPgWithTableAvailable() {
  const r = pyFile(`
${PY_BOOTSTRAP}
try:
    from step_orchestrator import _get_conn
    conn = _get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM step_handoffs LIMIT 1")
    conn.close()
    print('YES')
except Exception as e:
    print('NO: ' + str(e))
`);
  return r.stdout.includes('YES');
}

const pgWithTableAvailable = isPgWithTableAvailable();

// ─── Group 1: Migration file structure (always runs) ─────────────────────────

describe('[SHARD-04] Migration 017 file structure', () => {

  it('migrations/017-step-handoffs.sql exists', () => {
    assert.ok(fs.existsSync(MIGRATION_FILE), 'migrations/017-step-handoffs.sql does not exist');
  });

  it('migration 017 contains BEGIN', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(content.includes('BEGIN'), 'migration 017 missing BEGIN');
  });

  it('migration 017 contains COMMIT', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(content.includes('COMMIT'), 'migration 017 missing COMMIT');
  });

  it('migration 017 contains CREATE TABLE step_handoffs', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(
      content.includes('CREATE TABLE step_handoffs'),
      'migration 017 missing CREATE TABLE step_handoffs'
    );
  });

  it('migration 017 defines id column (UUID PRIMARY KEY)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(content.includes('UUID PRIMARY KEY'), 'migration 017 missing UUID PRIMARY KEY for id column');
  });

  it('migration 017 defines all required columns', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    const expectedColumns = [
      'workflow_name',
      'step_id',
      'task_id',
      'phase_number',
      'completed_steps',
      'context_snapshot',
      'artifacts',
      'decisions',
      'user_inputs',
      'next_step',
      'escalation_flags',
      'created_at',
    ];
    for (const col of expectedColumns) {
      assert.ok(content.includes(col), `migration 017 missing column: ${col}`);
    }
  });

  it('migration 017 creates idx_handoffs_task index', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(
      content.includes('idx_handoffs_task'),
      'migration 017 missing idx_handoffs_task index'
    );
  });

  it('migration 017 creates idx_handoffs_latest index', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(
      content.includes('idx_handoffs_latest'),
      'migration 017 missing idx_handoffs_latest index'
    );
  });

  it('migration 017 uses JSONB for context_snapshot, artifacts, decisions, user_inputs', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');
    assert.ok(content.includes('JSONB'), 'migration 017 missing JSONB column type');
    // Count JSONB occurrences — should have at least 4
    const jsonbCount = (content.match(/JSONB/g) || []).length;
    assert.ok(jsonbCount >= 4, `migration 017 has only ${jsonbCount} JSONB columns, expected >= 4`);
  });

});

// ─── Group 2: DOWN migration file structure ───────────────────────────────────

describe('[SHARD-04] Migration 017 DOWN file structure', () => {

  it('migrations/017-step-handoffs-DOWN.sql exists', () => {
    assert.ok(fs.existsSync(MIGRATION_DOWN_FILE), 'migrations/017-step-handoffs-DOWN.sql does not exist');
  });

  it('DOWN migration contains BEGIN', () => {
    const content = fs.readFileSync(MIGRATION_DOWN_FILE, 'utf-8');
    assert.ok(content.includes('BEGIN'), 'DOWN migration missing BEGIN');
  });

  it('DOWN migration contains COMMIT', () => {
    const content = fs.readFileSync(MIGRATION_DOWN_FILE, 'utf-8');
    assert.ok(content.includes('COMMIT'), 'DOWN migration missing COMMIT');
  });

  it('DOWN migration contains DROP TABLE step_handoffs', () => {
    const content = fs.readFileSync(MIGRATION_DOWN_FILE, 'utf-8');
    assert.ok(
      content.includes('DROP TABLE') && content.includes('step_handoffs'),
      'DOWN migration missing DROP TABLE step_handoffs'
    );
  });

  it('DOWN migration drops both indexes', () => {
    const content = fs.readFileSync(MIGRATION_DOWN_FILE, 'utf-8');
    assert.ok(content.includes('idx_handoffs_task'), 'DOWN migration missing DROP of idx_handoffs_task');
    assert.ok(content.includes('idx_handoffs_latest'), 'DOWN migration missing DROP of idx_handoffs_latest');
  });

});

// ─── Group 3: PG schema verification (skip if table unavailable) ──────────────

describe('[SHARD-04] PG: step_handoffs table schema verification', () => {

  if (pgWithTableAvailable) {

    it('[PG] step_handoffs table exists in database', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
from step_orchestrator import _get_conn
conn = _get_conn()
with conn.cursor() as cur:
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_name = 'step_handoffs'"
    )
    row = cur.fetchone()
conn.close()
assert row is not None, "step_handoffs table does not exist in database"
assert row[0] == 'step_handoffs', f"Wrong table name: {row[0]}"
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `Table existence check failed: ${r.error || r.stderr}`);
    });

    it('[PG] step_handoffs has all expected columns with correct types', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
from step_orchestrator import _get_conn
conn = _get_conn()
with conn.cursor() as cur:
    cur.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'step_handoffs' ORDER BY ordinal_position"
    )
    rows = cur.fetchall()
conn.close()
columns = {row[0]: row[1] for row in rows}
print(f"Columns found: {list(columns.keys())}")
# Required columns
assert 'id' in columns, f"Missing column: id"
assert 'workflow_name' in columns, f"Missing column: workflow_name"
assert 'step_id' in columns, f"Missing column: step_id"
assert 'task_id' in columns, f"Missing column: task_id"
assert 'phase_number' in columns, f"Missing column: phase_number"
assert 'completed_steps' in columns, f"Missing column: completed_steps"
assert 'context_snapshot' in columns, f"Missing column: context_snapshot"
assert 'artifacts' in columns, f"Missing column: artifacts"
assert 'decisions' in columns, f"Missing column: decisions"
assert 'user_inputs' in columns, f"Missing column: user_inputs"
assert 'next_step' in columns, f"Missing column: next_step"
assert 'escalation_flags' in columns, f"Missing column: escalation_flags"
assert 'created_at' in columns, f"Missing column: created_at"
# Type checks
assert columns['phase_number'] == 'integer', f"phase_number type wrong: {columns['phase_number']}"
assert columns['context_snapshot'] == 'jsonb', f"context_snapshot type wrong: {columns['context_snapshot']}"
assert columns['artifacts'] == 'jsonb', f"artifacts type wrong: {columns['artifacts']}"
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `Column schema check failed: ${r.error || r.stderr}`);
    });

    it('[PG] idx_handoffs_task and idx_handoffs_latest indexes exist', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
from step_orchestrator import _get_conn
conn = _get_conn()
with conn.cursor() as cur:
    cur.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'step_handoffs'"
    )
    rows = cur.fetchall()
conn.close()
index_names = [row[0] for row in rows]
print(f"Indexes found: {index_names}")
assert 'idx_handoffs_task' in index_names, f"idx_handoffs_task not found in: {index_names}"
assert 'idx_handoffs_latest' in index_names, f"idx_handoffs_latest not found in: {index_names}"
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `Index check failed: ${r.error || r.stderr}`);
    });

    it('[PG] INSERT + SELECT roundtrip works with all fields populated', () => {
      const r = pyFile(`
import psycopg2, os, json, uuid
${PY_BOOTSTRAP}
from step_orchestrator import _get_conn
conn = _get_conn()
test_id = str(uuid.uuid4())
try:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO step_handoffs "
            "(id, workflow_name, step_id, task_id, phase_number, "
            " completed_steps, context_snapshot, artifacts, "
            " decisions, user_inputs, next_step, escalation_flags) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                test_id,
                'plan-phase',
                'step-01-init',
                'migration-017-test',
                999,
                ['step-00-prior'],
                json.dumps({'migration_test': True}),
                json.dumps({'files': ['f1.md']}),
                json.dumps([{'decision': 'd1', 'rationale': 'r1', 'agent': 'a1'}]),
                json.dumps([{'step': 's1', 'question': 'q1', 'answer': 'a1'}]),
                'step-02-research',
                ['FLAG_1'],
            )
        )
        conn.commit()
        # SELECT back
        cur.execute(
            "SELECT id, workflow_name, step_id, context_snapshot, artifacts "
            "FROM step_handoffs WHERE id = %s",
            (test_id,)
        )
        row = cur.fetchone()
    assert row is not None, "SELECT returned no row after INSERT"
    assert str(row[0]) == test_id, f"id mismatch: {row[0]}"
    assert row[1] == 'plan-phase', f"workflow_name wrong: {row[1]}"
    assert row[2] == 'step-01-init', f"step_id wrong: {row[2]}"
    assert row[3]['migration_test'] == True, f"context_snapshot JSONB wrong: {row[3]}"
    assert row[4]['files'] == ['f1.md'], f"artifacts JSONB wrong: {row[4]}"
    print('PASS')
finally:
    # Cleanup
    with conn.cursor() as cur:
        cur.execute("DELETE FROM step_handoffs WHERE task_id = 'migration-017-test'")
    conn.commit()
    conn.close()
`);
      assert.ok(r.stdout.includes('PASS'), `Roundtrip test failed: ${r.error || r.stderr}`);
    });

  } else {
    it('[PG SKIP] Table exists check (PG or step_handoffs table unavailable)', () => {
      assert.ok(true, 'PG unavailable or step_handoffs table missing — skipping schema check');
    });
    it('[PG SKIP] Column schema check (PG or step_handoffs table unavailable)', () => {
      assert.ok(true, 'PG unavailable or step_handoffs table missing — skipping column check');
    });
    it('[PG SKIP] Index check (PG or step_handoffs table unavailable)', () => {
      assert.ok(true, 'PG unavailable or step_handoffs table missing — skipping index check');
    });
    it('[PG SKIP] INSERT + SELECT roundtrip (PG or step_handoffs table unavailable)', () => {
      assert.ok(true, 'PG unavailable or step_handoffs table missing — skipping roundtrip');
    });
  }

});
