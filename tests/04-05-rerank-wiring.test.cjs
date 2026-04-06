#!/usr/bin/env node
/**
 * Plan 04-05: Rerank Wiring Tests
 *
 * Tests:
 *   RERANK-01: Import helper
 *     1. _get_pgstore_rerank function exists
 *     2. Helper imports PGStore from pg_store
 *     3. Helper returns PGStore.rerank
 *   RERANK-02: Wiring in _mem_semantic_search
 *     4. Rerank call exists in _mem_semantic_search
 *     5. Guard on len(out) >= 3 before reranking
 *     6. doc_texts extracted from result text fields
 *     7. rerank_fn called with query, doc_texts, top_k
 *   RERANK-03: Result ordering
 *     8. rerank_score key added to reranked results
 *     9. Return reranked[:top_k] for truncation
 *    10. Original out returned when rerank skipped
 *   RERANK-04: Graceful degradation
 *    11. except block contains pass (silent fallback)
 *    12. RLM-07 comment marks the rerank section
 *   RERANK-05: PGStore.rerank still exists
 *    13. rerank method exists in pg_store.py
 *    14. rerank calls rerank-2.5 model
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');
const PG_STORE = path.join(ROOT, 'services', 'pg_store.py');

const amautaContent = fs.readFileSync(AMAUTA_PY, 'utf-8');
const pgStoreContent = fs.readFileSync(PG_STORE, 'utf-8');

// Extract _mem_semantic_search function body
const fnStart = amautaContent.indexOf('def _mem_semantic_search(');
const fnEnd = amautaContent.indexOf('\ndef ', fnStart + 1);
const memSearchBody = amautaContent.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);

describe('RERANK-01: Import helper', () => {
  it('1. _get_pgstore_rerank function exists', () => {
    assert.ok(amautaContent.includes('def _get_pgstore_rerank():'),
      'Missing _get_pgstore_rerank helper');
  });

  it('2. Helper imports PGStore from pg_store', () => {
    assert.ok(amautaContent.includes('from pg_store import PGStore'),
      'Helper should import PGStore');
  });

  it('3. Helper returns PGStore.rerank', () => {
    assert.ok(amautaContent.includes('PGStore.rerank'),
      'Helper should return PGStore.rerank');
  });
});

describe('RERANK-02: Wiring in _mem_semantic_search', () => {
  it('4. Rerank call exists in _mem_semantic_search', () => {
    assert.ok(memSearchBody.includes('rerank_fn('),
      '_mem_semantic_search should call rerank_fn');
  });

  it('5. Guard on len(out) >= 3 before reranking', () => {
    assert.ok(memSearchBody.includes('len(out) >= 3'),
      'Should guard rerank on at least 3 results');
  });

  it('6. doc_texts extracted from result text fields', () => {
    assert.ok(memSearchBody.includes('r["text"] for r in out'),
      'Should extract doc_texts from result text fields');
  });

  it('7. rerank_fn called with query, doc_texts, top_k', () => {
    assert.ok(memSearchBody.includes('rerank_fn(query, doc_texts, top_k=top_k)'),
      'rerank_fn should receive query, doc_texts, and top_k');
  });
});

describe('RERANK-03: Result ordering', () => {
  it('8. rerank_score key added to reranked results', () => {
    assert.ok(memSearchBody.includes('"rerank_score"'),
      'Reranked results should include rerank_score key');
  });

  it('9. Return reranked[:top_k] for truncation', () => {
    assert.ok(memSearchBody.includes('reranked[:top_k]'),
      'Should return top_k reranked results');
  });

  it('10. Original out returned when rerank skipped', () => {
    assert.ok(memSearchBody.includes('return out'),
      'Should return original results when rerank is skipped');
  });
});

describe('RERANK-04: Graceful degradation', () => {
  it('11. Exception handling with pass for silent fallback', () => {
    // Check that the rerank try block has an except with pass
    const rerankSection = memSearchBody.slice(memSearchBody.indexOf('RLM-07'));
    assert.ok(rerankSection.includes('except') && rerankSection.includes('pass'),
      'Should have except/pass for graceful degradation');
  });

  it('12. RLM-07 comment marks the rerank section', () => {
    assert.ok(memSearchBody.includes('RLM-07'),
      'Rerank section should have RLM-07 comment');
  });
});

describe('RERANK-05: PGStore.rerank still exists', () => {
  it('13. rerank method exists in pg_store.py', () => {
    assert.ok(pgStoreContent.includes('def rerank(query, documents, top_k'),
      'PGStore.rerank method must still exist');
  });

  it('14. rerank calls rerank-2.5 model', () => {
    assert.ok(pgStoreContent.includes('rerank-2.5'),
      'PGStore.rerank should use rerank-2.5 model');
  });
});
