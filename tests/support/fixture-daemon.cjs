'use strict';
/**
 * Fixture daemon for hermetic tests (Phase 88, plan 88-01).
 *
 * Starts services/amauta-daemon.py on an ephemeral port with the SQLite backend
 * and a throw-away data directory, so a test that needs a daemon never touches
 * the operator's live one (127.0.0.1:18799). Nothing here probes Docker: under
 * GSD_TEST_MODE=1 the daemon skips infrastructure detection entirely.
 *
 * The daemon has no --port flag; GSD_AMAUTA_PORT=0 means "bind an ephemeral port
 * and print DAEMON_PORT=<n> on stdout".
 *
 * @example
 *   const { startFixtureDaemon, stopFixtureDaemon } = require('./support/fixture-daemon.cjs');
 *   const h = await startFixtureDaemon();
 *   // ... run the CLI with { ...process.env, ...h.env } ...
 *   await stopFixtureDaemon(h);
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Plan 88-15's shared, VERIFIED Python launcher — one resolver, not a second
// copy of the candidate order (plan 88-16-06).
const platform = require('../../get-shit-done/bin/lib/platform.cjs');
const registry = require('./process-registry.cjs');

const REPO = path.resolve(__dirname, '..', '..');
/** This fixture's name in the run registry. */
const FIXTURE = 'startFixtureDaemon';

// 60 s: on a loaded macOS CI runner (node --test runs many files at once) the daemon needed more
// than the earlier 20 s before it printed DAEMON_PORT (88-03 first full matrix run).
const READY_TIMEOUT_MS = Number(process.env.GSD_FIXTURE_READY_TIMEOUT_MS) || 60000;
const POLL_INTERVAL_MS = 100;
const STOP_GRACE_MS = Number(process.env.GSD_FIXTURE_STOP_GRACE_MS) || 5000;

/**
 * Choose the Python interpreter, through the shared resolver.
 *
 * Phase 88 plan 88-16-06. The old order preferred `/opt/homebrew/bin/python3`
 * on darwin whenever it existed. On a macOS CI runner that is NOT the
 * `setup-python` interpreter the workflow installs PyYAML into, which is the
 * whole reason `88-12-agent-yaml-parses` skipped on macOS and nowhere else.
 *
 * The order is now `GSD_PYTHON` → the interpreter the shared resolver verifies
 * on PATH → the Homebrew path as a last resort, and the logic lives in ONE
 * place (`get-shit-done/bin/lib/platform.cjs`, plan 88-15) rather than in a
 * second copy here. `resolvePython()` VERIFIES each candidate by running it,
 * so a Microsoft Store stub or a broken nvm-style shim is rejected rather than
 * returned; on the operator's machine, where `python3` on PATH is the Homebrew
 * one, the resolved interpreter is unchanged.
 *
 * @returns {{command: string, args: string[]}} the verified launcher
 */
function pythonLauncher() {
  const resolved = platform.resolvePython();
  if (resolved && resolved.command) return resolved;
  // Last resort, and only when the resolver found nothing at all.
  if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/python3')) {
    return { command: '/opt/homebrew/bin/python3', args: [] };
  }
  throw new Error('fixture-daemon: no Python interpreter could be resolved');
}

/**
 * One GET /health attempt.
 * @param {number} port
 * @returns {Promise<boolean>} true when the daemon answered 200
 */
function healthOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * GET /health and return the parsed body, or null when it cannot be read.
 *
 * @param {number} port
 * @returns {Promise<object|null>}
 */
function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Start a fixture daemon.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] data directory; a fresh temp dir when omitted
 * @param {boolean} [opts.detached=false] spawn the daemon detached (Windows: outside libuv's kill-on-parent-exit job)
 * @param {boolean} [opts.postgres=false] run against the disposable PostgreSQL
 *   instead of SQLite. Opt-in per call (plan 88-16-06); the runner's scrub is
 *   unchanged, and the DSN is refused before anything starts when its port is
 *   one of the operator's live services.
 * @returns {Promise<{port: number, dataDir: string, proc: import('child_process').ChildProcess, env: object, keep?: boolean}>}
 * @throws {Error} 'fixture daemon did not become ready' plus the last 2000 chars of stderr
 * @throws {Error} `EHERMETICDSN` when `opts.postgres` is set and the DSN names a live port
 */
async function startFixtureDaemon(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fixture-'));
  fs.mkdirSync(dataDir, { recursive: true });

  const env = { ...process.env };
  for (const k of ['GSD_POSTGRES_URL', 'DATABASE_URL', 'REDIS_URL']) delete env[k];
  Object.assign(env, {
    GSD_TEST_MODE: '1',
    GSD_AMAUTA_PORT: '0',
    GSD_DAEMON_PORT: '0',
    GSD_FORCE_SQLITE: '1',
    GSD_BACKEND: 'sqlite',
    AMAUTA_DATA_DIR: dataDir,
    AMAUTA_AUTO_BACKUP: 'off',
    GSD_REDIS_ENABLED: 'false',
    GSD_RLM_ENABLED: 'false',
  });

  // Plan 88-16-06: Postgres mode, OPT-IN PER CALL. It is a deliberate, narrow
  // exception to the SQLite default above and it is NOT a change to the
  // runner's scrub: `scripts/run-tests.cjs` still deletes GSD_POSTGRES_URL
  // from every child, and this is the only place that puts one back, for one
  // process, after `pgChildEnv()` has refused a DSN on a live port.
  //
  // Plan 89-07, the defect plan 89-02 routed here: the block above sets
  // GSD_TEST_MODE=1, and `services/amauta-daemon.py` `_force_sqlite()` answers
  // TRUE for test mode before it looks at anything else (:1490) — so every
  // "Postgres mode" fixture daemon served SQLITE, on the Linux cells too, and
  // the seven live `step-handoff-daemon` tests asserted PostgreSQL behaviour
  // against a SQLite store. The fix is the shape plan 89-05 proved for the
  // Python fixture (`tests/test_89_05_inbox_round_trip.py` `_postgres_daemon`):
  //
  //   * test mode OFF, and set to the EMPTY STRING rather than removed —
  //     `tests/support/pythonpath/sitecustomize.py` `_arm_test_mode()` does
  //     `os.environ.setdefault("GSD_TEST_MODE", "1")` in every Python child on
  //     the test PYTHONPATH, so DELETING the name hands test mode back;
  //   * everything test mode would otherwise suppress, suppressed BY NAME
  //     (RLM, Redis, the auto-backup, container auto-start) — those are already
  //     in the base environment above;
  //   * the SQLite fallback path pinned INSIDE the temp data dir, so a failed
  //     PostgreSQL connection lands there and never in ~/.amauta/data;
  //   * `/health` asserted below before the handle is returned, so a daemon
  //     that silently fell back to SQLite is a loud failure instead of a green,
  //     vacuous test.
  //
  // This path is reachable only where a disposable DSN exists, which is CI:
  // with no DSN the call throws, which is why a developer machine never starts
  // a daemon outside test mode (its pid file would then sit beside the script
  // instead of in the data dir — `amauta-daemon.py:232-237`).
  if (opts.postgres) {
    const pg = require('./pg-fixture.cjs');
    const dsn = pg.postgresDsn();
    if (!dsn) throw new Error('startFixtureDaemon({postgres:true}): ' + pg.SKIP_REASON);
    const pgEnv = pg.pgChildEnv(env); // throws EHERMETICDSN on a live port
    Object.assign(env, pgEnv);
    env.GSD_TEST_MODE = '';
    env.GSD_FORCE_SQLITE = '';
    env.GSD_BACKEND = '';
    env.GSD_AMAUTA_NO_AUTO_START = '1';
    env.AMAUTA_MEMORY_DATABASE_URL = '';
    env.GSD_SQLITE_PATH = path.join(dataDir, 'gsd_amauta.db');
    delete env.GSD_DATA_DIR;
  } else {
    // Never inherit a SQLite path that points somewhere else; the daemon pins it
    // under the data dir in test mode.
    delete env.GSD_SQLITE_PATH;
    delete env.GSD_DATA_DIR;
  }

  const py = pythonLauncher();
  const spawnedAt = Date.now();
  const proc = spawn(py.command, [...py.args, path.join(REPO, 'services', 'amauta-daemon.py'), 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Default false. Windows: libuv puts every NON-detached child in a job object that is killed
    // when the parent dies, so a daemon can only outlive its parent (the leak that
    // tests/fixtures/stray-process/leaky-daemon.cjs stages on purpose) when it is detached.
    detached: Boolean(opts.detached),
    env,
  });

  // Plan 89-15: registered the moment it exists, not when it becomes ready — a
  // test process that dies while the daemon is still starting leaves a line the
  // stray check can read, with the test file that owns it.
  const entry = proc.pid
    ? registry.register({ kind: 'daemon', pid: proc.pid, spawnedAt, fixture: FIXTURE, dataDir })
    : null;
  /** Everything teardown needs; shared by the failure paths below and the handle. */
  const fx = { proc, kind: 'daemon', fixture: FIXTURE, dataDir, spawnedAt, entry, members: [], stopping: false };

  let stdoutBuf = '';
  let stderrBuf = '';
  let exited = false;
  proc.stderr.on('data', (c) => {
    stderrBuf = (stderrBuf + c.toString()).slice(-8000);
  });
  proc.on('exit', () => {
    exited = true;
    // A daemon that exits without going through stopFixtureDaemon (a test that
    // kills it to simulate a crash, a daemon that dies on its own) closes its
    // own line: the handle saw the exit, so the process is gone, and a line left
    // open would be matched against whatever the pid number is handed to next.
    if (entry && !fx.stopping) registry.close(entry, 'exited');
  });

  let port = null;
  proc.stdout.on('data', (c) => {
    stdoutBuf = (stdoutBuf + c.toString()).slice(-8000);
    if (port === null) {
      const m = /^DAEMON_PORT=(\d+)$/m.exec(stdoutBuf);
      if (m) port = Number(m[1]);
    }
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ready = false;
  while (Date.now() < deadline && !exited) {
    if (port !== null && (await healthOk(port))) {
      ready = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!ready) {
    const tail = stderrBuf.slice(-2000) + (stdoutBuf ? '\n[stdout] ' + stdoutBuf.slice(-1000) : '');
    // The same reaper as a normal stop: a daemon behind a launcher that never
    // became ready is still a process tree, not one pid.
    const r = await reap(fx, { hard: true });
    if (!opts.dataDir && r.allGone) fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error('fixture daemon did not become ready (port=' + port + ', exited=' + exited + '): ' + tail);
  }

  fx.port = port;
  if (entry) registry.annotate(entry, { port });
  // The process that IS the daemon, when `proc` is only its launcher (`py -3`
  // starts the real interpreter as a child): the daemon wrote its own pid into
  // its own data directory. Registered now, while the launcher is alive, so it
  // has a line of its own whatever happens to the launcher.
  const realPid = registry.readPidFile(path.join(dataDir, 'amauta-daemon.pid'));
  if (realPid && realPid !== proc.pid) {
    fx.members.push(registry.register({
      kind: 'daemon', role: 'pidfile', pid: realPid, rootPid: proc.pid, port, spawnedAt, fixture: FIXTURE, dataDir,
    }));
  }

  // Plan 89-07: a Postgres fixture must prove it IS on PostgreSQL before any
  // test asserts PostgreSQL behaviour through it. /health is the daemon's own
  // answer, and plan 89-05 measured that without this assertion the arm passes
  // green and vacuous on SQLite.
  if (opts.postgres) {
    const health = await fetchHealth(port);
    if (!health || health.pg_configured !== true || health.backend !== 'postgresql') {
      const r = await reap(fx, { hard: true });
      if (!opts.dataDir && r.allGone) fs.rmSync(dataDir, { recursive: true, force: true });
      throw new Error(
        'startFixtureDaemon({postgres:true}): the daemon is serving '
        + (health ? String(health.backend) : 'an unreadable /health')
        + ', not postgresql — a PostgreSQL assertion through this handle would be '
        + 'vacuous. /health: ' + JSON.stringify(health)
      );
    }
  }

  const childEnv = {
    GSD_AMAUTA_PORT: String(port),
    GSD_DAEMON_PORT: String(port),
    AMAUTA_PORT: String(port),
    AMAUTA_DATA_DIR: dataDir,
  };
  if (opts.postgres) {
    // The CLI children of a Postgres fixture must reach the SAME store the
    // daemon does. Claiming GSD_FORCE_SQLITE=1 here, as this object used to for
    // every mode, pointed them at a different backend from the daemon's.
    childEnv.GSD_TEST_MODE = '';
    childEnv.GSD_FORCE_SQLITE = '';
    childEnv.GSD_POSTGRES_URL = env.GSD_POSTGRES_URL;
    childEnv.DATABASE_URL = env.DATABASE_URL;
    childEnv.GSD_SQLITE_PATH = env.GSD_SQLITE_PATH;
    childEnv.GSD_HERMETIC_GUARD_ALLOW_PORTS = env.GSD_HERMETIC_GUARD_ALLOW_PORTS;
  } else {
    childEnv.GSD_TEST_MODE = '1';
    childEnv.GSD_FORCE_SQLITE = '1';
  }

  return {
    port,
    dataDir,
    proc,
    spawnedAt,
    fx,
    keep: Boolean(opts.dataDir),
    postgres: Boolean(opts.postgres),
    env: childEnv,
  };
}

/**
 * Stop a fixture daemon: SIGTERM, up to 5 s for exit, then SIGKILL; then remove
 * the data directory unless `handle.keep` is true. Only the process this module
 * spawned is signalled; no name-pattern kill is ever used.
 *
 * **The ledger record follows the measurement, not the intent** (plan 88-16's
 * finding, routed to 88-11). It used to write `stopped` unconditionally, so a
 * daemon that survived SIGTERM and SIGKILL was recorded as stopped and became
 * invisible to the stray detector in `live-store-canary.strayProcesses` — which
 * is how run 43189642396 ended with a live `amauta-daemon.py` that no ledger
 * line accounted for. The pid is probed after the kill pass; only a pid that
 * really stopped answering is recorded `stopped`, and one that did not is
 * recorded `started` with the port and data directory the detector needs to
 * identify it.
 *
 * **The process that must die is not always the process that was spawned**
 * (plan 88-11, the 2026-11-12 Windows leak). `resolvePython()` offers `py -3`
 * as a Windows candidate, and `py.exe` is a LAUNCHER: it starts the real
 * `python.exe` as a CHILD and waits on it. `proc` is then the launcher, and
 * node's kill on Windows terminates that one process — children survive a
 * terminated parent. Run 43223847244, `test (windows-latest, node 20)`, ended
 * `fail 0` and exited 5 with `SURVIVING PYTHON pid=1076 … amauta-daemon.py run`
 * and `pid=7328 ppid=1076 … rlm-service.py run` still alive, while the ledger
 * recorded `stopped` — truthfully, for the launcher, which really had exited.
 * The interpreter in that orphan's command line was 3.15.2, not the 3.12.10 the
 * workflow pins in `GSD_PYTHON`, which is the launcher's signature: `py -3`
 * picks the newest Python installed, so the resolver had fallen past the pinned
 * interpreter to the `py` candidate.
 *
 * So the kill pass now targets the pids the fixture's OWN daemon recorded in its
 * OWN temp data directory — `amauta-daemon.pid` (written by the daemon under
 * test mode) and `rlm-service.pid` — each by exact pid, each bounded, never by
 * process name, and `gone` is true only when every one of them has stopped
 * answering. Each pid gets its own ledger line, so a survivor can never again be
 * a process no ledger line accounts for.
 *
 * **And the whole tree, verified, with the owning test failing on a survivor**
 * (plan 89-15, the third occurrence of this class). The pass is now
 * `process-registry.reapFixture`: the spawned process through its handle, the
 * processes under it in the process table (launcher, interpreter, children),
 * and the pid-file pids — each of those signalled only after the process table
 * has shown it was created during this fixture's lifetime, so a stale pid file
 * whose number went to another process names a stranger and the stranger is
 * left alone. When anything survives, this function THROWS: the test that owns
 * the daemon fails, by name, instead of the whole run failing eleven minutes
 * later on a pid and a port.
 *
 * @param {{proc: import('child_process').ChildProcess, dataDir: string, port?: number, keep?: boolean}} handle
 * @returns {Promise<void>}
 * @throws {Error} `EFIXTURESURVIVOR` when a process of the fixture outlived SIGTERM and SIGKILL
 */
async function stopFixtureDaemon(handle) {
  if (!handle || !handle.proc) return;
  const r = await reap(fixtureOf(handle), { hard: false });
  finish(handle, r);
}

/**
 * Kill a fixture daemon at once, as a crash would: SIGKILL with no SIGTERM
 * first, to the daemon AND the process tree under it, with the registry closed
 * for every process observed gone. The data directory is left in place — a test
 * that simulates a crash goes on to start a new daemon over the same data.
 *
 * Use this instead of `handle.proc.kill('SIGKILL')` in a test: a bare kill
 * reaches one process (behind a launcher, the wrong one) and leaves a registry
 * line nobody closes.
 *
 * @param {{proc: import('child_process').ChildProcess, dataDir: string, port?: number}} handle
 * @returns {Promise<void>}
 * @throws {Error} `EFIXTURESURVIVOR` when a process of the fixture outlived the kill
 * @example
 *   await killFixtureDaemon(h); // then: h = await startFixtureDaemon({ dataDir: h.dataDir })
 */
async function killFixtureDaemon(handle) {
  if (!handle || !handle.proc) return;
  const r = await reap(fixtureOf(handle), { hard: true });
  finish({ ...handle, keep: true }, r);
}

/**
 * The fixture record behind a handle. A handle built by `startFixtureDaemon`
 * carries one; a hand-built `{proc, dataDir, port}` (the unit tests of this
 * module) gets one made for it, with no registration and no start time.
 *
 * @param {object} handle
 * @returns {object} what `reap()` takes
 */
function fixtureOf(handle) {
  const fx = handle.fx || {
    proc: handle.proc,
    kind: 'daemon',
    fixture: FIXTURE,
    dataDir: handle.dataDir,
    spawnedAt: handle.spawnedAt,
    entry: null,
    members: [],
  };
  if (handle.port && !fx.port) fx.port = handle.port;
  return fx;
}

/**
 * Run the shared reaper over one fixture daemon.
 *
 * @param {object} fx the fixture record (`fixtureOf`)
 * @param {{hard: boolean}} how SIGKILL at once, or SIGTERM first
 * @returns {Promise<{rootGone: boolean, survivors: object[], allGone: boolean}>}
 */
function reap(fx, how) {
  fx.stopping = true; // the 'exit' handler must not write a second closing line
  return registry.reapFixture({
    proc: fx.proc,
    kind: 'daemon',
    fixture: fx.fixture,
    dataDir: fx.dataDir,
    port: fx.port || null,
    spawnedAt: fx.spawnedAt,
    entry: fx.entry,
    members: fx.members,
    // Written by the fixture's OWN daemon into the fixture's OWN data directory
    // (test mode moves both there, precisely so a fixture can never touch the
    // live daemon's). An RLM the daemon started is not killed with it on
    // Windows, where a terminated parent leaves its children running.
    pidFiles: [
      { file: path.join(fx.dataDir, 'amauta-daemon.pid'), kind: 'daemon', port: fx.port || null },
      { file: path.join(fx.dataDir, 'rlm-service.pid'), kind: 'rlm', port: Number(process.env.GSD_RLM_PORT) || null },
    ],
    graceMs: STOP_GRACE_MS,
    hard: how.hard,
  });
}

/**
 * After a reap: say what survived, remove the data directory when nothing did,
 * and FAIL THE CALLER when something did.
 *
 * @param {{dataDir: string, keep?: boolean, proc: object}} handle
 * @param {{rootGone: boolean, survivors: {pid: number, kind: string, role: string}[], allGone: boolean}} r
 * @returns {void}
 * @throws {Error} `EFIXTURESURVIVOR` naming every surviving pid and the owning test file
 */
function finish(handle, r) {
  for (const s of r.survivors) {
    console.error(
      s.role === 'spawned'
        ? 'fixture-daemon: pid ' + s.pid + ' is still alive after SIGTERM and SIGKILL; '
          + 'recorded as RUNNING so the stray detector can see it'
        : 'fixture-daemon: the ' + s.kind + ' pid ' + s.pid + ' (' + s.role + ') of the fixture in ' + handle.dataDir
          + ' outlived SIGTERM and SIGKILL; recorded as RUNNING',
    );
  }
  // Never delete the data directory of a process that is still running.
  if (!handle.keep && r.allGone) fs.rmSync(handle.dataDir, { recursive: true, force: true });
  if (!r.allGone) throw registry.survivorError('fixture-daemon', r.survivors, handle.dataDir);
}

/** Re-exported: the one bounded kill helper and the pid-file reader live in the registry. */
const { killPid, readPidFile } = registry;

module.exports = { startFixtureDaemon, stopFixtureDaemon, killFixtureDaemon, killPid, readPidFile };
