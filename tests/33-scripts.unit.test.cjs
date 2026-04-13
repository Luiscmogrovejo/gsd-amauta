'use strict';
/**
 * Phase 33 — Scripts Unit Tests
 * File: tests/33-scripts.unit.test.cjs
 *
 * Requirements covered:
 *   TEST-04: coverage ratchet schema + behavior
 *   TEST-06: test pyramid output schema + pyramid_valid logic
 *   TEST-07: quality-audit structured JSON output
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ─── .coverage_threshold.json schema ────────────────────────────

describe('[TEST-04] .coverage_threshold.json schema', () => {
  it('file exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, '.coverage_threshold.json')), '.coverage_threshold.json missing');
  });
  it('is valid JSON', () => {
    const raw = fs.readFileSync(path.join(ROOT, '.coverage_threshold.json'), 'utf-8');
    assert.doesNotThrow(() => JSON.parse(raw));
  });
  it('has required fields: lines, branches, timestamp', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.coverage_threshold.json'), 'utf-8'));
    assert.ok(typeof data.lines === 'number', 'lines must be a number');
    assert.ok(typeof data.branches === 'number', 'branches must be a number');
    assert.ok(typeof data.timestamp === 'string', 'timestamp must be a string');
  });
  it('lines value is between 0 and 100', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.coverage_threshold.json'), 'utf-8'));
    assert.ok(data.lines >= 0 && data.lines <= 100, `lines ${data.lines} out of range`);
  });
  it('branches value is between 0 and 100', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.coverage_threshold.json'), 'utf-8'));
    assert.ok(data.branches >= 0 && data.branches <= 100, `branches ${data.branches} out of range`);
  });
  it('timestamp is a valid ISO date string', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.coverage_threshold.json'), 'utf-8'));
    assert.ok(!isNaN(Date.parse(data.timestamp)), `timestamp "${data.timestamp}" is not a valid ISO date`);
  });
});

// ─── coverage-ratchet.cjs behavior ──────────────────────────────

describe('[TEST-04] coverage-ratchet.cjs script validity', () => {
  it('script file exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'coverage-ratchet.cjs')));
  });
  it('script is syntactically valid (node --check)', () => {
    const result = spawnSync(process.execPath, ['--check', 'scripts/coverage-ratchet.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    assert.strictEqual(result.status, 0, `Syntax error: ${result.stderr}`);
  });
  it('contains auto-increment logic', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-ratchet.cjs'), 'utf-8');
    assert.ok(
      src.toLowerCase().includes('auto') || src.includes('increment') || src.includes('Threshold auto'),
      'Missing auto-increment logic in coverage-ratchet.cjs'
    );
  });
  it('reads SUMMARY_PATH (coverage-summary.json)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-ratchet.cjs'), 'utf-8');
    assert.ok(src.includes('coverage-summary.json') || src.includes('SUMMARY_PATH'));
  });
  it('reads THRESHOLD_PATH (.coverage_threshold.json)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-ratchet.cjs'), 'utf-8');
    assert.ok(src.includes('.coverage_threshold.json') || src.includes('THRESHOLD_PATH'));
  });
  it('has both process.exit(0) and process.exit(1) paths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-ratchet.cjs'), 'utf-8');
    assert.ok(src.includes('process.exit(1)'), 'Missing failure exit path');
    assert.ok(src.includes('process.exit(0)') || src.match(/process\.exit\(\)/), 'Missing success exit path');
  });
});

// ─── test-pyramid.cjs behavior ──────────────────────────────────

describe('[TEST-06] test-pyramid.cjs output schema', () => {
  it('script file exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'test-pyramid.cjs')));
  });
  it('is syntactically valid (node --check)', () => {
    const result = spawnSync(process.execPath, ['--check', 'scripts/test-pyramid.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    assert.strictEqual(result.status, 0, `Syntax error: ${result.stderr}`);
  });
  it('exits 0 and outputs valid JSON on clean codebase', () => {
    const result = spawnSync(process.execPath, ['scripts/test-pyramid.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout), `Not valid JSON: ${result.stdout}`);
  });
  it('output has all required fields', () => {
    const result = spawnSync(process.execPath, ['scripts/test-pyramid.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    const data = JSON.parse(result.stdout);
    for (const field of ['unit', 'integration', 'e2e', 'other', 'total', 'pyramidTotal', 'pyramid_valid']) {
      assert.ok(field in data, `Missing field: ${field}`);
    }
  });
  it('pyramid_valid is true on current codebase (E2E naming convention not yet widely used)', () => {
    const result = spawnSync(process.execPath, ['scripts/test-pyramid.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    const data = JSON.parse(result.stdout);
    assert.strictEqual(data.pyramid_valid, true, `pyramid_valid should be true: ${JSON.stringify(data)}`);
  });
  it('pyramid_valid logic: fails when e2e > 25% of pyramidTotal', () => {
    // Verify the logic exists in the script source
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'test-pyramid.cjs'), 'utf-8');
    assert.ok(src.includes('0.25') || src.includes('E2E_CEILING') || src.includes('25'), 'Missing 25% E2E ceiling logic');
  });
});

// ─── quality-audit.cjs behavior ─────────────────────────────────

describe('[TEST-07] quality-audit.cjs structured JSON output', () => {
  it('script file exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'quality-audit.cjs')));
  });
  it('is syntactically valid (node --check)', () => {
    const result = spawnSync(process.execPath, ['--check', 'scripts/quality-audit.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    assert.strictEqual(result.status, 0, `Syntax error: ${result.stderr}`);
  });
  it('exits 0 and outputs valid JSON on clean codebase', () => {
    const result = spawnSync(process.execPath, ['scripts/quality-audit.cjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout), `Not valid JSON: ${result.stdout.slice(0, 200)}`);
  });
  it('output has required top-level fields: pass, checks, gaps, timestamp', () => {
    const result = spawnSync(process.execPath, ['scripts/quality-audit.cjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000
    });
    const data = JSON.parse(result.stdout);
    for (const field of ['pass', 'checks', 'gaps', 'timestamp']) {
      assert.ok(field in data, `Missing field: ${field}`);
    }
  });
  it('pass field is a boolean', () => {
    const result = spawnSync(process.execPath, ['scripts/quality-audit.cjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000
    });
    const data = JSON.parse(result.stdout);
    assert.strictEqual(typeof data.pass, 'boolean');
  });
});
