'use strict';
/**
 * Plan 53-02-04: init.cjs --upgrade and --uninstall integration tests
 * File: tests/init-upgrade-uninstall.test.cjs
 *
 * Requirements covered:
 *   POLISH-02: --upgrade and --uninstall flag handlers with 12 frozen step names
 *
 * Tests (≥8):
 *   1. --upgrade and --uninstall are mutually exclusive
 *   2. --upgrade --json --dry-run emits 6 frozen upgrade step names
 *   3. --upgrade idempotent: re-run when all migrations applied → compute_migration_delta skip
 *   4. --upgrade applies new migrations when delta non-empty (dry-run preview)
 *   5. --uninstall --json --dry-run emits 6 frozen uninstall step names + would_delete arrays
 *   6. --uninstall preserves .planning/ and tests/ (preservation contract)
 *   7. --uninstall idempotent: no install record → all steps skip
 *   8. Phase 44 7-step install flow regression test
 *
 * Run: node --test tests/init-upgrade-uninstall.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const BIN_INIT = path.join(ROOT, 'bin', 'init.cjs');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

// ─── FROZEN step names ────────────────────────────────────────────────────────

// Upgrade (6): FROZEN per 53-CONTEXT.md §Area 2
const FROZEN_UPGRADE_STEPS = [
  'detect_current_version',
  'compute_migration_delta',
  'apply_upgrade_migrations',
  'update_install_record',
  'restart_daemon',
  'run_assertions',
];

// Uninstall (6): FROZEN per 53-CONTEXT.md §Area 2
const FROZEN_UNINSTALL_STEPS = [
  'read_install_record',
  'remove_skills',
  'remove_agents',
  'remove_generated_config',
  'clear_install_record',
  'post_uninstall_verify',
];

// Phase 44 install (7): regression regression guard
const FROZEN_INSTALL_STEPS = [
  'detect_ides',
  'install_skills',
  'detect_infra',
  'migrations',
  'start_daemon',
  'verify',
  'run_assertions',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run bin/init.cjs with given args in an isolated tmpDir.
 *
 * @param {string[]} args           — CLI arguments
 * @param {object}   [opts]
 * @param {string}   [opts.home]    — HOME override (defaults to tmpDir)
 * @param {string}   [opts.cwd]     — working dir (defaults to tmpDir)
 * @param {string}   [opts.tmpDir]  — use existing tmpDir (skip creation)
 * @param {boolean}  [opts.keepTmp] — do not clean up tmpDir
 * @returns {{ tmpDir, stdout, stderr, exitCode, parsed }}
 */
function runInit(args, opts) {
  opts = opts || {};
  const tmpDir = opts.tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'init-uu-'));
  const home = opts.home || tmpDir;
  const cwd = opts.cwd || tmpDir;

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [BIN_INIT, ...args], {
      cwd,
      env: { ...process.env, HOME: home, AMAUTA_DATA_DIR: path.join(tmpDir, 'data') },
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch (e) {
    stdout = (e.stdout || '').toString();
    stderr = (e.stderr || '').toString();
    exitCode = e.status || 1;
  }

  // Find first '{' or '[' to skip any non-JSON preamble
  const idx = stdout.search(/[{[]/);
  let parsed = null;
  if (idx >= 0) {
    try {
      parsed = JSON.parse(stdout.slice(idx));
    } catch (_e) { /* JSON parse error — parsed stays null */ }
  }

  if (!opts.keepTmp) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  return { tmpDir, stdout, stderr, exitCode, parsed };
}

/**
 * Write a mock install record JSON to tmpDir/.amauta/data/install_record.json.
 *
 * @param {string}   home              — HOME dir for the test
 * @param {string[]} appliedMigrations — list of migration filenames already applied
 * @param {string}   [version]         — version string (default '3.1.0')
 */
function makeInstallRecord(home, appliedMigrations, version) {
  const dir = path.join(home, '.amauta', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    version: version || '3.1.0',
    applied_migrations: appliedMigrations || [],
    installed_at: new Date().toISOString(),
    upgraded_at: null,
  };
  fs.writeFileSync(
    path.join(dir, 'install_record.json'),
    JSON.stringify(record, null, 2),
    'utf-8'
  );
}

/**
 * Get sorted list of all non-DOWN migration basenames from MIGRATIONS_DIR.
 */
function getAllMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes('DOWN'))
    .sort();
}

// ─── Test 1: mutual exclusion ─────────────────────────────────────────────────

test('--upgrade and --uninstall are mutually exclusive', () => {
  const { exitCode, stderr, stdout } = runInit(['--upgrade', '--uninstall', '--json']);
  assert.strictEqual(exitCode, 1,
    `Expected exit code 1 for mutually exclusive flags, got ${exitCode}`);
  const combined = (stderr || '') + (stdout || '');
  assert.ok(
    combined.toLowerCase().includes('mutually exclusive'),
    `Expected stderr/stdout to contain "mutually exclusive", got: ${combined.slice(0, 200)}`
  );
});

// ─── Test 2: --upgrade --json --dry-run emits 6 frozen step names ─────────────

test('--upgrade --json --dry-run emits 6 frozen upgrade step names', () => {
  const { exitCode, parsed } = runInit([
    '--upgrade', '--json', '--dry-run', '--skip-daemon',
  ]);
  assert.strictEqual(exitCode, 0,
    `Expected exit code 0, got ${exitCode}. results: ${JSON.stringify(parsed && parsed.results ? parsed.results.map(r => ({ name: r.name, status: r.status })) : null)}`);
  assert.ok(parsed !== null && parsed.results, 'Expected valid JSON with results array');
  assert.ok(Array.isArray(parsed.results), 'results must be an array');

  const names = parsed.results.map(r => r.name);
  assert.deepStrictEqual(names, FROZEN_UPGRADE_STEPS,
    `Upgrade step names mismatch.\nExpected: ${JSON.stringify(FROZEN_UPGRADE_STEPS)}\nGot:      ${JSON.stringify(names)}`);

  // Each step has the FROZEN 5-field schema
  for (const step of parsed.results) {
    const keys = Object.keys(step).sort();
    assert.deepStrictEqual(keys, ['details', 'duration_ms', 'message', 'name', 'status'],
      `Step '${step.name}' has wrong schema keys: ${JSON.stringify(keys)}`);
    assert.ok(['pass', 'fail', 'skip', 'warn'].includes(step.status),
      `Step '${step.name}' has invalid status: '${step.status}'`);
  }
});

// ─── Test 3: --upgrade idempotent (all migrations applied) ───────────────────

test('--upgrade idempotent: all migrations applied → compute_migration_delta = skip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-uu-'));
  try {
    // Write install record with ALL migrations applied
    makeInstallRecord(tmpDir, getAllMigrations(), '3.1.0');

    const { exitCode, parsed } = runInit(
      ['--upgrade', '--json', '--skip-daemon'],
      { home: tmpDir, cwd: tmpDir, tmpDir, keepTmp: true }
    );

    assert.strictEqual(exitCode, 0,
      `Expected exit code 0 for idempotent upgrade, got ${exitCode}`);
    assert.ok(parsed !== null && parsed.results, 'Expected valid JSON');

    const deltaStep = parsed.results.find(r => r.name === 'compute_migration_delta');
    assert.ok(deltaStep, 'compute_migration_delta step must exist');
    assert.strictEqual(deltaStep.status, 'skip',
      `compute_migration_delta should be 'skip' when no delta, got '${deltaStep.status}': ${deltaStep.message}`);

    // All state-modifying steps after compute_migration_delta should also be skip
    const stateModifyingNames = ['apply_upgrade_migrations', 'update_install_record', 'restart_daemon'];
    for (const name of stateModifyingNames) {
      const step = parsed.results.find(r => r.name === name);
      assert.ok(step, `${name} step must exist`);
      assert.strictEqual(step.status, 'skip',
        `${name} should be 'skip' after idempotent detection, got '${step.status}'`);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─── Test 4: --upgrade applies new migrations when delta non-empty ────────────

test('--upgrade with delta: apply_upgrade_migrations shows would_apply in dry-run', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-uu-'));
  try {
    const allMigrations = getAllMigrations();
    // Apply only first 5 (or 0 if fewer exist) → rest are delta
    const appliedSome = allMigrations.slice(0, 5);
    makeInstallRecord(tmpDir, appliedSome, '3.0.0');

    const { exitCode, parsed } = runInit(
      ['--upgrade', '--json', '--dry-run', '--skip-daemon'],
      { home: tmpDir, cwd: tmpDir, tmpDir, keepTmp: true }
    );

    assert.strictEqual(exitCode, 0,
      `Expected exit code 0 for upgrade dry-run, got ${exitCode}`);
    assert.ok(parsed !== null && parsed.results, 'Expected valid JSON');

    const deltaStep = parsed.results.find(r => r.name === 'compute_migration_delta');
    assert.ok(deltaStep, 'compute_migration_delta step must exist');

    if (allMigrations.length > 5) {
      // There should be a non-empty delta
      assert.strictEqual(deltaStep.status, 'pass',
        `compute_migration_delta should be 'pass' when delta non-empty, got '${deltaStep.status}'`);
      assert.ok(
        deltaStep.details && deltaStep.details.delta_count > 0,
        `delta_count must be > 0, got: ${JSON.stringify(deltaStep.details)}`
      );

      // apply_upgrade_migrations should be skip (dry-run) with would_apply list
      const applyStep = parsed.results.find(r => r.name === 'apply_upgrade_migrations');
      assert.ok(applyStep, 'apply_upgrade_migrations step must exist');
      assert.strictEqual(applyStep.status, 'skip',
        `apply_upgrade_migrations should be 'skip' in dry-run, got '${applyStep.status}'`);
      assert.ok(
        applyStep.details && Array.isArray(applyStep.details.would_apply),
        `apply_upgrade_migrations.details.would_apply must be an array in dry-run`
      );
      assert.ok(applyStep.details.would_apply.length > 0,
        'would_apply list must be non-empty when delta is non-empty');
    }
    // (If somehow all migrations are already the first 5, skip length assertions)
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─── Test 5: --uninstall --json --dry-run emits 6 step names + would_delete ───

test('--uninstall --json --dry-run emits 6 frozen step names + would_delete arrays', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-uu-'));
  try {
    // Write install record so we get the real flow (not absent → all-skip)
    makeInstallRecord(tmpDir, [], '3.1.0');

    const { exitCode, parsed } = runInit(
      ['--uninstall', '--json', '--dry-run'],
      { home: tmpDir, cwd: tmpDir, tmpDir, keepTmp: true }
    );

    assert.strictEqual(exitCode, 0,
      `Expected exit code 0, got ${exitCode}`);
    assert.ok(parsed !== null && parsed.results, 'Expected valid JSON with results');
    assert.ok(Array.isArray(parsed.results), 'results must be an array');

    const names = parsed.results.map(r => r.name);
    assert.deepStrictEqual(names, FROZEN_UNINSTALL_STEPS,
      `Uninstall step names mismatch.\nExpected: ${JSON.stringify(FROZEN_UNINSTALL_STEPS)}\nGot:      ${JSON.stringify(names)}`);

    // At least one step has would_delete in details
    const stepsWithWouldDelete = parsed.results.filter(r =>
      r.details && Array.isArray(r.details.would_delete)
    );
    assert.ok(stepsWithWouldDelete.length >= 1,
      `Expected at least 1 step with would_delete array, found ${stepsWithWouldDelete.length}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─── Test 6: preservation contract — .planning/ and tests/ NOT in would_delete ─

test('--uninstall preserves .planning/ and tests/ (preservation contract)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-uu-'));
  try {
    makeInstallRecord(tmpDir, [], '3.1.0');

    const { parsed } = runInit(
      ['--uninstall', '--json', '--dry-run'],
      { home: tmpDir, cwd: tmpDir, tmpDir, keepTmp: true }
    );

    assert.ok(parsed !== null && parsed.results, 'Expected valid JSON with results');

    // Collect ALL would_delete paths across all steps
    const allWouldDelete = [];
    for (const step of parsed.results) {
      const wd = (step.details || {}).would_delete;
      if (Array.isArray(wd)) {
        allWouldDelete.push(...wd);
      } else if (typeof wd === 'string') {
        allWouldDelete.push(wd);
      }
    }

    // PRESERVATION CONTRACT: none of the preserved paths should appear in would_delete
    const forbiddenPatterns = [
      // Path separators on both sides ensure we match directory segments, not just substrings
      `${path.sep}.planning${path.sep}`,
      `${path.sep}.planning"`,   // trailing quote in JSON
      `${path.sep}tests${path.sep}`,
      `${path.sep}tests"`,
      `${path.sep}services${path.sep}`,
      `${path.sep}migrations${path.sep}`,
    ];

    const violations = allWouldDelete.filter(p => {
      const normalised = String(p).replace(/\\/g, '/');
      return (
        normalised.includes('/.planning/') ||
        normalised.includes('/.planning"') ||
        normalised.endsWith('/.planning') ||
        normalised.includes('/tests/') ||
        (normalised.includes('/tests') && !normalised.includes('init-uu-')) ||
        normalised.includes('/services/') ||
        normalised.includes('/migrations/')
      );
    });

    assert.strictEqual(violations.length, 0,
      `PRESERVATION CONTRACT VIOLATED: found ${violations.length} forbidden path(s) in would_delete:\n${violations.join('\n')}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─── Test 7: --uninstall idempotent (no install record) ───────────────────────

test('--uninstall idempotent: no install record → all 6 steps skip, exit 0', () => {
  const { exitCode, parsed } = runInit(['--uninstall', '--json']);

  assert.strictEqual(exitCode, 0,
    `Expected exit code 0 when no install record, got ${exitCode}`);
  assert.ok(parsed !== null && parsed.results, 'Expected valid JSON with results');

  const names = parsed.results.map(r => r.name);
  assert.deepStrictEqual(names, FROZEN_UNINSTALL_STEPS,
    `Expected all 6 uninstall steps, got: ${JSON.stringify(names)}`);

  for (const step of parsed.results) {
    assert.strictEqual(step.status, 'skip',
      `Expected all steps to be 'skip' when no install record, '${step.name}' = '${step.status}'`);
  }
});

// ─── Test 8: Phase 44 7-step install flow regression ──────────────────────────

test('Phase 44 7-step install flow still works (regression)', () => {
  const { exitCode, parsed } = runInit([
    '--json', '--skip-daemon', '--skip-install', '--backend', 'sqlite',
  ]);

  assert.strictEqual(exitCode, 0,
    `Expected exit code 0 in skills-only smoke, got ${exitCode}`);
  assert.ok(parsed !== null && parsed.results, 'Expected valid JSON with results');

  const names = parsed.results.map(r => r.name);
  assert.deepStrictEqual(names, FROZEN_INSTALL_STEPS,
    `Phase 44 step names regression.\nExpected: ${JSON.stringify(FROZEN_INSTALL_STEPS)}\nGot:      ${JSON.stringify(names)}`);

  // Each step has the FROZEN 5-field schema
  for (const step of parsed.results) {
    const keys = Object.keys(step).sort();
    assert.deepStrictEqual(keys, ['details', 'duration_ms', 'message', 'name', 'status'],
      `Phase 44 step '${step.name}' has wrong schema: ${JSON.stringify(keys)}`);
  }

  // Expected Phase 44 skips
  const installSkills = parsed.results.find(r => r.name === 'install_skills');
  const startDaemon = parsed.results.find(r => r.name === 'start_daemon');
  const verify = parsed.results.find(r => r.name === 'verify');

  assert.strictEqual(installSkills.status, 'skip',
    `install_skills must be 'skip' with --skip-install, got '${installSkills.status}'`);
  assert.strictEqual(startDaemon.status, 'skip',
    `start_daemon must be 'skip' with --skip-daemon, got '${startDaemon.status}'`);
  assert.strictEqual(verify.status, 'skip',
    `verify must be 'skip' with daemon skipped, got '${verify.status}'`);
});
