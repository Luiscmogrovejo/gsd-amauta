#!/usr/bin/env node
/**
 * Plan 07-03: Perplexity Hardening Guard Tests
 *
 * Tests:
 *   PREAMBLE-01: Preamble stripping patterns
 *     1. "Of course" stripped
 *     2. "I'd be happy to help" stripped
 *     3. "As an AI assistant" stripped
 *     4. Original 10 patterns still present
 *     5. Loop-until-stable mechanism exists
 *     6. At least 13 preamble patterns total
 *   RATE-01: Perplexity rate limiter
 *     7. perplexityWithRetry function exists
 *     8. PERPLEXITY_MAX_RETRIES defined
 *     9. PERPLEXITY_BASE_DELAY_MS defined
 *    10. Exponential backoff formula (Math.pow)
 *    11. Retry condition checks status !== 429
 *    12. [RATE LIMIT] stderr message
 *   DEDUP-01: Dedup improvements
 *    13. TECH_SHORT_WORDS whitelist defined
 *    14. TECH_SHORT_WORDS includes 'ai', 'db', 'js', 'go'
 *    15. textSimilarity uses TECH_SHORT_WORDS.has(w)
 *    16. [DEDUP] similarity logging present
 *    17. Dedup log threshold is 0.3
 *    18. DEDUP_THRESHOLD configurable via GSD_RESEARCH_DEDUP_THRESHOLD
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESEARCH = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs'), 'utf-8');

describe('PREAMBLE-01: Preamble stripping patterns', () => {
  it('1. "Of course" pattern present', () => {
    assert.ok(RESEARCH.includes('of\\s+course'), 'Missing "Of course" preamble pattern');
  });

  it('2. "I\'d be happy to" pattern present', () => {
    assert.ok(RESEARCH.includes('be\\s+happy\\s+to'), 'Missing "I\'d be happy to" preamble pattern');
  });

  it('3. "As an AI" pattern present', () => {
    assert.ok(RESEARCH.includes('as\\s+an'), 'Missing "As an AI" preamble pattern');
  });

  it('4. Original patterns still present (spot check)', () => {
    assert.ok(RESEARCH.includes('here\\s+(?:is|are)'), 'Missing original "here is/are" pattern');
    assert.ok(RESEARCH.includes('based\\s+on'), 'Missing original "based on" pattern');
    assert.ok(RESEARCH.includes('certainly'), 'Missing original "certainly" pattern');
  });

  it('5. Loop-until-stable mechanism exists', () => {
    assert.ok(RESEARCH.includes('while (result !== prev)'), 'Missing loop-until-stable in stripPreamble');
  });

  it('6. At least 13 preamble patterns total', () => {
    // Count regex patterns in the patterns array (look for /^(?:  prefix which all patterns use)
    const patternMatches = RESEARCH.match(/\/\^\(\?:/g);
    assert.ok(patternMatches, 'No regex patterns found');
    assert.ok(patternMatches.length >= 13, `Expected >= 13 preamble patterns, found ${patternMatches.length}`);
  });
});

describe('RATE-01: Perplexity rate limiter', () => {
  it('7. perplexityWithRetry function exists', () => {
    assert.ok(RESEARCH.includes('async function perplexityWithRetry'), 'Missing perplexityWithRetry function');
  });

  it('8. PERPLEXITY_MAX_RETRIES defined', () => {
    assert.ok(RESEARCH.includes('PERPLEXITY_MAX_RETRIES'), 'Missing PERPLEXITY_MAX_RETRIES constant');
  });

  it('9. PERPLEXITY_BASE_DELAY_MS defined', () => {
    assert.ok(RESEARCH.includes('PERPLEXITY_BASE_DELAY_MS'), 'Missing PERPLEXITY_BASE_DELAY_MS constant');
  });

  it('10. Exponential backoff formula', () => {
    assert.ok(RESEARCH.includes('Math.pow(2,'), 'Missing exponential backoff formula');
  });

  it('11. Retry condition checks 429 status', () => {
    assert.ok(RESEARCH.includes('.status !== 429'), 'Missing 429 retry condition');
  });

  it('12. [RATE LIMIT] stderr message', () => {
    assert.ok(RESEARCH.includes('[RATE LIMIT]'), 'Missing [RATE LIMIT] log message');
  });
});

describe('DEDUP-01: Dedup improvements', () => {
  it('13. TECH_SHORT_WORDS whitelist defined', () => {
    assert.ok(RESEARCH.includes('TECH_SHORT_WORDS'), 'Missing TECH_SHORT_WORDS whitelist');
  });

  it('14. TECH_SHORT_WORDS includes key abbreviations', () => {
    const whitelistMatch = RESEARCH.match(/TECH_SHORT_WORDS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/);
    assert.ok(whitelistMatch, 'TECH_SHORT_WORDS Set definition not found');
    const content = whitelistMatch[1];
    for (const term of ['ai', 'db', 'js', 'go']) {
      assert.ok(content.includes(`'${term}'`), `TECH_SHORT_WORDS missing '${term}'`);
    }
  });

  it('15. textSimilarity uses TECH_SHORT_WORDS.has(w)', () => {
    const matches = RESEARCH.match(/TECH_SHORT_WORDS\.has\(w\)/g);
    assert.ok(matches && matches.length >= 2, 'textSimilarity should use TECH_SHORT_WORDS.has(w) for both word sets');
  });

  it('16. [DEDUP] similarity logging present', () => {
    assert.ok(RESEARCH.includes('[DEDUP]'), 'Missing [DEDUP] log message');
  });

  it('17. Dedup log threshold is 0.3', () => {
    assert.ok(RESEARCH.includes('sim >= 0.3'), 'Dedup log threshold should be 0.3');
  });

  it('18. DEDUP_THRESHOLD configurable via env var', () => {
    assert.ok(RESEARCH.includes('GSD_RESEARCH_DEDUP_THRESHOLD'), 'DEDUP_THRESHOLD should be configurable');
  });
});
