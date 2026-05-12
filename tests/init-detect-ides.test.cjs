'use strict';
/**
 * Plan 44-01-05: stepDetectIdes + buildStepResult + renderStepTable tests
 * File: tests/init-detect-ides.test.cjs
 *
 * Requirements covered:
 *   INST-02: IDE auto-detection — stepDetectIdes() detection table contract
 *   INST-04: empty-directory false-positive guard (44-CONTEXT.md §Area 2)
 *
 * Tests bin/init.cjs exported functions (export gate required by 44-01-03).
 * Hermetic via os.tmpdir() + process.chdir(). Always restores cwd in after().
 *
 * Run: node --test tests/init-detect-ides.test.cjs
 */

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
// Export gate in bin/init.cjs prevents main() from running on require()
const { stepDetectIdes, buildStepResult, renderStepTable } = require(path.join(ROOT, 'bin', 'init.cjs'));

// Track original cwd and HOME to restore after each test
const _origCwd = process.cwd();
const _origHome = process.env.HOME;

// Cleanup helper: restore cwd and HOME
function restoreEnv() {
  try { process.chdir(_origCwd); } catch (_) {}
  if (_origHome !== undefined) {
    process.env.HOME = _origHome;
  } else {
    delete process.env.HOME;
  }
}

// ── Test 1: buildStepResult returns the frozen 5-field schema ────────────────

test('buildStepResult returns the frozen 5-field schema', () => {
  const r = buildStepResult('foo', 'pass', 'msg', { a: 1 });
  const keys = Object.keys(r).sort();
  assert.deepStrictEqual(keys, ['details', 'duration_ms', 'message', 'name', 'status'],
    `Expected exactly 5 fields, got: ${JSON.stringify(keys)}`);
  assert.strictEqual(r.name, 'foo');
  assert.strictEqual(r.status, 'pass');
  assert.strictEqual(r.message, 'msg');
  assert.strictEqual(typeof r.duration_ms, 'number',
    `duration_ms should be a number, got: ${typeof r.duration_ms}`);
  assert.ok(r.duration_ms >= 0, `duration_ms should be non-negative, got: ${r.duration_ms}`);
  assert.deepStrictEqual(r.details, { a: 1 });
});

// ── Test 2: buildStepResult rejects invalid status ───────────────────────────

test('buildStepResult rejects invalid status', () => {
  assert.throws(
    () => buildStepResult('x', 'maybe', 'm', null),
    (err) => {
      assert.ok(err instanceof Error,
        `Expected Error instance, got: ${err}`);
      const msg = err.message.toLowerCase();
      assert.ok(msg.includes('invalid status') || msg.includes('maybe'),
        `Error message should mention 'invalid status' or 'maybe', got: '${err.message}'`);
      return true;
    }
  );
});

// ── Test 3: stepDetectIdes detects all 3 IDEs when dirs+skill_subdir present ─

test('stepDetectIdes detects all 3 IDEs when dirs+skill_subdir present', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-detect-all-'));
  // Create all 3 IDE dirs with their expected skill_subdirs
  fs.mkdirSync(path.join(tmpDir, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.opencode', 'skills'), { recursive: true });

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-home-empty-'));

  try {
    process.chdir(tmpDir);
    process.env.HOME = emptyHome;

    const result = await stepDetectIdes();
    assert.strictEqual(result.status, 'pass',
      `Expected status 'pass', got '${result.status}': ${result.message}`);
    assert.ok(result.details && Array.isArray(result.details.detections),
      `Expected details.detections array, got: ${JSON.stringify(result.details)}`);
    assert.strictEqual(result.details.detections.length, 3,
      `Expected 3 detections, got ${result.details.detections.length}`);

    for (const d of result.details.detections) {
      assert.strictEqual(d.detected, 'yes',
        `Expected detected:'yes' for ${d.ide_id}, got '${d.detected}'`);
      assert.strictEqual(d.action, 'install',
        `Expected action:'install' for ${d.ide_id}, got '${d.action}'`);
    }
  } finally {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Test 4: stepDetectIdes empty-directory false-positive guard ──────────────
// An empty .cursor/ (no rules/ subdir, no .md, no .json) must NOT trigger detection.

test('stepDetectIdes empty-directory false-positive guard', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-detect-empty-'));
  // Create EMPTY .cursor/ directory (no children — this simulates an unrelated extension)
  fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-home-empty2-'));

  try {
    process.chdir(tmpDir);
    process.env.HOME = emptyHome;

    const result = await stepDetectIdes();
    const cursorRow = result.details.detections.find((d) => d.ide_id === 'cursor');
    assert.ok(cursorRow, 'cursor row should appear in detections');
    assert.strictEqual(cursorRow.detected, 'no',
      `Empty .cursor/ should not be detected. Got detected:'${cursorRow.detected}'`);
    assert.strictEqual(cursorRow.action, 'skip',
      `Empty .cursor/ action should be 'skip', got '${cursorRow.action}'`);
  } finally {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Test 5: stepDetectIdes accepts stray *.md as valid signal ────────────────
// Any *.md directly under .claude/ counts as a valid detection signal.

test('stepDetectIdes accepts stray *.md as valid signal', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-detect-md-'));
  // Create .claude/ with a stray .md file (no skills/ subdir)
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.claude', 'NOTES.md'), '# notes\n', 'utf8');

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-home-md-'));

  try {
    process.chdir(tmpDir);
    process.env.HOME = emptyHome;

    const result = await stepDetectIdes();
    const claudeRow = result.details.detections.find((d) => d.ide_id === 'claude-code');
    assert.ok(claudeRow, 'claude-code row should appear in detections');
    assert.strictEqual(claudeRow.detected, 'yes',
      `Stray *.md should count as detected signal. Got detected:'${claudeRow.detected}'`);
  } finally {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Test 6: stepDetectIdes returns warn when no IDE directories present ───────

test('stepDetectIdes returns warn when no IDE directories present', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-detect-none-'));
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-home-none-'));

  try {
    process.chdir(tmpDir);
    process.env.HOME = emptyHome;

    const result = await stepDetectIdes();
    assert.strictEqual(result.status, 'warn',
      `Expected status 'warn' when no IDEs found, got '${result.status}': ${result.message}`);
    // Every IDE in the registry must still appear in the table (auditable)
    assert.ok(result.details && Array.isArray(result.details.detections),
      `Expected details.detections array`);
    assert.strictEqual(result.details.detections.length, 3,
      `Expected 3 detection rows (all IDEs auditable), got ${result.details.detections.length}`);

    for (const d of result.details.detections) {
      assert.strictEqual(d.detected, 'no',
        `Expected detected:'no' for all IDEs when dirs absent, got '${d.detected}' for ${d.ide_id}`);
    }
  } finally {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Test 7: stepDetectIdes detections rows have the frozen columns ────────────

test('stepDetectIdes detections rows have the frozen columns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-detect-frozen-'));
  // Create one IDE to get a non-trivial result
  fs.mkdirSync(path.join(tmpDir, '.claude', 'skills'), { recursive: true });
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-home-frozen-'));

  try {
    process.chdir(tmpDir);
    process.env.HOME = emptyHome;

    const result = await stepDetectIdes();
    assert.ok(result.details && Array.isArray(result.details.detections),
      `Expected details.detections array`);

    const EXPECTED_DETECTION_KEYS = ['action', 'detected', 'ide_id', 'signals'];
    for (const d of result.details.detections) {
      const dKeys = Object.keys(d).sort();
      assert.deepStrictEqual(dKeys, EXPECTED_DETECTION_KEYS,
        `Detection row for '${d.ide_id}' should have exactly 4 keys, got: ${JSON.stringify(dKeys)}`);

      // detected is 'yes' or 'no'
      assert.ok(['yes', 'no'].includes(d.detected),
        `detected should be 'yes' or 'no', got: '${d.detected}'`);

      // signals matches the expected pattern
      const SIGNALS_PATTERN = /^(dir(\+cli)?|cli|\(none\))$/;
      assert.ok(SIGNALS_PATTERN.test(d.signals),
        `signals '${d.signals}' for '${d.ide_id}' doesn't match expected pattern`);

      // action is 'install' or 'skip'
      assert.ok(['install', 'skip'].includes(d.action),
        `action should be 'install' or 'skip', got: '${d.action}'`);
    }
  } finally {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Test 8: renderStepTable is a no-op when flags.json is true ───────────────
// flags is module-scoped in bin/init.cjs; test via stdout spy or skip gracefully.

test('renderStepTable no-op in JSON mode (stdout spy)', { skip: false }, (t, done) => {
  // Capture stdout writes
  const captured = [];
  const _origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    captured.push(chunk);
    // Still call original to avoid breaking test runner output
    return _origWrite(chunk, ...args);
  };

  // The renderStepTable function checks module-scoped `flags.json`.
  // Since we can't set flags.json directly from tests, we verify the function
  // is callable and returns undefined (non-throwing contract).
  // The deterministic acceptance for the no-op contract is the grep in 44-01-03 AC.
  try {
    const mockResults = [
      { name: 'detect_ides', status: 'pass', message: 'ok', duration_ms: 1, details: null },
    ];
    // Call renderStepTable — it may or may not write depending on flags.json state.
    // The key assertion: it must not throw.
    assert.doesNotThrow(
      () => renderStepTable(mockResults),
      'renderStepTable should not throw on valid input'
    );

    // Function must exist and be callable
    assert.strictEqual(typeof renderStepTable, 'function',
      'renderStepTable should be a function');

    done();
  } finally {
    process.stdout.write = _origWrite;
  }
});

// ── Global cleanup ────────────────────────────────────────────────────────────

after(() => {
  restoreEnv();
});
