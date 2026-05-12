'use strict';
/**
 * Plan 42-04-03: Escalation Triggers Unit Tests
 * File: tests/escalation-triggers.test.cjs
 *
 * Requirements covered:
 *   SCALE-04: 4 escalation triggers + 2-cap enforcement
 *
 * Tests detect_escalation() and apply_escalation() from complexity_scorer.py.
 * All inputs/outputs are deterministic. No DB or daemon required.
 *
 * Run: node --test tests/escalation-triggers.test.cjs
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCORER_PATH = path.join(ROOT, 'services', 'complexity_scorer.py');

// Python bootstrap: load complexity_scorer via importlib
const PY_BOOTSTRAP = `
import importlib.util, sys, os, json
_spec = importlib.util.spec_from_file_location(
    'complexity_scorer',
    os.path.join('${ROOT}', 'services', 'complexity_scorer.py')
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules['complexity_scorer'] = _mod
_spec.loader.exec_module(_mod)
from complexity_scorer import detect_escalation, apply_escalation, select_phases
`;

// Default config used throughout tests
const DEFAULT_CFG_PY = `{
    'scale_adaptive': {
        'escalation_triggers': {},
        'file_overshoot_multiplier': 1.5,
        'max_escalations_per_task': 2,
    },
    'complexity_buckets': [
        {'max': 15, 'phases': ['E']},
        {'max': 35, 'phases': ['P', 'E', 'T']},
        {'max': 60, 'phases': ['R', 'P', 'E', 'T']},
        {'max': 85, 'phases': ['R', 'P', 'E', 'T', 'D']},
        {'max': 100, 'phases': ['R', 'P', 'E', 'T', 'D', 'S', 'A']},
    ],
}`;

// Check python3 is on PATH
const pythonCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (pythonCheck.error || pythonCheck.status !== 0) {
  console.log('SKIP: python3 not on PATH — skipping escalation-triggers tests');
  process.exit(0);
}

// Helper: run a python3 script via tmp file (cwd=ROOT)
function pyFile(scriptContent) {
  const tmpFile = `/tmp/esc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  fs.writeFileSync(tmpFile, scriptContent);
  try {
    const result = spawnSync('python3', [tmpFile], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 20000,
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error ? result.error.message : (result.status !== 0 ? `exit ${result.status}` : null),
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }
}

// ── Group 1: detect_escalation tests ─────────────────────────────────────────

describe('[SCALE-04] detect_escalation: trigger detection', () => {

  test('manifest_violation via executor_report', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {'escalation_flags': [], 'context_snapshot': {}}
executor = {'manifest_violation': True}
fired = detect_escalation(handoff, executor, None, cfg)
assert 'manifest_violation' in fired, f"Expected manifest_violation in {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.fired.includes('manifest_violation'), `manifest_violation should fire, got ${JSON.stringify(out.fired)}`);
  });

  test('manifest_violation via validator_report violations list', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {'escalation_flags': [], 'context_snapshot': {}}
validator = {'verdict': 'gaps_found', 'violations': ['manifest_violation']}
fired = detect_escalation(handoff, None, validator, cfg)
assert 'manifest_violation' in fired, f"Expected manifest_violation in {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.fired.includes('manifest_violation'), `manifest_violation via validator should fire, got ${JSON.stringify(out.fired)}`);
  });

  test('file_count_overshoot: files_touched=7 > 1.5*4=6 → triggers', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'feature_vector': {'files_expected': 4}}
}
executor = {'files_touched': 7}
fired = detect_escalation(handoff, executor, None, cfg)
assert 'file_count_overshoot' in fired, f"Expected file_count_overshoot (7 > 1.5*4=6): {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.fired.includes('file_count_overshoot'), `file_count_overshoot should fire (7>6): ${JSON.stringify(out.fired)}`);
  });

  test('file_count_overshoot: files_touched=5 < 1.5*4=6 → no trigger', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'feature_vector': {'files_expected': 4}}
}
executor = {'files_touched': 5}
fired = detect_escalation(handoff, executor, None, cfg)
assert 'file_count_overshoot' not in fired, f"file_count_overshoot should NOT fire (5 < 1.5*4=6): {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(!out.fired.includes('file_count_overshoot'), `file_count_overshoot should NOT fire (5<6), got ${JSON.stringify(out.fired)}`);
  });

  test('executor_self_report: summary containing COMPLEXITY_SURPRISE', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {'escalation_flags': [], 'context_snapshot': {}}
executor = {'summary': 'This task had COMPLEXITY_SURPRISE in the migration layer'}
fired = detect_escalation(handoff, executor, None, cfg)
assert 'executor_self_report' in fired, f"Expected executor_self_report via COMPLEXITY_SURPRISE: {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.fired.includes('executor_self_report'), `executor_self_report via COMPLEXITY_SURPRISE should fire, got ${JSON.stringify(out.fired)}`);
  });

  test('executor_self_report: complexity_surprise=True flag', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {'escalation_flags': [], 'context_snapshot': {}}
executor = {'complexity_surprise': True}
fired = detect_escalation(handoff, executor, None, cfg)
assert 'executor_self_report' in fired, f"Expected executor_self_report via flag: {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.fired.includes('executor_self_report'), `executor_self_report via flag should fire, got ${JSON.stringify(out.fired)}`);
  });

  test('validator_divergence: gaps_found + light phase set ["E"] → triggers', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'chosen_phases': ['E']}
}
validator = {'verdict': 'gaps_found', 'violations': []}
fired = detect_escalation(handoff, None, validator, cfg)
assert 'validator_divergence' in fired, f"Expected validator_divergence: {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.fired.includes('validator_divergence'), `validator_divergence should fire on gaps_found+light set, got ${JSON.stringify(out.fired)}`);
  });

  test('validator_divergence: gaps_found + heavy phase set ["R","P","E","T","D","S","A"] → no trigger', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'chosen_phases': ['R', 'P', 'E', 'T', 'D', 'S', 'A']}
}
validator = {'verdict': 'gaps_found', 'violations': []}
fired = detect_escalation(handoff, None, validator, cfg)
assert 'validator_divergence' not in fired, f"validator_divergence should NOT fire on heavy set: {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(!out.fired.includes('validator_divergence'), `validator_divergence should NOT fire on heavy set, got ${JSON.stringify(out.fired)}`);
  });

  test('config toggle: file_count_overshoot=false disables trigger', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = {
    'scale_adaptive': {
        'escalation_triggers': {'file_count_overshoot': False},
        'file_overshoot_multiplier': 1.5,
        'max_escalations_per_task': 2,
    },
    'complexity_buckets': [
        {'max': 15, 'phases': ['E']},
        {'max': 35, 'phases': ['P', 'E', 'T']},
        {'max': 60, 'phases': ['R', 'P', 'E', 'T']},
        {'max': 85, 'phases': ['R', 'P', 'E', 'T', 'D']},
        {'max': 100, 'phases': ['R', 'P', 'E', 'T', 'D', 'S', 'A']},
    ],
}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'feature_vector': {'files_expected': 4}}
}
executor = {'files_touched': 100}  # Way over threshold
fired = detect_escalation(handoff, executor, None, cfg)
assert 'file_count_overshoot' not in fired, f"Disabled trigger should not fire: {fired}"
print(json.dumps({'fired': fired}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(!out.fired.includes('file_count_overshoot'), `Disabled trigger should NOT fire, got ${JSON.stringify(out.fired)}`);
  });

});

// ── Group 2: apply_escalation tests ──────────────────────────────────────────

describe('[SCALE-04] apply_escalation: score update + cap enforcement', () => {

  test('apply_escalation: first escalation increments score by 20', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'complexity_score': 50, 'chosen_phases': ['R', 'P', 'E', 'T']},
}
result = apply_escalation(handoff, ['file_count_overshoot'], cfg)
assert result['new_score'] == 70, f"Expected 50+20=70, got {result['new_score']}"
assert result['cap_hit'] is False
print(json.dumps({'new_score': result['new_score'], 'cap_hit': result['cap_hit']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.new_score, 70, `First escalation should add 20, got ${out.new_score}`);
    assert.strictEqual(out.cap_hit, false, 'cap_hit should be false on first escalation');
  });

  test('apply_escalation: 2-cap enforcement → cap_hit=true', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
# 2 prior escalation entries → cap hit
handoff = {
    'escalation_flags': [
        'file_count_overshoot:rescored_to_70',
        'executor_self_report:rescored_to_90',
    ],
    'context_snapshot': {'complexity_score': 90, 'chosen_phases': ['R', 'P', 'E', 'T', 'D']},
}
result = apply_escalation(handoff, ['manifest_violation'], cfg)
assert result['cap_hit'] is True, f"Expected cap_hit=True, got {result}"
# Score should NOT change when cap hit
assert result['new_score'] == 90, f"Score should stay 90 at cap, got {result['new_score']}"
print(json.dumps({'cap_hit': result['cap_hit'], 'new_score': result['new_score']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.cap_hit, true, '2-cap should trigger cap_hit=true');
    assert.strictEqual(out.new_score, 90, 'Score should not change when cap hit');
  });

  test('apply_escalation: multi-trigger bias = N*20, clamped at 100', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'complexity_score': 50, 'chosen_phases': ['R', 'P', 'E', 'T']},
}
# 3 triggers: 3 * 20 = 60, so 50+60=110, clamped to 100
result = apply_escalation(handoff, ['a', 'b', 'c'], cfg)
assert result['new_score'] == 100, f"Expected min(50+60,100)=100, got {result['new_score']}"
assert result['cap_hit'] is False
print(json.dumps({'new_score': result['new_score'], 'cap_hit': result['cap_hit']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.new_score, 100, `3 triggers should give min(50+60,100)=100, got ${out.new_score}`);
    assert.strictEqual(out.cap_hit, false, 'cap_hit should be false when under cap');
  });

  test('apply_escalation: bucket change from medium to heavy', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
cfg = ${DEFAULT_CFG_PY}
# Score 50 → phases ['R','P','E','T'] (bucket max=60)
# After +20 → score 70 → phases ['R','P','E','T','D'] (bucket max=85)
handoff = {
    'escalation_flags': [],
    'context_snapshot': {'complexity_score': 50, 'chosen_phases': ['R', 'P', 'E', 'T']},
}
result = apply_escalation(handoff, ['file_count_overshoot'], cfg)
assert result['new_score'] == 70
assert result['new_chosen_phases'] == ['R', 'P', 'E', 'T', 'D'], f"Expected RPETD at 70, got {result['new_chosen_phases']}"
print(json.dumps({'new_score': result['new_score'], 'new_chosen_phases': result['new_chosen_phases']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.new_score, 70, `Score should be 70 after +20, got ${out.new_score}`);
    assert.deepStrictEqual(out.new_chosen_phases, ['R', 'P', 'E', 'T', 'D'], `Phases should be RPETD at 70, got ${JSON.stringify(out.new_chosen_phases)}`);
  });

});
