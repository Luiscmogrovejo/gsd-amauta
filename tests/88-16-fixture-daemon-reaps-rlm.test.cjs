'use strict';
/**
 * `stopFixtureDaemon` must also reap the RLM service the daemon started.
 *
 * Measured on `test (windows-latest, node 20)`, run 43189642396: the job ended
 * with two surviving interpreters —
 * `SURVIVING PYTHON pid=6044 … services\amauta-daemon.py run` and
 * `pid=7936 ppid=6044 … services\rlm-service.py run`. On Windows, terminating a
 * parent does not terminate its children, so even a daemon that IS stopped
 * leaves its RLM behind. Before this, `stopFixtureDaemon` only RECORDED that pid
 * in the process ledger; now it stops it.
 *
 * The test drives the real `stopFixtureDaemon` against a synthetic handle whose
 * "daemon" and "RLM" are two long-lived Node children THIS test spawned — so no
 * product process is started and no pid is signalled that the test did not
 * create.
 *
 * @module tests/88-16-fixture-daemon-reaps-rlm
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { stopFixtureDaemon } = require('./support/fixture-daemon.cjs');

/** @returns {import('child_process').ChildProcess} a child that stays alive until killed */
function spawnSleeper() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

/**
 * @param {number} pid
 * @returns {boolean} whether the pid still answers signal 0
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * @param {number} pid
 * @param {number} ms
 * @returns {Promise<boolean>} false once the pid is gone, true if it outlived the wait
 */
async function stillAliveAfter(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return alive(pid);
}

describe('[88-16-10] stopFixtureDaemon reaps the RLM the daemon left behind', () => {
  it('kills the pid in rlm-service.pid and records it as stopped', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reap-'));
    const ledger = path.join(dataDir, 'ledger.jsonl');
    const previousLedger = process.env.GSD_PROCESS_LEDGER;
    process.env.GSD_PROCESS_LEDGER = ledger;

    const daemon = spawnSleeper();
    const rlm = spawnSleeper();
    try {
      fs.writeFileSync(path.join(dataDir, 'rlm-service.pid'), String(rlm.pid), 'utf8');
      assert.ok(alive(rlm.pid), 'the stand-in RLM must be running before the stop');

      await stopFixtureDaemon({ proc: daemon, dataDir, keep: true });

      assert.strictEqual(
        await stillAliveAfter(rlm.pid, 5000),
        false,
        'the RLM pid named in rlm-service.pid outlived stopFixtureDaemon; on Windows that is ' +
          'exactly how run 43189642396 ended with an orphan rlm-service.py'
      );
      assert.strictEqual(await stillAliveAfter(daemon.pid, 2000), false, 'the daemon itself must be gone too');

      const records = fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const rlmRecord = records.find((r) => r.kind === 'rlm' && r.pid === rlm.pid);
      assert.ok(rlmRecord, 'the ledger must carry a record for the RLM pid');
      assert.strictEqual(
        rlmRecord.event,
        'stopped',
        'a reaped RLM is "stopped"; recording it as "started" is what made it a permanent stray'
      );
    } finally {
      for (const child of [daemon, rlm]) {
        try {
          if (child.pid && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
        } catch (_e) {
          /* already gone */
        }
      }
      if (previousLedger === undefined) delete process.env.GSD_PROCESS_LEDGER;
      else process.env.GSD_PROCESS_LEDGER = previousLedger;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
