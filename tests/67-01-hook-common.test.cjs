'use strict';

// 67-01-04: hooks/lib/hook-common.cjs — kill switch, mode resolution,
// fail-open wrapper, verified output shapes, gate telemetry.
//
// Uses tiny fixture gate scripts (written to a tmp dir, requiring
// hook-common.cjs by absolute path) spawned as real child processes so the
// kill-switch-first / stdin-timeout / fail-open behaviors are exercised
// exactly as a real hook registration would invoke them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOOK_COMMON_PATH = path.resolve(__dirname, '../hooks/lib/hook-common.cjs');
const hookCommon = require(HOOK_COMMON_PATH);

test('67-01-04: resolveMode() — off/block pass through, unset AND garbage values both resolve to warn', () => {
  const original = process.env.GSD_HOOKS_ENFORCE;
  try {
    delete process.env.GSD_HOOKS_ENFORCE;
    assert.equal(hookCommon.resolveMode(), 'warn', 'unset must resolve to warn');

    process.env.GSD_HOOKS_ENFORCE = 'banana';
    assert.equal(hookCommon.resolveMode(), 'warn', 'garbage value must resolve to warn, never block');

    process.env.GSD_HOOKS_ENFORCE = '';
    assert.equal(hookCommon.resolveMode(), 'warn', 'empty string must resolve to warn');

    process.env.GSD_HOOKS_ENFORCE = 'block';
    assert.equal(hookCommon.resolveMode(), 'block');

    process.env.GSD_HOOKS_ENFORCE = 'off';
    assert.equal(hookCommon.resolveMode(), 'off');
  } finally {
    if (original === undefined) delete process.env.GSD_HOOKS_ENFORCE;
    else process.env.GSD_HOOKS_ENFORCE = original;
  }
});

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixture(tmpDir, name, handlerBody) {
  const scriptPath = path.join(tmpDir, `${name}.cjs`);
  const content = [
    "'use strict';",
    `const hookCommon = require(${JSON.stringify(HOOK_COMMON_PATH)});`,
    `hookCommon.runGate('fixture-gate', (input, ctx) => {`,
    handlerBody,
    '});',
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, content);
  return scriptPath;
}

/**
 * Spawn a fixture script. `stdinPayload`: string to write+close, or
 * `undefined` to leave stdin fully open (never written, never closed —
 * used by the stdin-timeout hang case).
 */
function runFixture(scriptPath, env, stdinPayload) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.on('error', reject);

    if (stdinPayload !== undefined) {
      child.stdin.write(stdinPayload);
      child.stdin.end();
    }
    // else: leave stdin open — the hang case (g) relies on this.
  });
}

const DENY_HANDLER = "hookCommon.denyPreToolUse('would deny');";
const THROW_HANDLER = "throw new Error('boom');";
const BLOCKSTOP_HANDLER = "hookCommon.blockStop('stop reason');";

test('67-01-04(a): GSD_HOOKS_ENFORCE=off exits 0 with empty stdout and zero side effects', async () => {
  const tmpDir = freshTmpDir('hook-common-off-');
  const scriptPath = writeFixture(tmpDir, 'deny-gate', DENY_HANDLER);
  const nonexistentDataDir = path.join(tmpDir, 'never-created', 'data');

  const result = await runFixture(scriptPath, {
    ...process.env,
    GSD_HOOKS_ENFORCE: 'off',
    AMAUTA_DATA_DIR: nonexistentDataDir,
  }, '{}');

  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'off mode must produce empty stdout');
  assert.equal(fs.existsSync(nonexistentDataDir), false, 'off mode must not touch fs — AMAUTA_DATA_DIR must stay uncreated');
});

test('67-01-04(b): unset env resolves to warn — a deny attempt degrades to systemMessage', async () => {
  const tmpDir = freshTmpDir('hook-common-warn-');
  const scriptPath = writeFixture(tmpDir, 'deny-gate', DENY_HANDLER);
  const env = { ...process.env };
  delete env.GSD_HOOKS_ENFORCE;

  const result = await runFixture(scriptPath, env, '{}');
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.systemMessage, 'would deny');
  assert.equal(parsed.hookSpecificOutput, undefined, 'warn mode must never carry a hookSpecificOutput deny shape');
});

test('67-01-04(c): GSD_HOOKS_ENFORCE=block emits the exact PreToolUse deny JSON shape', async () => {
  const tmpDir = freshTmpDir('hook-common-block-');
  const scriptPath = writeFixture(tmpDir, 'deny-gate', DENY_HANDLER);

  const result = await runFixture(scriptPath, { ...process.env, GSD_HOOKS_ENFORCE: 'block' }, '{}');
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'would deny');
});

test('67-01-04(d): a throwing handler fails open — exit 0 + systemMessage mentions fail-open', async () => {
  const tmpDir = freshTmpDir('hook-common-throw-');
  const scriptPath = writeFixture(tmpDir, 'throw-gate', THROW_HANDLER);

  const result = await runFixture(scriptPath, { ...process.env, GSD_HOOKS_ENFORCE: 'block' }, '{}');
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.systemMessage, /fail-open/);
  assert.match(parsed.systemMessage, /boom/);
});

test('67-01-04(e): unparseable stdin fails open to null input — exit 0', async () => {
  const tmpDir = freshTmpDir('hook-common-badstdin-');
  const scriptPath = writeFixture(tmpDir, 'deny-gate', DENY_HANDLER);

  const result = await runFixture(scriptPath, { ...process.env, GSD_HOOKS_ENFORCE: 'warn' }, 'not-json-at-all{{{');
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  // Handler ignores its (null) input and still produces a well-formed warn.
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.systemMessage, 'would deny');
});

test('67-01-04(f): blockStop in warn mode degrades — no "decision" key, reason carried as systemMessage', async () => {
  const tmpDir = freshTmpDir('hook-common-blockstop-warn-');
  const scriptPath = writeFixture(tmpDir, 'blockstop-gate', BLOCKSTOP_HANDLER);
  const env = { ...process.env };
  delete env.GSD_HOOKS_ENFORCE; // unset -> warn

  const result = await runFixture(scriptPath, env, '{}');
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.systemMessage, 'stop reason');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'decision'), false, 'warn-mode blockStop must not carry a "decision" key');
});

test('67-01-04(g): stdin-timeout fail-open fires the 4000ms path within the 5s hook budget', async () => {
  const tmpDir = freshTmpDir('hook-common-hang-');
  const scriptPath = writeFixture(tmpDir, 'deny-gate', DENY_HANDLER);

  // Do NOT pass a stdinPayload — runFixture leaves stdin open (hang case).
  const result = await runFixture(scriptPath, { ...process.env, GSD_HOOKS_ENFORCE: 'warn' });

  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.systemMessage, 'would deny', 'must fail open to an allow/warn shape, never deny/block');
  assert.equal(parsed.decision, undefined);
  assert.equal(parsed.hookSpecificOutput, undefined);
  assert.ok(result.elapsedMs >= 3900, `expected wall-clock >= ~4000ms, got ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 6000, `expected wall-clock well within the 5s hook budget, got ${result.elapsedMs}ms`);
});
