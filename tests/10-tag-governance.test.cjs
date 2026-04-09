#!/usr/bin/env node
/**
 * Phase 10 LEARN-04 unit tests for tag governance.
 *
 * Verifies:
 *   - Synonym normalization (db->database, pg->postgresql, k8s->kubernetes, etc.)
 *   - Banned tag stripping ({best-practice, general, lesson, insight})
 *   - All-banned rejection with guidance message
 *   - Auto-trim to 5 by tier ranking (domain > technique > scope > meta)
 *   - Lowercase + dedupe
 *   - Empty input handling
 *   - loadTagRules caching
 *   - tagTier tier assignment
 *
 * Run: node tests/10-tag-governance.test.cjs
 */
const assert = require('assert');
const path = require('path');

const MEM_CLI = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const mod = require(MEM_CLI);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('normalizeTags: synonym normalization pg->postgresql', () => {
  const r = mod.normalizeTags(['pg']);
  assert.deepStrictEqual(r.tags, ['postgresql']);
  assert.strictEqual(r.error, null);
});

test('normalizeTags: synonym normalization k8s->kubernetes, ts->typescript, py->python', () => {
  const r = mod.normalizeTags(['k8s', 'ts', 'py']);
  assert.deepStrictEqual(r.tags.sort(), ['kubernetes', 'python', 'typescript']);
});

test('normalizeTags: banned tag stripped, specific tag kept', () => {
  const r = mod.normalizeTags(['best-practice', 'postgresql']);
  assert.deepStrictEqual(r.tags, ['postgresql']);
  assert.ok(r.warnings.some(w => /Stripped banned tags/.test(w)));
});

test('normalizeTags: all banned -> rejected with guidance', () => {
  const r = mod.normalizeTags(['best-practice', 'lesson', 'insight']);
  assert.deepStrictEqual(r.tags, []);
  assert.ok(r.error);
  assert.match(r.error, /Rejected: all tags are generic/);
  assert.match(r.error, /Add specific tags like/);
});

test('normalizeTags: empty input returns error (no tags at all)', () => {
  const r = mod.normalizeTags([]);
  assert.ok(r.error);
});

test('normalizeTags: comma-string input accepted', () => {
  const r = mod.normalizeTags('postgresql, connection-pool , nodejs');
  assert.deepStrictEqual(r.tags, ['postgresql', 'connection-pool', 'nodejs']);
});

test('normalizeTags: lowercase and dedupe', () => {
  const r = mod.normalizeTags(['PostgreSQL', 'postgresql', 'POSTGRESQL']);
  assert.strictEqual(r.tags.length, 1);
  assert.strictEqual(r.tags[0], 'postgresql');
});

test('normalizeTags: auto-trim >5 tags by tier ranking', () => {
  // domain=postgresql (tier 0), technique=connection-pool (tier 1),
  // scope=backend (tier 2), meta=pattern (tier 3)
  const input = ['pattern', 'backend', 'monitoring', 'postgresql', 'connection-pool', 'nodejs', 'testing'];
  const r = mod.normalizeTags(input);
  assert.strictEqual(r.tags.length, 5);
  assert.ok(r.warnings.some(w => /Trimmed 7->5 tags/.test(w)));
  // The two dropped tags should be the highest-tier (meta), with postgresql kept
  assert.ok(r.tags.includes('postgresql'));
});

test('normalizeTags: loadTagRules cached after first call', () => {
  const r1 = mod.loadTagRules();
  const r2 = mod.loadTagRules();
  assert.strictEqual(r1, r2); // same object reference (cached)
});

test('tagTier: domain tags return 0', () => {
  const rules = mod.loadTagRules();
  assert.strictEqual(mod.tagTier('postgresql', rules), 0);
});

test('tagTier: meta tags return 3', () => {
  const rules = mod.loadTagRules();
  assert.strictEqual(mod.tagTier('pattern', rules), 3);
});

// -------------------- Runner --------------------

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${name}`);
      console.log(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
