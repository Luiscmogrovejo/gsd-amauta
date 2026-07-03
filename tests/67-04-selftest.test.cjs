'use strict';

// tests/67-04-selftest.test.cjs — HOOK-06: the phase's core success
// criterion. A scripted plan -> claim -> execute -> stop -> close -> handoff
// cycle running with GSD_HOOKS_ENFORCE=block, entirely inside an ISOLATED
// tmp project (git init; fixture .planning/STATE.md + 99-01-PLAN.md; fixture
// data/tasks.json). Every spawn env points CLAUDE_PROJECT_DIR/AMAUTA_DATA_DIR
// /GSD_HOOK_ALLOWLISTS_PATH at the tmp fixture — zero real repo/production
// state is touched (see the pollution-canary test at the bottom, which
// asserts the REAL data/hook-active-tasks.json mtime is unchanged).
//
// The hooks under test are the REAL scripts in this repo's hooks/ dir,
// spawned as child processes with stdin JSON exactly as Claude Code would
// deliver it — no internal imports of gate handler functions, no live
// session, no daemon.
//
// data/tasks.json's `items` field is ARRAY-shaped, byte-compatible with the
// real repo's data/tasks.json (1792+ array elements, no keyed map). A
// map-shaped fixture ({"items": {"TK-9001": ...}}) would let an items[tk]
// lookup bug pass every one of these 10 steps undetected, so it MUST NOT be
// used here (same discipline as 67-03-stop-gate.test.cjs).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLAIM_GATE = path.join(REPO_ROOT, 'hooks', 'gsd-claim-gate.cjs');
const MANIFEST_GATE = path.join(REPO_ROOT, 'hooks', 'gsd-manifest-gate.cjs');
const STOP_GATE = path.join(REPO_ROOT, 'hooks', 'gsd-stop-gate.cjs');
const HANDOFF_GATE = path.join(REPO_ROOT, 'hooks', 'gsd-session-handoff.cjs');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');
const REAL_MARKER_PATH = path.join(REPO_ROOT, 'data', 'hook-active-tasks.json');
const hookState = require(path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'hook-state.cjs'));

const SESSION_ID = 'selftest-session';

// ─── Spawn + fixture helpers (67-01/67-02/67-03 convention) ────────────────

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function spawnGate(gatePath, env, stdinObj) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gatePath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.write(JSON.stringify(stdinObj));
    child.stdin.end();
  });
}

function dbg(result) {
  return `[spawn debug] exit=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
}

function editStdin(filePath) {
  return { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' }, session_id: SESSION_ID };
}
function writeStdin(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, session_id: SESSION_ID };
}

/**
 * baseEnv() — GSD_HOOKS_ENFORCE=block for every spawn per the plan's fixture
 * design, scoped ENTIRELY to the spawned child's env object (never assigned
 * to process.env, so it can never leak into this test process or any
 * sibling session). `modeOverride` lets steps 9/10 punch through to
 * off/warn for their specific assertions.
 */
function baseEnv({ tmpRoot, tmpData, allowlistsPath, modeOverride }) {
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: tmpRoot,
    AMAUTA_DATA_DIR: tmpData,
    GSD_HOOK_ALLOWLISTS_PATH: allowlistsPath,
    GSD_HOOKS_ENFORCE: modeOverride || 'block',
  };
}

/**
 * withFixtureDataDir(tmpData, fn) — the ONLY place this file touches
 * process.env, and only for the duration of a synchronous hook-state call
 * (writeActiveTask/pruneActiveTask read process.env.AMAUTA_DATA_DIR
 * internally, unlike findTaskItem/resolveManifestForTask which accept an
 * explicit path/cwd option). Restores the prior value immediately after —
 * this is an in-process simulation of the claim seam, kept daemon-free per
 * the plan ("the seam 67-01 proved end-to-end against the CLI; here state
 * is set directly to keep the self-test daemon-free").
 */
function withFixtureDataDir(tmpData, fn) {
  const prev = process.env.AMAUTA_DATA_DIR;
  process.env.AMAUTA_DATA_DIR = tmpData;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AMAUTA_DATA_DIR;
    else process.env.AMAUTA_DATA_DIR = prev;
  }
}

function readMarker(tmpData) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmpData, 'hook-active-tasks.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readTasksJson(tmpData) {
  return JSON.parse(fs.readFileSync(path.join(tmpData, 'tasks.json'), 'utf8'));
}
function writeTasksJson(tmpData, obj) {
  fs.writeFileSync(path.join(tmpData, 'tasks.json'), JSON.stringify(obj, null, 2));
}

// ─── Fixture project build (ISOLATED — tmp git repo, never the real repo) ──

function setupFixture() {
  const tmpRoot = freshTmpDir('gsd-67-04-selftest-root-');
  const tmpData = path.join(tmpRoot, 'data');
  fs.mkdirSync(tmpData, { recursive: true });

  execSync('git init -q', { cwd: tmpRoot });
  execSync('git config user.email "selftest@example.com"', { cwd: tmpRoot });
  execSync('git config user.name "selftest"', { cwd: tmpRoot });

  fs.mkdirSync(path.join(tmpRoot, '.planning', 'phases', '99-selftest', 'divergence-reports'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, '.planning', 'STATE.md'),
    '## Current Position\n\nPhase: 99 selftest\nNext step: run HOOK-06 self-test\n',
  );

  // Fixture 99-01-PLAN.md — concrete manifest for task 99-01-01, parsed via
  // the REAL hookState.resolveManifestForTask()/gsd-tools.cjs YAML parser.
  const planContent = [
    '---',
    'plan_id: 99-01',
    'phase: 99',
    '---',
    '',
    '<task id="99-01-01">',
    '  <title>Fixture self-test task</title>',
    '  <files_expected>',
    'modify:',
    '  - src/feature.cjs',
    'create:',
    '  - tests/feature.test.cjs',
    'delete: []',
    '  </files_expected>',
    '</task>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tmpRoot, '.planning', 'phases', '99-selftest', '99-01-PLAN.md'), planContent);

  // Fixture in-manifest source file (realistic Edit target).
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src', 'feature.cjs'), 'module.exports = {};\n');

  // Fixture data/tasks.json — ARRAY-shaped `items`, byte-compatible with the
  // real repo's data/tasks.json shape (see module doc comment above).
  writeTasksJson(tmpData, {
    items: [
      { id: 'TK-9001', tags: ['plan:99-01', 'task:99-01-01'], rpetd_phases: { R: '', P: '', E: '', T: '', D: '' } },
    ],
  });

  // Fixture allowlists artifact — a COPY of the real committed one, per the
  // plan's fixture design (never a hand-authored shape).
  const realAllowlists = fs.readFileSync(
    path.join(REPO_ROOT, 'get-shit-done', 'config', 'hook-allowlists.json'), 'utf8',
  );
  const allowlistsPath = path.join(tmpRoot, 'hook-allowlists.json');
  fs.writeFileSync(allowlistsPath, realAllowlists);

  return { tmpRoot, tmpData, allowlistsPath };
}

const fx = setupFixture();

// ─── Pollution canary (Risks & Mitigations #2) ─────────────────────────────
// The REAL repo's data/hook-active-tasks.json must be untouched by this
// entire run — every spawn/in-process call in this file targets fx.tmpData,
// never REPO_ROOT/data.

let realMarkerMtimeBefore = null;
before(() => {
  try {
    realMarkerMtimeBefore = fs.statSync(REAL_MARKER_PATH).mtimeMs;
  } catch {
    realMarkerMtimeBefore = null; // file absent — canary checks "still absent" instead
  }
});

after(() => {
  fs.rmSync(fx.tmpRoot, { recursive: true, force: true });
});

// ─── Step 1: PLAN (orchestrator, no claim) ─────────────────────────────────

test('67-04-03 step 1: PLAN — orchestrator writes with no active claim allow on both gates', async () => {
  const env = baseEnv(fx);

  const planClaim = await spawnGate(CLAIM_GATE, env, writeStdin('.planning/phases/99-selftest/99-02-PLAN.md'));
  assert.equal(planClaim.code, 0, dbg(planClaim));
  assert.equal(planClaim.stdout, '', `claim gate must allow planning-doc writes silently. ${dbg(planClaim)}`);

  const planManifest = await spawnGate(MANIFEST_GATE, env, writeStdin('.planning/phases/99-selftest/99-02-PLAN.md'));
  assert.equal(planManifest.code, 0, dbg(planManifest));
  assert.equal(planManifest.stdout, '', `manifest gate must allow with no active claim. ${dbg(planManifest)}`);

  const stateClaim = await spawnGate(CLAIM_GATE, env, writeStdin('.planning/STATE.md'));
  assert.equal(stateClaim.stdout, '', `orchestrator STATE.md write must pass the claim gate. ${dbg(stateClaim)}`);

  const stateManifest = await spawnGate(MANIFEST_GATE, env, writeStdin('.planning/STATE.md'));
  assert.equal(stateManifest.stdout, '', `orchestrator STATE.md write must pass the manifest gate (no executor claim active). ${dbg(stateManifest)}`);
});

// ─── Step 2: CLAIM (direct hook-state seam, daemon-free) ───────────────────

test('67-04-03 step 2: CLAIM — hook-state seam resolves the fixture manifest and writes the marker', () => {
  const item = hookState.findTaskItem('TK-9001', { dataDirPath: fx.tmpData });
  assert.ok(item, 'fixture tasks.json must yield the TK-9001 item via the array-aware lookup');

  const filesExpected = hookState.resolveManifestForTask(item, { cwd: fx.tmpRoot });
  assert.deepEqual(filesExpected, { modify: ['src/feature.cjs'], create: ['tests/feature.test.cjs'], delete: [] });

  withFixtureDataDir(fx.tmpData, () => {
    hookState.writeActiveTask('TK-9001', {
      plan_task_id: '99-01-01',
      plan_id: '99-01',
      phase: '99',
      agent: 'executor-backend',
      claimed_at: new Date().toISOString(),
      files_expected: filesExpected,
    });
  });

  const marker = readMarker(fx.tmpData);
  assert.ok(marker && marker.tasks && marker.tasks['TK-9001'], 'marker must be written to fx.tmpData, never the real repo');
  assert.deepEqual(marker.tasks['TK-9001'].files_expected, filesExpected);
});

// ─── Step 3: EXECUTE (in-manifest) — the HOOK-06 headline assertion ────────

test('67-04-03 step 3: EXECUTE in-manifest — legitimate executor writes pass BOTH gates in block mode', async () => {
  const env = baseEnv(fx);

  const editClaim = await spawnGate(CLAIM_GATE, env, editStdin('src/feature.cjs'));
  assert.equal(editClaim.stdout, '', `claimed code-file Edit must pass the claim gate. ${dbg(editClaim)}`);
  const editManifest = await spawnGate(MANIFEST_GATE, env, editStdin('src/feature.cjs'));
  assert.equal(editManifest.stdout, '', `in-manifest Edit must pass the manifest gate. ${dbg(editManifest)}`);

  const writeClaim = await spawnGate(CLAIM_GATE, env, writeStdin('tests/feature.test.cjs'));
  assert.equal(writeClaim.stdout, '', `claimed code-file Write must pass the claim gate. ${dbg(writeClaim)}`);
  const writeManifest = await spawnGate(MANIFEST_GATE, env, writeStdin('tests/feature.test.cjs'));
  assert.equal(writeManifest.stdout, '', `in-manifest Write (create-list member) must pass the manifest gate. ${dbg(writeManifest)}`);
});

// ─── Step 4: EXECUTE (rogue) — out-of-manifest write DENIED ────────────────

test('67-04-03 step 4: EXECUTE rogue — out-of-manifest Write is DENIED with the verified deny shape', async () => {
  const env = baseEnv(fx);
  const result = await spawnGate(MANIFEST_GATE, env, writeStdin('src/rogue.cjs'));
  assert.equal(result.code, 0, dbg(result));
  const parsed = JSON.parse(result.stdout || '{}');
  assert.equal(parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName, 'PreToolUse', dbg(result));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', dbg(result));
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /src\/feature\.cjs/, dbg(result));
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /divergence-protocol\.md/, dbg(result));
});

// ─── Step 5: EXECUTE (orchestrator-owned) — denied while an executor claim is active ─

test('67-04-03 step 5: EXECUTE orchestrator-owned — Edit .planning/STATE.md is DENIED while the executor marker is active', async () => {
  const env = baseEnv(fx);
  const result = await spawnGate(MANIFEST_GATE, env, editStdin('.planning/STATE.md'));
  const parsed = JSON.parse(result.stdout || '{}');
  assert.equal(parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision, 'deny', dbg(result));
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /orchestrator-owned/, dbg(result));
});

// ─── Step 6: STOP (incomplete) — blocked, naming TK-9001 ───────────────────

test('67-04-03 step 6: STOP incomplete — empty T-phase blocks turn-end naming TK-9001', async () => {
  const env = baseEnv(fx);
  const result = await spawnGate(STOP_GATE, env, { session_id: SESSION_ID, stop_hook_active: false });
  assert.equal(result.code, 0, dbg(result));
  const parsed = JSON.parse(result.stdout || '{}');
  assert.equal(parsed.decision, 'block', dbg(result));
  assert.match(parsed.reason, /TK-9001/, dbg(result));
  assert.match(parsed.reason, /T-phase/, dbg(result));
});

// ─── Step 7: CLOSE — T-phase evidence + divergence resolution + prune ──────

test('67-04-03 step 7a: CLOSE — writing T-phase evidence alone still blocks on the unresolved divergence report', async () => {
  const env = baseEnv(fx);

  const tasksJson = readTasksJson(fx.tmpData);
  tasksJson.items.find((it) => it.id === 'TK-9001').rpetd_phases.T = 'T-phase evidence logged via self-test';
  writeTasksJson(fx.tmpData, tasksJson);

  const reportPath = path.join(fx.tmpRoot, '.planning', 'phases', '99-selftest', 'divergence-reports', 'TK-9001-a.json');
  fs.writeFileSync(reportPath, JSON.stringify({ task_id: 'TK-9001', expected: 'x', found: 'y' }));

  const result = await spawnGate(STOP_GATE, env, { session_id: SESSION_ID, stop_hook_active: true });
  const parsed = JSON.parse(result.stdout || '{}');
  assert.equal(parsed.decision, 'block', dbg(result));
  assert.match(parsed.reason, /unresolved divergence report/, dbg(result));
});

test('67-04-03 step 7b: CLOSE — resolving via top-level orchestrator_response allows the turn end', async () => {
  const env = baseEnv(fx);
  const reportPath = path.join(fx.tmpRoot, '.planning', 'phases', '99-selftest', 'divergence-reports', 'TK-9001-a.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    task_id: 'TK-9001', expected: 'x', found: 'y',
    orchestrator_response: { decision: 'expand scope', decided_by: 'gsd-orchestrator' },
  }));

  const result = await spawnGate(STOP_GATE, env, { session_id: SESSION_ID, stop_hook_active: true });
  assert.equal(result.code, 0, dbg(result));
  assert.equal(result.stdout, '', `resolved report + filled T-phase must allow silently. ${dbg(result)}`);
});

test('67-04-03 step 7c: CLOSE — pruning the marker (status-done semantics) leaves no active tasks', () => {
  const pruned = withFixtureDataDir(fx.tmpData, () => hookState.pruneActiveTask('TK-9001'));
  assert.equal(pruned, true, 'pruneActiveTask must report an actual removal');
  const marker = readMarker(fx.tmpData);
  assert.equal(marker.tasks['TK-9001'], undefined, 'TK-9001 must no longer be present in the fixture marker');
});

test('67-04-03 step 7d: CLOSE — a final Stop with no active tasks allows', async () => {
  const env = baseEnv(fx);
  const result = await spawnGate(STOP_GATE, env, { session_id: SESSION_ID, stop_hook_active: false });
  assert.equal(result.code, 0, dbg(result));
  assert.equal(result.stdout, '', `no active tasks must allow silently. ${dbg(result)}`);
});

// ─── Step 8: HANDOFF — PreCompact ledger + SessionStart rehydration ────────

test('67-04-03 step 8: HANDOFF — PreCompact writes the ledger; SessionStart rehydrates it with TK-9001 removed', async () => {
  const env = baseEnv(fx);

  const preCompact = await spawnGate(HANDOFF_GATE, env, { hook_event_name: 'PreCompact', trigger: 'auto', session_id: SESSION_ID });
  assert.equal(preCompact.code, 0, dbg(preCompact));
  const ledgerPath = path.join(fx.tmpData, 'handoff-ledger.json');
  assert.ok(fs.existsSync(ledgerPath), 'PreCompact must write the ledger');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.match(ledger.current_phase, /99/, 'ledger must carry the fixture phase string');
  assert.deepEqual(ledger.active_tasks, [], 'the pruned marker must yield zero active tasks in the ledger');

  const sessionStart = await spawnGate(HANDOFF_GATE, env, { hook_event_name: 'SessionStart', source: 'resume', session_id: SESSION_ID });
  assert.equal(sessionStart.code, 0, dbg(sessionStart));
  const parsed = JSON.parse(sessionStart.stdout || '{}');
  assert.equal(parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName, 'SessionStart', dbg(sessionStart));
  assert.match(parsed.hookSpecificOutput.additionalContext, /99/, dbg(sessionStart));
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /TK-9001/, 'the rehydrated context must show TK-9001 removed/none, not still active');
});

// ─── Step 9: KILL SWITCH — GSD_HOOKS_ENFORCE=off ───────────────────────────

test('67-04-03 step 9: KILL SWITCH — GSD_HOOKS_ENFORCE=off allows the same rogue write with zero output', async () => {
  const env = baseEnv({ ...fx, modeOverride: 'off' });
  const result = await spawnGate(MANIFEST_GATE, env, writeStdin('src/rogue.cjs'));
  assert.equal(result.code, 0, dbg(result));
  assert.equal(result.stdout, '', `kill switch must produce empty stdout, zero side effects. ${dbg(result)}`);
});

// ─── Step 10: FAIL-OPEN — corrupt tasks.json, missing allowlists ───────────

test('67-04-03 step 10a: FAIL-OPEN — corrupt tasks.json allows the Stop turn (with an active claim re-established)', async () => {
  // Re-establish the marker so this Stop call actually exercises the
  // corrupt-tasks.json T-phase lookup path (an empty marker would allow
  // trivially via the "no active tasks" branch, proving nothing).
  withFixtureDataDir(fx.tmpData, () => {
    hookState.writeActiveTask('TK-9001', {
      plan_task_id: '99-01-01', plan_id: '99-01', phase: '99',
      agent: 'executor-backend', claimed_at: new Date().toISOString(),
      files_expected: { modify: ['src/feature.cjs'], create: ['tests/feature.test.cjs'], delete: [] },
    });
  });

  fs.writeFileSync(path.join(fx.tmpData, 'tasks.json'), 'not-json-at-all{{{');

  const env = baseEnv(fx);
  const result = await spawnGate(STOP_GATE, env, { session_id: 'selftest-failopen-session', stop_hook_active: false });
  assert.equal(result.code, 0, dbg(result));
  assert.equal(result.stdout, '', `corrupt tasks.json -> unfindable item -> fail-open allow (divergence report already resolved). ${dbg(result)}`);
});

test('67-04-03 step 10b: FAIL-OPEN — a missing allowlists artifact allows the rogue write (fail-open before manifest evaluation)', async () => {
  fs.rmSync(fx.allowlistsPath, { force: true });

  const env = baseEnv(fx); // GSD_HOOK_ALLOWLISTS_PATH now points at a deleted file
  const result = await spawnGate(MANIFEST_GATE, env, writeStdin('src/rogue.cjs'));
  assert.equal(result.code, 0, dbg(result));
  const parsed = JSON.parse(result.stdout || '{}');
  assert.equal(typeof parsed.systemMessage, 'string', `missing allowlists must fail open with a systemMessage. ${dbg(result)}`);
  assert.equal(parsed.hookSpecificOutput, undefined, 'a missing allowlists artifact must never produce a deny shape');
});

// ─── Registration cross-check: the COMMITTED settings.json points at real scripts ─

test('67-04-03 registration cross-check: every hooks/*.cjs command in the committed .claude/settings.json exists', () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  assert.equal(settings.env.GSD_HOOKS_ENFORCE, 'warn', 'the committed default must be warn, never block');

  const basenames = [];
  for (const eventName of Object.keys(settings.hooks || {})) {
    const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    for (const group of groups) {
      const hooksArr = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of hooksArr) {
        const cmd = typeof h.command === 'string' ? h.command : '';
        const m = /hooks\/([^"'\s]+\.cjs)/.exec(cmd);
        if (m) basenames.push(m[1]);
        assert.equal(h.timeout, 5, `every registered hook must carry timeout 5. command=${cmd}`);
      }
    }
  }
  assert.ok(basenames.length >= 5, `expected at least 5 registered hook commands, found ${basenames.length}`);
  for (const name of basenames) {
    const scriptPath = path.join(REPO_ROOT, 'hooks', name);
    assert.ok(fs.existsSync(scriptPath), `registered hook script must exist on disk: hooks/${name}`);
  }
});

// ─── Pollution canary ──────────────────────────────────────────────────────

test('67-04-03 pollution canary: the REAL repo data/hook-active-tasks.json was never touched by this run', () => {
  let mtimeAfter = null;
  try {
    mtimeAfter = fs.statSync(REAL_MARKER_PATH).mtimeMs;
  } catch {
    mtimeAfter = null;
  }
  assert.equal(mtimeAfter, realMarkerMtimeBefore, 'the real repo marker file mtime must be byte-identical before/after this entire self-test run');
});
