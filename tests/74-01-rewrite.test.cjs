'use strict';

// Behavioral suite for the Phase 74 rewrite mechanism (plan 74-01, task 74-01-05).
// Covers the five RWRT success criteria END-TO-END by spawning the two real hooks
// over stdin and asserting on their emitted JSON, plus direct assertions against the
// shared classifier and the additive hook-common PostToolUse primitives:
//   RWRT-01  PreToolUse rewrites an allowlisted read-only command via updatedInput
//   RWRT-02  PostToolUse replaces already-produced output via updatedToolOutput (NO re-run)
//   RWRT-03  passthrough for compound/piped/redirected/subst/env-assign/unknown/compressor-absent
//   RWRT-04  destructive denylist (deny-before-allow, program+verb) never rewrites side-effects
//   RWRT-05  double-wrap loop guard — the hook never re-fires on its own rewritten command
//
// Idioms mirror tests/72-01-compress-engine.test.cjs and tests/59-*.test.cjs:
// node:test + node:assert/strict, spawn via process.execPath (never a bare 'node'),
// tmp dirs via fs.mkdtempSync, cleanup in try/finally, and NO timing primitives.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const gatePath = path.resolve(repoRoot, 'hooks', 'gsd-compress-gate.cjs');
const postPath = path.resolve(repoRoot, 'hooks', 'gsd-compress-post.cjs');
const classifyPath = path.resolve(repoRoot, 'hooks', 'lib', 'compress-classify.cjs');
const hookCommonPath = path.resolve(repoRoot, 'hooks', 'lib', 'hook-common.cjs');

// Spawn a hook under the SAME interpreter, feeding a JSON payload on stdin, always
// with a copied env forcing compression ON (the opt-in default is OFF).
function runHook(hookPath, payload, extraEnv) {
  return spawnSync(
    process.execPath,
    [hookPath],
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, GSD_COMPRESS: 'on', ...(extraEnv || {}) },
    },
  );
}

// Write a fixture compress-registry.json into a fresh tmp dir; returns { dir, regPath }.
// The caller cleans up `dir` in a finally block.
function mkFixtureRegistry(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '74-01-'));
  const regPath = path.join(dir, 'reg.json');
  fs.writeFileSync(regPath, JSON.stringify({ registry_version: '1.0', entries }), 'utf8');
  return { dir, regPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// RWRT-01 — PreToolUse rewrite of an allowlisted, read-only, bare command.
// ─────────────────────────────────────────────────────────────────────────────
test('RWRT-01: PreToolUse gate rewrites an allowlisted read-only command via updatedInput', () => {
  const { dir, regPath } = mkFixtureRegistry([
    { name: 'git', heads: ['git'], subcommands: ['status', 'diff', 'log'], filter: 'git', enabled: true },
  ]);
  try {
    const r = runHook(gatePath, { tool_input: { command: 'git status' } }, {
      GSD_COMPRESS_REGISTRY_PATH: regPath,
    });
    assert.equal(r.status, 0, 'gate must always exit 0 (rewrite can never block)');
    assert.notEqual(r.stdout.trim(), '', 'a rewrite must emit a non-empty JSON body');

    const out = JSON.parse(r.stdout);
    const s = out.hookSpecificOutput;
    assert.equal(s.hookEventName, 'PreToolUse');
    assert.equal(s.permissionDecision, 'allow', 'the gate can never deny');
    assert.match(
      s.updatedInput.command,
      /gsd-compress\.cjs -- git status$/,
      'the original command must be routed through the compressor wrapper',
    );
    // The wrapper path must be absolute so a stripped PATH still resolves it (Pitfall 9).
    assert.match(s.updatedInput.command, /^node \//, 'wrapper must be invoked by absolute path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RWRT-02 — PostToolUse compresses ALREADY-PRODUCED output; never re-runs the command.
// ─────────────────────────────────────────────────────────────────────────────
test('RWRT-02: PostToolUse net replaces already-produced output via updatedToolOutput (no re-run)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '74-01-'));
  const genericPath = path.join(dir, 'generic.cjs');
  fs.writeFileSync(genericPath, "module.exports={transform:function(s){return 'COMPRESSED';}};", 'utf8');
  try {
    const r = runHook(postPath, {
      tool_input: { command: 'weirdcmd --x' },
      tool_output: { type: 'text', text: 'a'.repeat(40) },
    }, { GSD_COMPRESS_GENERIC_PATH: genericPath });

    assert.equal(r.status, 0, 'PostToolUse must always exit 0');
    assert.notEqual(r.stdout.trim(), '', 'a shrinking compression must emit output-replacement JSON');

    const out = JSON.parse(r.stdout);
    const s = out.hookSpecificOutput;
    assert.equal(s.hookEventName, 'PostToolUse');
    assert.equal(s.updatedToolOutput.type, 'text');
    assert.equal(s.updatedToolOutput.text, 'COMPRESSED', 'the produced output must be replaced in-place');
    assert.equal(s.updatedInput, undefined, 'PostToolUse must NOT emit updatedInput');

    // Pure emission mechanism: a shrinking chain override yields the compressed text directly.
    const post = require(postPath);
    assert.equal(post.buildPostOutput('c', 'x'.repeat(20), [() => 'y']), 'y');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RWRT-03 — passthrough matrix: compound/piped/redirected/subst/env-assign/unknown +
//           compressor-absent. Every path degrades to the raw command (EMPTY stdout).
// ─────────────────────────────────────────────────────────────────────────────
test('RWRT-03: gate passes through compound/redirected/subst/env-assign/unknown commands', () => {
  const passthroughCommands = [
    'git status | cat',      // pipe
    'git diff > x',          // redirect
    'a && git status',       // command sequence
    'echo $(git status)',    // command substitution
    'FOO=bar git status',    // leading env-assignment
    'zzz-unknown-cmd --x',   // unregistered head
  ];
  // Against the REAL populated prod registry (git IS registered) — none of these is a
  // bare, registered, read-only command, so each must emit NO rewrite.
  for (const command of passthroughCommands) {
    const r = runHook(gatePath, { tool_input: { command } });
    assert.equal(r.status, 0, `gate must exit 0 for: ${command}`);
    assert.equal(r.stdout.trim(), '', `expected passthrough (empty stdout) for: ${command}`);
  }
});

test('RWRT-03: gate passes through when the compressor wrapper is unresolvable (fail-open)', () => {
  const { dir, regPath } = mkFixtureRegistry([
    { name: 'git', heads: ['git'], subcommands: ['status'], filter: 'git', enabled: true },
  ]);
  try {
    // git status IS allowlisted here, so the ONLY reason for passthrough is the absent wrapper.
    const r = runHook(gatePath, { tool_input: { command: 'git status' } }, {
      GSD_COMPRESS_REGISTRY_PATH: regPath,
      GSD_COMPRESS_WRAPPER_PATH: '/no/such/gsd-compress.cjs',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'compressor-absent must degrade to the raw command (no rewrite)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RWRT-04 — destructive denylist (deny-before-allow, program+verb scoped). A
//           side-effecting command is NEVER rewritten, even when its program is
//           allowlisted.
// ─────────────────────────────────────────────────────────────────────────────
test('RWRT-04: destructive commands are never rewritten even when their program is allowlisted', () => {
  // Fixture registry allowlists git (INCLUDING push) and docker — so the ONLY thing
  // stopping a rewrite is the deny-before-allow denylist check.
  const { dir, regPath } = mkFixtureRegistry([
    { name: 'git', heads: ['git'], subcommands: ['status', 'push', 'reset'], filter: 'git', enabled: true },
    { name: 'docker', heads: ['docker'], subcommands: ['ps', 'rm'], filter: 'docker', enabled: true },
  ]);
  try {
    const destructive = [
      'git push origin main',   // deny_verbs.git push (allowlisted program → proves deny-before-allow)
      'git reset --hard',       // deny_verbs.git reset
      'docker rm x',            // deny_verbs.docker rm (allowlisted program → proves deny-before-allow)
      'curl -X POST http://h',  // deny_patterns -X POST
      'kubectl delete pod p',   // deny_verbs.kubectl delete
      'alembic upgrade head',   // deny_patterns alembic
      'rm -rf build',           // deny_all_programs rm
    ];
    for (const command of destructive) {
      const r = runHook(gatePath, { tool_input: { command } }, {
        GSD_COMPRESS_REGISTRY_PATH: regPath,
      });
      assert.equal(r.status, 0, `gate must exit 0 for destructive: ${command}`);
      assert.equal(r.stdout.trim(), '', `destructive command must never be rewritten: ${command}`);
    }

    // Direct deny-before-allow proof against the REAL populated prod registry (git IS
    // registered): a read-only verb rewrites, the destructive verb does not — this is
    // NOT a blanket deny of the whole program.
    const c = require(classifyPath);
    assert.notEqual(
      c.classifyForRewrite('git status'), 'passthrough',
      'a read-only allowlisted verb must still be eligible for rewrite',
    );
    assert.equal(
      c.classifyForRewrite('git push origin main'), 'passthrough',
      'the destructive verb of an allowlisted program must be denied',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RWRT-05 — double-wrap loop guard: the gate never re-fires on its own rewritten
//           command, and the net never re-compresses already-wrapped output.
// ─────────────────────────────────────────────────────────────────────────────
test('RWRT-05: loop guard prevents the gate re-firing on an already-wrapped command', () => {
  // Fixture registry allowlists `node` so the ONLY thing preventing a rewrite is the
  // gsd-compress sentinel loop guard (which is checked FIRST).
  const { dir, regPath } = mkFixtureRegistry([
    { name: 'node', heads: ['node'], filter: 'x', enabled: true },
  ]);
  try {
    const wrapped = 'node get-shit-done/bin/gsd-compress.cjs -- git status';
    const r = runHook(gatePath, { tool_input: { command: wrapped } }, {
      GSD_COMPRESS_REGISTRY_PATH: regPath,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'an already-wrapped command must never be re-wrapped');

    const c = require(classifyPath);
    assert.equal(c.isAlreadyWrapped('x gsd-compress y'), true, 'sentinel detection is the first guard');

    // The PostToolUse net likewise refuses to re-compress already-wrapped output.
    const post = require(postPath);
    assert.equal(
      post.buildPostOutput('node x/gsd-compress.cjs -- git status', 'out\n'.repeat(20), [() => 'X']),
      null,
      'the net must not re-compress an already-wrapped command\'s output',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// hook-common additive PostToolUse primitives — additive proof + exact emitted shape.
// ─────────────────────────────────────────────────────────────────────────────
test('hook-common: additive PostToolUse primitives emit the doc-verified shape; existing exports untouched', () => {
  const h = require(hookCommonPath);

  // Both new keys plus a sample of pre-existing keys resolve as functions (additive proof).
  for (const k of ['rewriteToolOutput', 'runPostGate', 'runGate', 'rewriteBashInput']) {
    assert.equal(typeof h[k], 'function', `export ${k} must be a function`);
  }

  // rewriteToolOutput exits the process, so exercise it in a child and parse its stdout.
  const script = `const h=require(${JSON.stringify(hookCommonPath)}); h.rewriteToolOutput('Z');`;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(r.status, 0, 'rewriteToolOutput must exit 0');
  const out = JSON.parse(r.stdout);
  const s = out.hookSpecificOutput;
  assert.equal(s.hookEventName, 'PostToolUse');
  assert.equal(s.updatedToolOutput.type, 'text');
  assert.equal(s.updatedToolOutput.text, 'Z');
  assert.equal(s.updatedInput, undefined, 'PostToolUse must NOT carry updatedInput');
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — reinforce never-worse and extraction robustness on the net.
// ─────────────────────────────────────────────────────────────────────────────
test('RWRT-02 edge: never-worse passthrough — a chain that GROWS the output emits no replacement', () => {
  const post = require(postPath);
  // Override returns a LARGER string than the input → null (original output kept).
  assert.equal(post.buildPostOutput('somecmd', 'ab', [() => 'abcd']), null);
});

test('RWRT-02 edge: extractToolOutputText tolerates {type,text}, bare string, and missing output', () => {
  const post = require(postPath);
  assert.equal(post.extractToolOutputText({ tool_output: { type: 'text', text: 'hi' } }), 'hi');
  assert.equal(post.extractToolOutputText({ tool_output: 'yo' }), 'yo');
  assert.equal(post.extractToolOutputText({}), null);
});
