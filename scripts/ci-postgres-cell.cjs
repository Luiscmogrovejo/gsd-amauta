#!/usr/bin/env node
'use strict';
/**
 * One cross-platform bring-up of a DISPOSABLE PostgreSQL for a CI cell.
 *
 * Phase 89, plan 89-07. `.github/workflows/test.yml` has two jobs (`test` and
 * `pytest`) with the same Postgres setup shape, and each needs a macOS and a
 * Windows variant — six blocks of shell if written inline, three of them in
 * `bash` on a Windows runner. This is that shape once, in Node, spawned through
 * `platform.spawnTool` so no string is ever handed to a shell.
 *
 * It produces the SAME DSN shape as the Linux container step
 * (`postgresql://gsd:gsd@127.0.0.1:<port>/gsd_test`), so the existing
 * "Apply the schema" step and every test work unchanged and no test needs to
 * know which cell it is on.
 *
 * Usage:
 *   node scripts/ci-postgres-cell.cjs --up --port <n> [--data-dir <d>]
 *   node scripts/ci-postgres-cell.cjs --stop [--port <n>] [--data-dir <d>]
 *
 * On `--up` the LAST line of stdout is exactly `GSD_TEST_POSTGRES_URL=<dsn>`,
 * which the workflow appends to `$GITHUB_ENV`.
 *
 * SAFETY, and it is the point of this module existing rather than three shell
 * blocks: it REFUSES to run unless `CI` is set (or `GSD_CI_PG_ALLOW_LOCAL=1` is
 * passed deliberately, which no test does), and it refuses any port in
 * `scripts/run-tests.cjs`'s `LIVE_PORTS` or a port something is already
 * listening on. A hand-run on a developer machine therefore cannot `initdb` or
 * start a PostgreSQL.
 *
 * @module scripts/ci-postgres-cell
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const platform = require('../get-shit-done/bin/lib/platform.cjs');
// The runner owns the list of the operator's live service ports (18799, 18798,
// 6379, 5433). Re-listing them here would be a second place to forget one.
const { LIVE_PORTS } = require('./run-tests.cjs');

/** The PostgreSQL major this helper brings up on macOS and Windows. */
const PG_MAJOR = '17';

/** The disposable cluster's role, password and database — the Linux step's shape. */
const ROLE = 'gsd';
const PASSWORD = 'gsd';
const DATABASE = 'gsd_test';

/** How long to wait for the cluster to accept a real connection, in seconds. */
const READY_TIMEOUT_S = Number(process.env.GSD_CI_PG_READY_TIMEOUT_S || 120);

/** How many lines of the server log a failure reports. */
const LOG_TAIL_LINES = 30;

/**
 * A typed failure of the bring-up, so a caller can branch on the kind.
 *
 * A bring-up that fails silently, or with an untyped string, is the class of
 * defect that makes a CI change unreviewable.
 */
class CellError extends Error {
  /**
   * @param {string} code - a stable kind, e.g. `not_ci`, `live_port`, `initdb_failed`.
   * @param {string} message - the human sentence.
   * @param {object} [detail] - extra fields for the report (never a password).
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'CellError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Parse argv into an options object.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {{mode: string|null, port: number|null, dataDir: string|null, allowLocal: boolean}}
 * @throws {CellError} `bad_args` on an unknown flag or a missing value.
 * @example
 *   parseArgs(['--up', '--port', '5440']); // { mode: 'up', port: 5440, ... }
 */
function parseArgs(argv) {
  const out = { mode: null, port: null, dataDir: null, allowLocal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--up' || a === '--stop') {
      out.mode = a.slice(2);
    } else if (a === '--port') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined) throw new CellError('bad_args', 'ci-postgres-cell: --port needs a value');
      out.port = Number(v);
    } else if (a === '--data-dir') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined) throw new CellError('bad_args', 'ci-postgres-cell: --data-dir needs a value');
      out.dataDir = v;
    } else if (a === '--allow-local' || a === '--help' || a === '-h') {
      if (a === '--allow-local') out.allowLocal = true;
      else out.mode = 'help';
    } else {
      throw new CellError('bad_args', 'ci-postgres-cell: unknown argument ' + a);
    }
  }
  return out;
}

/**
 * Refuse to do anything outside CI.
 *
 * This is the guard that makes a hand-run on the operator's Mac impossible: the
 * only real cluster this module ever starts is on a CI runner, and its unit
 * tests drive it with an injected command runner instead.
 *
 * @param {object} env - the environment to read.
 * @returns {void}
 * @throws {CellError} `not_ci` when neither `CI` nor `GSD_CI_PG_ALLOW_LOCAL=1` is set.
 */
function assertCi(env) {
  const ci = String((env && env.CI) || '').trim();
  const explicit = String((env && env.GSD_CI_PG_ALLOW_LOCAL) || '').trim() === '1';
  if (ci !== '' && ci.toLowerCase() !== 'false' && ci !== '0') return;
  if (explicit) return;
  throw new CellError(
    'not_ci',
    'ci-postgres-cell: refusing to initdb or start a PostgreSQL outside CI. '
    + 'CI is unset, so this is a developer machine; nothing was started. '
    + 'Set GSD_CI_PG_ALLOW_LOCAL=1 only if you really mean to create a cluster here.',
  );
}

/**
 * Refuse a port that is one of the operator's live services, or not a port.
 *
 * @param {number} port
 * @returns {number} the same port.
 * @throws {CellError} `live_port` or `bad_port`.
 */
function assertPortAllowed(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new CellError('bad_port', 'ci-postgres-cell: --port must be a TCP port, got ' + String(port));
  }
  if (LIVE_PORTS.has(port)) {
    throw new CellError(
      'live_port',
      'ci-postgres-cell: refusing port ' + port + '. 18799 (daemon), 18798 (RLM), '
      + "6379 (Redis) and 5433 (the operator's PostgreSQL) are never test ports; "
      + 'the workflow takes its port from run-tests.cjs freePort(), which excludes them.',
      { port },
    );
  }
  return port;
}

/**
 * Whether something already answers on 127.0.0.1:port.
 *
 * @param {number} port
 * @param {object} [opts]
 * @param {function} [opts.probe] - injected probe for tests: (port) => Promise<boolean>.
 * @returns {Promise<boolean>}
 */
function portInUse(port, opts = {}) {
  if (opts.probe) return Promise.resolve(opts.probe(port));
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(answer);
    };
    sock.setTimeout(1500);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/**
 * Join path parts the way the TARGET platform does, not the host.
 *
 * `path.join` uses the host separator, which is right in production — the
 * platform always IS the host there — and wrong under a platform override: on
 * the Windows cells the unit tests asserted `/opt/homebrew/...` and got
 * `\\opt\\homebrew\\...` (run 43360624446). Choosing the flavour makes the argv
 * assertions exact on every cell and changes nothing when `plat` is the host.
 *
 * @param {string} plat - the target platform.
 * @param {...string} parts
 * @returns {string}
 * @example
 *   joinFor('darwin', '/opt/homebrew', 'bin');  // '/opt/homebrew/bin'
 *   joinFor('win32', 'C:\\PG', 'bin');          // 'C:\\PG\\bin'
 */
function joinFor(plat, ...parts) {
  const flavour = String(plat || process.platform).startsWith('win') ? path.win32 : path.posix;
  return flavour.join(...parts);
}

/**
 * The directory holding this cell's PostgreSQL client and server binaries.
 *
 * macOS: the Homebrew `postgresql@17` keg (keg-only, so never on PATH).
 * Windows: `%PGBIN%`, which the runner image sets to
 *   `C:\Program Files\PostgreSQL\17\bin`, with that path as the fallback.
 * Anything else: `pg_config --bindir`.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform] - platform override for tests.
 * @param {object} [opts.env] - environment override for tests.
 * @param {function} [opts.run] - injected runner: (tool, args, options) => spawnSync-like.
 * @returns {string} an absolute directory.
 * @throws {CellError} `no_binaries` when no directory could be resolved.
 */
function resolveBinDir(opts = {}) {
  const plat = opts.platform || process.platform;
  const env = opts.env || process.env;
  const run = opts.run || defaultRun;
  if (plat === 'darwin') {
    const r = run('brew', ['--prefix', 'postgresql@' + PG_MAJOR], { env, encoding: 'utf8' });
    const prefix = String((r && r.stdout) || '').trim().split(/\r?\n/)[0];
    if (!prefix) {
      throw new CellError(
        'no_binaries',
        'ci-postgres-cell: `brew --prefix postgresql@' + PG_MAJOR + '` printed nothing. '
        + 'The workflow installs it with `brew install postgresql@' + PG_MAJOR + ' pgvector` '
        + 'before this step.',
        { status: r && r.status, stderr: String((r && r.stderr) || '').slice(0, 400) },
      );
    }
    return joinFor(plat, prefix, 'bin');
  }
  if (String(plat).startsWith('win')) {
    const fromEnv = String(env.PGBIN || '').trim();
    if (fromEnv) return fromEnv;
    return joinFor(plat, 'C:\\', 'Program Files', 'PostgreSQL', PG_MAJOR, 'bin');
  }
  const r = run('pg_config', ['--bindir'], { env, encoding: 'utf8' });
  const dir = String((r && r.stdout) || '').trim().split(/\r?\n/)[0];
  if (!dir) {
    throw new CellError(
      'no_binaries',
      'ci-postgres-cell: `pg_config --bindir` printed nothing, so there is no '
      + 'PostgreSQL installation to bring up on this platform.',
      { status: r && r.status },
    );
  }
  return dir;
}

/**
 * The absolute path of one PostgreSQL tool in a bin directory.
 *
 * @param {string} binDir
 * @param {string} name - `initdb`, `pg_ctl`, `psql`.
 * @param {string} [plat] - platform override for tests.
 * @returns {string}
 * @example
 *   toolPath('C:\\PG\\17\\bin', 'initdb', 'win32'); // 'C:\\PG\\17\\bin\\initdb.exe'
 */
function toolPath(binDir, name, plat) {
  const p = String(plat || process.platform);
  return joinFor(p, binDir, p.startsWith('win') ? name + '.exe' : name);
}

/**
 * The default spawner: `platform.spawnTool` on an already-resolved absolute path.
 *
 * No shell flag is ever passed, and nothing is ever concatenated into a command
 * string. On Windows a `.cmd`/`.bat` target goes through the `cmd.exe /d /s /c`
 * rule `platform.spawnTool` implements for CVE-2024-27980.
 *
 * @param {string} command - an absolute executable path, or a bare tool name.
 * @param {string[]} args
 * @param {object} [options] - spawnSync options (`env`, `encoding`, `cwd`, …).
 * @returns {object} the spawnSync result.
 */
function defaultRun(command, args, options = {}) {
  return platform.spawnTool({ command, args: [] }, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

/**
 * The last lines of the cluster's server log, for a failure report.
 *
 * @param {string} logFile
 * @returns {string} the tail, or a sentence saying there is none.
 */
function logTail(logFile) {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch (e) {
    return '(no server log at ' + logFile + ': ' + e.message + ')';
  }
}

/**
 * Where the cluster lives when `--data-dir` is not given.
 *
 * @returns {string}
 */
function defaultDataDir() {
  return path.join(os.tmpdir(), 'gsd-ci-pg');
}

/**
 * One `psql` invocation against the disposable cluster, over TCP.
 *
 * TCP, not the unix socket, because TCP is the channel every later step uses
 * and Windows has no socket at all. The password travels in `PGPASSWORD` in the
 * child's environment, never on a command line.
 *
 * @param {object} ctx - `{ binDir, platform, port, env, run }`.
 * @param {string} database
 * @param {string[]} args - psql arguments after the connection ones.
 * @returns {object} the spawn result.
 */
function psql(ctx, database, args) {
  const env = { ...ctx.env, PGPASSWORD: PASSWORD };
  return ctx.run(
    toolPath(ctx.binDir, 'psql', ctx.platform),
    ['-h', '127.0.0.1', '-p', String(ctx.port), '-U', ROLE, '-d', database, '-w', ...args],
    { env, encoding: 'utf8' },
  );
}

/**
 * Wait until the cluster accepts a REAL connection on the published port.
 *
 * Deliberately NOT PostgreSQL's own readiness utility, whose name this file does
 * not even spell so that a grep for it over this module answers zero. Plan 88-16
 * measured (run 43178016790) that such a probe can answer a server that is not
 * the one the next step needs: the container entrypoint's temporary init server
 * answered it on the container's unix socket while the published port was not
 * serving yet, and the next step died with "server closed the connection
 * unexpectedly". The condition that matters is the one the next step needs, so
 * that is the one to wait for: `psql … -tAc "SELECT 1"` over TCP on the
 * published port, which is libpq doing exactly what every test does.
 *
 * The bound is a number of ATTEMPTS, one a second, not a wall-clock deadline:
 * a deadline plus an injected no-op sleep is a busy loop that burns the whole
 * timeout in a unit test, which is how this function was first written.
 *
 * @param {object} ctx - `{ binDir, platform, port, env, run, sleep }`.
 * @param {number} [timeoutS] - the bound, in seconds, == the attempt count.
 * @returns {boolean} true when a connection succeeded.
 */
function waitForRealConnection(ctx, timeoutS = READY_TIMEOUT_S) {
  const attempts = Math.max(1, Math.ceil(timeoutS));
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const r = psql(ctx, 'postgres', ['-tAc', 'SELECT 1']);
    if (r && r.status === 0 && String(r.stdout || '').trim() === '1') return true;
    last = r;
    if (i + 1 < attempts) ctx.sleep(1000);
  }
  ctx.lastReadinessResult = last;
  return false;
}

/**
 * Sleep synchronously, without a shell and without `sleep(1)`.
 *
 * @param {number} ms
 * @returns {void}
 */
function sleepMs(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      // A real blocking wait: Atomics.wait on a shared buffer, no busy loop.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, until - Date.now()));
    } catch (_e) {
      break;
    }
  }
}

/**
 * Bring a disposable cluster up and print the DSN line.
 *
 * @param {object} opts
 * @param {number} opts.port - the port `freePort()` chose.
 * @param {string} [opts.dataDir]
 * @param {string} [opts.platform] - platform override for tests.
 * @param {object} [opts.env] - environment override for tests.
 * @param {function} [opts.run] - injected runner for tests.
 * @param {function} [opts.sleep] - injected sleep for tests.
 * @param {function} [opts.probe] - injected port probe for tests.
 * @param {number} [opts.readyTimeoutS] - the readiness bound, for tests.
 * @param {function} [opts.out] - stdout sink, default `process.stdout.write`.
 * @returns {Promise<string>} the DSN.
 * @throws {CellError} on every failure, with the server log tail in `detail.log`.
 */
async function up(opts) {
  const env = opts.env || process.env;
  const plat = opts.platform || process.platform;
  const run = opts.run || defaultRun;
  const sleep = opts.sleep || sleepMs;
  const out = opts.out || ((s) => process.stdout.write(s));

  assertCi(env);
  const port = assertPortAllowed(opts.port);
  if (await portInUse(port, { probe: opts.probe })) {
    throw new CellError(
      'port_in_use',
      'ci-postgres-cell: something already listens on 127.0.0.1:' + port
      + '. A cluster brought up on an occupied port would hand the suite a DSN '
      + 'pointing at a server this script does not own.',
      { port },
    );
  }

  const dataDir = opts.dataDir || defaultDataDir();
  const logFile = dataDir + '.log';
  const pwFile = dataDir + '.pw';
  const binDir = resolveBinDir({ platform: plat, env, run });
  const ctx = { binDir, platform: plat, port, env, run, sleep };

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  fs.writeFileSync(pwFile, PASSWORD, { mode: 0o600 });

  out('ci-postgres-cell: binaries in ' + binDir + '\n');

  // `--locale=C` deliberately: the three cells must agree on text ordering, and
  // the locale names differ by system (`en_US.UTF-8` does not exist on Windows,
  // where it is `English_United States.1252`). C with UTF8 encoding is the one
  // combination every platform accepts identically.
  const initdb = run(
    toolPath(binDir, 'initdb', plat),
    ['-D', dataDir, '-U', ROLE, '--auth-local=trust', '--auth-host=scram-sha-256',
      '--pwfile=' + pwFile, '--encoding=UTF8', '--locale=C'],
    { env, encoding: 'utf8' },
  );
  try {
    fs.rmSync(pwFile, { force: true });
  } catch (_e) { /* best effort */ }
  if (!initdb || initdb.status !== 0) {
    throw new CellError('initdb_failed',
      'ci-postgres-cell: initdb failed (status ' + (initdb && initdb.status) + ')',
      { stdout: String((initdb && initdb.stdout) || '').slice(-4000),
        stderr: String((initdb && initdb.stderr) || '').slice(-4000) });
  }

  // `pg_ctl start` leaves a SERVER behind, and that server inherits the stdio
  // handles its launcher was given. A PIPE therefore never reaches EOF, and
  // `spawnSync` waits for the pipes rather than for the process — measured on
  // `windows-latest`, run 43357540296: `pg_ctl` had plainly started the cluster
  // and the step still sat in this one call until the job's 25-minute timeout.
  // Its own two lines go to a FILE, which is read back for the diagnostic, so
  // nothing is lost and no handle is shared with the server.
  const ctlOut = dataDir + '.pg_ctl.out';
  const ctlFd = fs.openSync(ctlOut, 'w');
  let start;
  try {
    start = run(
      toolPath(binDir, 'pg_ctl', plat),
      ['-D', dataDir, '-l', logFile,
        '-o', '-p ' + port + ' -c listen_addresses=127.0.0.1', '-w', '-t', '90', 'start'],
      { env, stdio: ['ignore', ctlFd, ctlFd] },
    );
  } finally {
    try {
      fs.closeSync(ctlFd);
    } catch (_e) { /* already closed */ }
  }
  let ctlText = '';
  try {
    ctlText = fs.readFileSync(ctlOut, 'utf8');
  } catch (_e) { /* the injected runner in the unit tests writes nothing */ }
  out('ci-postgres-cell: pg_ctl start -> status ' + (start && start.status)
    + (ctlText.trim() ? ' | ' + ctlText.trim().replace(/\s+/g, ' ') : '') + '\n');
  if (!start || start.status !== 0) {
    throw new CellError('pg_ctl_start_failed',
      'ci-postgres-cell: pg_ctl start failed (status ' + (start && start.status) + ')',
      { stderr: ctlText.slice(-4000), log: logTail(logFile) });
  }

  if (!waitForRealConnection(ctx, opts.readyTimeoutS || READY_TIMEOUT_S)) {
    const last = ctx.lastReadinessResult || {};
    throw new CellError('not_ready',
      'ci-postgres-cell: the disposable PostgreSQL did not accept a real connection on '
      + '127.0.0.1:' + port + ' within ' + (opts.readyTimeoutS || READY_TIMEOUT_S) + ' attempts',
      { stderr: String(last.stderr || '').slice(-2000), log: logTail(logFile) });
  }

  // The role already exists and is the bootstrap SUPERUSER: `initdb -U gsd`
  // created it, with the password from --pwfile. A `CREATE ROLE gsd` here would
  // fail on the role it is meant to produce.
  const steps = [
    ['postgres', ['-v', 'ON_ERROR_STOP=1', '-c',
      'CREATE DATABASE ' + DATABASE + ' OWNER ' + ROLE]],
    [DATABASE, ['-v', 'ON_ERROR_STOP=1', '-c', 'CREATE EXTENSION IF NOT EXISTS vector']],
  ];
  for (const [db, args] of steps) {
    const r = psql(ctx, db, args);
    if (!r || r.status !== 0) {
      throw new CellError('setup_failed',
        'ci-postgres-cell: cluster setup failed on ' + db + ' (status ' + (r && r.status) + ')',
        { stderr: String((r && r.stderr) || '').slice(-4000), log: logTail(logFile) });
    }
  }

  const vectorVersion = String(
    (psql(ctx, DATABASE, ['-tAc', "SELECT extversion FROM pg_extension WHERE extname = 'vector'"]).stdout) || '',
  ).trim();
  const serverVersion = String(
    (psql(ctx, DATABASE, ['-tAc', 'SHOW server_version']).stdout) || '',
  ).trim();
  out('ci-postgres-cell: pgvector ' + vectorVersion + ' on PostgreSQL ' + serverVersion
    + ', data dir ' + dataDir + '\n');

  const dsn = 'postgresql://' + ROLE + ':' + PASSWORD + '@127.0.0.1:' + port + '/' + DATABASE;
  out('GSD_TEST_POSTGRES_URL=' + dsn + '\n');
  return dsn;
}

/**
 * Stop the cluster and remove its data directory. Idempotent.
 *
 * @param {object} opts - `{ dataDir, platform, env, run, out }`.
 * @returns {void}
 */
function stop(opts = {}) {
  const env = opts.env || process.env;
  const plat = opts.platform || process.platform;
  const run = opts.run || defaultRun;
  const out = opts.out || ((s) => process.stdout.write(s));
  assertCi(env);
  const dataDir = opts.dataDir || defaultDataDir();
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    out('ci-postgres-cell: no cluster at ' + dataDir + '; nothing to stop\n');
    return;
  }
  const binDir = resolveBinDir({ platform: plat, env, run });
  const r = run(
    toolPath(binDir, 'pg_ctl', plat),
    ['-D', dataDir, '-m', 'immediate', '-w', '-t', '60', 'stop'],
    { env, encoding: 'utf8' },
  );
  out('ci-postgres-cell: pg_ctl stop status ' + (r && r.status) + '\n');
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dataDir + '.log', { force: true });
  } catch (_e) { /* the runner is disposable */ }
}

/** The usage text. */
const USAGE = [
  'Usage:',
  '  node scripts/ci-postgres-cell.cjs --up --port <n> [--data-dir <d>]',
  '  node scripts/ci-postgres-cell.cjs --stop [--data-dir <d>]',
  '',
  'Refuses to run unless CI is set. The last line of --up stdout is',
  'GSD_TEST_POSTGRES_URL=<dsn>, for $GITHUB_ENV.',
].join('\n');

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} the process exit code.
 */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n' + USAGE + '\n');
    return 2;
  }
  if (args.mode === 'help' || args.mode === null) {
    process.stdout.write(USAGE + '\n');
    return args.mode === 'help' ? 0 : 2;
  }
  try {
    if (args.mode === 'up') {
      await up({ port: args.port, dataDir: args.dataDir, allowLocal: args.allowLocal });
    } else {
      stop({ dataDir: args.dataDir, allowLocal: args.allowLocal });
    }
    return 0;
  } catch (e) {
    const code = e instanceof CellError ? e.code : 'unexpected';
    process.stderr.write('ci-postgres-cell: FAILED [' + code + '] ' + e.message + '\n');
    const d = (e && e.detail) || {};
    for (const key of ['status', 'stdout', 'stderr']) {
      if (d[key] !== undefined && String(d[key]).trim() !== '') {
        process.stderr.write('--- ' + key + ' ---\n' + String(d[key]) + '\n');
      }
    }
    if (d.log) process.stderr.write('--- server log (last ' + LOG_TAIL_LINES + ' lines) ---\n' + d.log + '\n');
    return 1;
  }
}

module.exports = {
  CellError,
  joinFor,
  DATABASE,
  LOG_TAIL_LINES,
  PASSWORD,
  PG_MAJOR,
  ROLE,
  assertCi,
  assertPortAllowed,
  defaultDataDir,
  logTail,
  main,
  parseArgs,
  portInUse,
  psql,
  resolveBinDir,
  sleepMs,
  stop,
  toolPath,
  up,
  waitForRealConnection,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
