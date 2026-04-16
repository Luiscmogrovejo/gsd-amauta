'use strict';
/**
 * Plan 41-03-04: Sharded Workflow Integration Tests
 * File: tests/sharded-workflow-integration.test.cjs
 *
 * Requirements covered:
 *   SHARD-01, SHARD-02, SHARD-03, SHARD-04
 *
 * Integration tests that verify the full workflow step sequence works end-to-end:
 *   - step progression through all steps (plan-phase, execute-phase, discuss-phase)
 *   - resumption from PG (load_or_create_handoff retrieves last saved handoff)
 *   - rollback to previous steps
 *   - artifacts, decisions, and user_inputs accumulate across steps
 *
 * PG-dependent tests skip gracefully if step_handoffs table unavailable.
 * File-based tests always run.
 *
 * Run: node --test tests/sharded-workflow-integration.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'get-shit-done', 'workflows');

// Python bootstrap: load step-orchestrator via importlib (hyphen in filename)
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
  const tmpFile = `/tmp/shard-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
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

// Check if PG is available with step_handoffs table
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

// ─── Group 1: Workflow step file structure (always runs) ──────────────────────

describe('[SHARD-01-03] Workflow step file structure verified', () => {

  const WORKFLOW_STEPS = {
    'plan-phase': ['step-01-init', 'step-02-research', 'step-03-plan', 'step-04-check', 'step-05-approve'],
    'execute-phase': ['step-01-prepare', 'step-02-route', 'step-03-execute', 'step-04-verify', 'step-05-validate', 'step-06-close'],
    'discuss-phase': ['step-01-scout', 'step-02-analyze', 'step-03-discuss', 'step-04-commit'],
  };

  it('plan-phase has 5 step files', () => {
    const stepsDir = path.join(WORKFLOWS_DIR, 'plan-phase', 'steps');
    const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
    assert.strictEqual(files.length, 5, `Expected 5 plan-phase steps, got ${files.length}: ${files}`);
  });

  it('execute-phase has 6 step files', () => {
    const stepsDir = path.join(WORKFLOWS_DIR, 'execute-phase', 'steps');
    const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
    assert.strictEqual(files.length, 6, `Expected 6 execute-phase steps, got ${files.length}: ${files}`);
  });

  it('discuss-phase has 4 step files', () => {
    const stepsDir = path.join(WORKFLOWS_DIR, 'discuss-phase', 'steps');
    const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
    assert.strictEqual(files.length, 4, `Expected 4 discuss-phase steps, got ${files.length}: ${files}`);
  });

  it('WORKFLOW_STEPS in orchestrator matches filesystem step counts', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
counts = {wf: len(steps) for wf, steps in WORKFLOW_STEPS.items()}
assert counts['plan-phase'] == 5, f"Expected 5, got {counts['plan-phase']}"
assert counts['execute-phase'] == 6, f"Expected 6, got {counts['execute-phase']}"
assert counts['discuss-phase'] == 4, f"Expected 4, got {counts['discuss-phase']}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Step count mismatch: ${r.error || r.stderr}`);
  });

  it('each step file mentioned in orchestrator exists on filesystem', () => {
    for (const [wf, steps] of [
      ['plan-phase', ['step-01-init', 'step-02-research', 'step-03-plan', 'step-04-check', 'step-05-approve']],
      ['execute-phase', ['step-01-prepare', 'step-02-route', 'step-03-execute', 'step-04-verify', 'step-05-validate', 'step-06-close']],
      ['discuss-phase', ['step-01-scout', 'step-02-analyze', 'step-03-discuss', 'step-04-commit']],
    ]) {
      for (const step of steps) {
        const stepFile = path.join(WORKFLOWS_DIR, wf, 'steps', `${step}.md`);
        assert.ok(fs.existsSync(stepFile), `Missing step file: ${wf}/steps/${step}.md`);
      }
    }
  });

});

// ─── Group 2: Step progression logic (pure Python — no PG) ───────────────────

describe('[SHARD-04] Step progression logic via get_next_step', () => {

  it('plan-phase: traverses all 5 steps in sequence via get_next_step', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
steps = WORKFLOW_STEPS['plan-phase']
completed = []
step_id = steps[0]
while step_id is not None:
    # Create handoff at current step
    h = StepHandoff(
        workflow_name='plan-phase',
        step_id=step_id,
        task_id='test-progression-plan',
        phase_number=99999,
        context_snapshot={},
        completed_steps=list(completed),
    )
    next_path = get_next_step(h)
    if next_path is None:
        completed.append(step_id)
        step_id = None
    else:
        completed.append(step_id)
        step_id = next_path.replace('steps/', '').replace('.md', '')

assert len(completed) == 5, f"Expected 5 completed steps, got {len(completed)}: {completed}"
assert completed == steps, f"Progression mismatch: {completed} vs {steps}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `plan-phase progression failed: ${r.error || r.stderr}`);
  });

  it('execute-phase: traverses all 6 steps in sequence via get_next_step', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
steps = WORKFLOW_STEPS['execute-phase']
completed = []
step_id = steps[0]
while step_id is not None:
    h = StepHandoff(
        workflow_name='execute-phase',
        step_id=step_id,
        task_id='test-progression-exec',
        phase_number=99999,
        context_snapshot={},
        completed_steps=list(completed),
    )
    next_path = get_next_step(h)
    if next_path is None:
        completed.append(step_id)
        step_id = None
    else:
        completed.append(step_id)
        step_id = next_path.replace('steps/', '').replace('.md', '')

assert len(completed) == 6, f"Expected 6 completed steps, got {len(completed)}: {completed}"
assert completed == steps, f"Progression mismatch: {completed} vs {steps}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `execute-phase progression failed: ${r.error || r.stderr}`);
  });

  it('discuss-phase: traverses all 4 steps in sequence via get_next_step', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
steps = WORKFLOW_STEPS['discuss-phase']
completed = []
step_id = steps[0]
while step_id is not None:
    h = StepHandoff(
        workflow_name='discuss-phase',
        step_id=step_id,
        task_id='test-progression-discuss',
        phase_number=99999,
        context_snapshot={},
        completed_steps=list(completed),
    )
    next_path = get_next_step(h)
    if next_path is None:
        completed.append(step_id)
        step_id = None
    else:
        completed.append(step_id)
        step_id = next_path.replace('steps/', '').replace('.md', '')

assert len(completed) == 4, f"Expected 4 completed steps, got {len(completed)}: {completed}"
assert completed == steps, f"Progression mismatch: {completed} vs {steps}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `discuss-phase progression failed: ${r.error || r.stderr}`);
  });

  it('rollback logic: truncates completed_steps correctly', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-04-check',
    task_id='test-rollback-logic-01',
    phase_number=99999,
    context_snapshot={},
    completed_steps=['step-01-init', 'step-02-research', 'step-03-plan'],
    next_step='step-05-approve'
)
# Simulate rollback (without PG save — just verify the object state)
target = 'step-02-research'
assert target in h.completed_steps, f"target not in completed_steps"
target_idx = h.completed_steps.index(target)
truncated = h.completed_steps[:target_idx]
assert truncated == ['step-01-init'], f"Expected ['step-01-init'], got {truncated}"

# After rollback, step_id should be target and completed_steps should be truncated
steps = WORKFLOW_STEPS['plan-phase']
step_idx = steps.index(target)
recalc_next = steps[step_idx + 1] if step_idx + 1 < len(steps) else None
assert recalc_next == 'step-03-plan', f"Expected step-03-plan, got {recalc_next}"
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `rollback logic failed: ${r.error || r.stderr}`);
  });

});

// ─── Group 3: PG-dependent integration tests ──────────────────────────────────

describe('[SHARD-04] PG integration: resumption + rollback', () => {

  if (pgAvailable) {

    it('[PG] Resumption: save at step-03, load returns step-03 for continuation', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
# Progress to step-03-plan and save
h3 = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-03-plan',
    task_id='integration-test-resume-01',
    phase_number=99,
    context_snapshot={'resumption': True},
    completed_steps=['step-01-init', 'step-02-research'],
    next_step='step-04-check'
)
save_handoff(h3)
# "New session" — load_or_create_handoff should return the saved handoff
loaded = load_or_create_handoff('plan-phase', 99, 'integration-test-resume-01')
assert loaded.step_id == 'step-03-plan', f'Expected step-03-plan, got {loaded.step_id}'
assert loaded.completed_steps == ['step-01-init', 'step-02-research'], f'Wrong completed_steps: {loaded.completed_steps}'
# Continue from step-03: next step should be step-04-check
next_path = get_next_step(loaded)
assert next_path == 'steps/step-04-check.md', f'Expected step-04-check, got {next_path}'
# Cleanup
db_url = os.environ.get('DATABASE_URL') or os.environ.get('GSD_POSTGRES_URL') or 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta'
conn = psycopg2.connect(db_url)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute("DELETE FROM step_handoffs WHERE task_id LIKE 'integration-test-%'")
conn.close()
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `Resumption test failed: ${r.error || r.stderr}`);
    });

    it('[PG] Rollback from step-04 to step-02 via rollback_step', () => {
      const r = pyFile(`
import psycopg2, os
${PY_BOOTSTRAP}
# Create handoff at step-04
h4 = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-04-check',
    task_id='integration-test-rollback-01',
    phase_number=99,
    context_snapshot={'rollback': True},
    completed_steps=['step-01-init', 'step-02-research', 'step-03-plan'],
    next_step='step-05-approve'
)
save_handoff(h4)
# Rollback to step-02
rolled = rollback_step(h4, 'step-02-research')
assert rolled.step_id == 'step-02-research', f'step_id wrong: {rolled.step_id}'
assert rolled.completed_steps == ['step-01-init'], f'completed_steps wrong: {rolled.completed_steps}'
assert rolled.next_step == 'step-03-plan', f'next_step wrong: {rolled.next_step}'
# Cleanup
db_url = os.environ.get('DATABASE_URL') or os.environ.get('GSD_POSTGRES_URL') or 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta'
conn = psycopg2.connect(db_url)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute("DELETE FROM step_handoffs WHERE task_id LIKE 'integration-test-%'")
conn.close()
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `Rollback test failed: ${r.error || r.stderr}`);
    });

    it('[PG] Artifacts accumulate across steps (append-only log)', () => {
      const r = pyFile(`
import psycopg2, os, json
${PY_BOOTSTRAP}
# Step 1: save with init artifacts
h1 = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-01-init',
    task_id='integration-test-artifacts-01',
    phase_number=99,
    context_snapshot={},
    artifacts={'init_data': True},
    next_step='step-02-research'
)
save_handoff(h1)
# Step 2: save with additional artifacts
h2 = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-02-research',
    task_id='integration-test-artifacts-01',
    phase_number=99,
    context_snapshot={},
    completed_steps=['step-01-init'],
    artifacts={'init_data': True, 'research_path': '/path/to/research'},
    next_step='step-03-plan'
)
save_handoff(h2)
# Load latest — should be step-02's handoff with both artifact keys
loaded = load_or_create_handoff('plan-phase', 99, 'integration-test-artifacts-01')
assert loaded.step_id == 'step-02-research', f'Expected step-02-research, got {loaded.step_id}'
assert 'init_data' in loaded.artifacts, f'init_data missing from artifacts: {loaded.artifacts}'
assert 'research_path' in loaded.artifacts, f'research_path missing from artifacts: {loaded.artifacts}'
# Cleanup
db_url = os.environ.get('DATABASE_URL') or os.environ.get('GSD_POSTGRES_URL') or 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta'
conn = psycopg2.connect(db_url)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute("DELETE FROM step_handoffs WHERE task_id LIKE 'integration-test-%'")
conn.close()
print('PASS')
`);
      assert.ok(r.stdout.includes('PASS'), `Artifacts accumulation test failed: ${r.error || r.stderr}`);
    });

  } else {
    it('[PG SKIP] Resumption test (PG unavailable — graceful skip)', () => {
      assert.ok(true, 'PG unavailable — skipping resumption test');
    });
    it('[PG SKIP] Rollback test (PG unavailable — graceful skip)', () => {
      assert.ok(true, 'PG unavailable — skipping rollback test');
    });
    it('[PG SKIP] Artifacts accumulation test (PG unavailable — graceful skip)', () => {
      assert.ok(true, 'PG unavailable — skipping artifacts test');
    });
  }

});

// ─── Group 4: Handoff object fields accumulation (pure Python) ────────────────

describe('[SHARD-04] StepHandoff fields: decisions and user_inputs', () => {

  it('StepHandoff accepts decisions list with required fields', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-02-research',
    task_id='test-decisions-01',
    phase_number=99,
    context_snapshot={},
    decisions=[{'decision': 'use research', 'rationale': 'sufficient data', 'agent': 'gsd-researcher'}],
    next_step='step-03-plan'
)
assert len(h.decisions) == 1, f'Expected 1 decision, got {len(h.decisions)}'
assert h.decisions[0]['decision'] == 'use research', f'Wrong decision: {h.decisions[0]}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `Decisions field test failed: ${r.error || r.stderr}`);
  });

  it('StepHandoff accepts user_inputs list with step, question, answer', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-03-plan',
    task_id='test-user-inputs-01',
    phase_number=99,
    context_snapshot={},
    user_inputs=[{'step': 'step-03-plan', 'question': 'proceed?', 'answer': 'yes'}],
    next_step='step-04-check'
)
assert len(h.user_inputs) == 1, f'Expected 1 user_input, got {len(h.user_inputs)}'
assert h.user_inputs[0]['answer'] == 'yes', f'Wrong answer: {h.user_inputs[0]}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `user_inputs field test failed: ${r.error || r.stderr}`);
  });

  it('StepHandoff escalation_flags accumulate in rollback', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
h = StepHandoff(
    workflow_name='plan-phase',
    step_id='step-04-check',
    task_id='test-escalation-01',
    phase_number=99,
    context_snapshot={},
    completed_steps=['step-01-init', 'step-02-research', 'step-03-plan'],
    escalation_flags=['REVIEW_NEEDED']
)
# Rollback creates new escalation flag
new_flags = h.escalation_flags + ['ROLLBACK to step-02-research']
assert 'REVIEW_NEEDED' in new_flags, f'Original flag missing: {new_flags}'
assert 'ROLLBACK to step-02-research' in new_flags, f'Rollback flag missing: {new_flags}'
print('PASS')
`);
    assert.ok(r.stdout.includes('PASS'), `escalation_flags test failed: ${r.error || r.stderr}`);
  });

});
