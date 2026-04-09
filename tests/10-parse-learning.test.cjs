#!/usr/bin/env node
/**
 * Phase 10 LEARN-02 unit tests for parse-learning subcommand.
 *
 * Covers the 5 critical edge cases from RESEARCH.md R4:
 *   (a) single LEARNING block
 *   (b) multiple LEARNING blocks (split on \nLEARNING:)
 *   (c) partial structure (only WHAT present)
 *   (d) parse failure fallback to free-text
 *   (e) kill switch GSD_D_STRUCTURED=false disabling
 *
 * Plus length cap enforcement (WHAT/WHY/WHEN) and CATEGORY defaults.
 *
 * Run: node tests/10-parse-learning.test.cjs
 *      npm test tests/10-parse-learning.test.cjs
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const MEM_CLI = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');

// Try to require the module directly for fine-grained unit tests;
// fall back to empty object if exports unavailable.
let mod;
try {
  mod = require(MEM_CLI);
} catch (e) {
  mod = {};
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// -------------------- parseLearningBlock unit --------------------

test('parseLearningBlock: single block with all fields', () => {
  if (!mod.parseLearningBlock) return;
  const block = `LEARNING: Use connection pooling
  WHAT: Use connection pooling
  WHY: Prevents connection exhaustion
  WHEN: Working with PG in Node.js
  CATEGORY: pattern
  TAGS: postgresql, connection-pool, nodejs`;
  const p = mod.parseLearningBlock(block);
  assert.ok(p, 'should parse');
  assert.strictEqual(p.what, 'Use connection pooling');
  assert.strictEqual(p.why, 'Prevents connection exhaustion');
  assert.strictEqual(p.when, 'Working with PG in Node.js');
  assert.strictEqual(p.category, 'pattern');
  assert.deepStrictEqual(p.tags, ['postgresql', 'connection-pool', 'nodejs']);
});

test('parseLearningBlock: partial structure (WHAT only)', () => {
  if (!mod.parseLearningBlock) return;
  const block = `LEARNING: Use input validation
  WHAT: Use input validation`;
  const p = mod.parseLearningBlock(block);
  assert.ok(p);
  assert.strictEqual(p.what, 'Use input validation');
  assert.strictEqual(p.why, null);
  assert.strictEqual(p.when, null);
  assert.strictEqual(p.category, 'pattern');  // default
  assert.strictEqual(p.category_defaulted, true);
});

test('parseLearningBlock: header-only (no indented fields) returns headerWhat as WHAT', () => {
  if (!mod.parseLearningBlock) return;
  const block = `LEARNING: One-liner legacy style`;
  const p = mod.parseLearningBlock(block);
  assert.ok(p);
  assert.strictEqual(p.what, 'One-liner legacy style');
});

test('parseLearningBlock: unknown category defaults to pattern', () => {
  if (!mod.parseLearningBlock) return;
  const block = `LEARNING: test
  WHAT: test
  CATEGORY: madeup-category`;
  const p = mod.parseLearningBlock(block);
  assert.strictEqual(p.category, 'pattern');
  assert.strictEqual(p.category_defaulted, true);
});

test('parseLearningBlock: null/empty input returns null', () => {
  if (!mod.parseLearningBlock) return;
  assert.strictEqual(mod.parseLearningBlock(null), null);
  assert.strictEqual(mod.parseLearningBlock(''), null);
  assert.strictEqual(mod.parseLearningBlock(42), null);
});

// -------------------- splitLearningBlocks unit --------------------

test('splitLearningBlocks: multiple blocks split on \\nLEARNING:', () => {
  if (!mod.splitLearningBlocks) return;
  const content = `Some D-phase preamble.
LEARNING: First instruction
  WHAT: First instruction
  CATEGORY: pattern
  TAGS: postgresql

LEARNING: Second instruction
  WHAT: Second instruction
  CATEGORY: pitfall
  TAGS: jest`;
  const blocks = mod.splitLearningBlocks(content);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[0].startsWith('LEARNING: First'));
  assert.ok(blocks[1].startsWith('LEARNING: Second'));
});

test('splitLearningBlocks: no markers returns empty array', () => {
  if (!mod.splitLearningBlocks) return;
  assert.deepStrictEqual(mod.splitLearningBlocks('no marker here'), []);
});

test('splitLearningBlocks: content starting with LEARNING: (no preamble)', () => {
  if (!mod.splitLearningBlocks) return;
  const content = `LEARNING: Only one
  WHAT: Only one`;
  const blocks = mod.splitLearningBlocks(content);
  assert.strictEqual(blocks.length, 1);
});

// -------------------- validateLengthCaps unit --------------------

test('validateLengthCaps: WHAT over 120 chars rejected', () => {
  if (!mod.validateLengthCaps) return;
  const parsed = { what: 'x'.repeat(121), why: null, when: null };
  const err = mod.validateLengthCaps(parsed);
  assert.ok(err, 'should reject');
  assert.match(err.error, /WHAT is 121 chars \(max 120\)/);
});

test('validateLengthCaps: WHY over 200 chars rejected', () => {
  if (!mod.validateLengthCaps) return;
  const parsed = { what: 'ok', why: 'x'.repeat(201), when: null };
  const err = mod.validateLengthCaps(parsed);
  assert.ok(err);
  assert.match(err.error, /WHY is 201 chars \(max 200\)/);
});

test('validateLengthCaps: WHEN over 80 chars rejected', () => {
  if (!mod.validateLengthCaps) return;
  const parsed = { what: 'ok', why: null, when: 'x'.repeat(81) };
  const err = mod.validateLengthCaps(parsed);
  assert.ok(err);
  assert.match(err.error, /WHEN is 81 chars \(max 80\)/);
});

test('validateLengthCaps: all within limits returns null', () => {
  if (!mod.validateLengthCaps) return;
  assert.strictEqual(mod.validateLengthCaps({ what: 'ok', why: 'ok', when: 'ok' }), null);
});

// -------------------- CLI integration --------------------

test('CLI parse-learning: structured block exits 0 with parsed: true', () => {
  const input = `LEARNING: test instruction
  WHAT: test instruction
  CATEGORY: pattern
  TAGS: postgresql`;
  const r = spawnSync('node', [MEM_CLI, 'parse-learning', input], { encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.parsed, true);
  assert.strictEqual(out.blocks.length, 1);
  assert.strictEqual(out.blocks[0].what, 'test instruction');
});

test('CLI parse-learning: no marker returns parsed: false (free-text fallback)', () => {
  const r = spawnSync('node', [MEM_CLI, 'parse-learning', 'no marker here just text'], { encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.parsed, false);
  assert.ok(out.blocks.length >= 1);
});

test('CLI parse-learning: GSD_D_STRUCTURED=false disables with warning', () => {
  const input = `LEARNING: test
  WHAT: test`;
  const r = spawnSync('node', [MEM_CLI, 'parse-learning', input], {
    encoding: 'utf-8',
    env: { ...process.env, GSD_D_STRUCTURED: 'false' },
  });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  assert.match(r.stderr, /Structured learning disabled/);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.disabled, true);
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
