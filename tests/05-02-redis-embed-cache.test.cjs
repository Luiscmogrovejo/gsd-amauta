#!/usr/bin/env node
/**
 * Plan 05-02: Redis L2 Embedding Cache Tests
 *
 * Tests:
 *   L2-01: Redis L2 cache helpers
 *     1. _redis_embed_get function exists
 *     2. _redis_embed_set function exists
 *     3. Key prefix is gsd:emb:
 *     4. TTL is 3600 seconds
 *   L2-02: Cache lookup order
 *     5. L2 check happens after L1 miss (redis_embed_get call in generate_embedding)
 *     6. L2 write happens after API call (redis_embed_set call in generate_embedding)
 *     7. L1 promotion on L2 hit (dict write after redis_hit)
 *   L2-03: Bridge module
 *     8. amauta_daemon_redis.py exists
 *     9. get_redis_client function in bridge
 *    10. set_redis_client function in bridge
 *   L2-04: Daemon integration
 *    11. set_redis_client called after Redis startup in daemon
 *   L2-05: Graceful degradation
 *    12. All redis functions wrapped in try/except
 *    13. L1 cache still intact (no regression from Phase 4)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PG_STORE = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'services', 'amauta_daemon_redis.py'), 'utf-8');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');

describe('L2-01: Redis L2 cache helpers', () => {
  it('1. _redis_embed_get function exists', () => {
    assert.ok(PG_STORE.includes('def _redis_embed_get(cache_key):'),
      'Missing _redis_embed_get');
  });
  it('2. _redis_embed_set function exists', () => {
    assert.ok(PG_STORE.includes('def _redis_embed_set(cache_key, embedding):'),
      'Missing _redis_embed_set');
  });
  it('3. Key prefix is gsd:emb:', () => {
    assert.ok(PG_STORE.includes('_REDIS_EMBED_PREFIX = "gsd:emb:"'),
      'Key prefix must be gsd:emb:');
  });
  it('4. TTL is 3600 seconds', () => {
    assert.ok(PG_STORE.includes('_REDIS_EMBED_TTL = 3600'),
      'TTL must be 3600s');
  });
});

describe('L2-02: Cache lookup order', () => {
  it('5. L2 check after L1 miss', () => {
    assert.ok(PG_STORE.includes('_redis_embed_get(cache_key)'),
      'Missing L2 cache check in generate_embedding');
  });
  it('6. L2 write after API call', () => {
    assert.ok(PG_STORE.includes('_redis_embed_set(cache_key, embedding)'),
      'Missing L2 cache write in generate_embedding');
  });
  it('7. L1 promotion on L2 hit', () => {
    assert.ok(PG_STORE.includes('(redis_hit, time.time())'),
      'Missing L1 promotion after L2 hit');
  });
});

describe('L2-03: Bridge module', () => {
  it('8. amauta_daemon_redis.py exists', () => {
    assert.ok(BRIDGE.length > 0, 'Bridge module must exist');
  });
  it('9. get_redis_client in bridge', () => {
    assert.ok(BRIDGE.includes('def get_redis_client():'),
      'Missing get_redis_client');
  });
  it('10. set_redis_client in bridge', () => {
    assert.ok(BRIDGE.includes('def set_redis_client(client):'),
      'Missing set_redis_client');
  });
});

describe('L2-04: Daemon integration', () => {
  it('11. set_redis_client called after Redis startup', () => {
    assert.ok(DAEMON.includes('set_redis_client(_redis_client)'),
      'Missing set_redis_client call in daemon');
  });
});

describe('L2-05: Graceful degradation', () => {
  it('12. Redis functions wrapped in try/except', () => {
    // _redis_embed_get and _redis_embed_set both have try/except
    const getBlock = PG_STORE.slice(PG_STORE.indexOf('def _redis_embed_get'));
    const setBlock = PG_STORE.slice(PG_STORE.indexOf('def _redis_embed_set'));
    assert.ok(getBlock.includes('except Exception:'),
      '_redis_embed_get must have try/except');
    assert.ok(setBlock.includes('except Exception:'),
      '_redis_embed_set must have try/except');
  });
  it('13. L1 cache still intact', () => {
    assert.ok(PG_STORE.includes('_QUERY_EMBED_CACHE'),
      'L1 cache dict must still exist');
    assert.ok(PG_STORE.includes('_QUERY_EMBED_TTL'),
      'L1 cache TTL must still exist');
    assert.ok(PG_STORE.includes('_QUERY_EMBED_MAX'),
      'L1 cache max must still exist');
  });
});
