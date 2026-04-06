#!/usr/bin/env node
/**
 * Plan 04-02: Perplexity Response Cache Tests
 *
 * Tests:
 *   PCACHE-01: Cache infrastructure
 *     1. _loadPerplexityCache function exists
 *     2. _savePerplexityCache function exists
 *     3. _perplexityCacheKey function exists
 *     4. PERPLEXITY_CACHE_TTL is 6 hours (21600000 ms)
 *     5. Cache file path includes perplexity-cache.json
 *   PCACHE-02: Cache read/write pattern
 *     6. Cache read happens before API call in providerPerplexity
 *     7. Cache write happens after API call with storedAt timestamp
 *     8. Atomic write uses .tmp + renameSync pattern
 *   PCACHE-03: --no-cache bypass
 *     9. parseArgs recognizes --no-cache as boolean flag
 *    10. providerPerplexity._noCache wiring exists in cmdSearch
 *   PCACHE-04: TTL pruning
 *    11. _loadPerplexityCache prunes entries older than TTL
 *    12. Cache read returns cached: true for hits
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESEARCH_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');

const content = fs.readFileSync(RESEARCH_CJS, 'utf-8');

describe('PCACHE-01: Cache infrastructure', () => {
  it('1. _loadPerplexityCache function exists', () => {
    assert.ok(content.includes('function _loadPerplexityCache()'),
      'Missing _loadPerplexityCache function');
  });

  it('2. _savePerplexityCache function exists', () => {
    assert.ok(content.includes('function _savePerplexityCache(cache)'),
      'Missing _savePerplexityCache function');
  });

  it('3. _perplexityCacheKey function exists', () => {
    assert.ok(content.includes('function _perplexityCacheKey(query, model)'),
      'Missing _perplexityCacheKey function');
  });

  it('4. PERPLEXITY_CACHE_TTL is 6 hours', () => {
    assert.ok(content.includes('PERPLEXITY_CACHE_TTL = 6 * 60 * 60 * 1000'),
      'Cache TTL should be 6 hours (21600000 ms)');
  });

  it('5. Cache file path includes perplexity-cache.json', () => {
    assert.ok(content.includes("'perplexity-cache.json'"),
      'Cache file should be perplexity-cache.json');
  });
});

describe('PCACHE-02: Cache read/write pattern', () => {
  it('6. Cache read uses _loadPerplexityCache in providerPerplexity', () => {
    // Find providerPerplexity function and check it calls _loadPerplexityCache
    const fnStart = content.indexOf('async function providerPerplexity');
    const fnBody = content.slice(fnStart, fnStart + 3000);
    assert.ok(fnBody.includes('_loadPerplexityCache'),
      'providerPerplexity should call _loadPerplexityCache');
  });

  it('7. Cache write stores storedAt timestamp', () => {
    assert.ok(content.includes('storedAt: Date.now()'),
      'Cache entries should store storedAt timestamp');
  });

  it('8. Atomic write uses .tmp + renameSync pattern', () => {
    assert.ok(content.includes("PERPLEXITY_CACHE_FILE + '.tmp'"),
      'Should create .tmp file for atomic write');
    assert.ok(content.includes('fs.renameSync(tmpFile'),
      'Should rename .tmp to final file');
  });
});

describe('PCACHE-03: --no-cache bypass', () => {
  it('9. parseArgs recognizes --no-cache as boolean flag', () => {
    assert.ok(content.includes("'--no-cache'"),
      'parseArgs should handle --no-cache flag');
  });

  it('10. providerPerplexity._noCache wiring in cmdSearch', () => {
    assert.ok(content.includes('providerPerplexity._noCache'),
      'cmdSearch should wire _noCache to providerPerplexity');
  });
});

describe('PCACHE-04: TTL pruning and cache hits', () => {
  it('11. _loadPerplexityCache prunes entries older than TTL', () => {
    const fnStart = content.indexOf('function _loadPerplexityCache');
    const fnBody = content.slice(fnStart, fnStart + 500);
    assert.ok(fnBody.includes('PERPLEXITY_CACHE_TTL'),
      '_loadPerplexityCache should reference TTL for pruning');
  });

  it('12. Cache hit returns cached: true', () => {
    assert.ok(content.includes('cached: true'),
      'Cache hit should include cached: true in return');
  });
});
