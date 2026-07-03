'use strict';

// 67-03-02: hooks/gsd-stop-gate.cjs — deadlock-impossibility proof, structured
// block reasons, warn-mode non-blocking, fail-open behaviors.
//
// Spawns the real hook script as a child process (matches the
// 67-01-hook-common.test.cjs convention) against a fresh tmpRoot/tmpData
// fixture per test. tmpData's tasks.json `items` field is ARRAY-shaped, byte
// compatible with the real data/tasks.json shape — a map-shaped fixture
// ({"items": {"TK-9001": ...}}) would make an items[tk] lookup bug pass
// every test, so it MUST NOT be used here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const STOP_GATE_PATH = path.resolve(__dirname, '../hooks/gsd-stop-gate.cjs');

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * runGate(payload, {tmpRoot, tmpData, mode}) — spawn the real gate script.
 * `mode` === undefined deletes GSD_HOOKS_ENFORCE entirely (true "unset"
 * warn-default case), any other string value is passed through verbatim.
 */
function runGate(payload, { tmpRoot, tmpData, mode }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: tmpRoot, AMAUTA_DATA_DIR: tmpData };
    if (mode === undefined) delete env.GSD_HOOKS_ENFORCE;
    else env.GSD_HOOKS_ENFORCE = mode;

    const child = spawn(process.execPath, [STOP_GATE_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

function writeTasksJson(tmpData, tValue) {
  fs.writeFileSync(
    path.join(tmpData, 'tasks.json'),
    JSON.stringify({ items: [{ id: 'TK-9001', rpetd_phases: { T: tValue } }] }),
  );
}

function writeMarker(tmpData, entries) {
  fs.writeFileSync(path.join(tmpData, 'hook-active-tasks.json'), JSON.stringify({ version: 1, tasks: entries }));
}

function readCounterFile(tmpData) {
  const p = path.join(tmpData, 'hook-stop-counter.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** setupFixture() — fresh tmpRoot (.planning/phases/99-fixture/...) + tmpData
 * (array-shaped tasks.json, T empty; marker claiming TK-9001 under phase 99). */
function setupFixture() {
  const tmpRoot = freshTmpDir('stop-gate-root-');
  const tmpData = freshTmpDir('stop-gate-data-');
  fs.mkdirSync(path.join(tmpRoot, '.planning', 'phases', '99-fixture', 'divergence-reports'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, '.planning', 'STATE.md'), 'Phase: 99 fixture\nNext step: n/a\n');
  writeTasksJson(tmpData, '');
  writeMarker(tmpData, {
    'TK-9001': {
      plan_task_id: '99-01-01',
      plan_id: '99-01',
      phase: '99',
      agent: 'executor-backend',
      claimed_at: new Date().toISOString(),
    },
  });
  return { tmpRoot, tmpData };
}

test('67-03-02(1-4): deadlock-impossibility — 3 consecutive blocks then allow-with-warning, then a fresh bounded cycle', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  // Case 1: block + missing T.
  const call1 = await runGate({ session_id: 'sess-1', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(call1.code, 0, `stderr: ${call1.stderr}`);
  const parsed1 = JSON.parse(call1.stdout);
  assert.equal(parsed1.decision, 'block');
  assert.match(parsed1.reason, /TK-9001/);
  assert.match(parsed1.reason, /T-phase/);
  assert.equal(readCounterFile(tmpData)['sess-1'].count, 1);

  // Case 2: repeat, stop_hook_active true.
  const call2 = await runGate({ session_id: 'sess-1', stop_hook_active: true }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(JSON.parse(call2.stdout).decision, 'block');
  assert.equal(readCounterFile(tmpData)['sess-1'].count, 2);

  // Case 2 (again, per plan wording "repeat twice more"): third block.
  const call3 = await runGate({ session_id: 'sess-1', stop_hook_active: true }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(JSON.parse(call3.stdout).decision, 'block');
  assert.equal(readCounterFile(tmpData)['sess-1'].count, 3);

  // Case 3: 4th call -> ALLOW-with-warning, no "decision" key, counter reset.
  const call4 = await runGate({ session_id: 'sess-1', stop_hook_active: true }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(call4.code, 0, `stderr: ${call4.stderr}`);
  const parsed4 = JSON.parse(call4.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed4, 'decision'), false, 'the escape path must never carry a "decision" key');
  assert.match(parsed4.systemMessage, /3 consecutive blocks/);
  assert.equal(readCounterFile(tmpData)['sess-1'], undefined, 'counter must be reset after the escape fires');

  // Verification criterion 2: a 5th call (fresh turn) starts a fresh bounded cycle.
  const call5 = await runGate({ session_id: 'sess-1', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(JSON.parse(call5.stdout).decision, 'block', 'the 5th call must start a brand new bounded cycle, not stay in the escape state');
  assert.equal(readCounterFile(tmpData)['sess-1'].count, 1);
});

test('67-03-02(4): filling T-phase evidence allows the turn end and leaves the counter reset', async () => {
  const { tmpRoot, tmpData } = setupFixture();
  writeTasksJson(tmpData, 'T-phase evidence logged');

  const result = await runGate({ session_id: 'sess-4', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'no violations -> silent allow, empty stdout');
  assert.equal(readCounterFile(tmpData)['sess-4'], undefined);
});

test('67-03-02(5): unresolved divergence report blocks; orchestrator_response OR resolution independently resolves it', async () => {
  const { tmpRoot, tmpData } = setupFixture();
  writeTasksJson(tmpData, 'T evidence logged'); // T filled so the divergence report is the ONLY possible violation
  const reportsDir = path.join(tmpRoot, '.planning', 'phases', '99-fixture', 'divergence-reports');
  const reportPath = path.join(reportsDir, 'TK-9001-a.json');

  fs.writeFileSync(reportPath, JSON.stringify({ task_id: 'TK-9001', expected: 'x', found: 'y' }));
  const blocked = await runGate({ session_id: 'sess-5a', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  const parsedBlocked = JSON.parse(blocked.stdout);
  assert.equal(parsedBlocked.decision, 'block');
  assert.match(parsedBlocked.reason, /unresolved divergence report/);
  assert.match(parsedBlocked.reason, /divergence-reports\/TK-9001-a\.json/);

  // Resolve via orchestrator_response — the canonical signal all 7 real
  // resolved reports carry.
  fs.writeFileSync(reportPath, JSON.stringify({
    task_id: 'TK-9001', expected: 'x', found: 'y',
    orchestrator_response: { decision: 'halt phase', decided_by: 'gsd-orchestrator' },
  }));
  const allowedOrch = await runGate({ session_id: 'sess-5b', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(allowedOrch.code, 0, `stderr: ${allowedOrch.stderr}`);
  assert.equal(allowedOrch.stdout, '');

  // A second, separate report resolved via `resolution` ONLY (the accepted
  // future alias, no orchestrator_response) must independently allow too.
  const reportPath2 = path.join(reportsDir, 'TK-9001-b.json');
  fs.writeFileSync(reportPath2, JSON.stringify({
    task_id: 'TK-9001', expected: 'x', found: 'y',
    resolution: { decision: 'expand scope' },
  }));
  const allowedRes = await runGate({ session_id: 'sess-5c', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(allowedRes.code, 0, `stderr: ${allowedRes.stderr}`);
  assert.equal(allowedRes.stdout, '');
});

test('67-03-02(6): warn mode (env unset) with missing T lists the same items via systemMessage and never increments the counter', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  const result = await runGate({ session_id: 'sess-6', stop_hook_active: false }, { tmpRoot, tmpData, mode: undefined });
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.systemMessage, /TK-9001/);
  assert.match(parsed.systemMessage, /T-phase/);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'decision'), false, 'warn mode must never emit the Stop block shape');
  assert.equal(readCounterFile(tmpData)['sess-6'], undefined, 'warn mode must never increment the counter');
});

test('67-03-02(7): parallel sessions have independent bounded-retry counters', async () => {
  const { tmpRoot, tmpData } = setupFixture();

  await runGate({ session_id: 'sess-A', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  await runGate({ session_id: 'sess-A', stop_hook_active: true }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(readCounterFile(tmpData)['sess-A'].count, 2);

  const resultB = await runGate({ session_id: 'sess-B', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  const parsedB = JSON.parse(resultB.stdout);
  assert.equal(parsedB.decision, 'block', 'sess-B must start its own fresh cycle, unaffected by sess-A count 2');
  assert.equal(readCounterFile(tmpData)['sess-B'].count, 1);
  assert.equal(readCounterFile(tmpData)['sess-A'].count, 2, 'sess-A must be untouched by sess-B call');
});

test('67-03-02(8): corrupt tasks.json fails open to allow; missing counter file is treated as count 0', async () => {
  const { tmpRoot, tmpData } = setupFixture();
  fs.writeFileSync(path.join(tmpData, 'tasks.json'), 'not-json-at-all{{{');
  assert.equal(fs.existsSync(path.join(tmpData, 'hook-stop-counter.json')), false, 'no counter file exists yet');

  const result = await runGate({ session_id: 'sess-8', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'corrupt tasks.json -> item unfindable -> fail-open -> not a violation -> silent allow');
});

test('67-03-02(9): a divergence report for a task_id NOT in the active marker is inert', async () => {
  const { tmpRoot, tmpData } = setupFixture();
  writeTasksJson(tmpData, 'T evidence logged'); // T filled, so a T-phase violation cannot mask this case
  const reportsDir = path.join(tmpRoot, '.planning', 'phases', '99-fixture', 'divergence-reports');
  fs.writeFileSync(path.join(reportsDir, 'TK-8888-a.json'), JSON.stringify({ task_id: 'TK-8888', expected: 'x', found: 'y' }));

  const result = await runGate({ session_id: 'sess-9', stop_hook_active: false }, { tmpRoot, tmpData, mode: 'block' });
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'an unclaimed task_id report can never block a different active session');
});
