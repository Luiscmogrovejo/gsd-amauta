'use strict';
/**
 * `stopFixtureDaemon` must VERIFY the exit before it records one.
 *
 * Plan 88-16 routed this to 88-11 with the evidence that found it: run
 * 43189642396, `test (windows-latest, node 20)`, ended with a live
 * `services\amauta-daemon.py run` at pid 6044 that **no ledger line accounted
 * for**. The ledger said `stopped` because `stopFixtureDaemon` wrote that word
 * unconditionally, immediately after signalling — so
 * `live-store-canary.strayProcesses()`, which keys on the last event per pid,
 * could not see it. A record of intent is not a record of fact.
 *
 * Two cases, because the first alone is vacuous: it would pass just as well
 * against the old unconditional `stopped`.
 *
 *  1. a child that really dies is recorded `stopped`, and the data directory is
 *     cleaned up;
 *  2. a handle whose `kill` is swallowed, over a child that is really alive, is
 *     recorded `started` — with the port and data directory `identify()` needs —
 *     and its data directory is left in place. The old code recorded `stopped`
 *     here, which is the defect.
 *
 * No product process is started and no pid is signalled that this test did not
 * spawn itself.
 *
 * @module tests/88-11-fixture-daemon-verifies-exit
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Read at module load by fixture-daemon.cjs, and this file is its own process
// under `node --test`. Three grace windows are spent in case 2 (SIGTERM wait,
// SIGKILL wait, exit probe), so the default 5 s would make it a 15 s test.
process.env.GSD_FIXTURE_STOP_GRACE_MS = '300';

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
 * The ledger records for one pid, oldest first.
 * @param {string} ledger path of the JSONL ledger
 * @param {number} pid
 * @returns {object[]}
 */
function recordsFor(ledger, pid) {
  return fs
    .readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.pid === pid && r.kind === 'daemon');
}

/**
 * Run `body` with GSD_PROCESS_LEDGER pointed at a fresh file.
 * @param {function(string, string): Promise<void>} body receives (dataDir, ledgerPath)
 * @returns {Promise<void>}
 */
async function withLedger(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stopverify-'));
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stopledger-'));
  const ledger = path.join(ledgerDir, 'ledger.jsonl');
  const previous = process.env.GSD_PROCESS_LEDGER;
  process.env.GSD_PROCESS_LEDGER = ledger;
  try {
    await body(dataDir, ledger);
  } finally {
    if (previous === undefined) delete process.env.GSD_PROCESS_LEDGER;
    else process.env.GSD_PROCESS_LEDGER = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
}

describe('[88-11] stopFixtureDaemon records what it measured', () => {
  it('records "stopped" for a child that really exited, and removes the data dir', async () => {
    await withLedger(async (dataDir, ledger) => {
      const daemon = spawnSleeper();
      try {
        assert.ok(alive(daemon.pid), 'the stand-in daemon must be running before the stop');
        await stopFixtureDaemon({ proc: daemon, dataDir, port: 51234 });

        assert.strictEqual(alive(daemon.pid), false, 'the child must be gone');
        const records = recordsFor(ledger, daemon.pid);
        assert.strictEqual(records.length, 1, JSON.stringify(records));
        assert.strictEqual(records[0].event, 'stopped');
        assert.strictEqual(fs.existsSync(dataDir), false, 'a stopped daemon releases its data dir');
      } finally {
        try {
          if (daemon.pid && alive(daemon.pid)) process.kill(daemon.pid, 'SIGKILL');
        } catch (_e) {
          /* already gone */
        }
      }
    });
  });

  it('records "started" when the signal did not take, so the stray detector sees it', async () => {
    await withLedger(async (dataDir, ledger) => {
      const survivor = spawnSleeper();
      // A handle shaped like a ChildProcess whose kill() is swallowed and whose
      // 'exit' never fires -- the shape of a daemon that outlives its stop.
      const deafProc = {
        pid: survivor.pid,
        exitCode: null,
        signalCode: null,
        kill() { /* the signal does not take */ },
        once() { /* 'exit' never fires */ },
      };
      try {
        // Plan 89-15: a survivor is no longer only RECORDED — the stop REJECTS,
        // so the test that owns the daemon fails by name instead of the whole run
        // failing later on a pid and a port. Everything this case asserted about
        // the ledger still has to hold after the rejection.
        await assert.rejects(
          stopFixtureDaemon({ proc: deafProc, dataDir, port: 51235 }),
          (err) => err.code === 'EFIXTURESURVIVOR'
            && err.survivors.some((s) => s.pid === survivor.pid)
            && err.message.includes('tests/88-11-fixture-daemon-verifies-exit.test.cjs'),
          'a daemon that outlives SIGTERM and SIGKILL must fail its own test, naming the pid and the owning file',
        );

        assert.ok(alive(survivor.pid), 'the fixture must still be alive for this case to mean anything');
        const records = recordsFor(ledger, survivor.pid);
        assert.strictEqual(records.length, 1, JSON.stringify(records));
        assert.strictEqual(
          records[0].event,
          'started',
          'a daemon that survived the kill pass must stay "started" in the ledger; recording '
          + '"stopped" is what hid pid 6044 from strayProcesses() on run 43189642396',
        );
        assert.strictEqual(records[0].port, 51235, 'the detector identifies a stray by port or data dir');
        assert.strictEqual(records[0].dataDir, dataDir);
        assert.strictEqual(fs.existsSync(dataDir), true, 'a live daemon keeps its data dir');
      } finally {
        try {
          if (survivor.pid && alive(survivor.pid)) process.kill(survivor.pid, 'SIGKILL');
        } catch (_e) {
          /* already gone */
        }
      }
    });
  });
});
