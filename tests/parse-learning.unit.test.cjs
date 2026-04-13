'use strict';
/**
 * Property-based tests: parse-learning pure functions
 * File: tests/parse-learning.unit.test.cjs
 * Uses: fast-check (fc) — 100 iterations per property (numRuns: 100)
 *
 * Functions under test (from get-shit-done/bin/gsd-memory.cjs):
 *   - parseLearningBlock(block: string): {what, why, when, category, category_defaulted, tags, raw} | null
 *   - splitLearningBlocks(text: string): string[]
 *   - validateLengthCaps(parsed: {what, why, when}): {error: string} | null
 *
 * Property types demonstrated:
 *   1. Round-trip: splitLearningBlocks(format([x])) produces exactly 1 block
 *   2. Idempotency: parseLearningBlock on the same string always returns same result
 *   3. Invariant: any non-empty WHAT produces an object with all required fields
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// Import pure functions directly from gsd-memory.cjs exports
const mod = require('../get-shit-done/bin/gsd-memory.cjs');

// Validate that the required exports are present
if (!mod.parseLearningBlock) throw new Error('parseLearningBlock not exported from gsd-memory.cjs');
if (!mod.splitLearningBlocks) throw new Error('splitLearningBlocks not exported from gsd-memory.cjs');
if (!mod.validateLengthCaps) throw new Error('validateLengthCaps not exported from gsd-memory.cjs');

const { parseLearningBlock, splitLearningBlocks, validateLengthCaps } = mod;

// Valid CATEGORY_SET values from gsd-memory.cjs
const VALID_CATEGORIES = ['workflow', 'process', 'delivery', 'pattern', 'policy', 'architecture', 'convention', 'pitfall', 'tool-usage'];

// Arbitrary for a valid WHAT string: non-empty, single line, within MAX_WHAT (120 chars)
const validWhat = fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('\n') && s.trim().length > 0);

// Build a full LEARNING block string from parts
function buildLearningBlock(what) {
  return `LEARNING: ${what}\n  WHAT: ${what}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 1: Round-trip — splitLearningBlocks(buildLearningBlock(x)) yields 1 block
// ─────────────────────────────────────────────────────────────────────────────
describe('Property: round-trip — split recovers exactly 1 block from any valid WHAT', () => {
  it('round-trip: splitLearningBlocks of a well-formed LEARNING block returns 1 block that re-parses to the original WHAT', () => {
    fc.assert(
      fc.property(
        validWhat,
        (what) => {
          const block = buildLearningBlock(what);
          const blocks = splitLearningBlocks(block);
          // Must produce exactly 1 block
          assert.strictEqual(blocks.length, 1, `Expected 1 block, got ${blocks.length} for input: ${block}`);
          // That block must re-parse to the original what
          const parsed = parseLearningBlock(blocks[0]);
          assert.ok(parsed !== null, 'parseLearningBlock should not return null for a valid block');
          assert.strictEqual(parsed.what, what.trim(), `Round-trip failed: expected "${what.trim()}", got "${parsed.what}"`);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 2: Idempotency — parsing the same string twice yields the same result
// ─────────────────────────────────────────────────────────────────────────────
describe('Property: idempotency — parseLearningBlock produces same result on repeated calls', () => {
  it('idempotent: parsing a LEARNING block twice gives structurally identical results', () => {
    fc.assert(
      fc.property(
        fc.record({
          what: validWhat,
          why: fc.option(fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('\n'))),
          when: fc.option(fc.string({ minLength: 1, maxLength: 60 }).filter(s => !s.includes('\n'))),
          category: fc.constantFrom(...VALID_CATEGORIES),
          tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes(',') && !s.includes('\n')), { maxLength: 4 }),
        }),
        (learningData) => {
          const { what, why, when, category, tags } = learningData;
          const lines = [`LEARNING: ${what}`, `  WHAT: ${what}`];
          if (why) lines.push(`  WHY: ${why}`);
          if (when) lines.push(`  WHEN: ${when}`);
          lines.push(`  CATEGORY: ${category}`);
          if (tags.length > 0) lines.push(`  TAGS: ${tags.join(', ')}`);
          const block = lines.join('\n');

          const first = parseLearningBlock(block);
          const second = parseLearningBlock(block);

          // Both calls must produce non-null (same valid input)
          assert.ok(first !== null, 'First parse should not be null');
          assert.ok(second !== null, 'Second parse should not be null');

          // Idempotency: key fields must be identical
          assert.strictEqual(first.what, second.what, 'what field must be idempotent');
          assert.strictEqual(first.why, second.why, 'why field must be idempotent');
          assert.strictEqual(first.category, second.category, 'category field must be idempotent');
          assert.strictEqual(first.category_defaulted, second.category_defaulted, 'category_defaulted must be idempotent');
          assert.deepStrictEqual(first.tags, second.tags, 'tags must be idempotent');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 3: Structural invariant — valid blocks always produce objects with required fields
// ─────────────────────────────────────────────────────────────────────────────
describe('Property: structural invariant — parseLearningBlock always returns full-contract object or null', () => {
  it('invariant: any valid LEARNING block produces an object with what, why, when, category, category_defaulted, tags, raw fields', () => {
    fc.assert(
      fc.property(
        validWhat,
        (what) => {
          const block = `LEARNING: ${what}\n  WHAT: ${what}\n  CATEGORY: pattern`;
          const result = parseLearningBlock(block);

          // Must not throw and must return non-null
          assert.ok(result !== null, 'Should not return null for a valid block with non-empty WHAT');
          assert.strictEqual(typeof result, 'object', 'Result must be an object');

          // Structural invariant: all required fields present
          assert.ok('what' in result, 'Missing required field: what');
          assert.ok('why' in result, 'Missing required field: why');
          assert.ok('when' in result, 'Missing required field: when');
          assert.ok('category' in result, 'Missing required field: category');
          assert.ok('category_defaulted' in result, 'Missing required field: category_defaulted');
          assert.ok('tags' in result, 'Missing required field: tags');
          assert.ok('raw' in result, 'Missing required field: raw');

          // Type invariants
          assert.strictEqual(typeof result.what, 'string', 'what must be a string');
          assert.ok(result.what.length > 0, 'what must be non-empty');
          assert.ok(Array.isArray(result.tags), 'tags must be an array');
          assert.strictEqual(typeof result.category, 'string', 'category must be a string');
        }
      ),
      { numRuns: 100 }
    );
  });
});
