'use strict';
/**
 * `stopFixtureDaemon` must reap the process that IS the daemon, not only the
 * process it spawned.
 *
 * Evidence (plan 88-11, the second 2026-11-12 flake). Run 43223847244,
 * `test (windows-latest, node 20)` on master 946c5c3: the suite reported
 * `fail 0`, then the runner's stray check printed
 * `pid 4604 (daemon, port 63355): NOT signalled: not ours (EPERM)` and the job
 * exited 5 — and the post-job census found a different pair still alive,
 * `pid=1076 … services\amauta-daemon.py run` with `pid=7328 ppid=1076 …
 * services\rlm-service.py run`, which NO ledger line accounted for.
 *
 * Both halves come from the same place. `resolvePython()` offers `py -3` on
 * Windows, and `py.exe` is a launcher: it starts the real `python.exe` as a
 * CHILD. The orphan's interpreter was 3.15.2 while the workflow pins
 * `GSD_PYTHON` to 3.12.10 — `py -3` picks the newest Python installed, so that
 * version mismatch is the launcher's fingerprint. `stopFixtureDaemon` signalled
 * and verified `proc.pid`, the launcher: it died, the record said `stopped`,
 * truthfully, about the wrong process, and the daemon plus its RLM child
 * survived the job. The false alarm is the mirror image: once libuv has reaped
 * the child, a pid that still answers is whatever process Windows handed the
 * recycled number to, and probing it reported a stray with no identity at all.
 *
 * Three cases:
 *   1. a daemon reached through a LAUNCHER is reaped — the grandchild named in
 *      `<dataDir>/amauta-daemon.pid` must be gone;
 *   2. the ledger accounts for that pid, so a survivor can never again be a
 *      process no ledger line names;
 *   3. a handle libuv already reaped is `stopped` even when the pid number is
 *      answering again — the recycled-pid false red.
 *
 * Every process here is a node stand-in this test spawned, and each is killed by
 * exact pid in a finally. No product process is started.
 *
 * @module tests/88-11-fixture-daemon-reaps-launcher-tree
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Read at module load by fixture-daemon.cjs. Case 1 spends up to four grace
// windows (launcher SIGTERM/SIGKILL, then the daemon pid's two), so the 5 s
// default would make this a 20 s file.
process.env.GSD_FIXTURE_STOP_GRACE_MS = '400';

const fixture = require('./support/fixture-daemon.cjs');
const { stopFixtureDaemon } = fixture;

/** @returns {import('child_process').ChildProcess} a child that stays alive until killed */
function spawnSleeper() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

/**
 * A launcher stand-in: a child that spawns a DETACHED grandchild and prints its
 * pid, exactly as `py.exe` starts the real `python.exe`. Detached so that
 * killing the launcher leaves the grandchild running on every platform — the
 * behaviour Windows gives for free.
 *
 * @returns {Promise<{launcher: import('child_process').ChildProcess, grandchildPid: number}>}
 */
function spawnLauncherWithGrandchild() {
  const program =
    'const { spawn } = require("child_process");' +
    'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], ' +
    '{ detached: true, stdio: "ignore" });' +
    'g.unref();' +
    'process.stdout.write(String(g.pid));' +
    'setInterval(() => {}, 1000);';
  const launcher = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('the launcher stand-in never reported a grandchild pid')), 15000);
    launcher.stdout.on('data', (d) => {
      out += String(d);
      const pid = parseInt(out.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        clearTimeout(timer);
        resolve({ launcher, grandchildPid: pid });
      }
    });
    launcher.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
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
 * @returns {Promise<boolean>} true when the pid is gone before the budget ends
 */
async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

/** @param {number|undefined} pid */
function kill(pid) {
  try {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  } catch (_e) {
    /* already gone */
  }
}

/**
 * The ledger records, oldest first.
 * @param {string} ledger path of the JSONL ledger
 * @returns {object[]}
 */
function records(ledger) {
  return fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Run `body` with GSD_PROCESS_LEDGER pointed at a fresh file.
 * @param {function(string, string): Promise<void>} body receives (dataDir, ledgerPath)
 * @returns {Promise<void>}
 */
async function withLedger(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcherledger-'));
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

describe('[88-11] stopFixtureDaemon reaps the daemon behind the launcher', () => {
  it('kills the pid in amauta-daemon.pid, not just the process it spawned', async () => {
    await withLedger(async (dataDir, ledger) => {
      const { launcher, grandchildPid } = await spawnLauncherWithGrandchild();
      // What the daemon itself writes under test mode: PID_FILE = DATA_DIR /
      // "amauta-daemon.pid", holding os.getpid() — the pid of the REAL daemon,
      // which behind `py -3` is not the pid node spawned.
      fs.writeFileSync(path.join(dataDir, 'amauta-daemon.pid'), String(grandchildPid), 'utf8');
      try {
        assert.notStrictEqual(grandchildPid, launcher.pid, 'the stand-in must really be two processes');
        assert.ok(alive(grandchildPid), 'the daemon stand-in must be running before the stop');

        await stopFixtureDaemon({ proc: launcher, dataDir, port: 51236, keep: true });

        assert.ok(
          await goneWithin(grandchildPid, 5000),
          'the daemon named in amauta-daemon.pid outlived stopFixtureDaemon: killing only the '
          + 'spawned launcher is how run 43223847244 ended with a live amauta-daemon.py (pid 1076) '
          + 'and its rlm-service.py child (pid 7328)'
        );
        assert.ok(await goneWithin(launcher.pid, 2000), 'the launcher must be gone too');

        const daemonRecords = records(ledger).filter((r) => r.kind === 'daemon');
        const forReal = daemonRecords.find((r) => r.pid === grandchildPid);
        assert.ok(
          forReal,
          'the ledger must carry a record for the real daemon pid; with no line naming it, a '
          + 'survivor is invisible to live-store-canary.strayProcesses(), which keys on pid'
        );
        assert.strictEqual(forReal.event, 'stopped', 'a reaped daemon is recorded stopped');
        assert.strictEqual(forReal.port, 51236, 'the detector identifies a stray by port or data dir');
        assert.strictEqual(forReal.dataDir, dataDir);
      } finally {
        kill(grandchildPid);
        kill(launcher.pid);
      }
    });
  });

  it('records "stopped" for a handle libuv already reaped, whatever the pid number answers', async () => {
    await withLedger(async (dataDir, ledger) => {
      // A pid that answers, standing in for the number Windows recycled, under a
      // handle whose exitCode is set — libuv reaped THAT child, so the daemon is
      // dead and the process answering now is somebody else's. Probing the number
      // is what produced `pid 4604 … NOT signalled: not ours (EPERM)` on a job
      // whose own post-run census found no such daemon alive.
      const impostor = spawnSleeper();
      const reapedHandle = {
        pid: impostor.pid,
        exitCode: 0,
        signalCode: null,
        kill() { /* the real child is already gone */ },
        once() { /* 'exit' already happened */ },
      };
      try {
        await stopFixtureDaemon({ proc: reapedHandle, dataDir, port: 51237, keep: true });

        const rec = records(ledger).filter((r) => r.kind === 'daemon' && r.pid === impostor.pid);
        assert.strictEqual(rec.length, 1, JSON.stringify(rec));
        assert.strictEqual(
          rec[0].event,
          'stopped',
          'a reaped handle is authoritative: recording "started" because the recycled pid number '
          + 'still answers fails a green run with a stray that is not ours'
        );
        assert.ok(alive(impostor.pid), 'and the unrelated process must not have been signalled');
      } finally {
        kill(impostor.pid);
      }
    });
  });

  it('reports a kill only after it has observed the pid stop answering', async () => {
    // The ordering the ledger depends on, as its own unit: a signal is a request
    // the kernel completes asynchronously. The old RLM leg read liveness on the
    // line AFTER process.kill(..., 'SIGKILL') and recorded `started` for a
    // process in the act of dying — a stray that no longer exists. This is the
    // one helper every leg now goes through, so the ordering is pinned once.
    assert.strictEqual(typeof fixture.killPid, 'function', 'the kill pass must go through one bounded helper');
    const victim = spawnSleeper();
    try {
      assert.ok(alive(victim.pid), 'the victim must be running first');
      const stopped = await fixture.killPid(victim.pid, 2000);
      assert.strictEqual(stopped, true, 'killPid must report the kill it achieved');
      assert.strictEqual(
        alive(victim.pid),
        false,
        'killPid returned true while the pid was still answering: a record written on that return '
        + 'value would name a live process as stopped'
      );
      assert.strictEqual(await fixture.killPid(victim.pid, 200), true, 'a dead pid is idempotently "gone"');
    } finally {
      kill(victim.pid);
    }
  });

  it('waits for the RLM to actually stop before recording it stopped', async () => {
    await withLedger(async (dataDir, ledger) => {
      const daemon = spawnSleeper();
      const rlm = spawnSleeper();
      fs.writeFileSync(path.join(dataDir, 'rlm-service.pid'), String(rlm.pid), 'utf8');
      try {
        await stopFixtureDaemon({ proc: daemon, dataDir, keep: true });

        assert.ok(await goneWithin(rlm.pid, 5000), 'the RLM pid must be reaped');
        const rec = records(ledger).find((r) => r.kind === 'rlm' && r.pid === rlm.pid);
        assert.ok(rec, 'the ledger must carry a record for the RLM pid');
        assert.strictEqual(
          rec.event,
          'stopped',
          'the record must follow a measurement taken AFTER the signal completed; reading liveness '
          + 'on the line after SIGKILL records a dying process as a permanent stray'
        );
      } finally {
        kill(rlm.pid);
        kill(daemon.pid);
      }
    });
  });
});
