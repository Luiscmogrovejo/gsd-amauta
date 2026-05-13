'use strict';
/**
 * Plan 49-04-04: module lifecycle CLI integration tests.
 *
 * Tests the `gsd-tools module install|uninstall|upgrade` dispatch surface
 * and the `bin/cli.cjs module ...` shortcut end-to-end.
 *
 * Run:
 *   node tests/module-lifecycle-cli.test.cjs
 *   node --test tests/module-lifecycle-cli.test.cjs
 *
 * Phase 49 MOD-03 + MOD-04.
 * Mirrors tests/module-validate-cli.test.cjs (Phase 48) runner style.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const toolsPath = path.join(repoRoot, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const cliPath = path.join(repoRoot, 'bin', 'cli.cjs');
const fixtureV1 = path.join(repoRoot, 'tests', 'fixtures', 'modules', 'lifecycle-test', 'module.yaml');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amauta-phase49-'));
}

function runTools(args, { extraEnv = {} } = {}) {
  const dataDir = makeTmpDataDir();
  const env = {
    ...process.env,
    GSD_INSTALL_RECORD_BACKEND: 'sqlite',
    HOME: dataDir,
    GSD_DATA_DIR: dataDir,
    ...extraEnv,
  };
  const r = spawnSync('node', [toolsPath, 'module', ...args], {
    encoding: 'utf8',
    env,
    cwd: repoRoot,
    timeout: 30000,
  });
  return { ...r, dataDir };
}

function runCli(args, { extraEnv = {} } = {}) {
  const dataDir = makeTmpDataDir();
  const env = {
    ...process.env,
    GSD_INSTALL_RECORD_BACKEND: 'sqlite',
    HOME: dataDir,
    GSD_DATA_DIR: dataDir,
    ...extraEnv,
  };
  const r = spawnSync('node', [cliPath, 'module', ...args], {
    encoding: 'utf8',
    env,
    cwd: repoRoot,
    timeout: 30000,
  });
  return { ...r, dataDir };
}

// ── Micro runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log('  ok', name);
    passed += 1;
  } catch (err) {
    console.log('  FAIL', name + ':', err.message);
    failed += 1;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nmodule lifecycle CLI integration tests\n');

// 1. Usage error when no action given
run('test_usage_no_args_exits_2', () => {
  const r = runTools([]);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
  const combined = (r.stderr || '') + (r.stdout || '');
  assert.ok(
    combined.includes('Usage') || combined.includes('usage'),
    `output must contain usage info; got: ${combined}`
  );
  const hasActions = (
    combined.includes('install') &&
    combined.includes('uninstall') &&
    combined.includes('upgrade')
  );
  assert.ok(hasActions, `usage must list install/uninstall/upgrade; got: ${combined}`);
});

// 2. Unknown action exits 2
run('test_unknown_action_exits_2', () => {
  const r = runTools(['bogus']);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.ok(
    r.stderr.includes('Unknown module action'),
    `stderr must contain "Unknown module action"; got: ${r.stderr}`
  );
});

// 3. Phase 48 validate regression — must still work after Phase 49 extends the case block
run('test_validate_still_works_phase48_regression', () => {
  const r = runTools(['validate', fixtureV1]);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
});

// 4. Install dry-run exits 0 with would_apply in JSON output
run('test_install_dry_run_exits_0_with_would_apply', () => {
  const r = runTools(['install', fixtureV1, '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.dry_run, true, 'dry_run must be true');
  assert.ok(
    ['pass', 'skip', 'warn'].includes(parsed.status),
    `status must be pass/skip/warn in dry-run; got: ${parsed.status}`
  );
  const hasWouldApply = (parsed.steps || []).some((s) => {
    const d = s.details || {};
    return d.would_apply !== undefined;
  });
  assert.ok(hasWouldApply, 'at least one step must have details.would_apply in dry-run');
});

// 5. Install missing manifest exits 2
run('test_install_missing_manifest_exits_2', () => {
  const r = runTools(['install', '/nonexistent.yaml', '--json']);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
  const combined = (r.stdout || '') + (r.stderr || '');
  const hasErrorInfo = combined.includes('manifest not found') || combined.includes('io_error') || combined.includes('not found');
  assert.ok(hasErrorInfo, `output must mention manifest not found; got: ${combined}`);
});

// 6. Uninstall absent module exits 0 with skip
run('test_uninstall_absent_module_exits_0_skip', () => {
  const r = runTools(['uninstall', 'never-installed', '--json']);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.status, 'skip', `status must be "skip"; got: ${parsed.status}`);
});

// 7. Upgrade missing manifest exits 2
run('test_upgrade_missing_manifest_exits_2', () => {
  const r = runTools(['upgrade', '/nonexistent.yaml', '--json']);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
});

// 8. bin/cli.cjs shortcut module install dry-run exits 0
run('test_cli_cjs_shortcut_module_install_dry_run_exits_0', () => {
  const r = runCli(['install', fixtureV1, '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.dry_run, true, 'dry_run must be true through cli.cjs shortcut');
});

// 9. bin/cli.cjs module validate Phase 48 compat
run('test_cli_cjs_shortcut_module_validate_phase48_compat', () => {
  const r = runCli(['validate', fixtureV1]);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
});

// 10. Install JSON output has frozen 8 top-level keys
run('test_install_json_output_has_frozen_keys', () => {
  const r = runTools(['install', fixtureV1, '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  const FROZEN_KEYS = ['schema_version', 'operation', 'module', 'module_version',
                       'status', 'steps', 'rollback', 'dry_run'];
  const keys = Object.keys(parsed).sort();
  const expectedSorted = FROZEN_KEYS.slice().sort();
  assert.deepStrictEqual(
    keys,
    expectedSorted,
    `top-level keys must be exactly ${JSON.stringify(expectedSorted)}; got ${JSON.stringify(keys)}`
  );
  assert.strictEqual(parsed.schema_version, '1.0', 'schema_version must be "1.0"');
  assert.strictEqual(parsed.operation, 'install', 'operation must be "install"');
});

// 11. install --help subparser exits 0
run('test_install_help_subparser_exits_0', () => {
  const r = runTools(['install', '--help']);
  assert.strictEqual(r.status, 0, `expected exit 0 for --help; got ${r.status}; stderr: ${r.stderr}`);
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
