#!/usr/bin/env node
/**
 * Plan 05-03: Redis Perplexity Cache via Daemon Proxy Tests
 *
 * Tests:
 *   PROXY-01: Daemon research-cache endpoint
 *     1. /api/research-cache path in GET handler
 *     2. /api/research-cache path in POST handler
 *     3. REDIS_PERPLEXITY_PREFIX = gsd:ppx:
 *     4. REDIS_PERPLEXITY_TTL = 21600
 *     5. redis_unavailable fallback in POST handler
 *   PROXY-02: gsd-research.cjs daemon cache wiring
 *     6. _checkDaemonCache function exists
 *     7. _writeDaemonCache function exists
 *     8. Daemon cache checked before file cache in providerPerplexity
 *     9. Daemon cache written after file cache in providerPerplexity
 *    10. No non-stdlib Redis dependencies
 *   PROXY-03: File cache preservation
 *    11. _loadPerplexityCache still exists (fallback)
 *    12. _savePerplexityCache still exists (fallback)
 *    13. PERPLEXITY_CACHE_FILE still defined
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
const RESEARCH = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs'), 'utf-8');

describe('PROXY-01: Daemon research-cache endpoint', () => {
  it('1. /api/research-cache in GET handler', () => {
    assert.ok(DAEMON.includes('/api/research-cache'),
      'Missing /api/research-cache endpoint');
  });
  it('2. /api/research-cache in POST handler', () => {
    // The endpoint appears in both do_GET and do_POST sections
    const matches = DAEMON.match(/research-cache/g);
    assert.ok(matches && matches.length >= 2,
      'research-cache should appear in both GET and POST');
  });
  it('3. REDIS_PERPLEXITY_PREFIX', () => {
    assert.ok(DAEMON.includes('REDIS_PERPLEXITY_PREFIX = "gsd:ppx:"'),
      'Missing gsd:ppx: prefix');
  });
  it('4. REDIS_PERPLEXITY_TTL', () => {
    assert.ok(DAEMON.includes('REDIS_PERPLEXITY_TTL = 21600'),
      'Missing 21600s TTL');
  });
  it('5. redis_unavailable fallback', () => {
    assert.ok(DAEMON.includes('redis_unavailable'),
      'Missing redis_unavailable fallback message');
  });
});

describe('PROXY-02: gsd-research.cjs daemon cache wiring', () => {
  it('6. _checkDaemonCache function exists', () => {
    assert.ok(RESEARCH.includes('function _checkDaemonCache'),
      'Missing _checkDaemonCache');
  });
  it('7. _writeDaemonCache function exists', () => {
    assert.ok(RESEARCH.includes('function _writeDaemonCache'),
      'Missing _writeDaemonCache');
  });
  it('8. Daemon cache checked in providerPerplexity', () => {
    assert.ok(RESEARCH.includes('_checkDaemonCache(cacheKey)'),
      'Missing daemon cache check call');
  });
  it('9. Daemon cache written in providerPerplexity', () => {
    assert.ok(RESEARCH.includes('_writeDaemonCache(cacheKey'),
      'Missing daemon cache write call');
  });
  it('10. No non-stdlib Redis dependencies', () => {
    assert.ok(!RESEARCH.includes("require('ioredis')"),
      'Must not use ioredis');
    assert.ok(!RESEARCH.includes("require('redis')"),
      'Must not use redis npm package');
  });
});

describe('PROXY-03: File cache preservation', () => {
  it('11. _loadPerplexityCache still exists', () => {
    assert.ok(RESEARCH.includes('function _loadPerplexityCache'),
      '_loadPerplexityCache must remain as fallback');
  });
  it('12. _savePerplexityCache still exists', () => {
    assert.ok(RESEARCH.includes('function _savePerplexityCache'),
      '_savePerplexityCache must remain as fallback');
  });
  it('13. PERPLEXITY_CACHE_FILE still defined', () => {
    assert.ok(RESEARCH.includes('PERPLEXITY_CACHE_FILE'),
      'PERPLEXITY_CACHE_FILE must remain defined');
  });
});
