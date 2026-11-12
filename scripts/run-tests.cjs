#!/usr/bin/env node
// Cross-platform test runner — resolves test file globs via Node
// instead of relying on shell expansion (which fails on Windows PowerShell/cmd).
// Propagates NODE_V8_COVERAGE so c8 collects coverage from the child process.
//
// Hermetic (Phase 88, plan 88-01): every child and grandchild runs with a scrubbed
// environment (SQLite forced, test mode on, temporary data dir, ports moved off
// the operator's live 18799/18798/6379/5433, no Postgres/Redis URLs) and with
// tests/support/hermetic-guard.cjs loaded through NODE_OPTIONS.
//
// Usage:
//   node scripts/run-tests.cjs                      run every tests/*.test.cjs
//   node scripts/run-tests.cjs tests/a.test.cjs ... run exactly those files, in order
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const canary = require('../tests/support/live-store-canary.cjs');

/** Variables that would point a test at a live database or cache. */
const DELETED_KEYS = [
  'GSD_POSTGRES_URL',
  'DATABASE_URL',
  'AMAUTA_MEMORY_DATABASE_URL',
  'VALKEY_URL',
  'REDIS_URL',
  'GSD_PG_PORT',
];

/** Ports of the operator's live services; a test port must never be one of these. */
const LIVE_PORTS = new Set([18799, 18798, 6379, 5433]);

/**
 * Validate the disposable-Postgres DSN CI hands the runner and return its port.
 *
 * `GSD_TEST_POSTGRES_URL` is the ONE opt-in (plan 88-16-03). It is passed to
 * children under that name only — `GSD_POSTGRES_URL` stays in `DELETED_KEYS`
 * so no test can inherit a live DSN by accident — and the port is allowed
 * through the hermetic guard for that run and nothing else.
 *
 * libpq is a C extension: the in-process socket guard cannot see its connect.
 * This check is the control that DOES bind it, which is why it fails the run
 * rather than warning.
 *
 * @param {string|undefined} dsn the raw value of `GSD_TEST_POSTGRES_URL`
 * @returns {number|null} the port, or null when no DSN was supplied
 * @throws {Error} when the DSN names one of the operator's live service ports
 * @example
 *   testPostgresPort('postgresql://u:p@127.0.0.1:5434/db') // 5434
 */
function testPostgresPort(dsn) {
  const raw = String(dsn || '').trim();
  if (!raw) return null;
  let port = null;
  try {
    const u = new URL(raw);
    if (u.port) port = Number(u.port);
  } catch (_e) {
    const m = /:(\d{2,5})\//.exec(raw);
    if (m) port = Number(m[1]);
  }
  if (port !== null && LIVE_PORTS.has(port)) {
    throw new Error(
      'run-tests: GSD_TEST_POSTGRES_URL points at live service port ' + port + '. ' +
        '18799 (daemon), 18798 (RLM), 6379 (Redis) and 5433 (the operator\'s ' +
        'PostgreSQL) are never test ports. Give the disposable database a ' +
        'different port and try again.'
    );
  }
  return port;
}

/**
 * Pick a free TCP port on 127.0.0.1.
 *
 * The runner needs the port synchronously (the environment is built before the
 * child starts), and Node cannot bind a socket synchronously, so a short-lived
 * helper process binds port 0, prints the port and exits.
 *
 * @param {Iterable<number>} [avoid] ports that must not be returned
 * @returns {number} a port that was free a moment ago
 * @throws {Error} when no usable port is found after several attempts
 */
function freePort(avoid = []) {
  const skip = new Set([...LIVE_PORTS, ...avoid]);
  const script =
    "const s=require('net').createServer();" +
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  for (let i = 0; i < 10; i++) {
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const port = Number(out.trim());
    if (Number.isInteger(port) && port > 0 && !skip.has(port)) return port;
  }
  throw new Error('run-tests: could not obtain a free port');
}

/**
 * Build the scrubbed environment handed to the test processes.
 *
 * HOME is deliberately left alone: replacing it on macOS hides the user-site
 * Python packages and breaks pytest/numpy (88-RESEARCH.md section 1.2).
 *
 * @param {NodeJS.ProcessEnv} baseEnv the environment to start from
 * @returns {NodeJS.ProcessEnv} a new environment object
 */
function buildHermeticEnv(baseEnv) {
  const env = { ...baseEnv };
  for (const key of DELETED_KEYS) delete env[key];

  Object.assign(env, {
    GSD_FORCE_SQLITE: '1',
    GSD_BACKEND: 'sqlite',
    GSD_TEST_MODE: '1',
    GSD_REDIS_ENABLED: 'false',
    GSD_RLM_ENABLED: 'false',
    GSD_AMAUTA_NO_AUTO_START: '1',
    GSD_INSTALL_FILES_ONLY: '1',
    AMAUTA_AUTO_BACKUP: 'off',
    // 88-18: a Python child whose socket guard fails to arm must exit non-zero
    // instead of running unguarded (tests/support/pythonpath/sitecustomize.py).
    GSD_HERMETIC_GUARD_REQUIRED: '1',
    // 88-16-03: npm must not reach the registry from a test.
    // `get-shit-done/bin/gsd-tools.cjs` `_detectLinter()` probes with
    // `npx eslint --version`, and eslint is not a dependency of this
    // repository, so npm went to the network — on CI it downloaded eslint
    // mid-suite, and under the default-deny guard it retried and HUNG. Offline
    // mode makes the probe fail in milliseconds, which is the answer the
    // detection ladder is written for ("fall back to node --check").
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tests-'));
  env.AMAUTA_DATA_DIR = path.join(root, 'data');
  env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  fs.mkdirSync(env.AMAUTA_DATA_DIR, { recursive: true });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });

  const daemonPort = freePort();
  const rlmPort = freePort([daemonPort]);
  const redisPort = freePort([daemonPort, rlmPort]);
  env.GSD_AMAUTA_PORT = String(daemonPort);
  env.GSD_DAEMON_PORT = String(daemonPort);
  env.GSD_RLM_PORT = String(rlmPort);
  // Other names the repository reads for the same ports: AMAUTA_PORT is the daemon
  // port in the LIVE-daemon tests, GSD_REDIS_PORT is what services/pg_dsn.py
  // redis_port() reads (services/infra_detect.py probes it even when SQLite is forced).
  env.AMAUTA_PORT = String(daemonPort);
  env.GSD_REDIS_PORT = String(redisPort);
  env.GSD_REDIS_URL = 'redis://127.0.0.1:' + redisPort + '/0';
  // Every fixture daemon records the pid it starts and stops here; main() reads it
  // back after the run and fails the run on anything left alive (plan 88-12).
  env.GSD_PROCESS_LEDGER = path.join(root, 'process-ledger.jsonl');

  // Plan 88-16-03: the guard is default-deny for non-loopback destinations and
  // writes one line per refusal here. Nothing set this variable before, so the
  // Node guard's log branch was dead and the Python guard had no log at all.
  // main() prints the file after the run, which is how the network-reach
  // inventory is collected from a log-only CI run.
  env.GSD_HERMETIC_GUARD_LOG = path.join(root, 'hermetic-guard-refusals.tsv');

  // The ONE disposable-Postgres opt-in. Validated here (a live port fails the
  // run) and threaded to children under GSD_TEST_POSTGRES_URL only; the port is
  // allowed through the guard, nothing else is.
  const pgPort = testPostgresPort(baseEnv.GSD_TEST_POSTGRES_URL);
  if (pgPort !== null) {
    env.GSD_TEST_POSTGRES_URL = String(baseEnv.GSD_TEST_POSTGRES_URL).trim();
    const allow = String(baseEnv.GSD_HERMETIC_GUARD_ALLOW_PORTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allow.includes(String(pgPort))) allow.push(String(pgPort));
    env.GSD_HERMETIC_GUARD_ALLOW_PORTS = allow.join(',');
  } else {
    delete env.GSD_TEST_POSTGRES_URL;
  }

  const supportDir = path.join(__dirname, '..', 'tests', 'support');
  env.NODE_OPTIONS = [baseEnv.NODE_OPTIONS, '--require ' + path.join(supportDir, 'hermetic-guard.cjs')]
    .filter(Boolean)
    .join(' ');
  env.PYTHONPATH = [path.join(supportDir, 'pythonpath'), baseEnv.PYTHONPATH]
    .filter(Boolean)
    .join(path.delimiter);

  return env;
}

/**
 * Decide which test files to run.
 *
 * With explicit arguments, exactly those files run, in the order given. Without
 * them, every tests/*.test.cjs runs alphabetically, with the integration tests
 * (degradation, e2e, gsd-amauta) last to avoid shared-PG data conflicts.
 *
 * @param {string[]} args command-line arguments after the script name
 * @returns {{files: string[], explicit: boolean}}
 */
function selectFiles(args) {
  if (args.length > 0) {
    for (const f of args) {
      if (!fs.existsSync(f)) {
        console.error('run-tests: no such test file: ' + f);
        process.exit(2);
      }
    }
    return { files: args, explicit: true };
  }
  const testDir = path.join(__dirname, '..', 'tests');
  const LAST_TESTS = ['degradation.test.cjs', 'e2e-lifecycle.test.cjs', 'gsd-amauta.test.cjs'];
  const allFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.cjs'));
  const unitTests = allFiles.filter((f) => !LAST_TESTS.includes(f)).sort();
  const integrationTests = LAST_TESTS.filter((f) => allFiles.includes(f));
  return {
    files: [...unitTests, ...integrationTests].map((f) => path.join('tests', f)),
    explicit: false,
  };
}

/**
 * Synchronous sleep (the runner is synchronous).
 * @param {number} ms
 * @returns {void}
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop the strays this run identified as its own daemon or RLM: SIGTERM by pid,
 * re-check after 2 s, SIGKILL what remains. Entries that are not `identified`
 * are never signalled (no name pattern, no process group, never this process,
 * its parent or the live daemon's pids).
 *
 * @param {ReturnType<typeof canary.strayProcesses>} strays
 * @returns {number[]} pids that were signalled
 */
function killStrays(strays) {
  const mine = strays.filter((s) => s.identified && !canary.isProtectedPid(s.pid));
  const signalled = [];
  for (const s of mine) {
    try {
      process.kill(s.pid, 'SIGTERM');
      signalled.push(s.pid);
    } catch (_e) {
      /* already gone */
    }
  }
  if (signalled.length === 0) return signalled;
  sleepMs(2000);
  for (const s of mine) {
    // Re-identify immediately before the harder signal: the pid must still be ours.
    if (!canary.identify(s).identified) continue;
    try {
      process.kill(s.pid, 0);
      process.kill(s.pid, 'SIGKILL');
    } catch (_e) {
      /* exited after SIGTERM */
    }
  }
  return signalled;
}

/** Entry point: run the selected files under the hermetic environment. */
function main() {
  const { files, explicit } = selectFiles(process.argv.slice(2));
  if (files.length === 0) {
    console.error('No test files found in tests/');
    process.exit(1);
  }

  let env;
  try {
    env = buildHermeticEnv(process.env);
  } catch (err) {
    // A DSN on a live port is a refusal, not a crash: say so in one line and stop.
    console.error(err.message);
    process.exit(3);
  }
  console.error(
    'hermetic: data=' + env.AMAUTA_DATA_DIR +
      ' ports=' + env.GSD_AMAUTA_PORT + '/' + env.GSD_RLM_PORT +
      ' guard=' + (String(process.env.GSD_HERMETIC_GUARD_MODE || '').toLowerCase() === 'log'
        ? 'log-only'
        : 'enforce') +
      (env.GSD_TEST_POSTGRES_URL ? ' pg=on' : ' pg=off') +
      ' files=' + files.length + (explicit ? ' (explicit)' : '')
  );

  // Independent file-level alarm: the socket guard cannot see a write that goes
  // through a subprocess, so compare the live store before and after the run.
  const watch = process.env.GSD_SKIP_LIVE_STORE_CANARY !== '1';
  let before = null;
  if (watch) {
    try {
      before = canary.snapshot();
    } catch (err) {
      console.error('run-tests: live-store canary could not snapshot: ' + err.message);
    }
  }

  let status = 0;
  try {
    execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
  } catch (err) {
    status = err.status || 1;
  } finally {
    if (before) {
      let findings = [];
      try {
        findings = canary.diff(before, canary.snapshot());
      } catch (err) {
        console.error('run-tests: live-store canary could not compare: ' + err.message);
      }
      if (findings.length > 0) {
        console.error(canary.format(findings));
        status = 4; // fails even when the tests themselves passed
      }
    }
    // Process leaks: a daemon or RLM the run started and nobody stopped. Reported
    // even when the canary already set a status; the kill pass touches only entries
    // identified as this run's own daemon/RLM.
    let strays = [];
    try {
      strays = canary.strayProcesses(env.GSD_PROCESS_LEDGER);
    } catch (err) {
      console.error('run-tests: process ledger could not be read: ' + err.message);
    }
    if (strays.length > 0) {
      console.error(canary.formatStrays(strays));
      status = 5; // 4 is the live-store canary's; a leaked process fails the run too
      killStrays(strays);
    }
    // Plan 88-16-03: print whatever the guard refused. In log-only mode this IS
    // the network-reach inventory; in enforcing mode it is the diagnosis for a
    // test that died on EHERMETIC. The file is inside the temp root that is
    // removed below, so it has to be read here.
    try {
      if (fs.existsSync(env.GSD_HERMETIC_GUARD_LOG)) {
        const log = fs.readFileSync(env.GSD_HERMETIC_GUARD_LOG, 'utf-8').trimEnd();
        if (log) {
          console.error('--- hermetic guard refusals (time pid mode runtime host port reason argv) ---');
          console.error(log);
          console.error('--- end hermetic guard refusals (' + log.split('\n').length + ' line(s)) ---');
        } else {
          console.error('hermetic guard: no refusals');
        }
      } else {
        console.error('hermetic guard: no refusals');
      }
    } catch (err) {
      console.error('run-tests: could not read the guard log: ' + err.message);
    }
  }
  try {
    fs.rmSync(path.dirname(env.AMAUTA_DATA_DIR), { recursive: true, force: true });
  } catch (_e) {
    /* temp dir cleanup is best effort */
  }
  process.exit(status);
}

module.exports = { buildHermeticEnv, freePort, selectFiles, killStrays, testPostgresPort };

if (require.main === module) main();
