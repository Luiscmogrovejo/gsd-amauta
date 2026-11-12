'use strict';
/**
 * Plan 48-02-02: module validate CLI integration tests.
 *
 * Tests the `gsd-tools module validate` subcommand shell layer end-to-end.
 * Exercises 7 scenarios covering usage errors, valid manifests, install_order
 * determinism, conflict detection, missing-file I/O error, --json output, and
 * unknown-action rejection.
 *
 * Run:
 *   node tests/module-validate-cli.test.cjs
 *   node --test tests/module-validate-cli.test.cjs
 *
 * Phase 48 MOD-01 + MOD-02.
 * Mirrors tests/agent-hydrate-cli.test.cjs (Phase 47) runner style.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const coreFixture = path.join(repoRoot, 'tests', 'fixtures', 'modules', 'core-1.2.0', 'module.yaml');
const featureFixture = path.join(repoRoot, 'tests', 'fixtures', 'modules', 'feature-requires-core', 'module.yaml');

function runCli(extraArgs) {
  return spawnSync('node', [cliPath, 'module', ...extraArgs], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 20000,
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────
//
// Was a hand-rolled runner that showed up as one pass/fail per file. It now registers each case with node:test so a
// case that needs a tool the environment lacks can be skipped BY NAME instead of failing.
//
// Every case runs on every environment. (Until plan 88-12 two of them were skipped by name on a machine with pydantic
// and no PyYAML, because the fallback parser in services/module_schema.py stored an indented `services:` mapping as
// `[]`; the parser now reads the mapping, so the skip is gone.)
const { test } = require('node:test');

function run(name, fn) {
  test(name, fn);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. usage exit code is 2 when no action given
run('usage exit code is 2 when no action given', () => {
  const r = runCli([]);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
  // Phase 49 extended the usage block to multi-line format:
  //   Usage:\n  gsd-tools module validate <manifest.yaml> ...
  // Match the validate usage line regardless of preceding newline.
  assert.ok(
    r.stderr.includes('gsd-tools module validate'),
    `stderr must contain usage line; got: ${r.stderr}`
  );
});

// 2. unknown action exits 2
run('unknown action exits 2', () => {
  const r = runCli(['unknown-action']);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.ok(
    r.stderr.includes('Unknown module action: unknown-action'),
    `stderr must contain Unknown module action: unknown-action; got: ${r.stderr}`
  );
});

// 3. validate with no paths exits 2
run('validate with no paths exits 2', () => {
  const r = runCli(['validate']);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.ok(
    r.stderr.includes('Usage: gsd-tools module validate'),
    `stderr must contain usage line; got: ${r.stderr}`
  );
});

// 4. validate single core fixture exits 0
run('validate single core fixture exits 0', () => {
  const r = runCli(['validate', coreFixture]);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
});

// 5. validate both fixtures exits 0 and install_order is deterministic (--json)
run('validate both fixtures exits 0 and install_order is deterministic', () => {
  const r = runCli(['validate', coreFixture, featureFixture, '--json']);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.schema_version, '1.0', 'schema_version must be "1.0"');
  assert.strictEqual(parsed.ok, true, 'ok must be true');
  assert.ok(Array.isArray(parsed.resolver.install_order), 'install_order must be an array');
  assert.strictEqual(parsed.resolver.install_order[0], 'core', `install_order[0] must be 'core'; got ${parsed.resolver.install_order[0]}`);
  assert.strictEqual(parsed.resolver.install_order[1], 'feature-requires-core', `install_order[1] must be 'feature-requires-core'; got ${parsed.resolver.install_order[1]}`);
});

// 6. validate missing file exits 2
run('validate missing file exits 2', () => {
  // A file that is guaranteed absent: a child that is never created inside a fresh mkdtemp dir.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'module-validate-missing-'));
  try {
    const r = runCli(['validate', path.join(parent, 'this-does-not-exist-48-02-02.yaml')]);
    assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}`);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// 7. validate with conflict-injected third manifest exits 1 and reports conflict
run('validate with conflict-injected third manifest exits 1 and reports conflict', () => {
  // Create a TEMP manifest requesting core ^2.0.0 (incompatible with core-1.2.0)
  const tmpDir = path.join(os.tmpdir(), 'phase-48-conflict-test');
  const conflictPath = path.join(tmpDir, 'module.yaml');

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    conflictPath,
    [
      'name: feature-wants-core-v2',
      'version: 0.1.0',
      'description: Test fixture requesting core ^2.0.0 to force a conflict.',
      'requires:',
      '  core: ^2.0.0',
      'migrations:',
      '  - migrations/000-dummy.sql',
      'services: {}',
      'agents: []',
      'skills: []',
    ].join('\n') + '\n'
  );

  let r;
  try {
    r = runCli(['validate', coreFixture, featureFixture, conflictPath, '--json']);
  } finally {
    // Clean up temp file
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }

  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);

  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
  }
  assert.strictEqual(parsed.schema_version, '1.0', 'schema_version must be "1.0" even on conflict');
  assert.strictEqual(parsed.ok, false, 'ok must be false when conflicts present');
  assert.ok(
    parsed.resolver.conflicts.length >= 1,
    `conflicts must have at least 1 entry; got ${parsed.resolver.conflicts.length}`
  );
  const hasCoreConflict = parsed.resolver.conflicts.some(
    (entry) => entry.requested_module === 'core'
  );
  assert.ok(hasCoreConflict, `at least one conflict entry must have requested_module === 'core'`);
});
