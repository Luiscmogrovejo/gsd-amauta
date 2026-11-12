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

const REPO = path.resolve(__dirname, '..', '..');

/**
 * Where process-ledger lines go: GSD_PROCESS_LEDGER (set by scripts/run-tests.cjs)
 * or, for a standalone run, process-ledger.jsonl in the daemon's data dir.
 * @param {string} dataDir
 * @returns {string}
 */
function ledgerPath(dataDir) {
  return process.env.GSD_PROCESS_LEDGER || path.join(dataDir, 'process-ledger.jsonl');
}

/**
 * Append one JSON line to the process ledger. Never throws: a ledger that cannot
 * be written must not break the test that is starting a daemon.
 * @param {string} dataDir
 * @param {object} record
 * @returns {void}
 */
function appendLedger(dataDir, record) {
  try {
    fs.appendFileSync(ledgerPath(dataDir), JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('fixture-daemon: could not write the process ledger: ' + e.message);
  }
}

/**
 * Whether a pid answers signal 0 (EPERM counts as alive).
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
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
  if (opts.postgres) {
    const pg = require('./pg-fixture.cjs');
    const dsn = pg.postgresDsn();
    if (!dsn) throw new Error('startFixtureDaemon({postgres:true}): ' + pg.SKIP_REASON);
    const pgEnv = pg.pgChildEnv(env); // throws EHERMETICDSN on a live port
    Object.assign(env, pgEnv);
    delete env.GSD_FORCE_SQLITE;
    env.GSD_BACKEND = 'postgresql';
  }
  // Never inherit a SQLite path that points somewhere else; the daemon pins it
  // under the data dir in test mode.
  delete env.GSD_SQLITE_PATH;
  delete env.GSD_DATA_DIR;

  const py = pythonLauncher();
  const proc = spawn(py.command, [...py.args, path.join(REPO, 'services', 'amauta-daemon.py'), 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Default false. Windows: libuv puts every NON-detached child in a job object that is killed
    // when the parent dies, so a daemon can only outlive its parent (the leak that
    // tests/fixtures/stray-process/leaky-daemon.cjs stages on purpose) when it is detached.
    detached: Boolean(opts.detached),
    env,
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let exited = false;
  proc.stderr.on('data', (c) => {
    stderrBuf = (stderrBuf + c.toString()).slice(-8000);
  });
  proc.on('exit', () => {
    exited = true;
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
    try {
      proc.kill('SIGKILL');
    } catch (_e) {
      /* already gone */
    }
    if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error('fixture daemon did not become ready (port=' + port + ', exited=' + exited + '): ' + tail);
  }

  appendLedger(dataDir, { event: 'started', kind: 'daemon', pid: proc.pid, port, dataDir, at: Date.now() });

  return {
    port,
    dataDir,
    proc,
    keep: Boolean(opts.dataDir),
    env: {
      GSD_AMAUTA_PORT: String(port),
      GSD_DAEMON_PORT: String(port),
      AMAUTA_PORT: String(port),
      AMAUTA_DATA_DIR: dataDir,
      GSD_TEST_MODE: '1',
      GSD_FORCE_SQLITE: '1',
    },
  };
}

/**
 * Stop a fixture daemon: SIGTERM, up to 5 s for exit, then SIGKILL; then remove
 * the data directory unless `handle.keep` is true. Only the process this module
 * spawned is signalled; no name-pattern kill is ever used.
 *
 * @param {{proc: import('child_process').ChildProcess, dataDir: string, keep?: boolean}} handle
 * @returns {Promise<void>}
 */
async function stopFixtureDaemon(handle) {
  if (!handle || !handle.proc) return;
  const { proc } = handle;
  const done = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', () => resolve());
  });
  proc.kill('SIGTERM');
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), STOP_GRACE_MS);
  });
  const r = await Promise.race([done, timedOut]);
  clearTimeout(timer);
  if (r === 'timeout') {
    proc.kill('SIGKILL');
    await done;
  }
  appendLedger(handle.dataDir, { event: 'stopped', kind: 'daemon', pid: proc.pid });
  // An RLM service the daemon started. Killing the daemon does NOT kill it on
  // Windows — a terminated parent leaves its children running — and plan 88-16
  // measured exactly that: `test (windows-latest, node 20)`, run 43189642396,
  // ended with `SURVIVING PYTHON pid=6044 … services\amauta-daemon.py run` and
  // `pid=7936 ppid=6044 … services\rlm-service.py run`. The pid comes from this
  // fixture's OWN data directory, so it is a process this harness started.
  try {
    const rlmPid = parseInt(fs.readFileSync(path.join(handle.dataDir, 'rlm-service.pid'), 'utf8').trim(), 10);
    if (rlmPid > 0) {
      if (pidAlive(rlmPid)) {
        try {
          process.kill(rlmPid, 'SIGTERM');
        } catch (_e) {
          /* already gone */
        }
        for (let i = 0; i < 20 && pidAlive(rlmPid); i += 1) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (pidAlive(rlmPid)) {
          try {
            process.kill(rlmPid, 'SIGKILL');
          } catch (_e) {
            /* exited after SIGTERM */
          }
        }
      }
      appendLedger(handle.dataDir, {
        event: pidAlive(rlmPid) ? 'started' : 'stopped',
        kind: 'rlm',
        pid: rlmPid,
        port: Number(process.env.GSD_RLM_PORT) || null,
        dataDir: handle.dataDir,
        at: Date.now(),
      });
    }
  } catch (_e) {
    /* no RLM pid file: nothing to record */
  }
  if (!handle.keep) fs.rmSync(handle.dataDir, { recursive: true, force: true });
}

module.exports = { startFixtureDaemon, stopFixtureDaemon };
