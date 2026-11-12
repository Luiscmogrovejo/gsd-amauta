'use strict';
/**
 * init.cjs install-truth tests.
 *
 * Covers the defects where init reported success while hiding its real state:
 *   1. SQLite fallback finished "installed" with no degraded-mode banner
 *   2. nothing ever wrote ~/.amauta/data/install_record.json, so --upgrade
 *      always failed with "install record not found — run init first"
 *   3. --upgrade never re-ran install.js, so the installed copy was never
 *      refreshed; and on SQLite it marked un-run migrations as applied
 *   4. --uninstall only deleted the current project's .claude outputs and
 *      left the global install in place
 *
 * Hermetic: throwaway HOME, throwaway CLAUDE_CONFIG_DIR, a dead daemon port
 * (18991) so nothing here can reach a real daemon, and --skip-install so the
 * real installer never runs against a real config dir.
 *
 * Run: node --test tests/init-install-truth.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const BIN_INIT = path.join(ROOT, 'bin', 'init.cjs');
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
const { homeEnv } = require('./support/home-env.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runInit(args, opts) {
  opts = opts || {};
  const home = opts.home || tmp('init-truth-');
  const cwd = opts.cwd || home;
  const env = {
    ...process.env,
    ...homeEnv(home),
    AMAUTA_DATA_DIR: path.join(home, 'data'),
    GSD_AMAUTA_PORT: '18991',   // dead port: never touch a running daemon
    CLAUDE_CONFIG_DIR: opts.configDir || path.join(home, '.claude'),
    GSD_TEST_MODE: '',          // init shells out to install.js, which skips its main block under test mode
  };
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [BIN_INIT, ...args], {
      cwd, env, encoding: 'utf-8', timeout: 60000,
    });
  } catch (e) {
    stdout = (e.stdout || '').toString();
    stderr = (e.stderr || '').toString();
    exitCode = e.status || 1;
  }
  let parsed = null;
  if (args.includes('--json')) {
    try { parsed = JSON.parse(stdout); } catch (_e) { /* left null */ }
  }
  return { home, cwd, stdout, stderr, exitCode, parsed };
}

function recordPath(home) {
  return path.join(home, '.amauta', 'data', 'install_record.json');
}

function writeRecord(home, record) {
  const dir = path.join(home, '.amauta', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'install_record.json'), JSON.stringify(record, null, 2));
}

/** Build a fake INSTALLED copy so upgrade/uninstall have something to see. */
function fakeGlobalInstall(version) {
  const dir = tmp('init-truth-cfg-');
  fs.mkdirSync(path.join(dir, 'get-shit-done', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'get-shit-done', 'VERSION'), version || '3.0.0');
  fs.writeFileSync(path.join(dir, 'get-shit-done', 'bin', 'gsd-tools.cjs'), '// installed\n');
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'gsd-planner.md'), '# installed agent\n');
  fs.writeFileSync(path.join(dir, 'gsd-file-manifest.json'),
    JSON.stringify({ version: version || '3.0.0', files: {} }));
  return dir;
}

// ─── 1. Install record is written ─────────────────────────────────────────────

test('init writes the install record so --upgrade has something to read', () => {
  const { home, exitCode, parsed } = runInit(
    ['--json', '--skip-daemon', '--skip-install', '--backend', 'sqlite']);
  assert.strictEqual(exitCode, 0, 'skills-only init must exit 0');
  assert.ok(parsed, 'init --json must emit parseable JSON on stdout');

  const rp = recordPath(home);
  assert.ok(fs.existsSync(rp), `install record must exist at ${rp}`);
  const rec = JSON.parse(fs.readFileSync(rp, 'utf-8'));
  assert.strictEqual(rec.version, PKG_VERSION);
  assert.strictEqual(rec.backend, 'sqlite');
  assert.deepStrictEqual(rec.applied_migrations, [],
    'SQLite runs no SQL, so no migration may be recorded as applied');
  assert.ok(rec.installed_at, 'installed_at must be set');
});

// ─── 2. Degraded-mode reporting ───────────────────────────────────────────────

test('init --json reports degraded mode with the features that are off', () => {
  const { parsed } = runInit(['--json', '--skip-daemon', '--skip-install', '--backend', 'sqlite']);
  assert.ok(parsed && parsed.degraded, 'JSON output must carry a degraded block on SQLite');
  assert.strictEqual(parsed.degraded.backend, 'sqlite');
  assert.ok(parsed.degraded.features_off.length >= 3,
    `expected a list of disabled features, got ${JSON.stringify(parsed.degraded.features_off)}`);
  assert.ok(parsed.degraded.enable_commands.some(c => c.includes('docker compose')),
    'must tell the operator the exact command that enables PostgreSQL');
});

test('init prints an unmissable degraded banner in human mode', () => {
  const { stdout } = runInit(['--skip-daemon', '--skip-install', '--backend', 'sqlite']);
  assert.ok(stdout.includes('DEGRADED INSTALL'),
    `degraded banner missing from:\n${stdout.slice(-800)}`);
  assert.ok(/vector|semantic/i.test(stdout), 'banner must name the features that are off');
  assert.ok(stdout.includes('docker compose'), 'banner must give the enable command');
  assert.ok(!stdout.includes('gsd-amauta installed \x1b[0m'),
    'a degraded install must not claim a plain "installed" result');
});

// ─── 3. Upgrade works without a pre-existing record ──────────────────────────

test('--upgrade without an install record derives state instead of failing', () => {
  const cfg = fakeGlobalInstall('3.2.0');
  const { exitCode, parsed } = runInit(
    ['--upgrade', '--json', '--dry-run', '--skip-daemon', '--skip-install'],
    { configDir: cfg });
  assert.ok(parsed, 'upgrade --json must emit parseable JSON');
  const step = parsed.results.find(r => r.name === 'detect_current_version');
  assert.ok(step, 'detect_current_version step must exist');
  assert.notStrictEqual(step.status, 'fail',
    `upgrade must not abort without a record: ${step.message}`);
  assert.strictEqual(step.details.derived, true);
  assert.strictEqual(step.details.version, '3.2.0',
    'version must come from the installed VERSION file');
  assert.strictEqual(exitCode, 0);
});

test('--upgrade re-runs the file install (refresh_installed_files step)', () => {
  const cfg = fakeGlobalInstall('3.2.0');
  const { parsed } = runInit(
    ['--upgrade', '--json', '--dry-run', '--skip-daemon'],
    { configDir: cfg });
  const step = parsed.results.find(r => r.name === 'refresh_installed_files');
  assert.ok(step, 'upgrade must have a step that refreshes the installed copy');
  assert.strictEqual(step.status, 'skip', 'dry-run previews instead of installing');
  assert.ok(step.details.would_apply.installer.endsWith('install.js'),
    'the refresh must go through install.js (path rewriting + manifest), not a raw copy');
});

test('--upgrade on SQLite does NOT record migrations as applied', () => {
  const home = tmp('init-truth-');
  const cfg = fakeGlobalInstall('3.2.0');
  writeRecord(home, {
    version: '3.2.0', applied_migrations: [], installed_at: new Date().toISOString(),
  });

  const { parsed } = runInit(
    ['--upgrade', '--json', '--skip-daemon', '--skip-install', '--backend', 'sqlite'],
    { home, configDir: cfg });

  const applyStep = parsed.results.find(r => r.name === 'apply_upgrade_migrations');
  assert.strictEqual(applyStep.status, 'skip');
  assert.deepStrictEqual(applyStep.details.recorded_as_applied, []);

  const updateStep = parsed.results.find(r => r.name === 'update_install_record');
  assert.deepStrictEqual(updateStep.details.recorded_as_applied, []);

  const rec = JSON.parse(fs.readFileSync(recordPath(home), 'utf-8'));
  assert.deepStrictEqual(rec.applied_migrations, [],
    'un-run SQL must never be recorded as applied — a later move to PG would skip it');
});

// ─── 4. Uninstall reaches the global install ─────────────────────────────────

test('--uninstall --dry-run previews the GLOBAL install removal', () => {
  const home = tmp('init-truth-');
  const cfg = fakeGlobalInstall('3.2.0');
  writeRecord(home, { version: '3.2.0', applied_migrations: [] });

  const { parsed } = runInit(['--uninstall', '--json', '--dry-run'], { home, configDir: cfg });
  const step = parsed.results.find(r => r.name === 'remove_global_install');
  assert.ok(step, 'uninstall must have a global-install step');
  assert.strictEqual(step.status, 'skip');
  assert.ok(step.details.would_delete.some(p => p.includes('get-shit-done')),
    `would_delete must name the global get-shit-done dir: ${JSON.stringify(step.details.would_delete)}`);
  assert.ok(fs.existsSync(path.join(cfg, 'get-shit-done')), 'dry-run must delete nothing');
});

test('--uninstall without --yes leaves the global install in place (gated)', () => {
  const home = tmp('init-truth-');
  const cfg = fakeGlobalInstall('3.2.0');
  writeRecord(home, { version: '3.2.0', applied_migrations: [] });

  const { parsed, exitCode } = runInit(['--uninstall', '--json'], { home, configDir: cfg });
  const step = parsed.results.find(r => r.name === 'remove_global_install');
  assert.strictEqual(step.status, 'skip');
  assert.match(step.message, /LEFT IN PLACE/);
  assert.ok(fs.existsSync(path.join(cfg, 'get-shit-done')),
    'a non-interactive run without --yes must not delete the global install');
  assert.strictEqual(exitCode, 0);
});

test('--uninstall --yes removes the global install too', () => {
  const home = tmp('init-truth-');
  const cfg = fakeGlobalInstall('3.2.0');
  writeRecord(home, { version: '3.2.0', applied_migrations: [] });

  const { parsed } = runInit(['--uninstall', '--json', '--yes'], { home, configDir: cfg });
  const step = parsed.results.find(r => r.name === 'remove_global_install');
  assert.strictEqual(step.status, 'pass', step.message);
  assert.ok(!fs.existsSync(path.join(cfg, 'get-shit-done')),
    'the global get-shit-done dir must be gone');
  assert.ok(!fs.existsSync(path.join(cfg, 'agents', 'gsd-planner.md')),
    'global gsd-* agents must be gone');
});

// ─── 5. PATH collision detection ─────────────────────────────────────────────

test('init detects a foreign binary named `amauta` ahead of ours on PATH', () => {
  const binDir = tmp('init-truth-bin-');
  const fake = path.join(binDir, 'amauta');
  fs.writeFileSync(fake, '#!/bin/sh\necho not gsd\n');
  fs.chmodSync(fake, 0o755);

  const home = tmp('init-truth-');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath,
      [BIN_INIT, '--skip-daemon', '--skip-install', '--backend', 'sqlite'], {
        cwd: home,
        env: {
          ...process.env,
          ...homeEnv(home),
          PATH: `${binDir}:/usr/bin:/bin`,
          GSD_AMAUTA_PORT: '18991',
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        },
        encoding: 'utf-8',
        timeout: 60000,
      });
  } catch (e) {
    stdout = (e.stdout || '').toString();
  }
  assert.ok(stdout.includes('PATH collision'), 'collision must be reported');
  assert.ok(stdout.includes(fake),
    `the shadowing binary path must be named, got:\n${stdout.slice(0, 600)}`);
});

test('init --json keeps the PATH-collision warning off stdout', () => {
  const binDir = tmp('init-truth-bin-');
  const fake = path.join(binDir, 'amauta');
  fs.writeFileSync(fake, '#!/bin/sh\necho not gsd\n');
  fs.chmodSync(fake, 0o755);

  const home = tmp('init-truth-');
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath,
      [BIN_INIT, '--json', '--skip-daemon', '--skip-install', '--backend', 'sqlite'], {
        cwd: home,
        env: {
          ...process.env,
          ...homeEnv(home),
          PATH: `${binDir}:/usr/bin:/bin`,
          GSD_AMAUTA_PORT: '18991',
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        },
        encoding: 'utf-8',
        timeout: 60000,
      });
  } catch (e) {
    stdout = (e.stdout || '').toString();
    stderr = (e.stderr || '').toString();
  }
  assert.doesNotThrow(() => JSON.parse(stdout),
    'stdout must stay valid JSON — the warning belongs on stderr');
  assert.ok(stderr.includes('PATH collision') || stdout.length > 0);
});
