'use strict';

// 67-02-02: hooks/gsd-manifest-gate.cjs contract tests (HOOK-01).
//
// Spawns the REAL gate script as a child process with fixture stdin — the
// same discipline as tests/67-01-hook-common.test.cjs, but exercising the
// actual gate file rather than a synthetic runGate() fixture. The fixture
// allowlists artifact is pointed at via the authoritative-exclusive
// GSD_HOOK_ALLOWLISTS_PATH seam (hook-common.loadAllowlists()); the fixture
// marker is written directly to AMAUTA_DATA_DIR/hook-active-tasks.json in
// the exact shape gsd-amauta.cjs's cmdClaim writes (see gsd-amauta.cjs:528
// and hook-state.cjs readActiveTasks()).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_PATH = path.join(REPO_ROOT, 'hooks', 'gsd-manifest-gate.cjs');

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal fixture allowlists artifact — representative membership only, per
 * the plan's "zero copies of GLOBAL_ALLOWLIST/ORCHESTRATOR_OWNED contents"
 * must_have. These values are LOCAL fixture data, not the real lists. */
function writeAllowlists(tmpDir, overrides = {}) {
  const artifact = {
    artifact_version: 1,
    generated_by: 'test-fixture',
    orchestrator_owned: overrides.orchestrator_owned || ['.planning/STATE.md'],
    global_allowlist: overrides.global_allowlist || ['package-lock.json'],
    capability_catalog: { catalog_version: '1.0', entry_names: [] },
  };
  const p = path.join(tmpDir, 'hook-allowlists.json');
  fs.writeFileSync(p, JSON.stringify(artifact, null, 2));
  return p;
}

function writeMarker(tmpDataDir, tasks) {
  fs.mkdirSync(tmpDataDir, { recursive: true });
  const p = path.join(tmpDataDir, 'hook-active-tasks.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, tasks }, null, 2));
  return p;
}

function fixtureEntry(overrides = {}) {
  return {
    agent: 'executor-backend',
    claimed_at: new Date().toISOString(),
    files_expected: { modify: ['src/app.cjs'], create: ['tests/app.test.cjs'], delete: [] },
    ...overrides,
  };
}

function runGate({ env, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function baseEnv({ tmpRoot, tmpData, allowlistsPath, mode }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: tmpRoot,
    AMAUTA_DATA_DIR: tmpData,
    GSD_HOOK_ALLOWLISTS_PATH: allowlistsPath,
  };
  if (mode === undefined) delete env.GSD_HOOKS_ENFORCE;
  else env.GSD_HOOKS_ENFORCE = mode;
  return env;
}

function editStdin(filePath) {
  return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } });
}
function writeStdin(filePath) {
  return JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } });
}

function setupFixtures(tasks) {
  const tmpRoot = freshTmpDir('manifest-gate-root-');
  const tmpData = freshTmpDir('manifest-gate-data-');
  const allowlistsPath = writeAllowlists(tmpRoot);
  if (tasks) writeMarker(tmpData, tasks);
  return { tmpRoot, tmpData, allowlistsPath };
}

function cleanup({ tmpRoot, tmpData }) {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

// ─── Case 1 & 2: in-manifest edits allow ───────────────────────────────────

test('67-02-02(1): block mode, in-manifest Edit on modify-list member -> allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('src/app.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-02(2): block mode, in-manifest Write on create-list member -> allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: writeStdin('tests/app.test.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 3: out-of-manifest deny, exact JSON shape ────────────────────────

test('67-02-02(3): block mode, out-of-manifest Edit -> exact deny JSON shape', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /src\/app\.cjs/);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /divergence-protocol\.md/);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'decision'), false, 'deprecated top-level decision key must be absent');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 4: warn mode never denies ────────────────────────────────────────

test('67-02-02(4): warn mode (env unset), same rogue input -> exit 0, systemMessage, no permissionDecision', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: undefined }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.systemMessage, 'string');
    assert.ok(parsed.systemMessage.length > 0);
    assert.equal(parsed.hookSpecificOutput, undefined, 'warn mode must never carry permissionDecision anywhere');
    assert.equal(parsed.permissionDecision, undefined);
  } finally {
    cleanup(fx);
  }
});

// ─── Case 5: off mode ───────────────────────────────────────────────────────

test('67-02-02(5): GSD_HOOKS_ENFORCE=off -> exit 0, empty stdout', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'off' }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 6: global allowlist ───────────────────────────────────────────────

test('67-02-02(6): block mode, Edit on a global_allowlist entry -> allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('package-lock.json'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 7: orchestrator-owned semantics ──────────────────────────────────

test('67-02-02(7a): block mode, Edit .planning/STATE.md with an executor-agent marker -> deny (orchestrator-owned)', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry({ agent: 'executor-backend' }) });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('.planning/STATE.md'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /orchestrator-owned/);
  } finally {
    cleanup(fx);
  }
});

test('67-02-02(7b): block mode, Edit .planning/STATE.md with an operator (non-executor) marker -> allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry({ agent: 'operator' }) });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('.planning/STATE.md'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-02(7c): block mode, path present in BOTH orchestrator_owned AND global_allowlist -> orchestrator-owned deny wins (TK-1803 continuation)', async () => {
  // Reproduces the real committed get-shit-done/config/hook-allowlists.json
  // shape, where '.planning/STATE.md' is a member of BOTH lists. Before the
  // TK-1803 fix, gsd-manifest-gate.cjs checked global_allowlist (old Step 4)
  // before orchestrator_owned (old Step 5), so this overlap silently
  // allowed the write. The fix checks orchestrator_owned FIRST — this case
  // proves the ordering directly rather than relying on disjoint fixtures.
  const fx = setupFixtures({ 'TK-9001': fixtureEntry({ agent: 'executor-backend' }) });
  fx.allowlistsPath && fs.writeFileSync(fx.allowlistsPath, JSON.stringify({
    artifact_version: 1,
    generated_by: 'test-fixture-overlap',
    orchestrator_owned: ['.planning/STATE.md'],
    global_allowlist: ['.planning/STATE.md', 'package-lock.json'],
    capability_catalog: { catalog_version: '1.0', entry_names: [] },
  }, null, 2));
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('.planning/STATE.md'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout || '{}');
    assert.equal(
      parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision,
      'deny',
      `overlap path must hit the orchestrator-owned hard-halt, not the global_allowlist allow. ${result.stdout}`
    );
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /orchestrator-owned/);
  } finally {
    cleanup(fx);
  }
});

// ─── Case 8: files_expected null -> allow + warn ───────────────────────────

test('67-02-02(8): block mode, rogue path with files_expected:null in marker -> allow + systemMessage', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry({ files_expected: null }) });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.systemMessage, 'string');
    assert.match(parsed.systemMessage, /unenforceable|files_expected/i);
    assert.equal(parsed.hookSpecificOutput, undefined, 'unenforceable manifest must never deny');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 9: no marker file at all -> allow silently ───────────────────────

test('67-02-02(9): block mode, no marker file at all -> allow silently (claim gate owns it)', async () => {
  const fx = setupFixtures(null); // no marker written
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 10: corrupt artifact -> fail-open ─────────────────────────────────

test('67-02-02(10): block mode, corrupt allowlists artifact -> fail-open allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  fs.writeFileSync(fx.allowlistsPath, '{not valid json');
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    if (result.stdout.length > 0) {
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput, undefined, 'corrupt-artifact fail-open must never deny');
    }
  } finally {
    cleanup(fx);
  }
});

// ─── Case 11: glob manifest ──────────────────────────────────────────────────

test('67-02-02(11a): glob manifest allows a matching path under get-shit-done/bin/*.cjs', async () => {
  const fx = setupFixtures({
    'TK-9001': fixtureEntry({ files_expected: { modify: ['get-shit-done/bin/*.cjs'], create: [], delete: [] } }),
  });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('get-shit-done/bin/x.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-02(11b): glob manifest denies a non-matching path (services/x.py)', async () => {
  const fx = setupFixtures({
    'TK-9001': fixtureEntry({ files_expected: { modify: ['get-shit-done/bin/*.cjs'], create: [], delete: [] } }),
  });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('services/x.py'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanup(fx);
  }
});

// ─── Case 12: TTL-expired marker behaves like no marker ────────────────────

test('67-02-02(12): TTL-expired marker (claimed_at 25h ago) behaves as no-marker -> allow', async () => {
  const staleIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const fx = setupFixtures({ 'TK-9001': fixtureEntry({ claimed_at: staleIso }) });
  try {
    const result = await runGate({
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('src/rogue.cjs'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});
