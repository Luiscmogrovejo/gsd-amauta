#!/usr/bin/env node
/**
 * Plan 13-03-01: Creative research unit tests.
 *
 * Tests the Phase 13 exported functions from gsd-research.cjs:
 * _jaccardSimilarity, generateVariants, detectDomain, shouldEnableCreative,
 * deduplicateResults, parseArgs.
 *
 * Categories:
 *   (1) Jaccard similarity (~5 tests)
 *   (2) Variant query generation (~5 tests)
 *   (3) Task-type gating (~10 tests)
 *   (4) --creative flag parsing + kill switch (~3 tests)
 *   (5) Dedup across variants (~2 tests)
 *   (6) detectDomain (~2 tests)
 *
 * Run: node --test tests/13-creative-research.test.cjs
 */
'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RESEARCH_CJS = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-research.cjs');

// ── Module load ───────────────────────────────────────────────────────────────

let mod;

before(() => {
  // Set test env to prevent dotenv loading and daemon auto-start
  process.env.GSD_AMAUTA_NO_AUTO_START = '1';
  process.env.GSD_AMAUTA_PORT = '19999';
  mod = require(RESEARCH_CJS);
});

describe('Module load', () => {
  it('gsd-research.cjs exports all Phase 13 functions', () => {
    assert.ok(typeof mod._jaccardSimilarity === 'function', 'missing _jaccardSimilarity');
    assert.ok(typeof mod.generateVariants === 'function', 'missing generateVariants');
    assert.ok(typeof mod.detectDomain === 'function', 'missing detectDomain');
    assert.ok(typeof mod.shouldEnableCreative === 'function', 'missing shouldEnableCreative');
    assert.ok(typeof mod.deduplicateResults === 'function', 'missing deduplicateResults');
    assert.ok(typeof mod.parseArgs === 'function', 'missing parseArgs');
    assert.ok(typeof mod.CREATIVE_TYPES === 'object', 'missing CREATIVE_TYPES');
    assert.equal(mod.CREATIVE_JACCARD_THRESHOLD, 0.7, 'CREATIVE_JACCARD_THRESHOLD should be 0.7');
    assert.equal(mod.CREATIVE_QUERY_WORD_CAP, 8, 'CREATIVE_QUERY_WORD_CAP should be 8');
  });
});

// ── (1) Jaccard similarity ─────────────────────────────────────────────────

describe('_jaccardSimilarity', () => {
  it('identical strings return 1.0', () => {
    assert.equal(mod._jaccardSimilarity('hello world test', 'hello world test'), 1.0);
  });

  it('no overlap returns 0.0', () => {
    assert.equal(mod._jaccardSimilarity('alpha beta gamma', 'delta epsilon zeta'), 0.0);
  });

  it('partial overlap returns correct ratio', () => {
    // words >= 3 chars: {hello, world, abc} vs {hello, there, abc}
    // intersection: {hello, abc} = 2, union: {hello, world, abc, there} = 4 => 0.5
    const score = mod._jaccardSimilarity('hello world abc', 'hello there abc');
    assert.equal(score, 0.5);
  });

  it('short words (< 3 chars) are filtered and trigram fallback applies', () => {
    // "at to be" has no words >= 3 chars -> falls back to trigrams
    // Identical short text via trigram fallback should return > 0.0
    const score = mod._jaccardSimilarity('at to be', 'at to be');
    assert.ok(score > 0.0, `expected > 0 for identical short text, got ${score}`);
  });

  it('empty string returns 0.0', () => {
    assert.equal(mod._jaccardSimilarity('', 'hello world test'), 0.0);
    assert.equal(mod._jaccardSimilarity('hello world test', ''), 0.0);
    assert.equal(mod._jaccardSimilarity('', ''), 0.0);
  });
});

// ── (2) Variant query generation ──────────────────────────────────────────

describe('generateVariants', () => {
  it('returns exactly 3 variants', () => {
    const variants = mod.generateVariants('rate limiting implementation', 'api');
    assert.equal(variants.length, 3);
  });

  it('always includes inversion and anti-pattern variants', () => {
    const variants = mod.generateVariants('database connection pooling', 'database');
    const types = variants.map(v => v.type);
    assert.ok(types.includes('inversion'), 'missing inversion variant');
    assert.ok(types.includes('anti-pattern'), 'missing anti-pattern variant');
  });

  it('third slot is cross-domain for database domain', () => {
    const variants = mod.generateVariants('connection pooling', 'database');
    const third = variants.find(v => v.type !== 'inversion' && v.type !== 'anti-pattern');
    assert.equal(third.type, 'cross-domain');
  });

  it('third slot is lateral for frontend domain', () => {
    const variants = mod.generateVariants('component rendering', 'frontend');
    const third = variants.find(v => v.type !== 'inversion' && v.type !== 'anti-pattern');
    assert.equal(third.type, 'lateral');
  });

  it('variant queries are capped at CREATIVE_QUERY_WORD_CAP words', () => {
    const variants = mod.generateVariants(
      'this is a very long query that should trigger truncation behavior in the variant generator',
      'api'
    );
    for (const v of variants) {
      const wordCount = v.query.split(/\s+/).length;
      assert.ok(
        wordCount <= mod.CREATIVE_QUERY_WORD_CAP,
        `variant "${v.type}" has ${wordCount} words, expected <= ${mod.CREATIVE_QUERY_WORD_CAP}`
      );
    }
  });
});

// ── (3) Task-type gating ──────────────────────────────────────────────────

describe('shouldEnableCreative', () => {
  afterEach(() => {
    delete process.env.GSD_R_CREATIVE;
  });

  it('enables for research task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'research' }), true);
  });

  it('enables for exploration task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'exploration' }), true);
  });

  it('enables for architecture-review task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'architecture-review' }), true);
  });

  it('enables for pattern-search task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'pattern-search' }), true);
  });

  it('suppresses for implementation task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'implementation' }), false);
  });

  it('suppresses for bug-fix task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'bug-fix' }), false);
  });

  it('suppresses for documentation task type', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'documentation' }), false);
  });

  it('suppresses when no --task-type provided', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true }), false);
  });

  it('suppresses when --creative not provided', () => {
    assert.equal(mod.shouldEnableCreative({ 'task-type': 'research' }), false);
  });

  it('treats unknown task type as implementation (suppressed)', () => {
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'unknown-type' }), false);
  });

  it('auto-enables on re-research regardless of task type', () => {
    assert.equal(mod.shouldEnableCreative({ 're-research': true }), true);
  });

  it('kill switch GSD_R_CREATIVE=off overrides everything', () => {
    process.env.GSD_R_CREATIVE = 'off';
    assert.equal(mod.shouldEnableCreative({ creative: true, 'task-type': 'research' }), false);
  });
});

// ── (4) Flag parsing + kill switch ────────────────────────────────────────

describe('parseArgs creative flags', () => {
  it('parses --creative as boolean', () => {
    const args = mod.parseArgs(['search', 'test query', '--creative']);
    assert.equal(args.creative, true);
  });

  it('parses --task-type as value and --creative as boolean together', () => {
    const args = mod.parseArgs(['search', 'query', '--creative', '--task-type', 'research']);
    assert.equal(args.creative, true);
    assert.equal(args['task-type'], 'research');
  });

  it('parses --re-research as boolean', () => {
    const args = mod.parseArgs(['search', 'query', '--re-research']);
    assert.equal(args['re-research'], true);
  });
});

// ── (5) Dedup across variants ─────────────────────────────────────────────

describe('deduplicateResults', () => {
  it('removes variant result with high Jaccard similarity to original', () => {
    const original = [{ results: [{ text: 'database connection pooling best practices for PostgreSQL applications' }] }];
    const variant = [{ results: [{ text: 'database connection pooling best practices for PostgreSQL applications' }], count: 1 }];
    const result = mod.deduplicateResults(original, variant);
    assert.equal(result.length, 0, 'identical result should be deduped');
  });

  it('keeps variant result with low Jaccard similarity to original', () => {
    const original = [{ results: [{ text: 'database connection pooling best practices for PostgreSQL applications' }] }];
    const variant = [{ results: [{ text: 'TCP congestion control algorithms flow throttling network optimization' }], count: 1 }];
    const result = mod.deduplicateResults(original, variant);
    assert.equal(result.length, 1, 'novel result should be kept');
  });
});

// ── (6) detectDomain ──────────────────────────────────────────────────────

describe('detectDomain', () => {
  it('detects database domain from query keywords', () => {
    const domain = mod.detectDomain('postgresql connection pool migration');
    assert.equal(domain, 'database');
  });

  it('returns unknown for unrecognizable queries', () => {
    const domain = mod.detectDomain('xyz abc def');
    assert.equal(domain, 'unknown');
  });
});
