'use strict';

// 67-01-03: claim-marker seam — cmdClaim writes the local hook-state marker
// (plan-resolved manifest), cmdStatus prunes it on terminal status. A mock
// daemon proves the exit-code invariant holds regardless of marker-write
// success — the marker path NEVER changes claim/status behavior.
//
// REQUIRED: the mock daemon serves GET /health -> 200 {status:'ok'} (else
// ensureDaemon()/isDaemonRunning() at gsd-amauta.cjs:201-208 fails the
// handshake and the CLI would try to spawn a REAL python daemon) AND the
// spawned CLI sets GSD_AMAUTA_NO_AUTO_START=1 as a belt-and-braces backstop
// (gsd-amauta.cjs:254) so a real daemon can never spawn even if /health
// were ever unreachable.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_AMAUTA = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');

function startMockDaemon() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/claim') {
        res.writeHead(200);
        res.end(JSON.stringify({ exit_code: 0, output: 'CLAIMED', error: '' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/status') {
        res.writeHead(200);
        res.end(JSON.stringify({ exit_code: 0, output: 'STATUS OK', error: '' }));
        return;
      }
      // Defensive catch-all for any other route the CLI might hit.
      res.writeHead(200);
      res.end(JSON.stringify({ exit_code: 0 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GSD_AMAUTA, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

function setupFixtures() {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-marker-data-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-marker-root-'));

  fs.writeFileSync(
    path.join(tmpData, 'tasks.json'),
    JSON.stringify({
      items: [
        {
          id: 'TK-9001',
          type: 'task',
          title: 'Fixture claim-marker task',
          status: 'pending',
          tags: ['plan:99-01', 'task:99-01-01'],
          assigned_to: 'executor-backend',
        },
      ],
    })
  );

  const phaseDir = path.join(tmpRoot, '.planning', 'phases', '99-fixture');
  fs.mkdirSync(phaseDir, { recursive: true });
  const planContent = [
    '---',
    'plan_id: 99-01',
    '---',
    '',
    '<task id="99-01-01">',
    '<title>Fixture Task</title>',
    '<agent>executor-backend</agent>',
    '<files_expected>',
    'modify:',
    '  - fixtures/mod.js',
    'create:',
    '  - fixtures/new.js',
    'delete: []',
    '</files_expected>',
    '</task>',
  ].join('\n');
  fs.writeFileSync(path.join(phaseDir, '99-01-PLAN.md'), planContent);

  return { tmpData, tmpRoot };
}

test('67-01-03: claim writes a marker with the plan-resolved manifest; status-to-done prunes it', async () => {
  const { server, port } = await startMockDaemon();
  const { tmpData, tmpRoot } = setupFixtures();
  const markerPath = path.join(tmpData, 'hook-active-tasks.json');

  const baseEnv = {
    ...process.env,
    GSD_AMAUTA_HOST: '127.0.0.1',
    GSD_AMAUTA_PORT: String(port),
    GSD_AMAUTA_NO_AUTO_START: '1',
    AMAUTA_DATA_DIR: tmpData,
    CLAUDE_PROJECT_DIR: tmpRoot,
  };

  try {
    const claimResult = await runCli(['claim', 'TK-9001', '--agent', 'executor-backend'], baseEnv);
    assert.equal(claimResult.code, 0, `claim failed: ${claimResult.stderr}`);

    assert.ok(fs.existsSync(markerPath), 'marker file was not created by claim');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    assert.ok(marker.tasks['TK-9001'], 'marker entry for TK-9001 missing');
    const entry = marker.tasks['TK-9001'];
    assert.equal(entry.plan_id, '99-01');
    assert.equal(entry.plan_task_id, '99-01-01');
    assert.equal(entry.phase, '99');
    assert.deepEqual(entry.files_expected.modify, ['fixtures/mod.js']);
    assert.deepEqual(entry.files_expected.create, ['fixtures/new.js']);
    assert.deepEqual(entry.files_expected.delete, []);

    const statusResult = await runCli(['status', 'TK-9001', 'done', '--agent', 'executor-backend'], baseEnv);
    assert.equal(statusResult.code, 0, `status done failed: ${statusResult.stderr}`);

    const markerAfter = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    assert.equal(markerAfter.tasks['TK-9001'], undefined, 'marker entry for TK-9001 should be pruned after status done');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('67-01-03: marker-write failure (read-only data dir) does not change claim exit code', async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod read-only semantics differ on win32');
    return;
  }

  const { server, port } = await startMockDaemon();
  const { tmpData, tmpRoot } = setupFixtures();

  const baseEnv = {
    ...process.env,
    GSD_AMAUTA_HOST: '127.0.0.1',
    GSD_AMAUTA_PORT: String(port),
    GSD_AMAUTA_NO_AUTO_START: '1',
    AMAUTA_DATA_DIR: tmpData,
    CLAUDE_PROJECT_DIR: tmpRoot,
  };

  try {
    const baselineResult = await runCli(['claim', 'TK-9001', '--agent', 'executor-backend'], baseEnv);
    assert.equal(baselineResult.code, 0, `baseline claim failed: ${baselineResult.stderr}`);

    fs.chmodSync(tmpData, 0o555);
    try {
      const readonlyResult = await runCli(['claim', 'TK-9001', '--agent', 'executor-backend'], baseEnv);
      assert.equal(
        readonlyResult.code,
        baselineResult.code,
        `claim exit code changed under a read-only data dir: baseline=${baselineResult.code} readonly=${readonlyResult.code}`
      );
    } finally {
      fs.chmodSync(tmpData, 0o755);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
