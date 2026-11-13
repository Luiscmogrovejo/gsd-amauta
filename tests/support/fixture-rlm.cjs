'use strict';
/**
 * Fixture RLM service for hermetic tests (Phase 88, plan 88-16-05).
 *
 * Mirrors `tests/support/fixture-daemon.cjs` exactly: it starts
 * `services/rlm-service.py` on a port this helper obtained itself, polls
 * `/health` for readiness with a clear failure message, records the pid in
 * `GSD_PROCESS_LEDGER` so the runner's stray-process check (plan 88-12, exit
 * status 5) covers it, and stops it BY PID in a `finally`. No test ever has to
 * name the operator's live RLM port, which the hermetic guard blocks anyway.
 *
 * Why the helper picks the port rather than passing 0: `rlm-service.py` reads
 * `GSD_RLM_PORT` into a module constant and prints that value, so a 0 there
 * would bind an ephemeral port the test could never learn. Binding port 0
 * ourselves, reading the number and closing the socket gives the same property
 * with a port the caller knows. `run-tests.cjs`'s own `freePort()` excludes the
 * live ports by construction, and this helper is the only place the number is
 * chosen.
 *
 * @example
 *   const { startFixtureRlm, stopFixtureRlm } = require('./support/fixture-rlm.cjs');
 *   const rlm = await startFixtureRlm();
 *   try {
 *     const res = await fetch(`${rlm.baseUrl}/health`);
 *   } finally {
 *     await stopFixtureRlm(rlm);
 *   }
 *
 * @module tests/support/fixture-rlm
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

// Plan 88-15's shared, VERIFIED Python launcher. Never a literal interpreter
// name: `python3` is a Microsoft Store stub on Windows and the lint rejects it.
const platform = require('../../get-shit-done/bin/lib/platform.cjs');
const registry = require('./process-registry.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const SERVICE = path.join(REPO, 'services', 'rlm-service.py');

/**
 * Ports of the operator's live services; the fixture must never choose one.
 * Imported, never re-typed: one list, in tests/support/hermetic-guard.cjs.
 */
const LIVE_PORTS = new Set(require('./hermetic-guard.cjs').LIVE_PORTS);

const READY_TIMEOUT_MS = Number(process.env.GSD_FIXTURE_RLM_READY_TIMEOUT_MS) || 60000;
const POLL_INTERVAL_MS = 100;
const STOP_GRACE_MS = Number(process.env.GSD_FIXTURE_STOP_GRACE_MS) || 5000;

/** This fixture's name in the run registry. */
const FIXTURE = 'startFixtureRlm';

/**
 * Bind port 0 on loopback, read the port the OS chose, release it.
 *
 * @returns {Promise<number>} a port that was free a moment ago and is not a live port
 * @throws {Error} when ten attempts all produced a live port (impossible in practice)
 */
async function freePort() {
  for (let i = 0; i < 10; i++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    if (!LIVE_PORTS.has(port)) return port;
  }
  throw new Error('fixture-rlm: could not obtain a free port');
}

/**
 * One `GET /health` attempt.
 * @param {number} port
 * @returns {Promise<boolean>} true when the service answered 200
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
 * Start a fixture RLM service.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] data directory; a fresh temp dir when omitted
 * @param {boolean} [opts.detached=false] spawn detached (used only by the leak proof)
 * @returns {Promise<{port: number, baseUrl: string, dataDir: string, proc: import('child_process').ChildProcess, env: object, keep: boolean}>}
 * @throws {Error} 'fixture RLM did not become ready' plus the tails of its output
 */
async function startFixtureRlm(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fixture-rlm-'));
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();

  const env = { ...process.env };
  for (const k of ['GSD_POSTGRES_URL', 'DATABASE_URL', 'REDIS_URL', 'GSD_SQLITE_PATH', 'GSD_DATA_DIR']) {
    delete env[k];
  }
  Object.assign(env, {
    GSD_TEST_MODE: '1',
    // The pid file follows AMAUTA_DATA_DIR under test mode, so it can never
    // land beside the script where the operator's live service keeps its own
    // (the contract plan 88-12 established).
    AMAUTA_DATA_DIR: dataDir,
    GSD_RLM_ENABLED: 'true',
    GSD_RLM_PORT: String(port),
    GSD_FORCE_SQLITE: '1',
    GSD_BACKEND: 'sqlite',
    AMAUTA_AUTO_BACKUP: 'off',
    GSD_REDIS_ENABLED: 'false',
  });

  const py = platform.resolvePython();
  const spawnedAt = Date.now();
  const proc = spawn(py.command, [...py.args, SERVICE, 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: Boolean(opts.detached),
    env: platform.pythonEnv(env),
  });

  // Plan 89-15: registered the moment it exists (see fixture-daemon.cjs), with
  // the test file that owns it.
  const entry = proc.pid
    ? registry.register({ kind: 'rlm', pid: proc.pid, port, spawnedAt, fixture: FIXTURE, dataDir })
    : null;
  const fx = { proc, kind: 'rlm', fixture: FIXTURE, dataDir, port, spawnedAt, entry, members: [], stopping: false };

  let stdoutBuf = '';
  let stderrBuf = '';
  let exited = false;
  proc.stdout.on('data', (c) => {
    stdoutBuf = (stdoutBuf + c.toString()).slice(-8000);
  });
  proc.stderr.on('data', (c) => {
    stderrBuf = (stderrBuf + c.toString()).slice(-8000);
  });
  proc.on('exit', () => {
    exited = true;
    // Exited without going through stopFixtureRlm: the handle saw it, so the
    // line is closed here rather than left for a recycled pid to be matched to.
    if (entry && !fx.stopping) registry.close(entry, 'exited');
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ready = false;
  while (Date.now() < deadline && !exited) {
    if (await healthOk(port)) {
      ready = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!ready) {
    const r = await reap(fx, true);
    if (!opts.dataDir && r.allGone) fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      'fixture RLM did not become ready on 127.0.0.1:' + port +
        ' (exited=' + exited + ', budget=' + READY_TIMEOUT_MS + ' ms)\n' +
        '--- stdout ---\n' + stdoutBuf.slice(-2000) +
        '\n--- stderr ---\n' + stderrBuf.slice(-4000)
    );
  }

  // The process that IS the service, when `proc` is only its launcher: the
  // service wrote its own pid into its own data directory.
  const realPid = registry.readPidFile(path.join(dataDir, 'rlm-service.pid'));
  if (realPid && realPid !== proc.pid) {
    fx.members.push(registry.register({
      kind: 'rlm', role: 'pidfile', pid: realPid, rootPid: proc.pid, port, spawnedAt, fixture: FIXTURE, dataDir,
    }));
  }

  return {
    port,
    baseUrl: 'http://127.0.0.1:' + port,
    dataDir,
    proc,
    spawnedAt,
    fx,
    keep: Boolean(opts.dataDir),
    env: {
      GSD_RLM_PORT: String(port),
      GSD_RLM_ENABLED: 'true',
      AMAUTA_DATA_DIR: dataDir,
      GSD_TEST_MODE: '1',
    },
  };
}

/**
 * Run the shared reaper over one fixture RLM.
 *
 * @param {object} fx the fixture record built by `startFixtureRlm`
 * @param {boolean} hard SIGKILL at once (a start that never became ready)
 * @returns {Promise<{rootGone: boolean, survivors: object[], allGone: boolean}>}
 */
function reap(fx, hard) {
  fx.stopping = true; // the 'exit' handler must not write a second closing line
  return registry.reapFixture({
    proc: fx.proc,
    kind: 'rlm',
    fixture: fx.fixture,
    dataDir: fx.dataDir,
    port: fx.port || null,
    spawnedAt: fx.spawnedAt,
    entry: fx.entry,
    members: fx.members,
    pidFiles: [{ file: path.join(fx.dataDir, 'rlm-service.pid'), kind: 'rlm', port: fx.port || null }],
    graceMs: STOP_GRACE_MS,
    hard,
  });
}

/**
 * Stop a fixture RLM: SIGTERM, up to 5 s, then SIGKILL; then remove the data
 * directory unless `handle.keep`. The process this module spawned is signalled
 * through its handle, and the processes under it (plan 89-15: behind a `py`
 * launcher the service is a CHILD of what was spawned) by exact pid, each
 * verified against the process table first — never a name pattern, never a pid
 * this fixture did not start.
 *
 * The registry line follows the measurement: `stopped` only for a process
 * observed gone. A survivor stays `started` and this function THROWS, so the
 * test that owns the service fails by name.
 *
 * @param {{proc: import('child_process').ChildProcess, dataDir: string, keep?: boolean, pid?: number}} handle
 * @returns {Promise<void>}
 * @throws {Error} `EFIXTURESURVIVOR` when a process of the fixture outlived SIGTERM and SIGKILL
 */
async function stopFixtureRlm(handle) {
  if (!handle || !handle.proc) return;
  const fx = handle.fx || {
    proc: handle.proc,
    kind: 'rlm',
    fixture: FIXTURE,
    dataDir: handle.dataDir,
    port: handle.port || null,
    spawnedAt: handle.spawnedAt,
    entry: null,
    members: [],
  };
  const r = await reap(fx, false);
  for (const s of r.survivors) {
    console.error('fixture-rlm: pid ' + s.pid + ' (' + s.role + ') outlived SIGTERM and SIGKILL; recorded as RUNNING');
  }
  if (!handle.keep && r.allGone) fs.rmSync(handle.dataDir, { recursive: true, force: true });
  if (!r.allGone) throw registry.survivorError('fixture-rlm', r.survivors, handle.dataDir);
}

module.exports = { freePort, startFixtureRlm, stopFixtureRlm };
