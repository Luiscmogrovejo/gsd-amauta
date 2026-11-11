/**
 * Phase 88 plan 88-01: the fixture daemon is hermetic.
 *
 * Scope note: the live-store canary watches the LIVE checkout (GSD_LIVE_CHECKOUT,
 * default ~/Code/gsd-amauta) whichever worktree the run starts from, so the pid-file
 * assertion below holds for every plan in the phase, not only for a run started from
 * the live checkout. The daemon-side redirect of the pid files into the data dir
 * (services/amauta-daemon.py, GSD_TEST_MODE) is what keeps it green; this test is
 * its proof.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { startFixtureDaemon, stopFixtureDaemon } = require(path.join(ROOT, 'tests', 'support', 'fixture-daemon.cjs'));

const LIVE = process.env.GSD_LIVE_CHECKOUT || path.join(os.homedir(), 'Code', 'gsd-amauta');
const PID_FILES = [
  ...new Set(
    [ROOT, LIVE].flatMap((base) => [
      path.join(base, 'services', 'amauta-daemon.pid'),
      path.join(base, 'services', 'rlm-service.pid'),
    ])
  ),
];

/**
 * @param {string} p
 * @returns {{exists: boolean, sha256?: string}}
 */
function fileState(p) {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
}

/**
 * @param {number} port
 * @returns {Promise<{status: number, body: string}>}
 */
function get(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

describe('fixture daemon', () => {
  test('starts on an ephemeral port with SQLite, never calls docker, and leaves live files alone', async () => {
    const backupsDir = path.join(os.homedir(), '.amauta', 'backups');
    const backupsBefore = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : null;
    const pidsBefore = PID_FILES.map(fileState);

    // A fake docker first on PATH: if the daemon probes the container runtime it leaves a marker.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
    const marker = path.join(binDir, 'docker-called.txt');
    fs.writeFileSync(path.join(binDir, 'docker'), '#!/bin/sh\necho DOCKER_WAS_CALLED > "' + marker + '"\nexit 1\n', {
      mode: 0o755,
    });
    const savedPath = process.env.PATH;
    process.env.PATH = binDir + path.delimiter + savedPath;

    let handle;
    try {
      handle = await startFixtureDaemon();
    } finally {
      process.env.PATH = savedPath;
    }

    try {
      assert.ok(Number.isInteger(handle.port));
      assert.ok(![18799, 18798, 6379, 5433].includes(handle.port), 'port=' + handle.port);

      const res = await get(handle.port);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('sqlite'), res.body.slice(0, 300));

      const tmp = fs.realpathSync(os.tmpdir());
      assert.ok(fs.realpathSync(handle.dataDir).startsWith(tmp + path.sep), handle.dataDir);

      // The pid redirect is proven positively: the fixture's own pid file is in its data dir.
      const ownPid = path.join(handle.dataDir, 'amauta-daemon.pid');
      assert.ok(fs.existsSync(ownPid), 'fixture pid file must live in the data dir');
      assert.strictEqual(fs.readFileSync(ownPid, 'utf-8').trim(), String(handle.proc.pid));

      assert.ok(!fs.existsSync(marker), 'the daemon called docker under test mode');
    } finally {
      await stopFixtureDaemon(handle);
      fs.rmSync(binDir, { recursive: true, force: true });
    }

    assert.strictEqual(handle.proc.killed, true);
    assert.ok(!fs.existsSync(handle.dataDir), 'data dir must be removed');

    // Live files: byte-identical and still present after a full start + stop.
    assert.deepStrictEqual(PID_FILES.map(fileState), pidsBefore, 'live pid files changed');
    const backupsAfter = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : null;
    assert.strictEqual(backupsAfter, backupsBefore, '~/.amauta/backups changed');
  });

  test('a failed start reports the daemon stderr', async () => {
    // GSD_TEST_MODE refuses any data dir under ~/.amauta (exit 3), so the daemon never
    // becomes ready. A not-yet-existing subdirectory is used so that, if the refusal
    // ever regressed, the daemon would create a probe directory and not touch live files.
    const probe = path.join(os.homedir(), '.amauta', 'phase88-refusal-probe');
    let handle = null;
    let error = null;
    try {
      handle = await startFixtureDaemon({ dataDir: probe });
    } catch (err) {
      error = err;
    }
    if (handle) {
      await stopFixtureDaemon(handle);
      fs.rmSync(probe, { recursive: true, force: true });
      assert.fail('the daemon started on a data dir inside ~/.amauta');
    }
    assert.ok(/fixture daemon did not become ready/.test(error.message), error.message.slice(0, 300));
    assert.ok(/refuses DATA_DIR/.test(error.message), error.message.slice(0, 600));
    assert.ok(!fs.existsSync(probe) || fs.readdirSync(probe).length === 0, 'refusal must not write into the probe dir');
    fs.rmSync(probe, { recursive: true, force: true });
  });
});
