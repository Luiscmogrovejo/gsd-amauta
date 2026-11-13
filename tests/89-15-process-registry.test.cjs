'use strict';
/**
 * Phase 89 plan 89-15: the run's process registry, and what may be signalled.
 *
 * Third occurrence of one defect class. Run 43437354734, `test (windows-latest,
 * node 22)`: 5465 tests, 0 failed, exit 5 on `pid 3296 (daemon, port 64281):
 * NOT signalled: not an amauta daemon/rlm process`. The report named a pid and
 * a port. It did not name the test, and it could not tell a process the run
 * had started from a process that merely held one of its old pid numbers.
 *
 * One section per mechanism the plan requires a regression test for:
 *
 *   1. the registry is written — pid, port, start time, owning test file, fixture;
 *   2. teardown reaps the TREE under the recorded pid, not one process;
 *   3. a survivor fails its OWN test, by name;
 *   4. a process that is not in the registry is never signalled — reported,
 *      with the test files that were running when it appeared, and left alone.
 *
 * Every process here is one this file started (a node stand-in, or a fixture
 * daemon in test mode on an ephemeral port), and each is stopped by exact pid
 * in a `finally`. No name pattern is used anywhere, and nothing connects to a
 * live service port.
 *
 * @module tests/89-15-process-registry
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Read at module load by the fixtures; this file is its own process.
process.env.GSD_FIXTURE_STOP_GRACE_MS = '400';

const ROOT = path.resolve(__dirname, '..');
const registry = require('./support/process-registry.cjs');
const canary = require('./support/live-store-canary.cjs');
const fixture = require('./support/fixture-daemon.cjs');
const { stopFixtureRlm } = require('./support/fixture-rlm.cjs');
const { killStrays } = require(path.join(ROOT, 'scripts', 'run-tests.cjs'));

const SELF = 'tests/89-15-process-registry.test.cjs';

/** @returns {import('child_process').ChildProcess} a child that stays alive until killed */
function sleeper() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

/**
 * A process tree three deep: the returned child spawns a DETACHED child, which
 * spawns a detached child of its own, and prints both pids. Detached, so that
 * killing the top leaves the others running on every platform — the behaviour
 * Windows gives for free, and the shape of `py.exe` -> `python.exe` -> RLM.
 *
 * @returns {Promise<{top: import('child_process').ChildProcess, mid: number, leaf: number}>}
 */
function spawnTree() {
  const leafSrc = 'setInterval(() => {}, 1000)';
  const midSrc =
    'const { spawn } = require("child_process");' +
    'const g = spawn(process.execPath, ["-e", ' + JSON.stringify(leafSrc) + '], { detached: true, stdio: "ignore" });' +
    'g.unref(); process.stdout.write(String(g.pid) + "\\n"); setInterval(() => {}, 1000);';
  const topSrc =
    'const { spawn } = require("child_process");' +
    'const m = spawn(process.execPath, ["-e", ' + JSON.stringify(midSrc) + '], { detached: true, stdio: ["ignore", "pipe", "ignore"] });' +
    'm.stdout.on("data", (d) => process.stdout.write(m.pid + " " + String(d)));' +
    'setInterval(() => {}, 1000);';
  const top = spawn(process.execPath, ['-e', topSrc], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('the process tree never reported its pids: ' + out)), 20000);
    top.stdout.on('data', (d) => {
      out += String(d);
      const m = /(\d+) (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ top, mid: Number(m[1]), leaf: Number(m[2]) });
      }
    });
    top.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * @param {number} pid
 * @returns {boolean} whether the pid still answers signal 0
 */
function alive(pid) {
  return registry.pidAlive(pid);
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

/** @param {...(number|undefined)} pids processes THIS file started, killed by exact pid */
function kill(...pids) {
  for (const pid of pids) {
    try {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    } catch (_e) {
      /* already gone */
    }
  }
}

/**
 * Run `body` with GSD_PROCESS_LEDGER pointed at a fresh registry file.
 * @param {function(string, string): Promise<void>} body receives (dataDir, registryFile)
 * @returns {Promise<void>}
 */
async function withRegistry(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-data-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-reg-'));
  const file = path.join(dir, 'registry.jsonl');
  const previous = process.env.GSD_PROCESS_LEDGER;
  process.env.GSD_PROCESS_LEDGER = file;
  try {
    await body(dataDir, file);
  } finally {
    if (previous === undefined) delete process.env.GSD_PROCESS_LEDGER;
    else process.env.GSD_PROCESS_LEDGER = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} file a registry file
 * @returns {object[]} its lines, oldest first
 */
function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A synthetic process table.
 * @param {string} platform
 * @param {{pid: number, ppid: number, createdMs: number, command?: string}[]} rows
 * @returns {{at: number, platform: string, byPid: Map<number, object>}}
 */
function tableOf(platform, rows) {
  const byPid = new Map();
  for (const r of rows) byPid.set(r.pid, { command: '', ...r });
  return { at: Date.now(), platform, byPid };
}

describe('[89-15] 1. the registry names the owner of every fixture process', () => {
  it('a fixture daemon is registered with pid, port, start time, owning test file and fixture', async () => {
    await withRegistry(async (_dataDir, file) => {
      const before = Date.now();
      let h = null;
      try {
        h = await fixture.startFixtureDaemon();
        const started = lines(file).filter((l) => l.event === 'started' && l.pid === h.proc.pid);
        assert.strictEqual(started.length, 1, JSON.stringify(lines(file)));
        const line = started[0];
        assert.strictEqual(line.kind, 'daemon');
        assert.strictEqual(line.owner, SELF, 'the owner is the test FILE that started the daemon');
        assert.strictEqual(line.fixture, 'startFixtureDaemon');
        assert.strictEqual(line.dataDir, h.dataDir);
        assert.ok(line.spawnedAt >= before && line.spawnedAt <= line.at, 'the start-time window is [spawnedAt, at]');

        // The port is only known once the daemon has printed it; it is merged
        // into the entry, so the report can print it beside the owner.
        const { open } = registry.readEntries(file);
        const entry = open.find((e) => e.pid === h.proc.pid);
        assert.ok(entry, 'a running fixture daemon is an OPEN entry');
        assert.strictEqual(entry.port, h.port);

        // And the registry — not the command line — says it is ours.
        const audit = canary.processAudit(file);
        const mine = audit.strays.find((s) => s.pid === h.proc.pid);
        assert.ok(mine, 'while it runs, the daemon is what the stray check would report');
        assert.strictEqual(mine.identified, true);
        assert.match(mine.reason, /run registry/);
        const report = canary.formatStrays(audit.strays);
        assert.match(report, new RegExp('started by ' + SELF.replace(/[.]/g, '\\.') + ' through startFixtureDaemon'));

        await fixture.stopFixtureDaemon(h);
        h = null;
        assert.deepStrictEqual(registry.readEntries(file).open, [], 'a stopped fixture leaves no open entry');
        assert.deepStrictEqual(canary.strayProcesses(file), []);
      } finally {
        if (h) await fixture.stopFixtureDaemon(h);
      }
    });
  });

  it('a daemon killed behind the fixture\'s back closes its own registry line', async () => {
    // The cause of run 43437354734. tests/14-plan-to-tasks.integration.test.cjs
    // killed its daemons with a bare proc.kill('SIGKILL') to simulate a crash:
    // ten registry lines per run that nobody closed, each waiting to be matched
    // against whatever process its pid NUMBER was handed to next.
    await withRegistry(async (dataDir, file) => {
      const h = await fixture.startFixtureDaemon({ dataDir });
      const pid = h.proc.pid;
      try {
        const exited = new Promise((r) => h.proc.once('exit', r));
        h.proc.kill('SIGKILL');
        await exited;
        await new Promise((r) => setImmediate(r));
        const mine = lines(file).filter((l) => l.pid === pid && l.event !== 'ready').map((l) => l.event);
        assert.deepStrictEqual(mine, ['started', 'exited'], 'the handle saw the exit, so the line is closed');
        assert.deepStrictEqual(registry.readEntries(file).open, []);
      } finally {
        kill(pid);
      }
    });
  });

  it('killFixtureDaemon is a crash that the registry knows about, and keeps the data directory', async () => {
    await withRegistry(async (dataDir, file) => {
      const h = await fixture.startFixtureDaemon({ dataDir });
      const pid = h.proc.pid;
      try {
        await fixture.killFixtureDaemon(h);
        assert.strictEqual(alive(pid), false);
        assert.strictEqual(h.proc.signalCode || (process.platform === 'win32' ? 'SIGKILL' : null), 'SIGKILL', 'a crash, not a SIGTERM');
        assert.ok(fs.existsSync(dataDir), 'the next daemon starts over the same data');
        assert.deepStrictEqual(registry.readEntries(file).open, []);
      } finally {
        kill(pid);
      }
    });
  });

  it('two fixtures given the same pid number in turn are two entries', () => {
    // Windows hands a freed pid to the next process. The late `exited` of the
    // first holder must not close the second holder's line.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-key-'));
    const file = path.join(dir, 'r.jsonl');
    try {
      const write = (l) => fs.appendFileSync(file, JSON.stringify(l) + '\n');
      write({ event: 'started', kind: 'daemon', pid: 3296, spawnedAt: 1000, at: 1500, owner: 'a.test.cjs' });
      write({ event: 'started', kind: 'daemon', pid: 3296, spawnedAt: 9000, at: 9500, owner: 'b.test.cjs' });
      write({ event: 'exited', kind: 'daemon', pid: 3296, spawnedAt: 1000 });
      const { open, closed } = registry.readEntries(file);
      assert.deepStrictEqual(open.map((e) => e.owner), ['b.test.cjs']);
      assert.deepStrictEqual(closed.map((e) => e.owner), ['a.test.cjs']);
      // A closing line with no start time (a pre-89-15 writer) closes every entry of the pid.
      write({ event: 'stopped', kind: 'daemon', pid: 3296 });
      assert.deepStrictEqual(registry.readEntries(file).open, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a service that registers itself is merged into its fixture\'s entry, or stands alone when no fixture started it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-self-'));
    const file = path.join(dir, 'r.jsonl');
    try {
      const main = (l) => fs.appendFileSync(file, JSON.stringify(l) + '\n');
      const self = (l) => fs.appendFileSync(registry.selfRegistryPath(file), JSON.stringify({ event: 'self', ...l }) + '\n');
      // 1. a fixture daemon: registered at spawn, then the interpreter speaks.
      main({ event: 'started', kind: 'daemon', pid: 500, spawnedAt: 10000, at: 10002, owner: 'a.test.cjs', fixture: 'startFixtureDaemon' });
      self({ kind: 'daemon', pid: 500, at: 10400, owner: 'a.test.cjs' });
      // 2. a daemon no fixture started.
      self({ kind: 'daemon', pid: 600, ppid: 77, at: 20000, owner: 'b.test.cjs', dataDir: '/d' });
      // 3. the same pid number as (1), long after (1) was stopped: another process.
      main({ event: 'stopped', kind: 'daemon', pid: 500, spawnedAt: 10000, at: 11000 });
      self({ kind: 'rlm', pid: 500, at: 900000, owner: 'c.test.cjs' });
      fs.appendFileSync(registry.selfRegistryPath(file), 'not json\n');

      const { open, closed } = registry.readEntries(file);
      assert.deepStrictEqual(closed.map((e) => [e.pid, e.owner, e.selfRegistered]), [[500, 'a.test.cjs', true]]);
      assert.deepStrictEqual(
        open.map((e) => [e.pid, e.kind, e.role, e.owner, e.at - e.spawnedAt]),
        [[600, 'daemon', 'self', 'b.test.cjs', registry.SELF_REGISTER_SLACK_MS], [500, 'rlm', 'self', 'c.test.cjs', registry.SELF_REGISTER_SLACK_MS]],
      );
      assert.match(registry.provenance(open[0]), /started by b\.test\.cjs through a PRODUCT path, not a fixture/);
      // A self-registered service that is gone owes the registry nothing.
      assert.deepStrictEqual(canary.processAudit(file, { table: tableOf('linux', []) }).unclosed, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fixture daemon really does register itself, in the file beside the registry', async () => {
    await withRegistry(async (_dataDir, file) => {
      let h = null;
      try {
        h = await fixture.startFixtureDaemon();
        const selfLines = registry.readSelfLines(file).filter((l) => l.pid === h.proc.pid || l.ppid === h.proc.pid);
        assert.strictEqual(selfLines.length, 1, 'sitecustomize writes one line for a `run` daemon: ' + JSON.stringify(registry.readSelfLines(file)));
        assert.strictEqual(selfLines[0].kind, 'daemon');
        assert.strictEqual(selfLines[0].owner, SELF, 'the test file names itself to everything it starts');
        const { open } = registry.readEntries(file);
        assert.ok(open.every((e) => e.role !== 'self'), 'and it is ONE entry with the fixture\'s, not a second one');
        assert.strictEqual(open.find((e) => e.pid === selfLines[0].pid).selfRegistered, true);
      } finally {
        if (h) await fixture.stopFixtureDaemon(h);
      }
      assert.deepStrictEqual(registry.readEntries(file).open, []);
    });
  });

  it('the owner is the entry script of the process, repo-relative', () => {
    assert.strictEqual(registry.ownerOf(), SELF);
    assert.strictEqual(process.env.GSD_TEST_OWNER, SELF, 'tests/support/run-timeline.cjs names the test file to its children');
    assert.strictEqual(registry.ownerOf({}, process.argv), SELF, 'and without the variable the entry script says the same');
    assert.strictEqual(registry.ownerOf({ GSD_TEST_OWNER: 'tests/x.test.cjs' }, []), 'tests/x.test.cjs');
    assert.strictEqual(
      registry.ownerOf({}, ['node', path.join(ROOT, 'tests', 'fixtures', 'stray-process', 'leaky-daemon.cjs')]),
      'tests/fixtures/stray-process/leaky-daemon.cjs',
    );
  });
});

describe('[89-15] identity is pid AND start time', () => {
  for (const platform of ['win32', 'linux']) {
    const tol = registry.toleranceFor(platform);
    it(platform + ': a holder created inside the registry window is ours; outside it, a recycled pid', () => {
      const entry = { pid: 3296, spawnedAt: 100000, at: 104000 };
      const at = (createdMs) => registry.classify(entry, tableOf(platform, [{ pid: 3296, ppid: 1, createdMs }])).state;
      assert.strictEqual(at(100500), 'ours');
      assert.strictEqual(at(100000 - tol), 'ours', 'the tolerance covers the clock the OS reports creation with');
      assert.strictEqual(at(104000 + tol + 1), 'recycled', 'created after the line was written: a different process');
      assert.strictEqual(at(100000 - tol - 1), 'recycled', 'created before the fixture spawned anything');
      assert.strictEqual(registry.classify(entry, tableOf(platform, [])).state, 'gone');
    });

    it(platform + ': an entry with no start time, or a holder with no creation time, is unverified — never ours', () => {
      const t = tableOf(platform, [{ pid: 7, ppid: 1, createdMs: 5000 }, { pid: 8, ppid: 1, createdMs: 0 }]);
      assert.strictEqual(registry.classify({ pid: 7 }, t).state, 'unverified');
      assert.strictEqual(registry.classify({ pid: 8, spawnedAt: 1, at: 9e15 }, t).state, 'unverified');
      assert.strictEqual(registry.classify({ pid: 7, createdMs: 5000 + tol }, t).state, 'ours');
      assert.strictEqual(registry.classify({ pid: 7, createdMs: 5000 + tol + 1 }, t).state, 'recycled');
    });
  }

  it('the Windows table is parsed from FILETIME rows, and a row without a creation date is "unknown", not "old"', () => {
    // 2026-11-13T14:13:42.250Z as FILETIME (100 ns since 1601), beyond what a double holds exactly.
    const ms = Date.UTC(2026, 10, 13, 14, 13, 42, 250);
    const ft = (BigInt(ms) + 11644473600000n) * 10000n;
    const rows = registry.parseWindowsTable(
      '4\t0\t0\tSystem\r\n' +
        '7108\t5696\t' + ft + '\tC:\\py\\python.exe D:\\a\\repo\\services\\amauta-daemon.py run\r\n' +
        'not a row\r\n',
    );
    assert.deepStrictEqual(rows.map((r) => [r.pid, r.ppid, r.createdMs]), [[4, 0, 0], [7108, 5696, ms]]);
    assert.match(rows[1].command, /amauta-daemon\.py run$/);
  });

  it('the POSIX table is parsed from elapsed time', () => {
    assert.strictEqual(registry.elapsedSeconds('00:07'), 7);
    assert.strictEqual(registry.elapsedSeconds('01:02:03'), 3723);
    assert.strictEqual(registry.elapsedSeconds('02-02:13:34'), 2 * 86400 + 2 * 3600 + 13 * 60 + 34);
    assert.ok(Number.isNaN(registry.elapsedSeconds('ELAPSED')));
    const rows = registry.parsePosixTable('    1     0 02-02:13:34 /sbin/launchd\n  812   1  00:07 node x.cjs --flag\n', 1000000);
    assert.deepStrictEqual(rows[1], { pid: 812, ppid: 1, createdMs: 1000000 - 7000, command: 'node x.cjs --flag' });
  });

  it('the live process table knows this process and when it was created', () => {
    const table = registry.processTable();
    assert.ok(table, 'the process table must be readable on every supported platform');
    const me = table.byPid.get(process.pid);
    assert.ok(me, 'this process is in the table');
    assert.strictEqual(me.ppid, process.ppid);
    const tol = registry.toleranceFor();
    assert.ok(Math.abs(me.createdMs - registry.PROCESS_STARTED_AT) <= tol + 2000, 'creation time ' + me.createdMs + ' vs ' + registry.PROCESS_STARTED_AT);
    assert.strictEqual(registry.classify({ pid: process.pid, spawnedAt: registry.PROCESS_STARTED_AT - 1000, at: Date.now() }, table).state, 'ours');
  });

  it('a child older than its recorded parent is not followed: the parent pid was handed to something else', () => {
    const t = tableOf('win32', [
      { pid: 10, ppid: 1, createdMs: 50000 },
      { pid: 11, ppid: 10, createdMs: 51000 },
      { pid: 12, ppid: 11, createdMs: 52000 },
      { pid: 13, ppid: 10, createdMs: 20000 }, // older than pid 10: a child of whoever HAD pid 10 before
    ]);
    assert.deepStrictEqual(registry.descendants(t, 10).map((p) => p.pid), [11, 12]);
    assert.deepStrictEqual(registry.descendants(t, 99), []);
  });
});

describe('[89-15] 2. teardown reaps the tree under the recorded pid', () => {
  it('stopFixtureDaemon kills launcher, interpreter and child with NO pid file to point at them', async () => {
    await withRegistry(async (dataDir, file) => {
      const spawnedAt = Date.now();
      const { top, mid, leaf } = await spawnTree();
      try {
        assert.ok(alive(mid) && alive(leaf), 'the tree must be three live processes before the stop');
        assert.deepStrictEqual(fs.readdirSync(dataDir), [], 'no pid file: only the process table can find them');

        await fixture.stopFixtureDaemon({ proc: top, dataDir, port: 51240, keep: true, spawnedAt });

        assert.ok(await goneWithin(top.pid, 3000), 'the spawned process (the launcher) must be gone');
        assert.ok(await goneWithin(mid, 3000), 'its child (the interpreter) must be gone: on Windows a terminated parent leaves its children running');
        assert.ok(await goneWithin(leaf, 3000), 'and the child of that (the RLM) too');

        const recs = lines(file);
        for (const pid of [mid, leaf]) {
          const rec = recs.find((r) => r.pid === pid);
          assert.ok(rec, 'every process of the tree gets a registry line of its own: pid ' + pid);
          assert.strictEqual(rec.event, 'stopped');
          assert.strictEqual(rec.role, 'descendant');
          assert.strictEqual(rec.owner, SELF);
          assert.strictEqual(rec.rootPid, top.pid);
        }
        assert.strictEqual(recs.find((r) => r.pid === top.pid).event, 'stopped');
        assert.deepStrictEqual(registry.readEntries(file).open, []);
      } finally {
        kill(leaf, mid, top.pid);
      }
    });
  });

  it('stopFixtureRlm reaps the tree too', async () => {
    await withRegistry(async (dataDir) => {
      const spawnedAt = Date.now();
      const { top, mid, leaf } = await spawnTree();
      try {
        await stopFixtureRlm({ proc: top, dataDir, port: 51241, keep: true, spawnedAt });
        assert.ok(await goneWithin(mid, 3000), 'the interpreter behind the launcher must be gone');
        assert.ok(await goneWithin(leaf, 3000));
        assert.ok(await goneWithin(top.pid, 3000));
      } finally {
        kill(leaf, mid, top.pid);
      }
    });
  });

  it('the runner\'s kill pass takes the tree under an identified stray, and only that', async () => {
    await withRegistry(async (dataDir, file) => {
      const spawnedAt = Date.now();
      const { top, mid, leaf } = await spawnTree();
      const bystander = sleeper();
      try {
        registry.register({ kind: 'daemon', pid: top.pid, spawnedAt, fixture: 'startFixtureDaemon', dataDir, port: 51242 });
        const strays = canary.strayProcesses(file);
        assert.deepStrictEqual(strays.map((s) => [s.pid, s.identified]), [[top.pid, true]]);
        const signalled = killStrays(strays);
        assert.deepStrictEqual([...signalled].sort((a, b) => a - b), [top.pid, mid, leaf].sort((a, b) => a - b));
        assert.strictEqual(alive(mid) || alive(leaf), false, 'the processes under the stray must be gone when the kill pass returns');
        // `top` is a CHILD of this test process and the kill pass is synchronous,
        // so until the event loop turns it is a zombie that still answers signal 0
        // (in a real run a stray is never the runner's own child).
        assert.ok(await goneWithin(top.pid, 3000), 'and the stray itself once this process has reaped it');
        assert.ok(alive(bystander.pid), 'a process outside the tree must not have been touched');
      } finally {
        kill(leaf, mid, top.pid, bystander.pid);
      }
    });
  });
});

describe('[89-15] 3. a survivor fails its own test', () => {
  /** A handle whose kill() is swallowed and whose 'exit' never fires, over a live process. */
  const deaf = (pid) => ({ pid, exitCode: null, signalCode: null, kill() {}, once() {} });

  it('stopFixtureDaemon rejects, naming the pid and the owning test file, and the stray check then names them too', async () => {
    await withRegistry(async (dataDir, file) => {
      const spawnedAt = Date.now();
      const survivor = sleeper();
      try {
        await assert.rejects(
          fixture.stopFixtureDaemon({ proc: deaf(survivor.pid), dataDir, port: 51243, spawnedAt }),
          (err) => {
            assert.strictEqual(err.code, 'EFIXTURESURVIVOR');
            assert.deepStrictEqual(err.survivors, [{ pid: survivor.pid, kind: 'daemon', role: 'spawned' }]);
            assert.ok(err.message.includes('pid ' + survivor.pid), err.message);
            assert.ok(err.message.includes('Owner: ' + SELF), err.message);
            return true;
          },
        );
        assert.ok(alive(survivor.pid), 'the case means nothing unless the process really survived');
        assert.ok(fs.existsSync(dataDir), 'the data directory of a live process is never removed');

        // The same survivor, seen by the end-of-run check: still open, identified
        // by the registry, attributed.
        const strays = canary.strayProcesses(file);
        assert.deepStrictEqual(strays.map((s) => [s.pid, s.identified, s.owner]), [[survivor.pid, true, SELF]]);
      } finally {
        kill(survivor.pid);
      }
    });
  });

  it('stopFixtureRlm rejects the same way', async () => {
    await withRegistry(async (dataDir, file) => {
      const survivor = sleeper();
      try {
        await assert.rejects(
          stopFixtureRlm({ proc: deaf(survivor.pid), dataDir, port: 51244 }),
          (err) => err.code === 'EFIXTURESURVIVOR' && err.survivors[0].pid === survivor.pid && err.message.includes(SELF),
        );
        const rec = lines(file).filter((l) => l.pid === survivor.pid);
        assert.deepStrictEqual(rec.map((r) => r.event), ['started'], 'the survivor is recorded as RUNNING, never as stopped');
      } finally {
        kill(survivor.pid);
      }
    });
  });

  it('a pid that still answers under a NEW process is not a survivor', async () => {
    // The pid-file pid answers signal 0 after the kill pass, but the process
    // table shows a different creation time: the number was recycled.
    await withRegistry(async (dataDir) => {
      const daemon = sleeper();
      const other = sleeper();
      fs.writeFileSync(path.join(dataDir, 'rlm-service.pid'), String(other.pid));
      try {
        const real = await registry.processTableAsync();
        const created = real.byPid.get(other.pid).createdMs;
        let reads = 0;
        const readTable = async () => {
          reads += 1;
          const t = await registry.processTableAsync();
          // Second read (the survivor check): the same pid, created an hour later.
          if (reads > 1 && t.byPid.has(other.pid)) t.byPid.get(other.pid).createdMs = created + 3600000;
          return t;
        };
        const stubKill = process.kill;
        // The "recycled" process must not die for this case to mean anything:
        // swallow the signals to it, as if they had gone to the old process.
        process.kill = (pid, sig) => (pid === other.pid && sig !== 0 ? true : stubKill.call(process, pid, sig));
        let r;
        try {
          r = await registry.reapFixture({
            proc: daemon, kind: 'daemon', fixture: 'startFixtureDaemon', dataDir, graceMs: 200, readTable,
            pidFiles: [{ file: path.join(dataDir, 'rlm-service.pid'), kind: 'rlm' }],
          });
        } finally {
          process.kill = stubKill;
        }
        assert.strictEqual(reads, 2, 'a pid that still answers is checked against the table again');
        assert.deepStrictEqual(r.survivors, [], 'a recycled pid number is not a surviving process');
        assert.strictEqual(r.allGone, true);
      } finally {
        kill(daemon.pid, other.pid);
      }
    });
  });
});

describe('[89-15] 4. a process that is not in the registry is never signalled', () => {
  it('a pid file naming a process older than the fixture names a stranger: reported, left alone', async () => {
    await withRegistry(async (dataDir, file) => {
      // Created BEFORE the fixture existed — what a stale pid file whose number
      // was handed to another process looks like, and what the operator's live
      // daemon would look like if its pid ever turned up in a fixture's file.
      const stranger = sleeper();
      await new Promise((r) => setTimeout(r, registry.toleranceFor() + 1200));
      const spawnedAt = Date.now();
      const daemon = sleeper();
      fs.writeFileSync(path.join(dataDir, 'amauta-daemon.pid'), String(stranger.pid));
      fs.writeFileSync(path.join(dataDir, 'rlm-service.pid'), String(stranger.pid));
      try {
        await fixture.stopFixtureDaemon({ proc: daemon, dataDir, port: 51245, keep: true, spawnedAt });
        assert.ok(await goneWithin(daemon.pid, 3000), 'the fixture\'s own process is stopped');
        assert.ok(alive(stranger.pid), 'a process created before the fixture was SIGNALLED on the word of a pid file');
        assert.strictEqual(lines(file).some((l) => l.pid === stranger.pid), false, 'and it never enters the registry');
      } finally {
        kill(daemon.pid, stranger.pid);
      }
    });
  });

  it('with no process table, a pid known only from a pid file is not signalled; a registered one still is', async () => {
    await withRegistry(async (dataDir, file) => {
      const spawnedAt = Date.now();
      const daemon = sleeper();
      const fromPidFile = sleeper();
      const registered = sleeper();
      fs.writeFileSync(path.join(dataDir, 'rlm-service.pid'), String(fromPidFile.pid));
      try {
        const member = registry.register({
          kind: 'daemon', role: 'pidfile', pid: registered.pid, rootPid: daemon.pid, spawnedAt, fixture: 'startFixtureDaemon', dataDir,
        });
        const r = await registry.reapFixture({
          proc: daemon, kind: 'daemon', fixture: 'startFixtureDaemon', dataDir, spawnedAt, graceMs: 400,
          members: [member],
          pidFiles: [{ file: path.join(dataDir, 'rlm-service.pid'), kind: 'rlm' }],
          readTable: async () => null, // PowerShell missing, `ps` failing: nothing can be verified
        });
        assert.strictEqual(r.allGone, true);
        assert.ok(await goneWithin(daemon.pid, 3000), 'the spawned process is stopped through its handle');
        assert.ok(await goneWithin(registered.pid, 3000), 'a pid in the run registry is stopped');
        assert.ok(alive(fromPidFile.pid), 'an UNVERIFIABLE pid was signalled on the word of a pid file');
        assert.strictEqual(lines(file).some((l) => l.pid === fromPidFile.pid), false);
      } finally {
        kill(daemon.pid, fromPidFile.pid, registered.pid);
      }
    });
  });

  it('a registered pid now held by another process is not a stray and is not signalled', async () => {
    await withRegistry(async (dataDir, file) => {
      const holder = sleeper(); // stands in for whatever Windows handed pid 3296 to
      try {
        const longAgo = Date.now() - 600000;
        fs.writeFileSync(file, JSON.stringify({
          event: 'started', kind: 'daemon', pid: holder.pid, port: 64281, dataDir,
          spawnedAt: longAgo, at: longAgo + 900, owner: 'tests/14-plan-to-tasks.integration.test.cjs', fixture: 'startFixtureDaemon',
        }) + '\n');
        const audit = canary.processAudit(file);
        assert.deepStrictEqual(audit.strays, [], 'run 43437354734 failed a green cell on exactly this line');
        assert.deepStrictEqual(audit.recycled.map((r) => [r.pid, r.owner]), [[holder.pid, 'tests/14-plan-to-tasks.integration.test.cjs']]);
        assert.deepStrictEqual(killStrays(audit.strays), []);
        const report = canary.formatAudit(audit);
        assert.match(report, /now belong to another process \(not strays, not signalled\)/);
        assert.match(report, /started by tests\/14-plan-to-tasks\.integration\.test\.cjs through startFixtureDaemon/);
        assert.ok(alive(holder.pid));
      } finally {
        kill(holder.pid);
      }
    });
  });

  it('an identified stray whose pid changes hands before the kill pass is not signalled', async () => {
    await withRegistry(async (dataDir, file) => {
      const holder = sleeper();
      try {
        const table = registry.processTable();
        const created = table.byPid.get(holder.pid).createdMs;
        // What the stray check saw a moment ago: an entry it identified as ours...
        const stale = [{
          pid: holder.pid, kind: 'daemon', port: 1, dataDir, identified: true,
          reason: 'identified by the run registry (pid and start time)',
          // ...whose window does NOT contain the process holding the pid now.
          spawnedAt: created - 900000, at: created - 890000,
        }];
        assert.deepStrictEqual(killStrays(stale), [], 'identity is checked again immediately before the signal');
        assert.ok(alive(holder.pid));
        assert.strictEqual(lines(file).length, 0);
      } finally {
        kill(holder.pid);
      }
    });
  });

  it('an unregistered process with a daemon command line is reported and not signalled (unit)', async () => {
    // `node <dir>/services/amauta-daemon.py run`: node runs the file as a
    // script, and the command line is a daemon's. Nothing registers it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-lookalike-'));
    fs.mkdirSync(path.join(dir, 'services'));
    const script = path.join(dir, 'services', 'amauta-daemon.py');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const runStartedAt = Date.now();
    const lookalike = spawn(process.execPath, [script, 'run'], { stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
    try {
      await new Promise((r) => setTimeout(r, 400));
      const file = path.join(dir, 'registry.jsonl'); // an empty run registry
      const audit = canary.processAudit(file, { runStartedAt, repoRoot: dir });
      const seen = audit.unregistered.find((p) => p.pid === lookalike.pid);
      assert.ok(seen, 'the lookalike must be REPORTED: ' + JSON.stringify(audit.unregistered));
      assert.strictEqual(seen.inCheckout, true, 'its script is under the checkout the audit was told about');
      assert.deepStrictEqual(audit.strays, [], 'it is not a stray of the registry');
      assert.deepStrictEqual(killStrays(audit.strays), [], 'so the kill pass has nothing to signal');
      const report = canary.formatAudit(audit, { timeline: [{ file: SELF, pid: process.pid, start: runStartedAt - 1000, end: null }] });
      assert.match(report, /UNREGISTERED PROCESS/);
      assert.match(report, /NEVER signalled/);
      assert.ok(report.includes('pid ' + lookalike.pid + ' '), report);
      assert.ok(report.includes('test files running when it was created: ' + SELF), report);
      assert.ok(alive(lookalike.pid), 'an unregistered process was signalled');

      // The same process seen from a run that began AFTER it was created is a
      // process that was already there (the operator's live daemon; on a CI
      // runner, the daemon the package's install script starts): never one of
      // this run's unregistered processes, only named as already running.
      const later = canary.processAudit(file, { runStartedAt: Date.now() + registry.toleranceFor() + 60000, repoRoot: dir });
      assert.strictEqual(later.unregistered.some((p) => p.pid === lookalike.pid), false);
      assert.deepStrictEqual(later.preexisting.map((p) => p.pid), [lookalike.pid]);
      assert.match(canary.formatAudit(later), /already running when the run began \(not started by this run, never signalled\)/);
      assert.deepStrictEqual(killStrays(later.strays), []);
      assert.ok(alive(lookalike.pid));
      // And a protected pid (the live daemon's pid file) is never listed either.
      const guarded = registry.audit(file, { runStartedAt, repoRoot: dir, isProtectedPid: (pid) => pid === lookalike.pid });
      assert.strictEqual(guarded.unregistered.some((p) => p.pid === lookalike.pid), false);
    } finally {
      kill(lookalike.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end to end: the runner REPORTS a daemon nobody registered, names the files running then, and does not signal it', async () => {
    // A node stand-in under a throw-away directory (see the fixture's header).
    // It is not in the registry and it did not register itself, so nothing but
    // its command line says "daemon" — which is all the operator's live daemon
    // has to say for itself too. It must be listed and left exactly as it was.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-unreg-'));
    fs.mkdirSync(path.join(dir, 'services'));
    fs.writeFileSync(path.join(dir, 'services', 'amauta-daemon.py'), 'setInterval(() => {}, 1000);\n');
    let pid = null;
    try {
      const env = { ...process.env, GSD_SKIP_LIVE_STORE_CANARY: '1', GSD_8915_LOOKALIKE_DIR: dir };
      delete env.GSD_PROCESS_LEDGER;
      delete env.NODE_TEST_CONTEXT; // a nested node --test must really run its files
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'run-tests.cjs'), 'tests/fixtures/stray-process/unregistered-daemon.cjs'],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 },
      );
      const m = /UNREGISTERED_PID=(\d+)/.exec(r.stdout + r.stderr);
      assert.ok(m, 'the fixture did not print its pid. stderr: ' + r.stderr.slice(-1500));
      pid = Number(m[1]);

      assert.match(r.stderr, /UNREGISTERED PROCESS/, r.stderr.slice(-2500));
      assert.match(r.stderr, /NEVER signalled/);
      assert.ok(r.stderr.includes('pid ' + pid + ' ppid '), 'the report must name the pid: ' + r.stderr.slice(-2500));
      assert.match(
        r.stderr,
        /test files running when it was created: [^\n]*tests\/fixtures\/stray-process\/unregistered-daemon\.cjs/,
        'the report must name the test file that was running when the process appeared',
      );
      assert.doesNotMatch(r.stderr, /STRAY PROCESS/, 'it is not in the registry, so it is not a stray of this run');
      assert.strictEqual(r.status, 0, 'what is not in the registry is not this run\'s to fail on. stderr: ' + r.stderr.slice(-1500));
      assert.ok(
        alive(pid),
        'the runner SIGNALLED a process that is not in its registry: that process could have been the operator\'s live daemon',
      );
    } finally {
      kill(pid);
      if (pid) await goneWithin(pid, 5000);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('end to end: a daemon started through a PRODUCT path registers itself, and the runner names the file, stops it and fails', async () => {
    let pid = null;
    let dataDir = null;
    let own = null;
    try {
      const env = { ...process.env, GSD_SKIP_LIVE_STORE_CANARY: '1' };
      delete env.GSD_PROCESS_LEDGER;
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'run-tests.cjs'), 'tests/fixtures/stray-process/product-path-daemon.cjs'],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 },
      );
      const m = /PRODUCT_PID=(\d+) PRODUCT_DATA=(\S+)/.exec(r.stdout + r.stderr);
      assert.ok(m, 'the fixture did not print its pid. stderr: ' + r.stderr.slice(-1500));
      pid = Number(m[1]);
      dataDir = m[2];
      own = registry.readPidFile(path.join(dataDir, 'amauta-daemon.pid'));

      assert.strictEqual(r.status, 5, 'a daemon this run started and left alive fails the run. stderr: ' + r.stderr.slice(-2500));
      assert.match(r.stderr, /STRAY PROCESS/);
      assert.match(r.stderr, /\(daemon\): identified, will be stopped by pid/, r.stderr.slice(-2500));
      assert.match(
        r.stderr,
        /started by tests\/fixtures\/stray-process\/product-path-daemon\.cjs through a PRODUCT path, not a fixture/,
        'no fixture registered it, yet the report names the test file it was started under: ' + r.stderr.slice(-2500),
      );
      assert.doesNotMatch(r.stderr, /UNREGISTERED PROCESS/, 'it registered itself, so it is not unregistered');
      assert.ok(await goneWithin(pid, 5000), 'the runner left the daemon alive');
      if (own) assert.ok(await goneWithin(own, 5000), 'the runner left the interpreter behind the launcher alive');
    } finally {
      kill(own, pid);
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('end to end: a registered leak is reported WITH the file and fixture that started it', () => {
    let leaked = null;
    try {
      const env = { ...process.env, GSD_SKIP_LIVE_STORE_CANARY: '1' };
      delete env.GSD_PROCESS_LEDGER;
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'run-tests.cjs'), 'tests/fixtures/stray-process/leaky-daemon.cjs'],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 },
      );
      const m = /LEAKED_PID=(\d+)/.exec(r.stdout + r.stderr);
      assert.ok(m, 'leaky-daemon did not print LEAKED_PID. stderr: ' + r.stderr.slice(-1500));
      leaked = Number(m[1]);
      assert.strictEqual(r.status, 5);
      assert.match(r.stderr, new RegExp('pid ' + leaked + ' \\(daemon, port \\d+\\): identified, will be stopped by pid'));
      assert.match(
        r.stderr,
        /started by tests\/fixtures\/stray-process\/leaky-daemon\.cjs through startFixtureDaemon at \d{4}-/,
        'the stray report must name the test file and the fixture: ' + r.stderr.slice(-1500),
      );
      assert.doesNotMatch(r.stderr, /UNREGISTERED PROCESS/, 'a registered daemon is not also listed as unregistered');
      assert.strictEqual(alive(leaked), false, 'the runner left the leaked daemon alive');
    } finally {
      kill(leaked);
    }
  });
});

describe('[89-15] attribution of a process nobody registered', () => {
  it('the timeline names the test files that were running at a given moment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-tl-'));
    const file = path.join(dir, 'timeline.jsonl');
    try {
      const w = (l) => fs.appendFileSync(file, JSON.stringify(l) + '\n');
      w({ event: 'file-start', file: 'tests/a.test.cjs', pid: 10, at: 100000 });
      w({ event: 'file-start', file: 'tests/b.test.cjs', pid: 11, at: 150000 });
      w({ event: 'file-end', file: 'tests/a.test.cjs', pid: 10, at: 160000 });
      fs.appendFileSync(file, 'not json\n');
      const tl = registry.readTimeline(file);
      assert.deepStrictEqual(registry.filesRunningAt(tl, 120000), ['tests/a.test.cjs']);
      assert.deepStrictEqual(registry.filesRunningAt(tl, 155000), ['tests/a.test.cjs', 'tests/b.test.cjs']);
      assert.deepStrictEqual(registry.filesRunningAt(tl, 900000), ['tests/b.test.cjs'], 'a file that never ended is still running');
      assert.deepStrictEqual(registry.filesRunningAt(tl, 1000), []);
      assert.deepStrictEqual(registry.readTimeline(path.join(dir, 'absent')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the preload records this very test file in the run timeline', () => {
    const file = process.env.GSD_RUN_TIMELINE;
    assert.ok(file, 'scripts/run-tests.cjs sets GSD_RUN_TIMELINE');
    const mine = registry.readTimeline(file).filter((w) => w.pid === process.pid);
    assert.deepStrictEqual(mine.map((w) => [w.file, w.end]), [[SELF, null]]);
  });

  it('ancestry is read from everything the watcher saw, through parents that have exited', () => {
    const seen = [
      { pid: 100, ppid: 1, createdMs: 1000, command: 'node --test' },
      { pid: 200, ppid: 100, createdMs: 2000, command: 'node tests/x.test.cjs' },
      { pid: 300, ppid: 200, createdMs: 3000, command: 'node gsd-amauta.cjs' },
      { pid: 300, ppid: 999, createdMs: 90000, command: 'a LATER process with the same pid' },
    ];
    const chain = registry.ancestry({ pid: 400, ppid: 300, createdMs: 4000 }, seen, 'win32');
    assert.deepStrictEqual(chain.map((p) => p.command), ['node gsd-amauta.cjs', 'node tests/x.test.cjs', 'node --test']);
  });

  it('the watcher log round-trips on this platform', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8915-watch-'));
    const log = path.join(dir, 'watch.tsv');
    const watcher = registry.startWatcher(log);
    assert.ok(watcher, 'the watcher must start');
    try {
      const deadline = Date.now() + 60000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = registry.readWatchLog(log);
        if (rows.some((r) => r.pid === process.pid)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const me = rows.find((r) => r.pid === process.pid);
      assert.ok(me, 'the watcher must have seen this process (' + rows.length + ' rows)');
      assert.strictEqual(me.ppid, process.ppid);
      assert.ok(Math.abs(me.createdMs - registry.PROCESS_STARTED_AT) <= registry.toleranceFor() + 2000);
    } finally {
      const exited = new Promise((r) => watcher.once('exit', r));
      watcher.kill(); // by its own handle
      await exited;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
