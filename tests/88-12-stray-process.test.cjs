/**
 * Phase 88 plan 88-12 task 02: a daemon or RLM left alive by a run becomes a red run.
 *
 * The fixture daemon writes a pid ledger; scripts/run-tests.cjs reads it after the
 * run, fails with status 5 on anything still alive and stops, by pid, only the
 * processes whose command line and ledger entry identify them as this harness's own
 * daemon/RLM. Everything here uses sleepers or fixture daemons the test owns, and
 * stops them by pid in a finally.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const canary = require(path.join(ROOT, 'tests', 'support', 'live-store-canary.cjs'));
const { killStrays } = require(path.join(ROOT, 'scripts', 'run-tests.cjs'));
const { startFixtureDaemon, stopFixtureDaemon } = require(path.join(ROOT, 'tests', 'support', 'fixture-daemon.cjs'));

/** @returns {import('child_process').ChildProcess} a process that sleeps for a minute */
function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
}

/**
 * @param {number} pid
 * @returns {boolean} true when the pid still answers signal 0
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
 * Kill a child this test spawned (by pid, never by pattern) and wait for it to exit.
 * @param {import('child_process').ChildProcess|null} child
 * @returns {Promise<void>}
 */
async function reap(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (_e) {
      /* gone */
    }
    await exited;
  }
}

/**
 * @param {string} file
 * @param {object[]} lines
 * @returns {void}
 */
function writeLedger(file, lines) {
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('88-12 stray process ledger', () => {
  test('strayProcesses returns only the live, unstopped entry', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stray-unit-'));
    const live = sleeper();
    const stopped = sleeper();
    const dead = sleeper();
    try {
      await reap(dead);
      const ledger = path.join(tmp, 'ledger.jsonl');
      writeLedger(ledger, [
        { event: 'started', kind: 'daemon', pid: live.pid, port: 1, dataDir: tmp },
        { event: 'started', kind: 'daemon', pid: stopped.pid, port: 2, dataDir: tmp },
        { event: 'stopped', kind: 'daemon', pid: stopped.pid },
        { event: 'started', kind: 'daemon', pid: dead.pid, port: 3, dataDir: tmp },
      ]);
      const strays = canary.strayProcesses(ledger);
      assert.deepStrictEqual(
        strays.map((s) => s.pid),
        [live.pid]
      );
      assert.ok(alive(stopped.pid), 'the stopped entry is dropped by its record, not by dying');
    } finally {
      await reap(live);
      await reap(stopped);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a missing or malformed ledger yields no strays and does not throw', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stray-bad-'));
    try {
      assert.deepStrictEqual(canary.strayProcesses(path.join(tmp, 'nope.jsonl')), []);
      const bad = path.join(tmp, 'bad.jsonl');
      fs.writeFileSync(bad, 'not json\n{"event":\n');
      assert.deepStrictEqual(canary.strayProcesses(bad), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a live process that is not an amauta daemon is reported, never signalled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stray-guard-'));
    const imposter = sleeper();
    try {
      const ledger = path.join(tmp, 'ledger.jsonl');
      writeLedger(ledger, [{ event: 'started', kind: 'daemon', pid: imposter.pid, port: 1, dataDir: tmp }]);
      const strays = canary.strayProcesses(ledger);
      assert.strictEqual(strays.length, 1);
      assert.strictEqual(strays[0].identified, false);
      // Plan 89-15: identity is the registry's (pid and start time), not the
      // command line's. A line that carries no start time can be neither claimed
      // nor dismissed, so it is reported and — the point of this test — never signalled.
      assert.match(strays[0].reason, /cannot be proven to be the registered process/);
      const signalled = killStrays(strays);
      assert.deepStrictEqual(signalled, []);
      assert.ok(alive(imposter.pid), 'the runner kill pass signalled an unidentified process');
    } finally {
      await reap(imposter);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('protected pids are never identified: own pid, parent pid, live daemon pid file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stray-protected-'));
    const fakeLive = path.join(tmp, 'live');
    fs.mkdirSync(path.join(fakeLive, 'services'), { recursive: true });
    const livePidHolder = sleeper();
    try {
      fs.writeFileSync(path.join(fakeLive, 'services', 'amauta-daemon.pid'), String(livePidHolder.pid));
      canary._setLiveCheckoutForTest(fakeLive);
      assert.strictEqual(canary.isProtectedPid(process.pid), true);
      assert.strictEqual(canary.isProtectedPid(process.ppid), true);
      assert.strictEqual(canary.isProtectedPid(livePidHolder.pid), true);
      const ledger = path.join(tmp, 'ledger.jsonl');
      writeLedger(
        ledger,
        [process.pid, process.ppid, livePidHolder.pid].map((pid) => ({
          event: 'started',
          kind: 'daemon',
          pid,
          port: 1,
          dataDir: tmp,
        }))
      );
      const strays = canary.strayProcesses(ledger);
      assert.strictEqual(strays.length, 3);
      for (const s of strays) {
        assert.strictEqual(s.identified, false);
        assert.strictEqual(s.reason, 'protected pid');
      }
      assert.deepStrictEqual(killStrays(strays), []);
      assert.ok(alive(livePidHolder.pid));
    } finally {
      canary._setLiveCheckoutForTest(null);
      await reap(livePidHolder);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a normal start/stop pair leaves nothing behind', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stray-pair-'));
    const ledger = path.join(tmp, 'ledger.jsonl');
    const prev = process.env.GSD_PROCESS_LEDGER;
    process.env.GSD_PROCESS_LEDGER = ledger;
    let h = null;
    try {
      h = await startFixtureDaemon();
      const during = canary.strayProcesses(ledger);
      assert.strictEqual(during.length, 1, 'a running fixture daemon is listed while it runs');
      assert.strictEqual(during[0].pid, h.proc.pid);
      assert.strictEqual(during[0].identified, true, 'the daemon is identified by command line and port');
      await stopFixtureDaemon(h);
      h = null;
      assert.deepStrictEqual(canary.strayProcesses(ledger), []);
    } finally {
      if (h) await stopFixtureDaemon(h);
      if (prev === undefined) delete process.env.GSD_PROCESS_LEDGER;
      else process.env.GSD_PROCESS_LEDGER = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('end to end: the runner fails a run that leaks a daemon and stops it by pid', () => {
    let leaked = null;
    try {
      const env = { ...process.env, GSD_SKIP_LIVE_STORE_CANARY: '1' };
      delete env.GSD_PROCESS_LEDGER;
      delete env.NODE_TEST_CONTEXT; // a nested node --test must really run its files
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'run-tests.cjs'), 'tests/fixtures/stray-process/leaky-daemon.cjs'],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 }
      );
      const m = /LEAKED_PID=(\d+)/.exec(r.stdout + r.stderr);
      assert.ok(m, 'leaky-daemon did not print LEAKED_PID. stderr: ' + r.stderr.slice(-1500));
      leaked = Number(m[1]);
      assert.notStrictEqual(r.status, 0, 'a run that leaks a daemon must not exit 0');
      assert.match(r.stderr, /STRAY PROCESS/);
      assert.strictEqual(alive(leaked), false, 'the runner left the leaked daemon alive');
    } finally {
      if (leaked && alive(leaked)) {
        try {
          process.kill(leaked, 'SIGKILL');
        } catch (_e) {
          /* gone */
        }
      }
    }
  });
});
