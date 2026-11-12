'use strict';

/**
 * Plan 88-11, the two decisions an upgrade must not make on its own.
 *
 * 1. The BACKEND. The 2026-11-11 run upgraded an install whose record says
 *    `backend: "sqlite"`, and `stepDetectInfra` ran `infra_detect.py
 *    --auto-start`, which STARTED the operator's `gsd-postgres` container on
 *    127.0.0.1:5433; 30 migrations were then applied to it. Changing the backend
 *    is now something the operator asks for (`--start-postgres`).
 *
 * 2. WHO OWNS THE DAEMON. The same run SIGTERMed the launchd-managed daemon and
 *    spawned a detached replacement, which inherited this process's environment
 *    instead of the plist's (so PostgreSQL, against a plist pinning
 *    GSD_BACKEND=sqlite) and mirrored 2914 tasks into the wrong store.
 *
 * The decision tables are pure functions driven by INJECTED probes: no test here
 * runs `launchctl`, and the end-to-end case runs with fake `docker`, `psql` and
 * `launchctl` first on PATH that record every invocation to a file. Temporary
 * HOME, port 0, sqlite pinned; nothing dials 18799, 18798, 5433 or 6379.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { homeEnv } = require('./support/home-env.cjs');
const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

const ROOT = path.resolve(__dirname, '..');
const BIN_INIT = path.join(ROOT, 'bin', 'init.cjs');
const { shouldStartPostgres, daemonRestartPlan } = require(BIN_INIT);

// ─── Decision table 1: may this run start PostgreSQL? ───────────────────────

describe('88-11 shouldStartPostgres decision table', () => {
  const SQLITE = { backend: 'sqlite' };
  const PG = { backend: 'postgresql' };
  const cases = [
    ['--start-postgres wins over a sqlite record',
      { env: {}, record: SQLITE, flags: { startPostgres: true } }, true, 'forced_by_flag'],
    ['--start-postgres wins over GSD_FORCE_SQLITE',
      { env: { GSD_FORCE_SQLITE: '1' }, record: SQLITE, flags: { startPostgres: true } }, true, 'forced_by_flag'],
    ['--backend pg is an explicit ask',
      { env: {}, record: SQLITE, flags: { backend: 'pg' } }, true, 'backend_flag_pg'],
    ['GSD_FORCE_SQLITE=1 declines',
      { env: { GSD_FORCE_SQLITE: '1' }, record: null, flags: {} }, false, 'env_force_sqlite'],
    ['GSD_FORCE_SQLITE=true declines too',
      { env: { GSD_FORCE_SQLITE: 'true' }, record: null, flags: {} }, false, 'env_force_sqlite'],
    ['GSD_FORCE_SQLITE=0 is NOT a pin',
      { env: { GSD_FORCE_SQLITE: '0' }, record: null, flags: {} }, true, 'no_recorded_backend'],
    ['GSD_BACKEND=sqlite declines (what the launchd plist pins)',
      { env: { GSD_BACKEND: 'sqlite' }, record: null, flags: {} }, false, 'env_backend_sqlite'],
    ['GSD_BACKEND=SQLite is the same pin',
      { env: { GSD_BACKEND: 'SQLite' }, record: null, flags: {} }, false, 'env_backend_sqlite'],
    ['GSD_BACKEND=postgresql is not a sqlite pin',
      { env: { GSD_BACKEND: 'postgresql' }, record: null, flags: {} }, true, 'no_recorded_backend'],
    ['--backend sqlite declines',
      { env: {}, record: null, flags: { backend: 'sqlite' } }, false, 'backend_flag_sqlite'],
    ['THE INCIDENT: a record that says sqlite declines',
      { env: {}, record: SQLITE, flags: {} }, false, 'record_backend_sqlite'],
    ['a record that says postgresql still starts',
      { env: {}, record: PG, flags: {} }, true, 'no_recorded_backend'],
    ['CHARACTERISED FRESH-INSTALL DEFAULT, unchanged: no record, no pin, no flag',
      { env: {}, record: null, flags: {} }, true, 'no_recorded_backend'],
    ['a record with no backend key behaves like no record',
      { env: {}, record: { version: '1' }, flags: {} }, true, 'no_recorded_backend'],
    ['a derived record (no backend) behaves like no record',
      { env: {}, record: { derived: true, applied_migrations: [] }, flags: {} }, true, 'no_recorded_backend'],
  ];
  for (const [name, ctx, start, reason] of cases) {
    test(name, () => {
      assert.deepEqual(shouldStartPostgres(ctx), { start, reason });
    });
  }
});

// ─── Decision table 2: how does the daemon come back? ───────────────────────

describe('88-11 daemonRestartPlan decision table (injected probes only)', () => {
  const cases = [
    ['THE INCIDENT: launchd-managed on macOS is kickstarted, never spawned',
      { platform: 'darwin', uid: 501, launchdManaged: true },
      { action: 'kickstart', target: 'gui/501/com.amauta.daemon', reason: 'launchd_managed' }],
    ['not launchd-managed on macOS: this run owns the daemon and spawns it',
      { platform: 'darwin', uid: 501, launchdManaged: false },
      { action: 'spawn', target: null, reason: 'not_launchd_managed' }],
    ['linux never consults launchd',
      { platform: 'linux', uid: 1000, launchdManaged: null },
      { action: 'spawn', target: null, reason: 'not_macos' }],
    ['windows never consults launchd',
      { platform: 'win32', uid: null, launchdManaged: null },
      { action: 'spawn', target: null, reason: 'not_macos' }],
    ['macOS with no uid cannot name a gui domain, so it spawns',
      { platform: 'darwin', uid: null, launchdManaged: true },
      { action: 'spawn', target: null, reason: 'uid_unknown' }],
    ['a probe that could not answer skips rather than guess',
      { platform: 'darwin', uid: 501, launchdManaged: null },
      { action: 'skip', target: 'gui/501/com.amauta.daemon', reason: 'launchd_probe_failed' }],
    ['a probe that was not run at all skips too',
      { platform: 'darwin', uid: 501, launchdManaged: undefined },
      { action: 'skip', target: 'gui/501/com.amauta.daemon', reason: 'launchd_probe_failed' }],
    ['the uid is interpolated, not hard-coded',
      { platform: 'darwin', uid: 0, launchdManaged: true },
      { action: 'kickstart', target: 'gui/0/com.amauta.daemon', reason: 'launchd_managed' }],
    ['an injected label is honoured',
      { platform: 'darwin', uid: 501, launchdManaged: true, label: 'com.example.other' },
      { action: 'kickstart', target: 'gui/501/com.example.other', reason: 'launchd_managed' }],
  ];
  for (const [name, ctx, expected] of cases) {
    test(name, () => {
      assert.deepEqual(daemonRestartPlan(ctx), expected);
    });
  }

  test('no case in this suite can reach launchctl: the plan takes no probe function', () => {
    // The probe RESULT is an argument. There is nothing to call, which is what
    // makes "no test touches a real service" a property rather than a promise.
    assert.equal(daemonRestartPlan.length, 1, 'daemonRestartPlan takes exactly one options object');
    const src = fs.readFileSync(BIN_INIT, 'utf8');
    const body = src.slice(src.indexOf('function daemonRestartPlan'));
    const end = body.indexOf('\n}\n');
    assert.ok(end > 0);
    assert.equal(/launchctl|spawnSync|execFile/.test(body.slice(0, end)), false,
      'daemonRestartPlan must not spawn anything');
  });
});

// ─── End to end: an upgrade of an install recorded as sqlite ────────────────

describe('88-11 a sqlite-recorded upgrade leaves PostgreSQL alone', () => {
  let tmp, bin, calls;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-gates-'));
    bin = path.join(tmp, 'bin');
    calls = path.join(tmp, 'calls.log');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['docker', 'launchctl', 'psql', 'pg_isready']) {
      writeFakeExe(bin, name, {
        node: [
          `require('fs').appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');`,
          `console.log(${JSON.stringify(name)} + ' 1.0');`,
        ].join('\n'),
      });
    }
    writeFakeExe(bin, 'python3', {
      node: [
        "const a = process.argv.slice(2);",
        "if (a[0] === '-c') { console.log('3'); process.exit(0); }",
        `require('fs').appendFileSync(${JSON.stringify(calls)}, 'python3 ' + a.join(' ') + '\\n');`,
        // infra_detect.py is the call that auto-starts the container. If the gate
        // leaks, the fake answers "postgresql" and the next step tries to migrate.
        "if (a.some(x => String(x).includes('infra_detect'))) {",
        "  console.log(JSON.stringify({ backend: 'postgresql',",
        "    connection_url: 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta',",
        "    features: ['memory'], message: 'FAKE postgresql' }));",
        "}",
        "process.exit(0);",
      ].join('\n'),
    });
  });

  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  /**
   * Upgrade a throwaway install whose record says `backend`.
   * @param {string} backend the recorded backend
   * @param {string[]} extraArgv extra flags
   * @param {object} [extraEnv] environment overrides
   * @returns {{status: number|null, stdout: string, stderr: string, log: string, parsed: object}}
   */
  function upgrade(backend, extraArgv, extraEnv = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-gate-home-'));
    try {
      fs.mkdirSync(path.join(home, '.amauta', 'data'), { recursive: true });
      fs.writeFileSync(path.join(home, '.amauta', 'data', 'install_record.json'), JSON.stringify({
        version: '0.0.1-before', backend, plugin_root: ROOT, applied_migrations: [],
      }));
      fs.rmSync(calls, { force: true });
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      Object.assign(env, homeEnv(home), {
        PATH: prependPath([bin]),
        GSD_PYTHON: path.join(bin, process.platform === 'win32' ? 'python3.cmd' : 'python3'),
        GSD_TEST_MODE: '1',
        AMAUTA_DATA_DIR: path.join(home, 'amauta-data'),
        GSD_DATA_DIR: path.join(home, 'amauta-data'),
        CLAUDE_CONFIG_DIR: path.join(home, 'cfg', 'claude'),
        GSD_INSTALL_PROJECT_ROOT: path.join(home, 'cfg'),
        GSD_AMAUTA_PORT: '0',
        GSD_DAEMON_PORT: '0',
        GSD_RLM_PORT: '0',
        AMAUTA_MEMORY_DATABASE_URL: '',
        GSD_POSTGRES_URL: '',
        AMAUTA_AUTO_BACKUP: 'off',
        GSD_INSTALL_FILES_ONLY: '',
        GSD_SHUNT: '', GSD_COMPRESS: '',
        // Deliberately NOT set: this suite must prove the RECORD is enough. The
        // pinned-environment GSD_FORCE_SQLITE would decide it before the record
        // was consulted, and the test would prove nothing about the record.
        GSD_FORCE_SQLITE: undefined, GSD_BACKEND: undefined,
        ...extraEnv,
      });
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const r = spawnSync(process.execPath,
        [BIN_INIT, '--upgrade', '--json', '--skip-install', '--skip-daemon', ...extraArgv],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 180000, input: '' });
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch (_e) { /* asserted below */ }
      return {
        status: r.status, stdout: r.stdout || '', stderr: r.stderr || '',
        log: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', parsed,
      };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const stepOf = (parsed, name) => {
    const s = (parsed.results || []).find((x) => x.name === name);
    assert.ok(s, `step ${name} missing`);
    return s;
  };

  test('no container is started and no migration is applied', () => {
    const res = upgrade('sqlite', []);
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.ok(res.parsed, `--json did not parse:\n${res.stdout}`);
    assert.equal(/\bdocker\b|\bpsql\b|\bpg_isready\b/.test(res.log), false,
      `a database tool was invoked:\n${res.log}`);
    assert.equal(/infra_detect\.py|migrate_runner\.py/.test(res.log), false,
      `infra detection (which auto-starts the container) ran:\n${res.log}`);
    const s = stepOf(res.parsed, 'apply_upgrade_migrations');
    assert.equal(s.status, 'skip');
    assert.equal(s.details.skip_reason, 'record_backend_sqlite');
    assert.deepEqual(s.details.recorded_as_applied, []);
  });

  test('it says what it skipped and why, and how to override', () => {
    const res = upgrade('sqlite', []);
    const s = stepOf(res.parsed, 'apply_upgrade_migrations');
    assert.match(s.message, /install record says backend "sqlite"/);
    assert.match(s.message, /container was NOT started/);
    assert.match(s.message, /--start-postgres/);
  });

  test('the would-be work is still reported, so nothing is hidden', () => {
    const res = upgrade('sqlite', []);
    const s = stepOf(res.parsed, 'apply_upgrade_migrations');
    assert.ok(Array.isArray(s.details.would_apply));
    assert.ok(s.details.would_apply.length > 0,
      'the migrations it did not apply must still be named');
  });

  test('MUTATION ARM: --start-postgres DOES reach infra detection', () => {
    const res = upgrade('sqlite', ['--start-postgres']);
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.match(res.log, /infra_detect\.py/,
      'with the explicit opt-in the gate must open — otherwise the arm above proves nothing');
  });

  test('a record that says postgresql is not gated', () => {
    const res = upgrade('postgresql', []);
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.match(res.log, /infra_detect\.py/);
  });

  test('GSD_BACKEND=sqlite alone gates a record with no backend', () => {
    const res = upgrade('postgresql', [], { GSD_BACKEND: 'sqlite' });
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    const s = stepOf(res.parsed, 'apply_upgrade_migrations');
    assert.equal(s.details.skip_reason, 'env_backend_sqlite');
    assert.equal(/infra_detect\.py/.test(res.log), false, res.log);
  });

  test('launchctl is never invoked by any of these runs', () => {
    for (const args of [[], ['--start-postgres']]) {
      const res = upgrade('sqlite', args);
      assert.equal(/\blaunchctl\b/.test(res.log), false,
        `launchctl was invoked with ${JSON.stringify(args)}:\n${res.log}`);
    }
  });
});
