'use strict';

// 67-02-04: hooks/gsd-claim-gate.cjs contract tests (HOOK-02) + cross-gate
// telemetry emission proof (both gates: gsd-manifest-gate.cjs +
// gsd-claim-gate.cjs).
//
// Section A spawns the real gate script with fixture stdin, same discipline
// as tests/67-02-manifest-gate.test.cjs. Section B proves telemetry.cjs's
// buffered-append contract fires exactly once per denial, metadata-only
// (never the fixture file path), for BOTH gates.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLAIM_GATE_PATH = path.join(REPO_ROOT, 'hooks', 'gsd-claim-gate.cjs');
const MANIFEST_GATE_PATH = path.join(REPO_ROOT, 'hooks', 'gsd-manifest-gate.cjs');

const { isCodeFile } = require(CLAIM_GATE_PATH);

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAllowlists(tmpDir) {
  const artifact = {
    artifact_version: 1,
    generated_by: 'test-fixture',
    orchestrator_owned: ['.planning/STATE.md'],
    global_allowlist: ['package-lock.json'],
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
    files_expected: { modify: ['services/x.py'], create: [], delete: [] },
    ...overrides,
  };
}

function runGate(gatePath, { env, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gatePath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

function editStdin(filePath) {
  return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } });
}
function writeStdin(filePath) {
  return JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } });
}

function baseEnv({ tmpRoot, tmpData, allowlistsPath, mode }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: tmpRoot,
    AMAUTA_DATA_DIR: tmpData,
  };
  if (allowlistsPath) env.GSD_HOOK_ALLOWLISTS_PATH = allowlistsPath;
  if (mode === undefined) delete env.GSD_HOOKS_ENFORCE;
  else env.GSD_HOOKS_ENFORCE = mode;
  return env;
}

function setupFixtures(tasks) {
  const tmpRoot = freshTmpDir('claim-gate-root-');
  const tmpData = freshTmpDir('claim-gate-data-');
  const allowlistsPath = writeAllowlists(tmpRoot);
  if (tasks) writeMarker(tmpData, tasks);
  return { tmpRoot, tmpData, allowlistsPath };
}

function cleanup({ tmpRoot, tmpData }) {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
}

// ─── Section A: claim-gate cases ───────────────────────────────────────────

test('67-02-04(A1): block mode, code-file Edit with empty marker -> deny with claim command template', async () => {
  const fx = setupFixtures({});
  try {
    const result = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('services/x.py'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /amauta\.cjs claim <TK-ID> --agent <agent>/);
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(A2): warn mode (env unset), same input -> exit 0 + systemMessage', async () => {
  const fx = setupFixtures({});
  try {
    const result = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: undefined }),
      stdin: editStdin('services/x.py'),
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.systemMessage, 'string');
    assert.match(parsed.systemMessage, /amauta\.cjs claim/);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(A3): off mode -> exit 0, empty stdout', async () => {
  const fx = setupFixtures({});
  try {
    const result = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'off' }),
      stdin: editStdin('services/x.py'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(A4): block mode, code-file Edit with a fresh marker entry -> allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  try {
    const result = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('services/x.py'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(A5): block mode, Write under .planning/, empty marker -> allow (planning-path exemption)', async () => {
  const fx = setupFixtures({});
  try {
    const result = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: writeStdin('.planning/phases/67-enforcement-hooks/note.md'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(A6): block mode, docs/ and .claude/ writes -> allow (non-code exemptions)', async () => {
  const fx = setupFixtures({});
  try {
    const r1 = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: writeStdin('docs/guide.md'),
    });
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.stdout, '');

    const r2 = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('.claude/settings.json'),
    });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.stdout, '');
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(A7): isCodeFile unit spot-checks via require', () => {
  assert.equal(isCodeFile('x.kt'), true);
  assert.equal(isCodeFile('docs/x.py'), false);
  assert.equal(isCodeFile('a/b.md'), false);
  assert.equal(isCodeFile('migrations/030-x.sql'), true);
});

test('67-02-04(A8): block mode, corrupt marker JSON -> fail-open allow', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry() });
  const markerPath = path.join(fx.tmpData, 'hook-active-tasks.json');
  fs.writeFileSync(markerPath, '{not valid json');
  try {
    const result = await runGate(CLAIM_GATE_PATH, {
      env: baseEnv({ ...fx, mode: 'block' }),
      stdin: editStdin('services/x.py'),
    });
    assert.equal(result.code, 0, result.stderr);
    if (result.stdout.length > 0) {
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput, undefined, 'corrupt-marker fail-open must never deny');
    }
  } finally {
    cleanup(fx);
  }
});

// ─── Section B: cross-gate telemetry emission proof ────────────────────────

function writeTelemetryConfig(dir, { enabled, salt }) {
  const p = path.join(dir, 'telemetry-config.json');
  fs.writeFileSync(p, JSON.stringify({ telemetry: { enabled, salt: salt || null, sink_url: null } }, null, 2));
  return p;
}

function readBufferLines(tmpData) {
  const bufPath = path.join(tmpData, 'telemetry-buffer.jsonl');
  if (!fs.existsSync(bufPath)) return [];
  return fs.readFileSync(bufPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

test('67-02-04(B1): manifest gate — enabled telemetry buffers exactly one hook_gate_denied line, no file path leaked', async () => {
  const fx = setupFixtures({ 'TK-9001': fixtureEntry({ files_expected: { modify: ['src/app.cjs'], create: [], delete: [] } }) });
  const telemetryConfigPath = writeTelemetryConfig(fx.tmpRoot, { enabled: true, salt: 'test-salt' });
  const targetPath = 'src/rogue-secret-marker.cjs';
  try {
    const env = { ...baseEnv({ ...fx, mode: 'block' }), GSD_TELEMETRY_CONFIG_PATH: telemetryConfigPath };
    const result = await runGate(MANIFEST_GATE_PATH, { env, stdin: editStdin(targetPath) });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');

    const lines = readBufferLines(fx.tmpData);
    assert.equal(lines.length, 1, `expected exactly one telemetry line, got ${lines.length}`);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event_type, 'error_class');
    assert.equal(event.payload.error_class, 'hook_gate_denied');
    assert.equal(event.payload.gate, 'manifest');
    for (const line of lines) {
      assert.equal(line.includes(targetPath), false, 'telemetry line must never contain the fixture file path');
    }
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(B2): claim gate — enabled telemetry buffers exactly one hook_gate_denied line, no file path leaked', async () => {
  const fx = setupFixtures({});
  const telemetryConfigPath = writeTelemetryConfig(fx.tmpRoot, { enabled: true, salt: 'test-salt' });
  const targetPath = 'services/secret-marker.py';
  try {
    const env = { ...baseEnv({ ...fx, mode: 'block' }), GSD_TELEMETRY_CONFIG_PATH: telemetryConfigPath };
    const result = await runGate(CLAIM_GATE_PATH, { env, stdin: editStdin(targetPath) });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');

    const lines = readBufferLines(fx.tmpData);
    assert.equal(lines.length, 1, `expected exactly one telemetry line, got ${lines.length}`);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event_type, 'error_class');
    assert.equal(event.payload.error_class, 'hook_gate_denied');
    assert.equal(event.payload.gate, 'claim');
    for (const line of lines) {
      assert.equal(line.includes(targetPath), false, 'telemetry line must never contain the fixture file path');
    }
  } finally {
    cleanup(fx);
  }
});

test('67-02-04(B3): telemetry disabled — buffers nothing, gate still denies correctly', async () => {
  const fx = setupFixtures({});
  const telemetryConfigPath = writeTelemetryConfig(fx.tmpRoot, { enabled: false });
  try {
    const env = { ...baseEnv({ ...fx, mode: 'block' }), GSD_TELEMETRY_CONFIG_PATH: telemetryConfigPath };
    const result = await runGate(CLAIM_GATE_PATH, { env, stdin: editStdin('services/x.py') });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');

    const bufPath = path.join(fx.tmpData, 'telemetry-buffer.jsonl');
    assert.equal(fs.existsSync(bufPath), false, 'disabled telemetry must never create a buffer file');
  } finally {
    cleanup(fx);
  }
});
