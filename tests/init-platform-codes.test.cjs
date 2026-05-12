'use strict';
/**
 * Plan 44-01-04: loadPlatformCodes() + compiler back-compat tests
 * File: tests/init-platform-codes.test.cjs
 *
 * Requirements covered:
 *   INST-02: IDE auto-detection — loadPlatformCodes() is the registry source
 *   INST-04: platform-codes.yaml schema frozen at 4 fields per IDE
 *
 * Tests scripts/skill-compiler.cjs::loadPlatformCodes() and TARGET_MAPS overrides.
 * No live DB or daemon dependency — hermetic.
 *
 * Run: node --test tests/init-platform-codes.test.cjs
 */

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const compiler = require(path.join(ROOT, 'scripts', 'skill-compiler.cjs'));
const { loadPlatformCodes, compile, TARGET_MAPS } = compiler;

// Temp dir used by test 5 for custom yaml fixture
let _customYamlPath = null;

// ── Test 1: loadPlatformCodes returns 3 IDEs from the default path ──────────

test('loadPlatformCodes returns 3 IDEs from the default path', () => {
  const m = loadPlatformCodes();
  const keys = Object.keys(m).sort();
  assert.deepStrictEqual(keys, ['claude-code', 'cursor', 'opencode'],
    `Expected exactly 3 IDE keys, got: ${JSON.stringify(keys)}`);

  // Assert each entry has exactly the 4 required fields and no extras
  const REQUIRED_FIELDS = ['cli_name', 'dir_name', 'ide_id', 'skill_subdir'];
  for (const ideId of keys) {
    const entry = m[ideId];
    const entryKeys = Object.keys(entry).sort();
    assert.deepStrictEqual(entryKeys, REQUIRED_FIELDS,
      `IDE '${ideId}' should have exactly 4 fields, got: ${JSON.stringify(entryKeys)}`);
  }
});

// ── Test 2: loadPlatformCodes claude-code values match the locked schema ─────

test('loadPlatformCodes claude-code values match the locked schema', () => {
  const m = loadPlatformCodes();
  assert.ok(m['claude-code'], 'claude-code entry should exist');
  assert.deepStrictEqual(m['claude-code'], {
    ide_id: 'claude-code',
    dir_name: '.claude',
    skill_subdir: 'skills',
    cli_name: 'claude',
  }, `claude-code values mismatch: ${JSON.stringify(m['claude-code'])}`);
});

// ── Test 3: loadPlatformCodes cursor uses rules subdir ───────────────────────

test('loadPlatformCodes cursor uses rules subdir', () => {
  const m = loadPlatformCodes();
  assert.ok(m['cursor'], 'cursor entry should exist');
  assert.strictEqual(m['cursor'].skill_subdir, 'rules',
    `cursor.skill_subdir should be 'rules' (not 'skills'), got: '${m['cursor'].skill_subdir}'`);
  assert.strictEqual(m['cursor'].dir_name, '.cursor',
    `cursor.dir_name should be '.cursor', got: '${m['cursor'].dir_name}'`);
});

// ── Test 4: loadPlatformCodes returns empty object for missing file ───────────

test('loadPlatformCodes returns empty object for missing file', () => {
  const m = loadPlatformCodes('/nonexistent/path-does-not-exist.yaml');
  assert.deepStrictEqual(m, {},
    `Expected empty object for missing file, got: ${JSON.stringify(m)}`);
});

// ── Test 5: loadPlatformCodes parses a custom yaml fixture ───────────────────

test('loadPlatformCodes parses a custom yaml fixture', () => {
  _customYamlPath = path.join(os.tmpdir(), `pc-${Date.now()}.yaml`);
  const yamlContent = `# custom fixture\nides:\n  someide:\n    ide_id: someide\n    dir_name: .someide\n    skill_subdir: custom\n    cli_name: somecli\n`;
  fs.writeFileSync(_customYamlPath, yamlContent, 'utf8');

  const m = loadPlatformCodes(_customYamlPath);
  assert.ok(m['someide'], `Expected 'someide' key in parsed result: ${JSON.stringify(m)}`);
  assert.strictEqual(m['someide'].dir_name, '.someide',
    `Expected dir_name '.someide', got: '${m['someide'].dir_name}'`);
  assert.strictEqual(m['someide'].skill_subdir, 'custom',
    `Expected skill_subdir 'custom', got: '${m['someide'].skill_subdir}'`);
  assert.strictEqual(m['someide'].ide_id, 'someide',
    `Expected ide_id 'someide', got: '${m['someide'].ide_id}'`);
});

// ── Test 6: TARGET_MAPS.cursor.out_dir was overridden by yaml at module-load ─

test('TARGET_MAPS.cursor.out_dir was overridden by yaml at module-load time', () => {
  // The module-load mutation in 44-01-02 should have set cursor.out_dir to
  // '.cursor/rules/' (from yaml skill_subdir: rules), not the original '.cursor/skills/'
  assert.ok(TARGET_MAPS.cursor, 'TARGET_MAPS.cursor should exist');
  assert.strictEqual(TARGET_MAPS.cursor.out_dir, '.cursor/rules/',
    `Expected TARGET_MAPS.cursor.out_dir === '.cursor/rules/', got: '${TARGET_MAPS.cursor.out_dir}'`);
  // Also verify claude and opencode are overridden
  assert.strictEqual(TARGET_MAPS.claude.out_dir, '.claude/skills/',
    `Expected TARGET_MAPS.claude.out_dir === '.claude/skills/', got: '${TARGET_MAPS.claude.out_dir}'`);
  assert.strictEqual(TARGET_MAPS.opencode.out_dir, '.opencode/skills/',
    `Expected TARGET_MAPS.opencode.out_dir === '.opencode/skills/', got: '${TARGET_MAPS.opencode.out_dir}'`);
});

// ── Test 7: compile dry-run still succeeds for all 3 targets ─────────────────

test('compile dry-run still succeeds for all 3 targets', () => {
  const srcDir = path.join(ROOT, 'get-shit-done/skills');
  for (const target of ['claude', 'opencode', 'cursor']) {
    const result = compile(target, { source: srcDir, dryRun: true });
    assert.deepStrictEqual(result.errors, [],
      `Target '${target}' should have no errors, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.compiled.length >= 3,
      `Target '${target}' should compile >= 3 skills, got ${result.compiled.length}`);
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  if (_customYamlPath) {
    try { fs.unlinkSync(_customYamlPath); } catch (_) {}
  }
});
