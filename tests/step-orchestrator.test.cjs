'use strict';
/**
 * Plan 41-03-01: Step Orchestrator Unit Tests
 * File: tests/step-orchestrator.test.cjs
 *
 * Requirements covered:
 *   SHARD-04: StepHandoff model, step-orchestrator.py public functions
 *
 * Tests all 5 public functions of step-orchestrator.py:
 *   load_or_create_handoff, save_handoff, get_next_step, rollback_step, validate_handoff
 *
 * Uses python3 subprocess calls for testing. Loads module via importlib because
 * the filename uses a hyphen (step-orchestrator.py), which is not a valid Python
 * module name for standard import.
 *
 * PG-dependent tests skip gracefully if PG is unavailable.
 *
 * Run: node --test tests/step-orchestrator.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORCHESTRATOR_PATH = path.join(ROOT, 'services', 'step-orchestrator.py');

// Python bootstrap: load module via importlib (handles hyphen in filename)
const PY_BOOTSTRAP = `
import importlib.util, sys, os
_spec = importlib.util.spec_from_file_location(
    'step_orchestrator',
    os.path.join('${ROOT}', 'services', 'step-orchestrator.py')
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules['step_orchestrator'] = _mod
_spec.loader.exec_module(_mod)
from step_orchestrator import (
    WORKFLOW_STEPS, StepHandoff, validate_handoff,
    get_next_step, load_or_create_handoff, save_handoff, rollback_step
)
`;

// Helper: run a python3 script via tmp file (cwd=ROOT)
function pyFile(scriptContent, options = {}) {
  const tmpFile = `/tmp/orch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  fs.writeFileSync(tmpFile, scriptContent);
  try {
    const result = execSync(`python3 "${tmpFile}"`, {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 20000,
      ...options,
    });
    return { stdout: result, stderr: '', error: null };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }
}

// Check if PG is available AND step_handoffs table exists
function isPgAvailable() {
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

const pgAvailable = isPgAvailable();

// ─── Group 1: File existence and structure ────────────────────────────────────

describe('[SHARD-04] step-orchestrator.py exists and is importable', () => {

  it('services/step-orchestrator.py exists', () => {
    assert.ok(
      fs.existsSync(ORCHESTRATOR_PATH),
      'services/step-orchestrator.py does not exist'
    );
  });

  it('step-orchestrator.py defines load_or_create_handoff', () => {
    const content = fs.readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    assert.ok(content.includes('def load_or_create_handoff'), 'Missing load_or_create_handoff');
  });

  it('step-orchestrator.py defines save_handoff', () => {
    const content = fs.readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    assert.ok(content.includes('def save_handoff'), 'Missing save_handoff');
  });

  it('step-orchestrator.py defines get_next_step', () => {
    const content = fs.readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    assert.ok(content.includes('def get_next_step'), 'Missing get_next_step');
  });

  it('step-orchestrator.py defines rollback_step', () => {
    const content = fs.readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    assert.ok(content.includes('def rollback_step'), 'Missing rollback_step');
  });

  it('step-orchestrator.py defines validate_handoff', () => {
    const content = fs.readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    assert.ok(content.includes('def validate_handoff'), 'Missing validate_handoff');
  });

  it('module is importable via importlib (no syntax errors)', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
print('IMPORT_OK')
`);
    assert.ok(r.stdout.includes('IMPORT_OK'), `Import failed: ${r.error || r.stderr}`);
  });

});

// ─── Group 2: WORKFLOW_STEPS constant validation ──────────────────────────────

describe('[SHARD-04] WORKFLOW_STEPS constant validation', () => {

  it('plan-phase has exactly 5 steps', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
assert len(WORKFLOW_STEPS['plan-phase']) == 5, f"Expected 5, got {len(WORKFLOW_STEPS['plan-phase'])}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `plan-phase step count wrong: ${r.error || r.stderr}`);
  });

  it('execute-phase has exactly 6 steps', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
assert len(WORKFLOW_STEPS['execute-phase']) == 6, f"Expected 6, got {len(WORKFLOW_STEPS['execute-phase'])}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `execute-phase step count wrong: ${r.error || r.stderr}`);
  });

  it('discuss-phase has exactly 4 steps', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
assert len(WORKFLOW_STEPS['discuss-phase']) == 4, f"Expected 4, got {len(WORKFLOW_STEPS['discuss-phase'])}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `discuss-phase step count wrong: ${r.error || r.stderr}`);
  });

  it('all step names follow pattern step-NN-name', () => {
    const r = pyFile(`
import re
${PY_BOOTSTRAP}
pattern = re.compile(r'^step-\\d{2}-[a-z]+$')
for wf, steps in WORKFLOW_STEPS.items():
    for step in steps:
        assert pattern.match(step), f"Step '{step}' in '{wf}' does not match step-NN-name pattern"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Step naming pattern wrong: ${r.error || r.stderr}`);
  });

  it('plan-phase first step is step-01-init and last is step-05-approve', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
steps = WORKFLOW_STEPS['plan-phase']
assert steps[0] == 'step-01-init', f"First step is {steps[0]}"
assert steps[-1] == 'step-05-approve', f"Last step is {steps[-1]}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `plan-phase step order wrong: ${r.error || r.stderr}`);
  });

});

// ─── Group 3: validate_handoff (pure logic — no PG needed) ────────────────────

describe('[SHARD-04] validate_handoff — rejects invalid handoffs', () => {

  it('valid handoff passes validation', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-01-init',
    task_id='test-validate-01',
    phase_number=99,
    context_snapshot={'key': 'value'}
)
valid, errors = validate_handoff(h)
assert valid, f'Expected valid but got errors: {errors}'
assert errors == [], f'Expected empty errors, got: {errors}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Valid handoff failed: ${r.error || r.stderr}`);
  });

  it('missing workflow_name is rejected', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='',
    step_id='step-01-init',
    task_id='test-validate-02',
    phase_number=99,
    context_snapshot={}
)
valid, errors = validate_handoff(h)
assert not valid, 'Expected invalid for empty workflow_name'
assert len(errors) > 0, 'Expected at least one error'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Missing workflow_name not rejected: ${r.error || r.stderr}`);
  });

  it('invalid workflow_name is rejected', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='invalid-workflow',
    step_id='step-01-init',
    task_id='test-validate-03',
    phase_number=99,
    context_snapshot={}
)
valid, errors = validate_handoff(h)
assert not valid, 'Expected invalid for unknown workflow_name'
assert any('invalid-workflow' in e for e in errors), f'Expected error mentioning invalid-workflow: {errors}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Invalid workflow_name not rejected: ${r.error || r.stderr}`);
  });

  it('invalid step_id is rejected', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-99-nonexistent',
    task_id='test-validate-04',
    phase_number=99,
    context_snapshot={}
)
valid, errors = validate_handoff(h)
assert not valid, 'Expected invalid for bad step_id'
assert len(errors) > 0, f'Expected errors, got: {errors}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Invalid step_id not rejected: ${r.error || r.stderr}`);
  });

  it('context_snapshot too large (>2400 chars) is rejected', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
big_value = 'x' * 2500
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-01-init',
    task_id='test-validate-05',
    phase_number=99,
    context_snapshot={'data': big_value}
)
valid, errors = validate_handoff(h)
assert not valid, 'Expected invalid for oversized context_snapshot'
assert any('600-token' in e or 'exceeds' in e for e in errors), f'Expected size error: {errors}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Oversized context_snapshot not rejected: ${r.error || r.stderr}`);
  });

});

// ─── Group 4: get_next_step (pure logic — no PG needed) ───────────────────────

describe('[SHARD-04] get_next_step — returns correct sequence', () => {

  it('get_next_step returns step-02-research for step-01-init in plan-phase', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-01-init',
    task_id='test-next-01',
    phase_number=99,
    context_snapshot={}
)
result = get_next_step(h)
assert result == 'steps/step-02-research.md', f'Expected steps/step-02-research.md, got: {result}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `get_next_step step-01 failed: ${r.error || r.stderr}`);
  });

  it('get_next_step returns None for last step (step-05-approve) in plan-phase', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-05-approve',
    task_id='test-next-02',
    phase_number=99,
    context_snapshot={}
)
result = get_next_step(h)
assert result is None, f'Expected None for last step, got: {result}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `get_next_step last step failed: ${r.error || r.stderr}`);
  });

  it('get_next_step returns None for last step (step-06-close) in execute-phase', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='execute-phase',
    step_id='step-06-close',
    task_id='test-next-03',
    phase_number=99,
    context_snapshot={}
)
result = get_next_step(h)
assert result is None, f'Expected None for last execute step, got: {result}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `get_next_step execute last step failed: ${r.error || r.stderr}`);
  });

  it('get_next_step returns None for unknown workflow', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='unknown-phase',
    step_id='step-01-init',
    task_id='test-next-04',
    phase_number=99,
    context_snapshot={}
)
result = get_next_step(h)
assert result is None, f'Expected None for unknown workflow, got: {result}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `get_next_step unknown workflow failed: ${r.error || r.stderr}`);
  });

});

// ─── Group 5: load_or_create_handoff fresh path (always-runs) ─────────────────

describe('[SHARD-04] load_or_create_handoff — fresh handoff creation', () => {

  it('creates fresh handoff with first step when no PG record exists', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
handoff = load_or_create_handoff('plan-phase', 99999, 'test-lc-fresh-99999')
assert handoff.workflow_name == 'plan-phase', f'workflow_name wrong: {handoff.workflow_name}'
assert handoff.step_id == 'step-01-init', f'step_id wrong: {handoff.step_id}'
assert handoff.next_step == 'step-02-research', f'next_step wrong: {handoff.next_step}'
assert handoff.completed_steps == [], f'completed_steps should be empty: {handoff.completed_steps}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `load_or_create_handoff fresh path failed: ${r.error || r.stderr}`);
  });

  it('fresh handoff for discuss-phase has step-01-scout as first step', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
handoff = load_or_create_handoff('discuss-phase', 99999, 'test-discuss-fresh-99999')
assert handoff.step_id == 'step-01-scout', f'step_id wrong: {handoff.step_id}'
assert handoff.next_step == 'step-02-analyze', f'next_step wrong: {handoff.next_step}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `discuss-phase fresh handoff failed: ${r.error || r.stderr}`);
  });

});

// ─── Group 6: PG-dependent tests ──────────────────────────────────────────────

describe('[SHARD-04] PG-dependent: save_handoff + rollback_step', () => {

  if (pgAvailable) {
    it('[PG] save_handoff persists and load_or_create_handoff retrieves it', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-02-research',
    task_id='test-save-retrieve-01',
    phase_number=99,
    context_snapshot={'research_done': True},
    completed_steps=['step-01-init'],
    next_step='step-03-plan'
)
save_handoff(h)
loaded = load_or_create_handoff('plan-phase', 99, 'test-save-retrieve-01')
assert loaded.step_id == 'step-02-research', f'step_id wrong: {loaded.step_id}'
assert loaded.task_id == 'test-save-retrieve-01', f'task_id wrong: {loaded.task_id}'
assert loaded.workflow_name == 'plan-phase', f'workflow_name wrong: {loaded.workflow_name}'
assert loaded.phase_number == 99, f'phase_number wrong: {loaded.phase_number}'
# Cleanup
db_url = os.environ.get('DATABASE_URL') or os.environ.get('GSD_POSTGRES_URL') or 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta'
conn = psycopg2.connect(db_url)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute("DELETE FROM step_handoffs WHERE task_id LIKE 'test-save-retrieve-%'")
conn.close()
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `save/load roundtrip failed: ${r.error || r.stderr}`);
    });

    it('[PG] rollback_step reverts to target with truncated completed_steps', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-04-check',
    task_id='test-rollback-01',
    phase_number=99,
    context_snapshot={'phase': 'test'},
    completed_steps=['step-01-init', 'step-02-research', 'step-03-plan'],
    next_step='step-05-approve'
)
save_handoff(h)
rolled = rollback_step(h, 'step-02-research')
assert rolled.step_id == 'step-02-research', f'step_id wrong after rollback: {rolled.step_id}'
assert rolled.completed_steps == ['step-01-init'], f'completed_steps wrong: {rolled.completed_steps}'
assert rolled.next_step == 'step-03-plan', f'next_step wrong after rollback: {rolled.next_step}'
# Cleanup
db_url = os.environ.get('DATABASE_URL') or os.environ.get('GSD_POSTGRES_URL') or 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta'
conn = psycopg2.connect(db_url)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute("DELETE FROM step_handoffs WHERE task_id LIKE 'test-rollback-%'")
conn.close()
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `rollback_step failed: ${r.error || r.stderr}`);
    });
  } else {
    it('[PG SKIP] save_handoff + load roundtrip (PG unavailable — graceful skip)', () => {
      assert.ok(true, 'PG unavailable — skipping roundtrip test');
    });

    it('[PG SKIP] rollback_step (PG unavailable — graceful skip)', () => {
      assert.ok(true, 'PG unavailable — skipping rollback test');
    });
  }

  it('rollback_step raises ValueError for step not in completed_steps', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-03-plan',
    task_id='test-rollback-err',
    phase_number=99,
    context_snapshot={},
    completed_steps=['step-01-init', 'step-02-research']
)
try:
    rollback_step(h, 'step-05-approve')
    print('ERROR: expected ValueError not raised')
except ValueError:
    print('PASS')
except Exception as e:
    print(f'ERROR: unexpected exception: {type(e).__name__}: {e}')
`);
    assert.ok(r.stdout.includes('PASS'), `rollback ValueError not raised: ${r.error || r.stderr}`);
  });

});
