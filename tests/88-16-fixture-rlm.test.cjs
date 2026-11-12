'use strict';
/**
 * 88-16-05: the fixture RLM starts, answers, is recorded in the process ledger
 * and stops by pid.
 *
 * The companion of `tests/88-01-fixture-daemon.test.cjs`. It binds a port this
 * helper chose on loopback; it never names 18798, the operator's live RLM port.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { startFixtureRlm, stopFixtureRlm, freePort } = require('./support/fixture-rlm.cjs');

/** GET a path from the fixture and return `{status, body}`. */
function get(baseUrl, p) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + p, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

test('88-16-05: the fixture RLM answers /health on a port it chose itself', async () => {
  const rlm = await startFixtureRlm();
  try {
    assert.ok(Number.isInteger(rlm.port) && rlm.port > 0);
    assert.ok(![18799, 18798, 6379, 5433].includes(rlm.port), 'the fixture must never choose a live port');
    const health = await get(rlm.baseUrl, '/health');
    assert.equal(health.status, 200, 'body: ' + health.body.slice(0, 300));
    const parsed = JSON.parse(health.body);
    assert.equal(typeof parsed, 'object');
  } finally {
    await stopFixtureRlm(rlm);
  }
});

test('88-16-05: its pid file lands under the data dir, never beside the script', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-rlm-pid-'));
  const rlm = await startFixtureRlm({ dataDir });
  try {
    const pidFile = path.join(dataDir, 'rlm-service.pid');
    assert.ok(fs.existsSync(pidFile), 'the fixture RLM must write its pid under AMAUTA_DATA_DIR');
    assert.equal(Number(fs.readFileSync(pidFile, 'utf-8').trim()), rlm.proc.pid);
    // The live service's pid file, beside the script, must be untouched.
    const besideScript = path.join(__dirname, '..', 'services', 'rlm-service.pid');
    assert.equal(
      fs.existsSync(besideScript) && fs.readFileSync(besideScript, 'utf-8').trim() === String(rlm.proc.pid),
      false,
      'the fixture overwrote services/rlm-service.pid, which belongs to the live service'
    );
  } finally {
    await stopFixtureRlm(rlm);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('88-16-05: start and stop are recorded in the process ledger', async () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-rlm-ledger-'));
  const ledger = path.join(ledgerDir, 'process-ledger.jsonl');
  const saved = process.env.GSD_PROCESS_LEDGER;
  process.env.GSD_PROCESS_LEDGER = ledger;
  try {
    const rlm = await startFixtureRlm();
    const pid = rlm.proc.pid;
    await stopFixtureRlm(rlm);
    const lines = fs
      .readFileSync(ledger, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.pid === pid);
    assert.deepEqual(
      lines.map((r) => r.event),
      ['started', 'stopped'],
      'the runner stray-process check needs both halves: ' + JSON.stringify(lines)
    );
    assert.equal(lines[0].kind, 'rlm');
  } finally {
    if (saved === undefined) delete process.env.GSD_PROCESS_LEDGER;
    else process.env.GSD_PROCESS_LEDGER = saved;
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('88-16-05: freePort never returns a live service port', async () => {
  for (let i = 0; i < 5; i++) {
    const p = await freePort();
    assert.ok(![18799, 18798, 6379, 5433].includes(p), 'freePort returned a live port: ' + p);
  }
});
