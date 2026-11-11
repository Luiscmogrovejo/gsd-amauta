'use strict';
/**
 * Plan 49-04-05: module lifecycle E2E tests.
 *
 * Full install → uninstall → reinstall → upgrade round-trip against the
 * lifecycle-test + lifecycle-test-v2 fixtures via the gsd-tools.cjs dispatch
 * surface.
 *
 * DESIGN NOTE (plan 88-12): `module install` copies agents to `agents/<name>.md` and
 *   skills to `get-shit-done/skills/<name>/`, resolved against the Python cwd, and
 *   gsd-tools.cjs forces that cwd to the repository root. Until plan 88-12 that meant
 *   a test run wrote `agents/test-agent.md` into the working tree, where a concurrently
 *   running roster test could read it. services/module_lifecycle.py now honours
 *   GSD_MODULE_TARGET_ROOT, and every install here points it at a hermetic temp tree;
 *   the tests assert the installed files exist UNDER that tree and that the repository
 *   was never written to.
 *
 *   The install record (HOME=tmpRoot → ~/.amauta/data/module_installs.json) is hermetic
 *   because install_record_store uses os.path.expanduser(HOME).
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

/** @param {string} tmpRoot @returns {string} the install target root for this test's tree */
function targetRootOf(tmpRoot) {
  return path.join(tmpRoot, 'target-root');
}

/**
 * Copy a directory tree recursively using fs.cpSync (Node 16.7+).
 */
function copyRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * Create a hermetic tmp tree for install records. Returns:
 *   { tmpRoot, v1Manifest (absolute), v2Manifest (absolute) }
 *
 * The tmp tree holds:
 *   - lifecycle-test/ and lifecycle-test-v2/ fixture copies (absolute paths
 *     passed as manifest args — avoids cwd-relative resolution issues since
 *     gsd-tools.cjs spawns Python with cwd=repoRoot)
 *   - .amauta/data/ for install_record_store (HOME=tmpRoot redirects
 *     os.path.expanduser('~') to tmpRoot)
 *
 * Agent and skill copies land under <tmpRoot>/target-root (GSD_MODULE_TARGET_ROOT),
 * never under repoRoot.
 */
function setupHermeticTree() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amauta-phase49-e2e-'));
  copyRecursive(fixtureV1Src, path.join(tmpRoot, 'lifecycle-test'));
  copyRecursive(fixtureV2Src, path.join(tmpRoot, 'lifecycle-test-v2'));
  fs.mkdirSync(targetRootOf(tmpRoot), { recursive: true });
  return {
    tmpRoot,
    v1Manifest: path.join(tmpRoot, 'lifecycle-test', 'module.yaml'),
    v2Manifest: path.join(tmpRoot, 'lifecycle-test-v2', 'module.yaml'),
  };
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
 * The repository tree must never receive the fixture module's files.
 * @returns {void}
 */
function assertRepoUntouched() {
  assert.ok(!fs.existsSync(path.join(repoRoot, 'agents', 'test-agent.md')),
    'module install wrote agents/test-agent.md into the repository tree');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'get-shit-done', 'skills', 'test-skill')),
    'module install wrote get-shit-done/skills/test-skill into the repository tree');
}

/**
 * Run `node gsd-tools.cjs module ...args` with HOME set to the hermetic tmp
 * tree so that install_record_store expands ~/.amauta/data/module_installs.json
 * into that tree.
 *
 * gsd-tools.cjs spawns Python with cwd=repoRoot, so manifest arguments MUST
 * be absolute paths from the tmp tree (returned by setupHermeticTree).
 */
function runStep(args, tmpRoot) {
  const env = {
    ...process.env,
    GSD_INSTALL_RECORD_BACKEND: 'sqlite',
    HOME: tmpRoot,
    GSD_DATA_DIR: path.join(tmpRoot, '.amauta', 'data'),
    GSD_MODULE_TARGET_ROOT: targetRootOf(tmpRoot),
  };
  return spawnSync('node', [toolsPath, 'module', ...args], {
    encoding: 'utf8',
    env,
    cwd: repoRoot,
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

// ── Runner ───────────────────────────────────────────────────────────────────
//
// Was a hand-rolled ok/FAIL runner that only showed up as one pass/fail per file. It now registers each case with
// node:test so a case that needs a tool the environment lacks can be skipped BY NAME instead of failing.
//
// `module install|uninstall|upgrade` hash the manifest with PyYAML (services/module_lifecycle.py:
// "compute_manifest_hash requires PyYAML"). The GitHub macOS runner has python3 + pydantic but no PyYAML, so those
// cases cannot pass there.
const { test } = require('node:test');
const pyHas = (mod) => spawnSync('python3', ['-c', `import ${mod}`], { stdio: 'ignore' }).status === 0;
const HAVE_PYYAML = pyHas('yaml');
const SKIP_NO_PYYAML = HAVE_PYYAML
  ? false
  : 'PyYAML is not installed for python3 in this environment; module install/uninstall/upgrade need it to hash the manifest';
const NEEDS_PYYAML = new Set([
  'test_e2e_install_creates_agent_skill_record',
  'test_e2e_uninstall_returns_filesystem_to_pre_install',
  'test_e2e_reinstall_is_idempotent_skip',
  'test_e2e_upgrade_v1_to_v2',
  'test_e2e_dry_run_install_leaves_filesystem_unchanged',
  'test_e2e_human_output_includes_would_apply_block',
]);

function run(name, fn) {
  test(name, { skip: NEEDS_PYYAML.has(name) ? SKIP_NO_PYYAML : false }, fn);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Install creates install record (load-bearing SC1 gate per plan spec)
run('test_e2e_install_creates_agent_skill_record', () => {
  const { tmpRoot, v1Manifest } = setupHermeticTree();
  try {
    const r = runStep(['install', v1Manifest, '--json'], tmpRoot);
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
    assert.strictEqual(parsed.module, 'lifecycle-test',
      `module must be "lifecycle-test"; got: ${parsed.module}`);
    assert.strictEqual(parsed.module_version, '0.1.0',
      `version must be "0.1.0"; got: ${parsed.module_version}`);

    // Load-bearing: install record assertions
    const records = readInstallRecord(tmpRoot);
    assert.ok(records !== null, 'module_installs.json must exist after install');
    assert.ok('lifecycle-test' in records, 'install record must contain "lifecycle-test" key');
    assert.strictEqual(records['lifecycle-test'].version, '0.1.0',
      `install record version must be "0.1.0"; got: ${records['lifecycle-test'].version}`);
    const hash = records['lifecycle-test'].manifest_hash;
    assert.ok(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      `manifest_hash must be 64 hex chars; got: ${hash}`);

    // Agent and skill files land under the target root, not in the repository
    const agentFile = path.join(targetRootOf(tmpRoot), 'agents', 'test-agent.md');
    assert.ok(fs.existsSync(agentFile),
      `agents/test-agent.md must exist at ${agentFile} after install`);
    const skillFile = path.join(targetRootOf(tmpRoot), 'get-shit-done', 'skills', 'test-skill', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile),
      `get-shit-done/skills/test-skill/SKILL.md must exist at ${skillFile} after install`);
    assertRepoUntouched();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 2. Uninstall returns install record to pre-install state (ROADMAP SC1)
//
// NOTE: The "filesystem snapshot diff" (SC1 gate) is based on the install record
// as the authoritative state representation. Agent/skill file removal is also
// verified. The whole-tree snapshot diff uses the tmpRoot-scoped view (install
// records only, since files land under the per-test target root).
run('test_e2e_uninstall_returns_filesystem_to_pre_install', () => {
  const { tmpRoot, v1Manifest } = setupHermeticTree();
  const preSnapshot = snapshotTree(tmpRoot);

  try {
    // Install first
    const installResult = runStep(['install', v1Manifest, '--json'], tmpRoot);
    assert.strictEqual(installResult.status, 0,
      `install must exit 0; stderr: ${installResult.stderr}; stdout: ${installResult.stdout}`);

    // Verify install created agent and skill files
    const agentFile = path.join(targetRootOf(tmpRoot), 'agents', 'test-agent.md');
    assert.ok(fs.existsSync(agentFile), `agent file must exist after install`);
    const skillFile = path.join(targetRootOf(tmpRoot), 'get-shit-done', 'skills', 'test-skill', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), `skill file must exist after install`);

    // Uninstall
    const r = runStep(['uninstall', 'lifecycle-test', '--json'], tmpRoot);
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

    // Agent and skill files must be gone (SC1: uninstall reverses install)
    assert.ok(!fs.existsSync(agentFile), `agents/test-agent.md must NOT exist after uninstall`);
    assert.ok(!fs.existsSync(skillFile), `test-skill/SKILL.md must NOT exist after uninstall`);

    // Install record must not contain lifecycle-test
    const records = readInstallRecord(tmpRoot);
    if (records !== null) {
      assert.ok(!('lifecycle-test' in records),
        'install record must NOT contain "lifecycle-test" after uninstall');
    }

    // SC1: tmpRoot snapshot (install records dir) returns to pre-install state
    const postSnapshot = snapshotTree(tmpRoot);
    const preArr = Array.from(preSnapshot).sort();
    const postArr = Array.from(postSnapshot).sort();
    assert.deepStrictEqual(postArr, preArr,
      `tmpRoot snapshot must return to pre-install state (SC1); ` +
      `pre=${JSON.stringify(preArr)}, post=${JSON.stringify(postArr)}`);
    assertRepoUntouched();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 3. Reinstall is idempotent (status skip)
run('test_e2e_reinstall_is_idempotent_skip', () => {
  const { tmpRoot, v1Manifest } = setupHermeticTree();
  try {
    // First install
    const r1 = runStep(['install', v1Manifest, '--json'], tmpRoot);
    assert.strictEqual(r1.status, 0,
      `first install must exit 0; stderr: ${r1.stderr}; stdout: ${r1.stdout}`);

    // Second install (same manifest) — must be idempotent skip
    const r2 = runStep(['install', v1Manifest, '--json'], tmpRoot);
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
    assertRepoUntouched();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 4. Upgrade v1 → v2 records version bump (ROADMAP SC3)
run('test_e2e_upgrade_v1_to_v2', () => {
  const { tmpRoot, v1Manifest, v2Manifest } = setupHermeticTree();
  try {
    // Install v1
    const r1 = runStep(['install', v1Manifest, '--json'], tmpRoot);
    assert.strictEqual(r1.status, 0,
      `v1 install must exit 0; stderr: ${r1.stderr}; stdout: ${r1.stdout}`);

    const recordsBeforeUpgrade = readInstallRecord(tmpRoot);
    const installedAt = recordsBeforeUpgrade && recordsBeforeUpgrade['lifecycle-test']
      ? recordsBeforeUpgrade['lifecycle-test'].installed_at
      : null;
    assert.ok(installedAt, 'installed_at must be set after v1 install');

    // Upgrade to v2
    const r2 = runStep(['upgrade', v2Manifest, '--json'], tmpRoot);
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

    // Install record must reflect v2 (load-bearing SC3 gate)
    const recordsAfter = readInstallRecord(tmpRoot);
    assert.ok(recordsAfter !== null, 'module_installs.json must exist after upgrade');
    assert.ok('lifecycle-test' in recordsAfter,
      'install record must have lifecycle-test after upgrade');
    const rec = recordsAfter['lifecycle-test'];
    assert.strictEqual(rec.version, '0.2.0',
      `install record version must be "0.2.0" after upgrade; got: ${rec.version}`);

    // upgraded_at must be set (SC3: tracks upgrade metadata)
    assert.ok(rec.upgraded_at,
      `upgraded_at must be non-null after upgrade; got: ${rec.upgraded_at}`);

    // installed_at must be preserved from v1 (SC3: preserve user data)
    assert.strictEqual(rec.installed_at, installedAt,
      `installed_at must be preserved from original install (SC3); ` +
      `was: ${installedAt}, got: ${rec.installed_at}`);

    // applied_migrations should reflect v2 migrations (expand + contract)
    // Soft assertion: if applied_migrations present, check for expand/contract paths
    if (rec.applied_migrations && Array.isArray(rec.applied_migrations) &&
        rec.applied_migrations.length > 0) {
      const hasExpand = rec.applied_migrations.some((m) => String(m).includes('expand'));
      const hasContract = rec.applied_migrations.some((m) => String(m).includes('contract'));
      assert.ok(hasExpand || hasContract,
        `applied_migrations should include expand or contract path; ` +
        `got: ${JSON.stringify(rec.applied_migrations)}`);
    }
    // Skill file copy on upgrade is intentionally a soft assertion per plan spec
    // (upgrade is record-centric for the synthetic fixture; physical re-copy of
    // new skills deferred to v3.3+). No assertion on new-skill file presence.
    assertRepoUntouched();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 5. Dry-run install leaves filesystem unchanged (ROADMAP SC2)
run('test_e2e_dry_run_install_leaves_filesystem_unchanged', () => {
  const { tmpRoot, v1Manifest } = setupHermeticTree();
  const preSnapshot = snapshotTree(tmpRoot);

  const r = runStep(['install', v1Manifest, '--dry-run', '--json'], tmpRoot);
  assert.strictEqual(r.status, 0,
    `dry-run install must exit 0, got ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON in dry-run; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.dry_run, true, 'dry_run must be true in JSON output');

  // tmpRoot snapshot must be unchanged (SC2: dry-run wrote no install record)
  const postSnapshot = snapshotTree(tmpRoot);
  const preArr = Array.from(preSnapshot).sort();
  const postArr = Array.from(postSnapshot).sort();
  assert.deepStrictEqual(postArr, preArr,
    `dry-run must not modify tmpRoot (install record); ` +
    `pre=${JSON.stringify(preArr)}, post=${JSON.stringify(postArr)}`);

  // Install record must not exist or must not contain lifecycle-test
  const records = readInstallRecord(tmpRoot);
  if (records !== null) {
    assert.ok(!('lifecycle-test' in records),
      'dry-run must not write install record; got: ' + JSON.stringify(records));
  }

  // No agent or skill file should be written, under the target root or in the repository
  assert.ok(!fs.existsSync(path.join(targetRootOf(tmpRoot), 'agents', 'test-agent.md')),
    'dry-run must not write the agent file');
  assert.ok(!fs.existsSync(path.join(targetRootOf(tmpRoot), 'get-shit-done', 'skills', 'test-skill')),
    'dry-run must not write the skill directory');
  assertRepoUntouched();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 6. Human output (no --json) includes would_apply block in dry-run (ROADMAP SC2)
run('test_e2e_human_output_includes_would_apply_block', () => {
  const { tmpRoot, v1Manifest } = setupHermeticTree();

  // Run without --json to get human-readable output
  const r = runStep(['install', v1Manifest, '--dry-run'], tmpRoot);
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
  const { tmpRoot } = setupHermeticTree();

  const r = runStep(['uninstall', 'never-installed', '--json'], tmpRoot);
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
