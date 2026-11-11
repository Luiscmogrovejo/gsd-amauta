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
 * Choose the Python interpreter.
 * @returns {string} /opt/homebrew/bin/python3 on macOS when present, else GSD_PYTHON, else python (Windows) or python3
 */
function pythonBin() {
  if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/python3')) {
    return '/opt/homebrew/bin/python3';
  }
  return process.env.GSD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
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
 * @returns {Promise<{port: number, dataDir: string, proc: import('child_process').ChildProcess, env: object, keep?: boolean}>}
 * @throws {Error} 'fixture daemon did not become ready' plus the last 2000 chars of stderr
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
  // Never inherit a SQLite path that points somewhere else; the daemon pins it
  // under the data dir in test mode.
  delete env.GSD_SQLITE_PATH;
  delete env.GSD_DATA_DIR;

  const proc = spawn(pythonBin(), [path.join(REPO, 'services', 'amauta-daemon.py'), 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
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
  // An RLM service the daemon started (never in test mode, but recorded if present).
  try {
    const rlmPid = parseInt(fs.readFileSync(path.join(handle.dataDir, 'rlm-service.pid'), 'utf8').trim(), 10);
    if (rlmPid > 0) {
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
