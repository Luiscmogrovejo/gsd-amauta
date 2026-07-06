'use strict';

// Behavioral suite for the Phase 72 compression engine (plan 72-01, task 72-01-03).
// Covers the five COMP invariants end-to-end plus the additive hook-common rewrite
// primitives:
//   COMP-01  exact child exit-code propagation (0 and non-zero)
//   COMP-02  tee full raw stdout+stderr to a deterministic, discoverable path BEFORE filtering
//   COMP-03  never-worse guard (compressed never larger than raw)
//   COMP-04  any filter throw -> raw (no crash); unregistered command -> passthrough identity
//   COMP-05  child stdout / stderr kept distinct (stderr never merged into stdout)
//
// Idioms mirror tests/59-*.test.cjs: node:test + node:assert/strict, spawn the CLI via
// process.execPath (never a bare 'node'), tmp dirs via fs.mkdtempSync, cleanup in try/finally,
// and no timing primitives (fully deterministic).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const cliPath = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-compress.cjs');
const hookCommonPath = path.resolve(__dirname, '..', 'hooks', 'lib', 'hook-common.cjs');

// Spawn the wrapper CLI under the SAME interpreter, always with a copied env.
function runCli(script, extraEnv) {
  return spawnSync(
    process.execPath,
    [cliPath, '--', 'sh', '-c', script],
    { encoding: 'utf8', env: { ...process.env, ...(extraEnv || {}) } },
  );
}

test('COMP-01: wrapper propagates the child exit code EXACTLY (0 and non-zero)', () => {
  const ok = runCli('exit 0');
  assert.equal(ok.status, 0, 'exit 0 must propagate as status 0');

  const seven = runCli('exit 7');
  assert.equal(seven.status, 7, 'exit 7 must propagate as status 7');
});

test('COMP-02: non-zero exit tees full raw to a deterministic, discoverable path BEFORE filtering', () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), '72-01-'));
  try {
    const r = runCli('echo hello; exit 3', { GSD_COMPRESS_RAW_DIR: rawDir });
    assert.equal(r.status, 3, 'exit code still propagates when a tee happens');

    const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.raw'));
    assert.equal(rawFiles.length, 1, 'exactly one .raw file should be teed');

    const contents = fs.readFileSync(path.join(rawDir, rawFiles[0]), 'utf8');
    assert.ok(contents.includes('hello'), 'teed raw file must contain the raw stdout');

    // Discoverable: the wrapper prints the raw path on stdout.
    assert.ok(r.stdout.includes(rawDir), 'stdout must advertise the raw dir path (discoverable)');

    // Deterministic: same command -> same .raw filename.
    const r2 = runCli('echo hello; exit 3', { GSD_COMPRESS_RAW_DIR: rawDir });
    assert.equal(r2.status, 3);
    const rawFiles2 = fs.readdirSync(rawDir).filter((f) => f.endsWith('.raw'));
    assert.equal(rawFiles2.length, 1, 'same command must reuse the same deterministic .raw file');
    assert.equal(rawFiles2[0], rawFiles[0], 'raw filename must be identical across runs (content hash)');
  } finally {
    fs.rmSync(rawDir, { recursive: true, force: true });
  }
});

test('COMP-02: a zero-exit command does NOT tee (tee is failure-only)', () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), '72-01-'));
  try {
    const r = runCli('echo hello; exit 0', { GSD_COMPRESS_RAW_DIR: rawDir });
    assert.equal(r.status, 0);
    const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.raw'));
    assert.equal(rawFiles.length, 0, 'success must not leave a .raw file');
    assert.ok(!r.stdout.includes('teed to'), 'success stdout must carry no tee-discovery line');
  } finally {
    fs.rmSync(rawDir, { recursive: true, force: true });
  }
});

test('COMP-03: never-worse guard returns raw unless compressed is strictly smaller', () => {
  const c = require(cliPath);
  // Bloated compression (larger) -> raw.
  assert.equal(c.neverWorse('X'.repeat(100), 'X'.repeat(10)), 'X'.repeat(10));
  // Equal length -> raw (>= guard).
  assert.equal(c.neverWorse('abcd', 'wxyz'), 'wxyz');
  // Strictly smaller -> keep compressed.
  assert.equal(c.neverWorse('ab', 'abcd'), 'ab');
  // Non-string compressed -> raw (defensive).
  assert.equal(c.neverWorse(null, 'abcd'), 'abcd');
});

test('COMP-04: a filter that throws mid-chain yields raw (no crash)', () => {
  const c = require(cliPath);
  const raw = 'r1\nr2\n';
  const boom = () => { throw new Error('boom'); };
  assert.equal(c.applyChain('anything', raw, '', 0, [boom]), raw);
});

test('COMP-04: a filter returning a non-string yields raw', () => {
  const c = require(cliPath);
  const raw = 'keep\nme\n';
  const badFilter = () => 42; // not a string
  assert.equal(c.applyChain('anything', raw, '', 0, [badFilter]), raw);
});

test('COMP-04: an unregistered command resolves to _passthrough (identity), not an error', () => {
  const c = require(cliPath);
  // Empty registry in Phase 72 -> passthrough returns stdout unchanged.
  assert.equal(c.applyChain('totally-unknown-cmd', 'keep me\n', '', 0), 'keep me\n');
});

test('COMP-05: child stdout and stderr are preserved as DISTINCT streams', () => {
  const r = runCli('echo OUT; echo ERR 1>&2');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('OUT'), 'stdout must carry child stdout');
  assert.ok(r.stderr.includes('ERR'), 'stderr must carry child stderr');
  assert.ok(!r.stdout.includes('ERR'), 'stderr must NEVER be merged into stdout');
});

test('hook-common: additive rewrite primitives present; pre-existing exports untouched', () => {
  const h = require(hookCommonPath);

  // Additive primitives behave as documented.
  assert.equal(h.extractBashCommand({ tool_input: { command: 'git diff' } }), 'git diff');
  assert.equal(h.extractBashCommand({}), null);
  assert.equal(h.extractBashCommand(null), null);

  // All four new keys are functions.
  for (const k of ['extractBashCommand', 'rewriteBashInput', 'resolveCompressMode', 'runRewriteGate']) {
    assert.equal(typeof h[k], 'function', `new export ${k} must be a function`);
  }

  // A sample of pre-existing exports still resolve as functions (additive proof).
  for (const k of ['runGate', 'denyPreToolUse']) {
    assert.equal(typeof h[k], 'function', `pre-existing export ${k} must still be a function`);
  }
});
