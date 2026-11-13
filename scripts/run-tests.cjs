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
const { pathToFileURL } = require('url');
const canary = require('../tests/support/live-store-canary.cjs');
const registry = require('../tests/support/process-registry.cjs');
const skipGate = require('./skip-gate.cjs');

/**
 * Variables that would point a test at a live database or cache.
 *
 * All FIVE legacy cache names are here (plan 89-09 task 06): the resolver in
 * `get-shit-done/bin/lib/cache-url.cjs` reads GSD_REDIS_URL, AMAUTA_REDIS_URL,
 * VALKEY_URL, REDIS_URL and REDIS_HOST+REDIS_PORT in that order, so leaving any
 * of them through would let an ambient value outrank the disposable cache this
 * runner configures. `tests/conftest.py`'s `_DELETED_KEYS` carries the same five.
 *
 * `GSD_REDIS_URL`, the CANONICAL name, is deliberately NOT scrubbed: it is the
 * one this runner SETS, a few lines below, to an ephemeral free port. Scrubbing
 * it and then setting it would be the same thing written twice, and the value a
 * child inherits must be the runner's, never the operator's — which is what
 * `tests/88-01-runner-env.test.cjs:51` asserts by refusing a `:6379/` or
 * `:5433/` in it.
 */
const DELETED_KEYS = [
  'GSD_POSTGRES_URL',
  'DATABASE_URL',
  'AMAUTA_MEMORY_DATABASE_URL',
  'VALKEY_URL',
  'REDIS_URL',
  'AMAUTA_REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
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
    // 88-16-07: the scanners are INSTALLED in CI now, so `scripts/security-scan.cjs`
    // really invokes them — and `trivy image` pulls three container images and a
    // vulnerability database. That is not something a unit-test suite may do: the
    // 60 s budget in tests/34-security-pipeline.integration.test.cjs was exceeded on
    // the first run that had trivy (43178758984, macOS, status null = killed).
    // With no cache and updates off, trivy fails in milliseconds, which is the
    // degradation path those tests are about. That the binary installs and runs is
    // proven in the workflow step (`trivy --version`), outside the suite.
    TRIVY_SKIP_DB_UPDATE: 'true',
    TRIVY_SKIP_JAVA_DB_UPDATE: 'true',
    TRIVY_NO_PROGRESS: 'true',
    TRIVY_CACHE_DIR: path.join(os.tmpdir(), 'gsd-trivy-cache-empty'),
    // semgrep must not phone its registry either (`--config auto`) or send metrics.
    SEMGREP_SEND_METRICS: 'off',
    SEMGREP_ENABLE_VERSION_CHECK: '0',
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
  // Plan 89-15: the registry names the test file behind every process, and that
  // name is the entry script of the process that registered it. An owner or a
  // watcher switch inherited from an ENCLOSING run (a test that drives this
  // runner) would attribute this run's processes to the wrong file.
  delete env.GSD_TEST_OWNER;
  env.GSD_PROCESS_WATCH = '0';
  // Which test file was running when: tests/support/run-timeline.cjs, preloaded
  // below, writes one line per test-file process. It is what lets the stray
  // report attribute a process that NOBODY registered.
  env.GSD_RUN_TIMELINE = path.join(root, 'timeline.jsonl');

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
  env.NODE_OPTIONS = [
    baseEnv.NODE_OPTIONS,
    '--require ' + path.join(supportDir, 'hermetic-guard.cjs'),
    '--require ' + path.join(supportDir, 'run-timeline.cjs'),
  ]
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
 * Stop the strays the registry identified as this run's own: SIGTERM by exact
 * pid, re-check after 2 s, SIGKILL what remains, wait for it to be gone.
 *
 * What may be signalled (plan 89-15), and nothing else:
 *   - a pid whose registry line the process table CONFIRMS — the process
 *     holding it was created inside the window the registry recorded — checked
 *     again here, immediately before the first signal;
 *   - the processes under such a pid (a launcher's interpreter, a daemon's RLM
 *     child), each remembered with its own creation time and checked against it
 *     again before the harder signal.
 * Never a name pattern, never a process group, never an entry that is not
 * `identified`, never this process, its parent or the live daemon's pids — and
 * nothing at all when the process table cannot be read, because then nothing
 * can be verified.
 *
 * @param {ReturnType<typeof canary.strayProcesses>} strays
 * @returns {number[]} pids that were signalled
 */
function killStrays(strays) {
  const mine = strays.filter((s) => s.identified && !canary.isProtectedPid(s.pid));
  if (mine.length === 0) return [];
  const table = registry.processTable();
  if (!table) return [];
  /** @type {{pid: number, createdMs: number}[]} */
  const targets = [];
  for (const s of mine) {
    const c = registry.classify(s, table);
    if (c.state !== 'ours') continue;
    targets.push({ pid: s.pid, createdMs: c.holder.createdMs });
    for (const d of registry.descendants(table, s.pid)) {
      if (canary.isProtectedPid(d.pid) || targets.some((t) => t.pid === d.pid)) continue;
      targets.push({ pid: d.pid, createdMs: d.createdMs });
    }
  }
  const signalled = [];
  for (const t of targets) {
    try {
      process.kill(t.pid, 'SIGTERM');
      signalled.push(t.pid);
    } catch (_e) {
      /* already gone */
    }
  }
  if (signalled.length === 0) return signalled;
  sleepMs(2000);
  // Re-verify immediately before the harder signal: the pid must still be the
  // SAME process, which is a statement about its creation time, not its number.
  const again = registry.processTable();
  const tol = registry.toleranceFor();
  const stillOurs = (t) => {
    const holder = again && again.byPid.get(t.pid);
    return Boolean(holder && holder.createdMs && Math.abs(holder.createdMs - t.createdMs) <= tol);
  };
  const remaining = targets.filter(stillOurs);
  for (const t of remaining) {
    try {
      process.kill(t.pid, 'SIGKILL');
    } catch (_e) {
      /* exited after SIGTERM */
    }
  }
  // A signal is a request the kernel completes asynchronously: wait, bounded,
  // so the caller does not read a process in the act of dying as a survivor.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && remaining.some((t) => registry.pidAlive(t.pid))) sleepMs(100);
  return signalled;
}

/**
 * Whether to run the diagnostic process watcher for this run.
 *
 * `GSD_PROCESS_WATCH=1` turns it on; it is off otherwise. It costs a process
 * that polls the process table twice a second, and the runner sets `0` for its
 * children, so a run that is itself a child of another run never starts one.
 *
 * @param {NodeJS.ProcessEnv} baseEnv the environment the runner was started with
 * @returns {boolean}
 */
function watchWanted(baseEnv) {
  return baseEnv.GSD_PROCESS_WATCH === '1';
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

  // Plan 88-11: the SAME alarm, aimed at this checkout's tracked generated
  // artefacts (agents/, .mcp.json). A test that rewrites one of them with
  // identical bytes leaves git clean and passes every content assertion, yet
  // truncates the file for an instant — and a sibling test file reading it in
  // another process then reads it EMPTY (master 33f33b6, run 43248042858: five
  // failures in tests/82-01-domain-auditors-w2.test.cjs, all on an empty
  // agents/gsd-auditor-api-connections.md). mtime is therefore part of the
  // comparison, which is why this is a separate snapshot from the live store's.
  const watchTracked = process.env.GSD_SKIP_TRACKED_TREE_CANARY !== '1';
  let trackedBefore = null;
  if (watchTracked) {
    try {
      trackedBefore = canary.trackedSnapshot(path.join(__dirname, '..'));
    } catch (err) {
      console.error('run-tests: tracked-tree canary could not snapshot: ' + err.message);
    }
  }

  // Plan 88-19: the skip gate needs machine-readable per-test results, and `node --test`
  // writes none today (`stdio: 'inherit'` with the default reporter). TWO reporters run:
  // `spec` to stdout so the terminal output a human reads is unchanged in kind, and
  // scripts/skip-reporter.mjs to a file the gate parses. Measured in 88-19-01 on Node
  // 20.19.0, 22.22.3 and 25.8.1: TAP carries NO file attribution on a multi-file run, so
  // the reporter event stream — which does carry `data.file` — is the only source that can
  // produce the gate's `(file, name, platform)` key. The reporter is passed as a file://
  // URL because a Windows absolute path is not a valid module specifier.
  const skipReportFile = path.join(path.dirname(env.AMAUTA_DATA_DIR), 'skips.jsonl');
  const reporterUrl = pathToFileURL(path.join(__dirname, 'skip-reporter.mjs')).href;
  const childArgs = [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=' + reporterUrl,
    '--test-reporter-destination=' + skipReportFile,
    ...files,
  ];

  // Plan 89-15: this run's registry is announced so that another run in
  // progress (a nested runner inside a test, a second run beside this one) does
  // not report THIS run's registered fixtures as processes nobody registered.
  const runStartedAt = Date.now();
  const registryMarker = registry.announce(env.GSD_PROCESS_LEDGER);
  // Diagnostic and opt-in: a watcher that logs every process it sees, so the
  // ancestry of an unregistered daemon can be read after its parents are gone.
  const watchLog = path.join(path.dirname(env.AMAUTA_DATA_DIR), 'process-watch.tsv');
  const watcher = watchWanted(process.env) ? registry.startWatcher(watchLog) : null;

  let status = 0;
  try {
    execFileSync(process.execPath, childArgs, { stdio: 'inherit', env });
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
    if (trackedBefore) {
      let trackedFindings = [];
      try {
        trackedFindings = canary.trackedDiff(
          trackedBefore,
          canary.trackedSnapshot(path.join(__dirname, '..'))
        );
      } catch (err) {
        console.error('run-tests: tracked-tree canary could not compare: ' + err.message);
      }
      if (trackedFindings.length > 0) {
        console.error(canary.formatTracked(trackedFindings));
        status = 7; // 4/5/6 are taken below and above; a tracked-tree write is its own red
      }
    }
    // Process leaks: a daemon or RLM the run started and nobody stopped. Reported
    // even when the canary already set a status; the kill pass touches only
    // entries the REGISTRY identifies as this run's own (plan 89-15: pid and
    // start time, never a command line).
    if (watcher) {
      try {
        watcher.kill(); // by its own handle: the one process this runner started
      } catch (_e) {
        /* already gone */
      }
    }
    let audit = { strays: [], recycled: [], unclosed: [], unregistered: [], preexisting: [], table: null };
    try {
      audit = canary.processAudit(env.GSD_PROCESS_LEDGER, { runStartedAt, repoRoot: path.join(__dirname, '..') });
    } catch (err) {
      console.error('run-tests: process ledger could not be read: ' + err.message);
    }
    const strays = audit.strays;
    if (strays.length > 0) {
      console.error(canary.formatStrays(strays));
      status = 5; // 4 is the live-store canary's; a leaked process fails the run too
      killStrays(strays);
    }
    // What is NOT in the registry is not this run's, and is never signalled and
    // never fails the run: it is listed below, with the test files that were
    // running when it appeared. A daemon or RLM started under this run's
    // environment through a PRODUCT path is not in that list — it registers
    // itself (tests/support/pythonpath/sitecustomize.py), so it is a stray
    // above, attributed and stopped like a fixture's. What remains unregistered
    // is another run's (a pytest session beside this one), the operator's own,
    // or a start whose environment was scrubbed; nothing but its command line
    // says it is ours, and a command line is exactly what the live daemon has.
    try {
      const report = canary.formatAudit(audit, {
        timeline: registry.readTimeline(env.GSD_RUN_TIMELINE),
        watched: watcher ? registry.readWatchLog(watchLog) : [],
      });
      if (report) console.error(report);
    } catch (err) {
      console.error('run-tests: the process audit could not be rendered: ' + err.message);
    }
    registry.withdraw(registryMarker);
    // Plan 88-19: the skip gate. A test that skipped without an entry in
    // tests/skip-exceptions.d/ (sharded one file per owner by plan 89-09) fails
    // the run with status 6 (4 is the live-store
    // canary's and 5 the stray-process check's, both unchanged above), and on a FULL
    // run an entry that excused nothing fails it too, so the file cannot rot.
    //
    // Two scopes beyond the gate's own rules are applied here, both deliberate:
    //   - `explicit` (file arguments were given) means a PARTIAL run: SKIP_UNLISTED is
    //     still checked, staleness is not, because a run of one file leaves almost every
    //     entry unmatched by construction.
    //   - a run whose child exited non-zero is an INCOMPLETE run for the same reason, so
    //     staleness is not checked there either. Unlisted skips still are.
    // A gate finding never masks a real test failure: status 6 is set only when the run
    // was otherwise green, and when it was not, the findings are printed with the status
    // the run already carries named beside them.
    try {
      const gate = skipGate.runNodeGate({
        reportFile: skipReportFile,
        repoRoot: path.join(__dirname, '..'),
        explicit: explicit || status !== 0,
        env: process.env,
      });
      console.error(gate.text);
      if (gate.exit_code !== 0) {
        if (status === 0) {
          status = 6; // the skip gate's own status; 4 and 5 keep their meanings
        } else {
          console.error(
            'skip gate: ' + gate.findings.length + ' finding(s) above, but the run already ' +
              'failed with status ' + status + ', which is kept so the first failure is not hidden.'
          );
        }
      }
    } catch (err) {
      console.error('run-tests: the skip gate could not run: ' + err.message);
      if (status === 0) status = 6; // fail closed: a gate that cannot run is not a pass
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

// LIVE_PORTS is exported (plan 89-07) so scripts/ci-postgres-cell.cjs can refuse
// a cluster on one of the operator's live ports by reading THIS list rather than
// keeping a second copy of it.
module.exports = { LIVE_PORTS, buildHermeticEnv, freePort, selectFiles, killStrays, testPostgresPort, watchWanted };

if (require.main === module) main();
