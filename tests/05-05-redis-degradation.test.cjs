#!/usr/bin/env node
/**
 * Plan 05-04: Graceful Degradation Tests
 *
 * Tests:
 *   DEGRADE-01: Redis import guard
 *     1. _HAS_REDIS flag exists
 *     2. import redis as redis_module in try block
 *     3. except ImportError sets _HAS_REDIS = False
 *   DEGRADE-02: Redis connection fallback
 *     4. _start_redis returns False on failure (not exception)
 *     5. _check_redis_health returns False on failure
 *     6. _auto_start_redis_container has timeout handling
 *   DEGRADE-03: Embedding cache fallback
 *     7. _redis_embed_get returns None on error
 *     8. _redis_embed_set silently fails (pass in except)
 *     9. L1 dict cache still works without Redis
 *   DEGRADE-04: Perplexity cache fallback
 *    10. _checkDaemonCache resolves null on error
 *    11. _writeDaemonCache resolves false on error
 *    12. File cache (_loadPerplexityCache) still exists as fallback
 *   DEGRADE-05: Health endpoint degradation
 *    13. pipeline_status computed from service states
 *    14. service_errors populated per failed service
 *    15. redis_unavailable message in research-cache POST
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
const PG_STORE = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');
const RESEARCH = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs'), 'utf-8');

describe('DEGRADE-01: Redis import guard', () => {
  it('1. _HAS_REDIS flag exists', () => {
    assert.ok(DAEMON.includes('_HAS_REDIS = False'),
      'Missing _HAS_REDIS default False');
    assert.ok(DAEMON.includes('_HAS_REDIS = True'),
      'Missing _HAS_REDIS set True after import');
  });
  it('2. import redis in try block', () => {
    assert.ok(DAEMON.includes('import redis as redis_module'),
      'Missing guarded redis import');
  });
  it('3. except ImportError guard', () => {
    assert.ok(DAEMON.includes('except ImportError'),
      'Missing ImportError catch');
  });
});

describe('DEGRADE-02: Redis connection fallback', () => {
  it('4. _start_redis returns False on failure', () => {
    const fn = DAEMON.slice(DAEMON.indexOf('def _start_redis'));
    assert.ok(fn.includes('return False'),
      '_start_redis must return False on failure');
  });
  it('5. _check_redis_health returns False on failure', () => {
    const fn = DAEMON.slice(DAEMON.indexOf('def _check_redis_health'));
    assert.ok(fn.includes('return False'),
      '_check_redis_health must return False on failure');
  });
  it('6. _auto_start_redis_container has timeout', () => {
    const fn = DAEMON.slice(DAEMON.indexOf('def _auto_start_redis_container'));
    assert.ok(fn.includes('timeout='),
      '_auto_start_redis_container must have timeout');
  });
});

describe('DEGRADE-03: Embedding cache fallback', () => {
  it('7. _redis_embed_get returns None on error', () => {
    const fn = PG_STORE.slice(PG_STORE.indexOf('def _redis_embed_get'));
    assert.ok(fn.includes('return None'),
      '_redis_embed_get must return None on error');
  });
  it('8. _redis_embed_set silently fails', () => {
    const fn = PG_STORE.slice(PG_STORE.indexOf('def _redis_embed_set'));
    assert.ok(fn.includes('except Exception'),
      '_redis_embed_set must catch all exceptions');
  });
  it('9. L1 dict cache still works', () => {
    assert.ok(PG_STORE.includes('_QUERY_EMBED_CACHE'),
      'L1 dict cache must remain');
  });
});

describe('DEGRADE-04: Perplexity cache fallback', () => {
  it('10. _checkDaemonCache resolves null on error', () => {
    const fn = RESEARCH.slice(RESEARCH.indexOf('function _checkDaemonCache'));
    assert.ok(fn.includes('resolve(null)'),
      '_checkDaemonCache must resolve null on error');
  });
  it('11. _writeDaemonCache resolves false on error', () => {
    const fn = RESEARCH.slice(RESEARCH.indexOf('function _writeDaemonCache'));
    assert.ok(fn.includes('resolve(false)'),
      '_writeDaemonCache must resolve false on error');
  });
  it('12. File cache exists as fallback', () => {
    assert.ok(RESEARCH.includes('_loadPerplexityCache'),
      'File cache must remain as L2 fallback');
  });
});

describe('DEGRADE-05: Health endpoint degradation', () => {
  it('13. pipeline_status computed from service states', () => {
    assert.ok(DAEMON.includes('pipeline_status'),
      'pipeline_status must exist');
  });
  it('14. service_errors populated per failed service', () => {
    assert.ok(DAEMON.includes('service_errors.append'),
      'service_errors must be populated on failure');
  });
  it('15. redis_unavailable in research-cache POST', () => {
    assert.ok(DAEMON.includes('redis_unavailable'),
      'Must report redis_unavailable when Redis is down');
  });
});
