'use strict';
/**
 * Plan 54-02-02: STAB-04 PATH collision detection unit tests.
 *
 * Verifies:
 *   1. package.json bin.gsd-amauta maps to bin/cli.cjs
 *   2. package.json bin.amauta maps to get-shit-done/bin/amauta.cjs
 *   3. bin/init.cjs defines detectAmautaAiConflict
 *   4. Warning text contains amauta-ai, gsd-amauta, PATH collision
 *   5. Warning includes pipx uninstall remediation
 *   6. gsd-amauta-mcp bin entry exists
 *
 * Run: node --test tests/stab04-path-collision.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('STAB-04: package.json bin.gsd-amauta maps to bin/cli.cjs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.strictEqual(pkg.bin['gsd-amauta'], 'bin/cli.cjs',
    'gsd-amauta must point to bin/cli.cjs');
});

test('STAB-04: package.json bin.amauta maps to get-shit-done/bin/amauta.cjs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.strictEqual(pkg.bin['amauta'], 'get-shit-done/bin/amauta.cjs',
    'amauta bin must map to get-shit-done/bin/amauta.cjs (GSD plugin, not pipx)');
});

test('STAB-04: bin/init.cjs contains detectAmautaAiConflict function', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'init.cjs'), 'utf-8');
  assert.ok(src.includes('detectAmautaAiConflict'),
    'bin/init.cjs must define detectAmautaAiConflict');
});

test('STAB-04: bin/init.cjs warning text contains amauta-ai and gsd-amauta', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'init.cjs'), 'utf-8');
  assert.ok(src.includes('amauta-ai'), 'warning must reference amauta-ai');
  assert.ok(src.includes('gsd-amauta'), 'warning must reference gsd-amauta');
  assert.ok(src.includes('PATH collision'), 'warning must include PATH collision text');
});

test('STAB-04: bin/init.cjs warning includes pipx uninstall remediation', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'init.cjs'), 'utf-8');
  assert.ok(
    src.includes('pipx uninstall amauta-ai'),
    'warning must include pipx uninstall remediation step'
  );
});

test('STAB-04: bin/gsd-amauta-mcp entry point exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.ok('gsd-amauta-mcp' in pkg.bin, 'gsd-amauta-mcp bin entry must exist');
});
