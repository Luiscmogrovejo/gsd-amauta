#!/usr/bin/env node
/**
 * Plan 04-03: Query Embedding Cache Tests
 *
 * Tests:
 *   ECACHE-01: Cache infrastructure
 *     1. _QUERY_EMBED_CACHE dict exists
 *     2. _QUERY_EMBED_TTL is 3600 (1 hour)
 *     3. _QUERY_EMBED_MAX is 500
 *     4. _clear_query_embed_cache function exists
 *   ECACHE-02: Cache key correctness
 *     5. Cache key uses sha256 hash
 *     6. Cache key includes input_type in the hash input
 *     7. Cache key includes model in the hash input
 *     8. Cache key truncated to 16 hex chars
 *   ECACHE-03: Query-only caching guard
 *     9. Cache read gated on input_type == "query"
 *    10. Cache write gated on cache_key (only set for queries)
 *   ECACHE-04: Eviction policy
 *    11. Eviction triggers when len > _QUERY_EMBED_MAX
 *    12. Eviction removes oldest 100 entries (sorted by timestamp)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PG_STORE = path.join(ROOT, 'services', 'pg_store.py');

const content = fs.readFileSync(PG_STORE, 'utf-8');

// ═══════════════════════════════════════════════════════
// ECACHE-01: Cache infrastructure
// ═══════════════════════════════════════════════════════

describe('ECACHE-01: Cache infrastructure', () => {
  it('1. _QUERY_EMBED_CACHE dict exists', () => {
    assert.ok(
      content.includes('_QUERY_EMBED_CACHE: dict = {}'),
      'Missing _QUERY_EMBED_CACHE module-level dict'
    );
  });

  it('2. _QUERY_EMBED_TTL is 3600 (1 hour)', () => {
    assert.ok(
      content.includes('_QUERY_EMBED_TTL = 3600'),
      'TTL should be 3600 seconds (1 hour)'
    );
  });

  it('3. _QUERY_EMBED_MAX is 500', () => {
    assert.ok(
      content.includes('_QUERY_EMBED_MAX = 500'),
      'Max cache entries should be 500'
    );
  });

  it('4. _clear_query_embed_cache function exists', () => {
    assert.ok(
      content.includes('def _clear_query_embed_cache():'),
      'Missing _clear_query_embed_cache function'
    );
  });
});

// ═══════════════════════════════════════════════════════
// ECACHE-02: Cache key correctness
// ═══════════════════════════════════════════════════════

describe('ECACHE-02: Cache key correctness', () => {
  it('5. Cache key uses sha256 hash', () => {
    assert.ok(
      content.includes('sha256('),
      'Cache key should use sha256 hashing'
    );
  });

  it('6. Cache key includes input_type in hash input', () => {
    assert.ok(
      content.includes(':{input_type}:'),
      'Cache key hash input should include input_type'
    );
  });

  it('7. Cache key includes model in hash input', () => {
    assert.ok(
      content.includes(':{use_model}'),
      'Cache key hash input should include model'
    );
  });

  it('8. Cache key truncated to 16 hex chars', () => {
    assert.ok(
      content.includes('.hexdigest()[:16]'),
      'Cache key should be truncated to 16 hex chars'
    );
  });
});

// ═══════════════════════════════════════════════════════
// ECACHE-03: Query-only caching guard
// ═══════════════════════════════════════════════════════

describe('ECACHE-03: Query-only caching guard', () => {
  it('9. Cache read gated on input_type == "query"', () => {
    assert.ok(
      content.includes('if input_type == "query":'),
      'Cache read should only fire for query embeddings'
    );
  });

  it('10. Cache write gated on cache_key existence', () => {
    assert.ok(
      content.includes('if cache_key and embedding:'),
      'Cache write should check cache_key is set (only for queries)'
    );
  });
});

// ═══════════════════════════════════════════════════════
// ECACHE-04: Eviction policy
// ═══════════════════════════════════════════════════════

describe('ECACHE-04: Eviction policy', () => {
  it('11. Eviction triggers when cache exceeds max', () => {
    assert.ok(
      content.includes('len(_QUERY_EMBED_CACHE) > _QUERY_EMBED_MAX'),
      'Eviction should check against _QUERY_EMBED_MAX'
    );
  });

  it('12. Eviction removes oldest 100 entries', () => {
    assert.ok(
      content.includes('sorted_keys[:100]'),
      'Should evict oldest 100 entries in batch'
    );
  });
});
