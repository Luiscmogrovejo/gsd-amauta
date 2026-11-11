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

/** Entry point: run the selected files under the hermetic environment. */
function main() {
  const { files, explicit } = selectFiles(process.argv.slice(2));
  if (files.length === 0) {
    console.error('No test files found in tests/');
    process.exit(1);
  }

  const env = buildHermeticEnv(process.env);
  console.error(
    'hermetic: data=' + env.AMAUTA_DATA_DIR +
      ' ports=' + env.GSD_AMAUTA_PORT + '/' + env.GSD_RLM_PORT +
      ' guard=on files=' + files.length + (explicit ? ' (explicit)' : '')
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
  }
  try {
    fs.rmSync(path.dirname(env.AMAUTA_DATA_DIR), { recursive: true, force: true });
  } catch (_e) {
    /* temp dir cleanup is best effort */
  }
  process.exit(status);
}

module.exports = { buildHermeticEnv, freePort, selectFiles };

if (require.main === module) main();
