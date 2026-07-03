'use strict';

// 67-03-04: hooks/gsd-session-handoff.cjs — PreCompact ledger write on both
// triggers, SessionStart rehydration content, staleness, and fail-open
// behaviors. Spawns the real hook script as a child process, matching the
// 67-01-hook-common.test.cjs / 67-03-stop-gate.test.cjs conventions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const HANDOFF_PATH = path.resolve(__dirname, '../hooks/gsd-session-handoff.cjs');

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runGate(payload, { tmpRoot, tmpData, mode }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: tmpRoot, AMAUTA_DATA_DIR: tmpData };
    if (mode === undefined) delete env.GSD_HOOKS_ENFORCE;
    else env.GSD_HOOKS_ENFORCE = mode;

    const child = spawn(process.execPath, [HANDOFF_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function ledgerFilePath(tmpData) {
  return path.join(tmpData, 'handoff-ledger.json');
}

function readLedgerFile(tmpData) {
  return JSON.parse(fs.readFileSync(ledgerFilePath(tmpData), 'utf8'));
}

/**
 * setupFixture() — tmpRoot as a real git repo (one dirty file), a
 * .planning/STATE.md stub with 'Phase: 67 of 71' / 'Next step: run wave 2',
 * a marker claiming TK-9001 under phase 99, and a fixture unresolved
 * divergence report for that same task_id.
 */
function setupFixture() {
  const tmpRoot = freshTmpDir('handoff-root-');
  const tmpData = freshTmpDir('handoff-data-');

  execSync('git init -q', { cwd: tmpRoot });
  execSync('git config user.email "a@b.com"', { cwd: tmpRoot });
  execSync('git config user.name "a"', { cwd: tmpRoot });
  fs.writeFileSync(path.join(tmpRoot, 'dirty.txt'), 'uncommitted change\n');

  fs.mkdirSync(path.join(tmpRoot, '.planning', 'phases', '99-fixture', 'divergence-reports'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, '.planning', 'STATE.md'),
    '## Current Position\n\nPhase: 67 of 71\nNext step: run wave 2\n',
  );
  fs.writeFileSync(
    path.join(tmpRoot, '.planning', 'phases', '99-fixture', 'divergence-reports', 'TK-9001-a.json'),
    JSON.stringify({ task_id: 'TK-9001', expected: 'x', found: 'y' }),
  );

  fs.writeFileSync(
    path.join(tmpData, 'hook-active-tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: {
        'TK-9001': {
          plan_task_id: '99-01-01',
          plan_id: '99-01',
          phase: '99',
          agent: 'executor-backend',
          claimed_at: new Date().toISOString(),
        },
      },
    }),
  );

  return { tmpRoot, tmpData };
}

test('67-03-04(1): PreCompact trigger auto writes a ledger with all locked fields', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  const result = await runGate(
    { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'warn' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);

  assert.ok(fs.existsSync(ledgerFilePath(tmpData)), 'ledger must be written');
  const ledger = readLedgerFile(tmpData);
  assert.equal(ledger.version, 1);
  assert.equal(ledger.trigger, 'auto');
  assert.match(ledger.current_phase, /67/);
  assert.match(ledger.next_action, /wave 2/);
  assert.equal(ledger.active_tasks.length, 1);
  assert.equal(ledger.active_tasks[0].tk, 'TK-9001');
  assert.equal(ledger.open_divergences.length, 1);
  assert.match(ledger.open_divergences[0], /divergence-reports\/TK-9001-a\.json/);
  assert.ok(ledger.touched_files.length > 0, 'touched_files must be non-empty for a dirty repo');
});

test('67-03-04(2): PreCompact trigger manual also writes a ledger (both triggers write)', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  const result = await runGate(
    { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'warn' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const ledger = readLedgerFile(tmpData);
  assert.equal(ledger.trigger, 'manual');
});

test('67-03-04(3): SessionStart source resume with a fresh ledger renders additionalContext with phase and the TK id', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  await runGate({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 's1' }, { tmpRoot, tmpData, mode: 'warn' });

  const result = await runGate(
    { hook_event_name: 'SessionStart', source: 'resume', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'warn' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /GSD handoff/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /67/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /TK-9001/);
});

test('67-03-04(4): a ledger written_at 8 days ago is stale — exit 0, empty stdout', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  const staleWrittenAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  fs.mkdirSync(tmpData, { recursive: true });
  fs.writeFileSync(ledgerFilePath(tmpData), JSON.stringify({
    version: 1,
    written_at: staleWrittenAt,
    trigger: 'auto',
    session_id: 's1',
    current_phase: '67 of 71',
    next_action: 'run wave 2',
    active_tasks: [],
    open_divergences: [],
    touched_files: [],
  }));

  const result = await runGate(
    { hook_event_name: 'SessionStart', source: 'resume', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'warn' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'an 8-day-old ledger must produce no additionalContext');
});

test('67-03-04(5): no .planning/STATE.md — PreCompact still exits 0 and writes a ledger with a null phase', async () => {
  const { tmpRoot, tmpData } = setupFixture();
  fs.rmSync(path.join(tmpRoot, '.planning', 'STATE.md'));

  const result = await runGate(
    { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'warn' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const ledger = readLedgerFile(tmpData);
  assert.equal(ledger.current_phase, null);
  assert.equal(ledger.next_action, null);
});

test('67-03-04(6): GSD_HOOKS_ENFORCE=off — PreCompact exits 0 and does NOT write a ledger', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  const result = await runGate(
    { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'off' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(ledgerFilePath(tmpData)), false, 'kill switch must produce zero side effects — no ledger write');
});

test('67-03-04(7): a corrupt existing ledger + SessionStart exits 0 silently', async () => {
  const { tmpRoot, tmpData } = setupFixture();
  fs.writeFileSync(ledgerFilePath(tmpData), 'not-json-at-all{{{');

  const result = await runGate(
    { hook_event_name: 'SessionStart', source: 'resume', session_id: 's1' },
    { tmpRoot, tmpData, mode: 'warn' },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'a corrupt ledger must fail open to silence, never a crash or a block');
});
