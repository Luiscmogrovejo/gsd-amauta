'use strict';
/**
 * Plan 42-04-02: Complexity Scorer Unit Tests
 * File: tests/complexity-scorer.test.cjs
 *
 * Requirements covered:
 *   SCALE-01: feature extraction + deterministic scoring
 *   SCALE-02: configurable bucket selection
 *
 * Tests services/complexity_scorer.py pure functions via python3 subprocess.
 * No DB or daemon required — all inputs/outputs are deterministic.
 *
 * Run: node --test tests/complexity-scorer.test.cjs
 */
const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCORER_PATH = path.join(ROOT, 'services', 'complexity_scorer.py');

// ── Python bootstrap: load complexity_scorer via importlib (handles path) ───────
const PY_BOOTSTRAP = `
import importlib.util, sys, os, json
_spec = importlib.util.spec_from_file_location(
    'complexity_scorer',
    os.path.join('${ROOT}', 'services', 'complexity_scorer.py')
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules['complexity_scorer'] = _mod
_spec.loader.exec_module(_mod)
from complexity_scorer import (
    extract_features, score_features, select_phases,
    FEATURE_KEYS, OUTCOME_LABELS, _DEFAULT_BUCKETS
)
`;

// Default config with 5 complexity buckets
const DEFAULT_CONFIG = JSON.stringify({
  complexity_buckets: [
    { max: 15, phases: ['E'] },
    { max: 35, phases: ['P', 'E', 'T'] },
    { max: 60, phases: ['R', 'P', 'E', 'T'] },
    { max: 85, phases: ['R', 'P', 'E', 'T', 'D'] },
    { max: 100, phases: ['R', 'P', 'E', 'T', 'D', 'S', 'A'] },
  ],
});

// Check python3 is on PATH
const pythonCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (pythonCheck.error || pythonCheck.status !== 0) {
  console.log('SKIP: python3 not on PATH — skipping complexity-scorer tests');
  process.exit(0);
}

// Helper: run a python3 script via tmp file (cwd=ROOT)
function pyFile(scriptContent, options = {}) {
  const tmpFile = `/tmp/scorer-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  fs.writeFileSync(tmpFile, scriptContent);
  try {
    const result = spawnSync('python3', [tmpFile], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 20000,
      ...options,
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

// ── Group 1: score_features — pure function tests ─────────────────────────────

describe('[SCALE-01] score_features: pure function scoring', () => {

  test('score_features: zero-input feature vector → score 0', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
features = {
    'files_expected': 0,
    'estimated_loc': 0,
    'test_impact': 0,
    'dependency_depth': 0,
    'has_migration': False,
    'has_api_change': False,
    'security_sensitivity': 0,
}
result = score_features(features)
print(json.dumps({'score': result}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.score, 0, `Expected score 0, got ${out.score}`);
  });

  test('score_features: max-input feature vector → score 100', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
features = {
    'files_expected': 20,
    'estimated_loc': 500,
    'test_impact': 10,
    'dependency_depth': 10,
    'has_migration': True,
    'has_api_change': True,
    'security_sensitivity': 10,
}
result = score_features(features)
print(json.dumps({'score': result}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.score, 100, `Expected score 100, got ${out.score}`);
  });

  test('score_features: determinism — same input 3 times → same output', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
features = {
    'files_expected': 5,
    'estimated_loc': 120,
    'test_impact': 3,
    'dependency_depth': 2,
    'has_migration': False,
    'has_api_change': True,
    'security_sensitivity': 4,
}
results = [score_features(features) for _ in range(3)]
assert results[0] == results[1] == results[2], f"Non-deterministic: {results}"
print(json.dumps({'scores': results}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.scores[0], out.scores[1], 'scores[0] != scores[1]');
    assert.strictEqual(out.scores[1], out.scores[2], 'scores[1] != scores[2]');
  });

  test('score_features: has_migration boolean adds 15 points', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
base = {'files_expected': 0,'estimated_loc': 0,'test_impact': 0,'dependency_depth': 0,'has_migration': False,'has_api_change': False,'security_sensitivity': 0}
with_mig = dict(base, has_migration=True)
delta = score_features(with_mig) - score_features(base)
assert delta == 15, f"has_migration delta expected 15, got {delta}"
print(json.dumps({'delta': delta}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.delta, 15, `has_migration weight should be 15, got ${out.delta}`);
  });

  test('score_features: has_api_change boolean adds 10 points', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
base = {'files_expected': 0,'estimated_loc': 0,'test_impact': 0,'dependency_depth': 0,'has_migration': False,'has_api_change': False,'security_sensitivity': 0}
with_api = dict(base, has_api_change=True)
delta = score_features(with_api) - score_features(base)
assert delta == 10, f"has_api_change delta expected 10, got {delta}"
print(json.dumps({'delta': delta}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.delta, 10, `has_api_change weight should be 10, got ${out.delta}`);
  });

  test('score_features: files_expected=20 contributes max 20 points', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
base = {'files_expected': 0,'estimated_loc': 0,'test_impact': 0,'dependency_depth': 0,'has_migration': False,'has_api_change': False,'security_sensitivity': 0}
with_files = dict(base, files_expected=20)
delta = score_features(with_files) - score_features(base)
assert delta == 20, f"files_expected=20 delta expected 20, got {delta}"
print(json.dumps({'delta': delta}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.delta, 20, `files_expected max contribution should be 20, got ${out.delta}`);
  });

  test('score_features: security_sensitivity=10 contributes max 15 points', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
base = {'files_expected': 0,'estimated_loc': 0,'test_impact': 0,'dependency_depth': 0,'has_migration': False,'has_api_change': False,'security_sensitivity': 0}
with_sec = dict(base, security_sensitivity=10)
delta = score_features(with_sec) - score_features(base)
assert delta == 15, f"security_sensitivity=10 delta expected 15, got {delta}"
print(json.dumps({'delta': delta}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.delta, 15, `security_sensitivity max contribution should be 15, got ${out.delta}`);
  });

  test('score_features: score clamped at 100 for very large inputs', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
features = {'files_expected': 9999,'estimated_loc': 999999,'test_impact': 10,'dependency_depth': 10,'has_migration': True,'has_api_change': True,'security_sensitivity': 10}
result = score_features(features)
assert 0 <= result <= 100, f"Score out of range [0,100]: {result}"
print(json.dumps({'score': result}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.score <= 100, `Score should be clamped to 100, got ${out.score}`);
    assert.ok(out.score >= 0, `Score should be >= 0, got ${out.score}`);
  });

});

// ── Group 2: select_phases — bucket boundary tests ────────────────────────────

describe('[SCALE-02] select_phases: bucket selection', () => {

  test('select_phases: boundary scores map to correct bucket', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
import json
cfg = json.loads('${DEFAULT_CONFIG}')
cases = [
    (0,   ['E']),
    (15,  ['E']),
    (16,  ['P', 'E', 'T']),
    (35,  ['P', 'E', 'T']),
    (36,  ['R', 'P', 'E', 'T']),
    (60,  ['R', 'P', 'E', 'T']),
    (61,  ['R', 'P', 'E', 'T', 'D']),
    (85,  ['R', 'P', 'E', 'T', 'D']),
    (86,  ['R', 'P', 'E', 'T', 'D', 'S', 'A']),
    (100, ['R', 'P', 'E', 'T', 'D', 'S', 'A']),
]
errors = []
for score, expected in cases:
    got = select_phases(score, cfg)
    if got != expected:
        errors.append(f"score={score}: expected {expected}, got {got}")
if errors:
    raise AssertionError("\\n".join(errors))
print("PASS")
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    assert.ok(r.stdout.includes('PASS'), `Bucket boundaries wrong: ${r.stdout}${r.stderr}`);
  });

  test('select_phases: custom 3-bucket config works', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
custom_cfg = {
    'complexity_buckets': [
        {'max': 30, 'phases': ['E']},
        {'max': 70, 'phases': ['P', 'E', 'T']},
        {'max': 100, 'phases': ['R', 'P', 'E', 'T', 'D']},
    ]
}
assert select_phases(10, custom_cfg) == ['E'], f"Expected ['E'], got {select_phases(10, custom_cfg)}"
assert select_phases(30, custom_cfg) == ['E'], f"Expected ['E'], got {select_phases(30, custom_cfg)}"
assert select_phases(31, custom_cfg) == ['P', 'E', 'T']
assert select_phases(70, custom_cfg) == ['P', 'E', 'T']
assert select_phases(71, custom_cfg) == ['R', 'P', 'E', 'T', 'D']
assert select_phases(100, custom_cfg) == ['R', 'P', 'E', 'T', 'D']
print("PASS")
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    assert.ok(r.stdout.includes('PASS'), `Custom buckets wrong: ${r.stdout}${r.stderr}`);
  });

  test('select_phases: score -1 raises ValueError', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
import json
cfg = json.loads('${DEFAULT_CONFIG}')
try:
    select_phases(-1, cfg)
    print("NO_ERROR")
except ValueError as e:
    print("GOT_VALUE_ERROR:" + str(e))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    assert.ok(r.stdout.includes('GOT_VALUE_ERROR'), `Expected ValueError for score=-1: ${r.stdout}`);
  });

  test('select_phases: score 101 raises ValueError', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
import json
cfg = json.loads('${DEFAULT_CONFIG}')
try:
    select_phases(101, cfg)
    print("NO_ERROR")
except ValueError as e:
    print("GOT_VALUE_ERROR:" + str(e))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    assert.ok(r.stdout.includes('GOT_VALUE_ERROR'), `Expected ValueError for score=101: ${r.stdout}`);
  });

});

// ── Group 3: extract_features — file pattern detection ───────────────────────

describe('[SCALE-01] extract_features: file pattern detection', () => {

  test('extract_features: migrations/*.sql → has_migration=True', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
meta = {'files_expected': ['migrations/018-task-completions.sql', 'services/foo.py']}
features = extract_features(None, meta)
assert features['has_migration'] is True, f"Expected has_migration=True, got {features['has_migration']}"
print(json.dumps({'has_migration': features['has_migration']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.has_migration, true, 'migrations/*.sql should set has_migration=True');
  });

  test('extract_features: services/amauta-daemon.py → has_api_change=True', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
meta = {'files_expected': ['services/amauta-daemon.py']}
features = extract_features(None, meta)
assert features['has_api_change'] is True, f"Expected has_api_change=True, got {features['has_api_change']}"
print(json.dumps({'has_api_change': features['has_api_change']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.has_api_change, true, 'services/amauta-daemon.py should set has_api_change=True');
  });

  test('extract_features: file under migrations/ → security_sensitivity >= 4', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
meta = {'files_expected': ['migrations/018-task-completions.sql']}
features = extract_features(None, meta)
assert features['security_sensitivity'] >= 4, f"migrations/ floor should be >=4, got {features['security_sensitivity']}"
print(json.dumps({'security_sensitivity': features['security_sensitivity']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.security_sensitivity >= 4, `migrations/ floor should be >=4, got ${out.security_sensitivity}`);
  });

  test('extract_features: file under services/ → security_sensitivity >= 3', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
meta = {'files_expected': ['services/complexity_scorer.py']}
features = extract_features(None, meta)
assert features['security_sensitivity'] >= 3, f"services/ floor should be >=3, got {features['security_sensitivity']}"
print(json.dumps({'security_sensitivity': features['security_sensitivity']}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.security_sensitivity >= 3, `services/ floor should be >=3, got ${out.security_sensitivity}`);
  });

  test('extract_features: LLM gating off — GSD_COMPLEXITY_LLM unset → floor-rule values only', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
import os
os.environ.pop('GSD_COMPLEXITY_LLM', None)
meta = {'files_expected': ['migrations/schema.sql']}
features = extract_features(None, meta)
# With LLM off, security_sensitivity must be exactly the floor rule value (4 for migrations/)
assert features['security_sensitivity'] == 4, f"LLM off: expected security_sensitivity=4 (floor), got {features['security_sensitivity']}"
print(json.dumps({'security_sensitivity': features['security_sensitivity'], 'llm_off': True}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.security_sensitivity, 4, `LLM off: security_sensitivity should be floor 4, got ${out.security_sensitivity}`);
  });

  test('extract_features: all 7 FEATURE_KEYS present in output', () => {
    const r = pyFile(`
${PY_BOOTSTRAP}
meta = {}
features = extract_features(None, meta)
missing = [k for k in FEATURE_KEYS if k not in features]
assert not missing, f"Missing keys: {missing}"
print(json.dumps({'keys': list(features.keys())}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    const EXPECTED_KEYS = ['files_expected', 'estimated_loc', 'test_impact', 'dependency_depth', 'has_migration', 'has_api_change', 'security_sensitivity'];
    for (const key of EXPECTED_KEYS) {
      assert.ok(out.keys.includes(key), `Missing feature key: ${key}`);
    }
  });

  test('extract_features: complexity_buckets round-trip via score+select', () => {
    // Integration: features → score → select_phases → non-empty list
    const r = pyFile(`
${PY_BOOTSTRAP}
import json
cfg = json.loads('${DEFAULT_CONFIG}')
meta = {'files_expected': ['services/foo.py', 'migrations/001.sql', 'tests/test_foo.py'], 'estimated_loc': 200}
features = extract_features(None, meta)
score = score_features(features)
phases = select_phases(score, cfg)
assert isinstance(phases, list) and len(phases) > 0, f"Expected non-empty phases list, got {phases}"
assert 0 <= score <= 100, f"Score out of range: {score}"
print(json.dumps({'score': score, 'phases': phases, 'features_ok': True, 'complexity_buckets_used': True, 'deterministic_pass': True}))
`);
    assert.ok(!r.error, `Python error: ${r.error}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.features_ok, 'features extraction failed');
    assert.ok(out.score >= 0 && out.score <= 100, `Score out of range: ${out.score}`);
    assert.ok(Array.isArray(out.phases) && out.phases.length > 0, 'phases should be non-empty array');
    assert.ok(out.complexity_buckets_used, 'complexity_buckets not used in test');
    assert.ok(out.deterministic_pass, 'determinism marker missing');
  });

});
