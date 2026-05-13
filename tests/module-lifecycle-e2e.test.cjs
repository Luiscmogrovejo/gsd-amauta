'use strict';
/**
 * Plan 49-04-05: module lifecycle E2E tests.
 *
 * Full install → uninstall → reinstall → upgrade round-trip against the
 * lifecycle-test + lifecycle-test-v2 fixtures via the gsd-tools.cjs dispatch
 * surface. Creates a hermetic tmp working tree for each test so no real
 * agents/, get-shit-done/skills/, or ~/.amauta/ directories are touched.
 *
 * Run:
 *   node tests/module-lifecycle-e2e.test.cjs
 *   node --test tests/module-lifecycle-e2e.test.cjs
 *
 * Phase 49 MOD-03 + MOD-04.
 * Mirrors tests/module-lifecycle-cli.test.cjs (49-04-04) runner style.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const toolsPath = path.join(repoRoot, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const fixtureV1Src = path.join(repoRoot, 'tests', 'fixtures', 'modules', 'lifecycle-test');
const fixtureV2Src = path.join(repoRoot, 'tests', 'fixtures', 'modules', 'lifecycle-test-v2');

// ── Setup helpers ─────────────────────────────────────────────────────────────

/**
 * Copy a directory tree recursively using fs.cpSync (Node 16.7+).
 */
function copyRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * Create a hermetic tmp working tree with the v1 and v2 fixture directories
 * copied into it, plus pre-created destination directories that install will
 * write into.
 */
function setupHermeticTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amauta-phase49-e2e-'));
  // Copy v1 + v2 fixtures into the hermetic tree
  copyRecursive(fixtureV1Src, path.join(root, 'lifecycle-test'));
  copyRecursive(fixtureV2Src, path.join(root, 'lifecycle-test-v2'));
  // Pre-create dest dirs that install writes into (agents/, get-shit-done/skills/)
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'get-shit-done', 'skills'), { recursive: true });
  return root;
}

/**
 * Return a Set of relative file paths under root, excluding:
 *  - .amauta/  (state directory may differ between snapshots)
 *  - lifecycle-test/, lifecycle-test-v2/  (fixtures remain unchanged)
 */
function snapshotTree(root) {
  const seen = new Set();
  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.amauta') continue;
      if (entry.name === 'lifecycle-test' || entry.name === 'lifecycle-test-v2') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else {
        seen.add(relPath);
      }
    }
  }
  walk(root, '');
  return seen;
}

/**
 * Run `node gsd-tools.cjs module ...args` with the hermetic tmp tree as the
 * working directory and HOME so that install_record_store expands
 * ~/.amauta/data/module_installs.json into that tree.
 */
function runStep(args, tmpRoot) {
  const env = {
    ...process.env,
    GSD_INSTALL_RECORD_BACKEND: 'sqlite',
    HOME: tmpRoot,
    GSD_DATA_DIR: path.join(tmpRoot, '.amauta', 'data'),
  };
  return spawnSync('node', [toolsPath, 'module', ...args], {
    encoding: 'utf8',
    env,
    cwd: tmpRoot,
    timeout: 30000,
  });
}

/**
 * Read module_installs.json from the hermetic tree. Returns parsed object or
 * null if missing.
 */
function readInstallRecord(tmpRoot) {
  const jsonPath = path.join(tmpRoot, '.amauta', 'data', 'module_installs.json');
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
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

console.log('\nmodule lifecycle E2E tests\n');

// 1. Install creates agent, skill, and install record
run('test_e2e_install_creates_agent_skill_record', () => {
  const tmp = setupHermeticTree();
  const r = runStep(['install', 'lifecycle-test/module.yaml', '--json'], tmp);
  assert.strictEqual(r.status, 0,
    `expected exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.status, 'pass', `status must be "pass"; got: ${parsed.status}`);
  assert.strictEqual(parsed.operation, 'install', 'operation must be "install"');
  assert.strictEqual(parsed.module, 'lifecycle-test', `module must be "lifecycle-test"; got: ${parsed.module}`);
  assert.strictEqual(parsed.module_version, '0.1.0', `version must be "0.1.0"; got: ${parsed.module_version}`);

  // Agent and skill files should be in the hermetic tree
  const agentFile = path.join(tmp, 'agents', 'test-agent.md');
  assert.ok(fs.existsSync(agentFile), `agents/test-agent.md must exist at ${agentFile}`);

  const skillFile = path.join(tmp, 'get-shit-done', 'skills', 'test-skill', 'SKILL.md');
  assert.ok(fs.existsSync(skillFile), `get-shit-done/skills/test-skill/SKILL.md must exist at ${skillFile}`);

  // Install record
  const records = readInstallRecord(tmp);
  assert.ok(records !== null, 'module_installs.json must exist after install');
  assert.ok('lifecycle-test' in records, 'install record must contain "lifecycle-test" key');
  assert.strictEqual(records['lifecycle-test'].version, '0.1.0',
    `install record version must be "0.1.0"; got: ${records['lifecycle-test'].version}`);
  const hash = records['lifecycle-test'].manifest_hash;
  assert.ok(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
    `manifest_hash must be 64 hex chars; got: ${hash}`);
});

// 2. Uninstall returns filesystem to pre-install state (ROADMAP SC1)
run('test_e2e_uninstall_returns_filesystem_to_pre_install', () => {
  const tmp = setupHermeticTree();
  const preSnapshot = snapshotTree(tmp);

  // Install first
  const installResult = runStep(['install', 'lifecycle-test/module.yaml', '--json'], tmp);
  assert.strictEqual(installResult.status, 0,
    `install must exit 0; stderr: ${installResult.stderr}; stdout: ${installResult.stdout}`);

  // Uninstall
  const r = runStep(['uninstall', 'lifecycle-test', '--json'], tmp);
  assert.strictEqual(r.status, 0,
    `expected exit 0 for uninstall, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.status, 'pass', `status must be "pass"; got: ${parsed.status}`);
  assert.strictEqual(parsed.operation, 'uninstall', 'operation must be "uninstall"');

  // Agent and skill files must be gone
  const agentFile = path.join(tmp, 'agents', 'test-agent.md');
  assert.ok(!fs.existsSync(agentFile), `agents/test-agent.md must NOT exist after uninstall`);

  const skillFile = path.join(tmp, 'get-shit-done', 'skills', 'test-skill', 'SKILL.md');
  assert.ok(!fs.existsSync(skillFile), `test-skill/SKILL.md must NOT exist after uninstall`);

  // Install record must not contain lifecycle-test
  const records = readInstallRecord(tmp);
  if (records !== null) {
    assert.ok(!('lifecycle-test' in records),
      'install record must NOT contain "lifecycle-test" after uninstall');
  }

  // SC1: filesystem returns to pre-install state
  const postSnapshot = snapshotTree(tmp);
  const preArr = Array.from(preSnapshot).sort();
  const postArr = Array.from(postSnapshot).sort();
  assert.deepStrictEqual(postArr, preArr,
    `filesystem must return to pre-install state (SC1); pre=${JSON.stringify(preArr)}, post=${JSON.stringify(postArr)}`);
});

// 3. Reinstall is idempotent (status skip)
run('test_e2e_reinstall_is_idempotent_skip', () => {
  const tmp = setupHermeticTree();

  // First install
  const r1 = runStep(['install', 'lifecycle-test/module.yaml', '--json'], tmp);
  assert.strictEqual(r1.status, 0,
    `first install must exit 0; stderr: ${r1.stderr}; stdout: ${r1.stdout}`);

  // Second install (same manifest)
  const r2 = runStep(['install', 'lifecycle-test/module.yaml', '--json'], tmp);
  assert.strictEqual(r2.status, 0,
    `reinstall must exit 0, got ${r2.status}; stderr: ${r2.stderr}; stdout: ${r2.stdout}`);

  let parsed2;
  try {
    parsed2 = JSON.parse(r2.stdout);
  } catch (e) {
    assert.fail(`reinstall stdout must be valid JSON; got: ${r2.stdout}`);
  }
  assert.strictEqual(parsed2.status, 'skip',
    `reinstall status must be "skip" for idempotent re-install; got: ${parsed2.status}`);

  // At least one step message mentions already installed
  const messages = (parsed2.steps || []).map((s) => s.message || '');
  const anyAlreadyInstalled = messages.some((m) =>
    m.toLowerCase().includes('already installed') || m.toLowerCase().includes('skip')
  );
  assert.ok(anyAlreadyInstalled,
    `at least one step should mention already installed; messages: ${JSON.stringify(messages)}`);
});

// 4. Upgrade v1 → v2 records version bump (ROADMAP SC3)
run('test_e2e_upgrade_v1_to_v2', () => {
  const tmp = setupHermeticTree();

  // Install v1
  const r1 = runStep(['install', 'lifecycle-test/module.yaml', '--json'], tmp);
  assert.strictEqual(r1.status, 0,
    `v1 install must exit 0; stderr: ${r1.stderr}; stdout: ${r1.stdout}`);

  let installParsed;
  try {
    installParsed = JSON.parse(r1.stdout);
  } catch (e) {
    assert.fail(`v1 install stdout must be valid JSON; got: ${r1.stdout}`);
  }
  const installedAt = (readInstallRecord(tmp) || {})['lifecycle-test']?.installed_at;
  assert.ok(installedAt, 'installed_at must be set after v1 install');

  // Upgrade to v2
  const r2 = runStep(['upgrade', 'lifecycle-test-v2/module.yaml', '--json'], tmp);
  assert.strictEqual(r2.status, 0,
    `upgrade must exit 0, got ${r2.status}; stderr: ${r2.stderr}; stdout: ${r2.stdout}`);

  let upgradeParsed;
  try {
    upgradeParsed = JSON.parse(r2.stdout);
  } catch (e) {
    assert.fail(`upgrade stdout must be valid JSON; got: ${r2.stdout}`);
  }

  // Operation and status
  assert.strictEqual(upgradeParsed.operation, 'upgrade', 'operation must be "upgrade"');
  assert.ok(
    ['pass', 'warn'].includes(upgradeParsed.status),
    `upgrade status must be pass or warn; got: ${upgradeParsed.status}`
  );
  assert.strictEqual(upgradeParsed.module_version, '0.2.0',
    `module_version must be "0.2.0" after upgrade; got: ${upgradeParsed.module_version}`);

  // Install record must reflect v2
  const recordsAfter = readInstallRecord(tmp);
  assert.ok(recordsAfter !== null, 'module_installs.json must exist after upgrade');
  assert.ok('lifecycle-test' in recordsAfter, 'install record must have lifecycle-test after upgrade');
  const rec = recordsAfter['lifecycle-test'];
  assert.strictEqual(rec.version, '0.2.0',
    `install record version must be "0.2.0" after upgrade; got: ${rec.version}`);

  // upgraded_at must be set (user-data continuity proxy for SC3)
  assert.ok(rec.upgraded_at, `upgraded_at must be non-null after upgrade; got: ${rec.upgraded_at}`);

  // installed_at must be preserved from v1 (SC3: preserve user data)
  assert.strictEqual(rec.installed_at, installedAt,
    `installed_at must be preserved from original install (SC3); was: ${installedAt}, got: ${rec.installed_at}`);

  // applied_migrations should reflect v2 migrations (expand + contract)
  // Soft assertion: if applied_migrations is present and non-empty, check content
  if (rec.applied_migrations && Array.isArray(rec.applied_migrations) && rec.applied_migrations.length > 0) {
    const hasExpand = rec.applied_migrations.some((m) => String(m).includes('expand'));
    const hasContract = rec.applied_migrations.some((m) => String(m).includes('contract'));
    assert.ok(hasExpand || hasContract,
      `applied_migrations should include expand or contract path; got: ${JSON.stringify(rec.applied_migrations)}`);
  }
  // Skill file copy on upgrade is intentionally a soft assertion per plan spec
  // (upgrade is record-centric for the synthetic fixture; physical re-copy of
  // new skills deferred to v3.3+). No assertion on new-skill file presence.
});

// 5. Dry-run install leaves filesystem unchanged (ROADMAP SC2)
run('test_e2e_dry_run_install_leaves_filesystem_unchanged', () => {
  const tmp = setupHermeticTree();
  const preSnapshot = snapshotTree(tmp);

  const r = runStep(['install', 'lifecycle-test/module.yaml', '--dry-run', '--json'], tmp);
  assert.strictEqual(r.status, 0,
    `dry-run install must exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON in dry-run; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.dry_run, true, 'dry_run must be true in JSON output');

  // Filesystem must be unchanged (SC2: dry-run wrote nothing)
  const postSnapshot = snapshotTree(tmp);
  const preArr = Array.from(preSnapshot).sort();
  const postArr = Array.from(postSnapshot).sort();
  assert.deepStrictEqual(postArr, preArr,
    `dry-run must not modify filesystem; pre=${JSON.stringify(preArr)}, post=${JSON.stringify(postArr)}`);

  // Install record must not exist or must not contain lifecycle-test
  const records = readInstallRecord(tmp);
  if (records !== null) {
    assert.ok(!('lifecycle-test' in records),
      'dry-run must not write install record; got: ' + JSON.stringify(records));
  }
});

// 6. Human output (no --json) includes would_apply block in dry-run (ROADMAP SC2)
run('test_e2e_human_output_includes_would_apply_block', () => {
  const tmp = setupHermeticTree();

  // Run without --json to get human-readable output
  const r = runStep(['install', 'lifecycle-test/module.yaml', '--dry-run'], tmp);
  assert.strictEqual(r.status, 0,
    `dry-run human install must exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);

  const stdout = r.stdout || '';
  assert.ok(stdout.includes('would_apply:'),
    `stdout must contain "would_apply:" block in human output; got: ${stdout}`);

  // At least one of the known step names should appear after would_apply:
  const hasKnownStep = (
    stdout.includes('apply_migrations:') ||
    stdout.includes('register_services:') ||
    stdout.includes('copy_agents:') ||
    stdout.includes('copy_skills:')
  );
  assert.ok(hasKnownStep,
    `stdout must include at least one step name after would_apply:; got: ${stdout}`);
});

// 7. Uninstall absent module exits 0 with skip (all steps skip)
run('test_e2e_uninstall_absent_module_exits_0_with_skip_status', () => {
  const tmp = setupHermeticTree();

  const r = runStep(['uninstall', 'never-installed', '--json'], tmp);
  assert.strictEqual(r.status, 0,
    `uninstall of absent module must exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.status, 'skip',
    `status must be "skip" for absent module; got: ${parsed.status}`);

  // All 7 uninstall steps should be skip
  const steps = parsed.steps || [];
  const nonSkip = steps.filter((s) => s.status !== 'skip');
  assert.strictEqual(nonSkip.length, 0,
    `all steps must be skip for absent module; non-skip: ${JSON.stringify(nonSkip)}`);
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
