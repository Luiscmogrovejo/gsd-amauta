'use strict';

/**
 * Plan 88-11: `--files-only` refreshes the installed FILES and touches nothing else.
 *
 * The incident: `node bin/init.cjs --upgrade --files-only --enable-shunt` was run
 * on the operator's machine. `bin/init.cjs` did not know `--files-only`, so the
 * upgrade ran its full path — `refresh_installed_files` shelled out to
 * `bin/install.js`, whose "Amauta Infrastructure" block printed "Starting
 * PostgreSQL container..." and started `gsd-postgres` on 127.0.0.1:5433;
 * `apply_upgrade_migrations` applied 30 SQL files to it; `restart_daemon`
 * SIGTERMed the launchd-managed daemon and spawned a detached one that came up on
 * backend postgresql (the plist pins GSD_BACKEND=sqlite), mirrored 2914 tasks into
 * PostgreSQL and flushed 58 queued writes.
 *
 * Every case here runs the REAL entry point as a child process with fake
 * `docker`, `launchctl`, `psql` and `python3` first on PATH, each of which
 * appends its own invocation to one log file. The assertion is on that log: the
 * fakes were never called. Temporary HOME, temporary config dir, a port of 0,
 * sqlite pinned; nothing connects to the live daemon (18799), RLM (18798),
 * PostgreSQL (5433) or Redis (6379).
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

/** Tools a files-only run must never invoke; each records its own argv. */
const FAKE_TOOLS = ['docker', 'launchctl', 'psql', 'pg_isready', 'brew'];

let tmp, bin, calls;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-files-only-'));
  bin = path.join(tmp, 'bin');
  calls = path.join(tmp, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of FAKE_TOOLS) {
    writeFakeExe(bin, name, {
      node: [
        `require('fs').appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');`,
        `console.log(${JSON.stringify(name)} + ' 1.0');`,
      ].join('\n'),
    });
  }
  // A fake python3 that answers the interpreter probe (`-c` must print 3, see
  // get-shit-done/bin/lib/platform.cjs) and records every other invocation, so
  // a spawn of amauta-daemon.py / infra_detect.py / migrate_runner.py is visible.
  writeFakeExe(bin, 'python3', {
    node: [
      "const a = process.argv.slice(2);",
      "if (a[0] === '-c') { console.log('3'); process.exit(0); }",
      `require('fs').appendFileSync(${JSON.stringify(calls)}, 'python3 ' + a.join(' ') + '\\n');`,
      "process.exit(0);",
    ].join('\n'),
  });
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Everything the fakes recorded since the last reset. */
function log() {
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
}

/** Did anything start, stop or talk to a container, a service or a database? */
const TOUCHED = /\bdocker\b|\blaunchctl\b|\bpsql\b|\bpg_isready\b|\bbrew\b|amauta-daemon\.py|rlm[-_]service|infra_detect\.py|migrate_runner\.py/;

/**
 * Run bin/init.cjs in a throwaway HOME with the fakes first on PATH.
 *
 * @param {string[]} argv arguments after the script path
 * @param {{home: string, env?: object}} opts `home` is reused across calls on purpose
 *        so an upgrade can read the record a previous call wrote
 * @returns {{status: number|null, stdout: string, stderr: string, log: string, parsed: (object|null)}}
 */
function runInit(argv, opts) {
  const home = opts.home;
  fs.rmSync(calls, { force: true });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, homeEnv(home), {
    PATH: prependPath([bin]),
    GSD_PYTHON: path.join(bin, process.platform === 'win32' ? 'python3.cmd' : 'python3'),
    // Default on; a case that needs install.js to really write files clears it,
    // because install.js only EXPORTS under GSD_TEST_MODE and runs nothing.
    // The daemon gate still declines on `foreign_home` with HOME in a temp dir.
    GSD_TEST_MODE: '1',
    AMAUTA_DATA_DIR: path.join(home, 'amauta-data'),
    GSD_DATA_DIR: path.join(home, 'amauta-data'),
    // NOT `$HOME/.claude`: install.js's test-mode guard refuses (exit 0) when the
    // target IS the home config dir.
    CLAUDE_CONFIG_DIR: path.join(home, 'cfg', 'claude'),
    GSD_INSTALL_PROJECT_ROOT: path.join(home, 'cfg'),
    GSD_FORCE_SQLITE: '1',
    GSD_AMAUTA_PORT: '0',
    GSD_DAEMON_PORT: '0',
    GSD_RLM_PORT: '0',
    AMAUTA_MEMORY_DATABASE_URL: '',
    GSD_POSTGRES_URL: '',
    AMAUTA_AUTO_BACKUP: 'off',
    GSD_INSTALL_FILES_ONLY: '',
    GSD_SHUNT: '',
    GSD_COMPRESS: '',
  }, opts.env || {});
  for (const k of Object.keys(opts.env || {})) if (opts.env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [BIN_INIT, ...argv], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 300000, input: '',
  });
  let parsed = null;
  if (argv.includes('--json')) {
    try { parsed = JSON.parse(r.stdout); } catch (_e) { parsed = null; }
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', log: log(), parsed };
}

/** A fresh HOME holding an install record that says sqlite. */
function homeWithRecord(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-home-'));
  const dir = path.join(home, '.amauta', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'install_record.json'), JSON.stringify({
    version: '0.0.1-before',
    installed_at: '2026-01-01T00:00:00.000Z',
    upgraded_at: null,
    backend: 'sqlite',
    plugin_root: ROOT,
    package_commit: '0'.repeat(40),
    applied_migrations: [],
    ...extra,
  }, null, 2));
  return home;
}

/** The record as it is on disk now. */
function readRecord(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.amauta', 'data', 'install_record.json'), 'utf8'));
}

/** @returns {object} the step named `name` from a --json run */
function step(parsed, name) {
  const s = (parsed.results || []).find((x) => x.name === name);
  assert.ok(s, `step ${name} missing from ${JSON.stringify((parsed.results || []).map((x) => x.name))}`);
  return s;
}

// ─── The incident command, end to end ────────────────────────────────────────

describe('88-11 the incident command: --upgrade --files-only --enable-shunt', () => {
  let home, res, record;

  before(() => {
    home = homeWithRecord();
    res = runInit(['--upgrade', '--files-only', '--enable-shunt', '--json'],
      { home, env: { GSD_TEST_MODE: '' } });
    record = res.status === 0 ? readRecord(home) : null;
  });

  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  test('exits 0', () => {
    assert.equal(res.status, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  });

  test('no container, service, database or launchctl call was made', () => {
    assert.equal(TOUCHED.test(res.log), false, `a fake was invoked:\n${res.log}`);
    assert.equal(res.log.trim(), '', `nothing may be invoked at all, got:\n${res.log}`);
  });

  test('install.js was told to install files only', () => {
    assert.ok(res.parsed, `--json output did not parse:\n${res.stdout}`);
    const refresh = step(res.parsed, 'refresh_installed_files');
    assert.equal(refresh.status, 'pass', refresh.message);
    // Two independent guards, both passed on purpose: --files-only forbids all
    // infrastructure, --skip-postgres forbids the container even if a later
    // change narrowed --files-only. (GSD_FORCE_SQLITE=1 is in the pinned env.)
    assert.deepEqual(refresh.details.installer_args,
      ['--files-only', '--skip-postgres', '--enable-shunt']);
  });

  test('apply_upgrade_migrations skips with reason files_only and records nothing', () => {
    const s = step(res.parsed, 'apply_upgrade_migrations');
    assert.equal(s.status, 'skip');
    assert.equal(s.details.skip_reason, 'files_only');
    assert.deepEqual(s.details.recorded_as_applied, []);
    assert.match(s.message, /--files-only/);
  });

  test('restart_daemon skips with reason files_only', () => {
    const s = step(res.parsed, 'restart_daemon');
    assert.equal(s.status, 'skip');
    assert.equal(s.details.skip_reason, 'files_only');
    assert.match(s.message, /launchctl/);
  });

  test('the install record is updated with the shipped provenance', () => {
    assert.ok(record, 'no record was written');
    assert.equal(typeof record.package_commit, 'string');
    assert.match(record.shipped_hash, /^[0-9a-f]{64}$/);
    assert.equal(typeof record.shipped_files, 'object');
    assert.ok(Object.keys(record.shipped_files).length > 100,
      `shipped_files looks empty: ${Object.keys(record.shipped_files).length} entries`);
    assert.notEqual(record.upgraded_at, null);
    assert.equal(new Date(record.upgraded_at).toString() === 'Invalid Date', false);
  });

  test('it records no migration it did not apply, and does not change the backend', () => {
    assert.deepEqual(record.applied_migrations, [],
      'a files-only run applied no SQL, so applied_migrations must stay empty');
    assert.equal(record.backend, 'sqlite', 'the recorded backend must survive a files-only run');
  });

  test('--enable-shunt was registered in the installed settings', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'cfg', 'claude', 'settings.json'), 'utf8'));
    const pre = (settings.hooks && settings.hooks.PreToolUse) || [];
    const hasShunt = pre.some((e) => (e.hooks || []).some((h) => String(h.command).includes('gsd-shunt-gate')));
    assert.ok(hasShunt, `the shunt gate was not registered: ${JSON.stringify(settings.hooks, null, 1)}`);
    assert.equal((settings.env || {}).GSD_SHUNT, 'on');
  });

  test('the installed files really were refreshed (manifest + VERSION)', () => {
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'claude', 'get-shit-done', 'VERSION')));
    assert.ok(fs.existsSync(path.join(home, 'cfg', 'claude', 'gsd-file-manifest.json')));
  });
});

// ─── A fresh install in files-only mode ──────────────────────────────────────

describe('88-11 a fresh files-only install starts nothing', () => {
  // --skip-install keeps this case to the step table: that install.js honours
  // --files-only is covered above and in tests/88-00-install-files-only.test.cjs.
  const run = (extraArgv, extraEnv) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-fresh-'));
    try {
      return runInit(['--json', '--skip-install', ...extraArgv], { home, env: extraEnv });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  test('--files-only skips detect_infra, migrations, start_daemon and verify', () => {
    const res = run(['--files-only']);
    assert.equal(res.status, 0, res.stderr);
    for (const name of ['detect_infra', 'migrations', 'start_daemon', 'verify']) {
      const s = step(res.parsed, name);
      assert.equal(s.status, 'skip', `${name}: ${s.status} — ${s.message}`);
      assert.equal(s.details.skip_reason, 'files_only', `${name} reason: ${JSON.stringify(s.details)}`);
    }
    assert.equal(res.log.trim(), '', `nothing may be invoked, got:\n${res.log}`);
  });

  test('GSD_INSTALL_FILES_ONLY=1 selects the same mode with no flag', () => {
    const res = run([], { GSD_INSTALL_FILES_ONLY: '1' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(step(res.parsed, 'detect_infra').details.skip_reason, 'files_only');
    assert.equal(res.log.trim(), '', `nothing may be invoked, got:\n${res.log}`);
  });

  test('without --files-only the same run DOES detect infrastructure (the gate is live)', () => {
    const res = run([]);
    assert.equal(res.status, 0, res.stderr);
    // The step RESULT, not the fake log: on Windows a `.cmd` shim cannot shadow
    // a bare-name spawn (see tests/support/fake-exe.cjs), so a positive "the
    // tool ran" claim has to come from the product's own output. A negative
    // claim ("the fake was never invoked") is sound on every platform.
    for (const name of ['detect_infra', 'migrations', 'start_daemon', 'verify']) {
      const s = step(res.parsed, name);
      assert.notEqual(s.details && s.details.skip_reason, 'files_only',
        `the mutation arm: a plain run must not skip ${name} for files_only`);
    }
    const infra = step(res.parsed, 'detect_infra');
    assert.notEqual(infra.status, 'skip',
      'a plain run resolves a backend — if it does not, this suite proves nothing');
    assert.equal(typeof infra.details.backend, 'string', JSON.stringify(infra.details));
  });

  test('--files-only prints what it will not do', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-88-11-text-'));
    try {
      const res = runInit(['--skip-install', '--files-only'], { home });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /--files-only: installing files only/);
      assert.match(res.stdout, /no container, no migration/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
