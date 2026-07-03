'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');

// RLM-04: rlm_search.py checks
test('27-03: rlm_search.py has hybrid_search with RRF_K=60', () => {
  const src = fs.readFileSync('services/rlm_search.py', 'utf8');
  assert.ok(src.includes('def hybrid_search'), 'hybrid_search required');
  assert.ok(src.includes('RRF_K = 60'), 'RRF_K=60 required');
  assert.ok(src.includes('FULL OUTER JOIN'), 'single SQL RRF with FULL OUTER JOIN required');
  assert.ok(src.includes('paradedb.score'), 'paradedb.score BM25 SQL required');
});

test('27-03: rlm_search.py has bm25_only_search and sanitize', () => {
  const src = fs.readFileSync('services/rlm_search.py', 'utf8');
  assert.ok(src.includes('def bm25_only_search'), 'bm25_only_search required');
  assert.ok(src.includes('def _sanitize_query'), '_sanitize_query required');
  assert.ok(src.includes('graceful degradation'), 'graceful degradation fallback note required');
  assert.ok(src.includes('position_decay'), 'position_decay tuning required');
});

// RLM-05: rlm_reranker.py checks
test('27-03: rlm_reranker.py has rerank with Valkey cache TTL=600', () => {
  const src = fs.readFileSync('services/rlm_reranker.py', 'utf8');
  assert.ok(src.includes('def rerank'), 'rerank function required');
  assert.ok(src.includes('CACHE_TTL = 600'), 'TTL=600 required');
  assert.ok(src.includes('rlm:rerank:'), 'Valkey key prefix required');
  assert.ok(src.includes('cache_hit_rate'), 'cache hit rate logging required');
});

test('27-03: rlm_reranker.py has Jina + sbert fallback', () => {
  const src = fs.readFileSync('services/rlm_reranker.py', 'utf8');
  assert.ok(src.includes('def _try_jina'), '_try_jina required');
  assert.ok(src.includes('def _try_sbert'), '_try_sbert required');
  assert.ok(src.includes('graceful fallback'), 'graceful fallback note required');
});

// RLM-06: rlm_graph.py checks
test('27-03: rlm_graph.py has graph builder and Valkey storage', () => {
  const src = fs.readFileSync('services/rlm_graph.py', 'utf8');
  assert.ok(src.includes('def build_graph_from_pg'), 'build_graph_from_pg required');
  assert.ok(src.includes('def store_graph_in_valkey'), 'store_graph_in_valkey required');
  assert.ok(src.includes('def get_neighbors'), 'get_neighbors required');
  assert.ok(src.includes('rlm:graph:'), 'Valkey key prefix required');
  assert.ok(src.includes('pagerank'), 'PageRank computation required');
  assert.ok(src.includes('graph_callers'), 'graph_callers expansion field required');
});

test('27-03: rlm_graph.py has expand_chunks_with_graph and get_hub_files', () => {
  const src = fs.readFileSync('services/rlm_graph.py', 'utf8');
  assert.ok(src.includes('def expand_chunks_with_graph'), 'expand_chunks_with_graph required');
  assert.ok(src.includes('def get_hub_files'), 'get_hub_files required');
  assert.ok(src.includes('def rebuild_graph'), 'rebuild_graph required');
});

// RLM-02 / Phase 65 RETR-04: rlm-service.py transformation checks
test('27-03: rlm-service.py marks BM25 scorer as DEPRECATED, mtime index fully retired', () => {
  const src = fs.readFileSync('services/rlm-service.py', 'utf8');
  const deprecatedCount = (src.match(/DEPRECATED Phase 27/g) || []).length;
  assert.strictEqual(deprecatedCount, 1, `Expected exactly 1 DEPRECATED marker (BM25 fallback scorer), got ${deprecatedCount}`);
  assert.ok(!/MtimeIndex/.test(src), 'MtimeIndex must not appear in source -- SHA-256 is the single staleness authority');
});

test('27-03: rlm-service.py /search uses hybrid_rrf_reranked engine', () => {
  const src = fs.readFileSync('services/rlm-service.py', 'utf8');
  assert.ok(src.includes('hybrid_search'), 'hybrid_search wired in');
  assert.ok(src.includes('rerank'), 'reranker wired in');
  assert.ok(src.includes('expand_chunks_with_graph'), 'graph expansion wired in');
  assert.ok(src.includes('"engine"'), 'engine field in response');
  assert.ok(src.includes('pg_chunks_count'), 'health endpoint updated');
});

// Live test: /search returns engine field
test('27-03: live /search returns engine field', async () => {
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: 'chunk file function', paths: ['services/'] });
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(process.env.GSD_RLM_PORT || '18798'),
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${data}`);
        const json = JSON.parse(data);
        assert.ok(json.ok === true, 'ok field required');
        assert.ok(json.engine, `engine field required, got: ${JSON.stringify(json)}`);
        assert.ok(['hybrid_rrf_reranked', 'in_memory_bm25'].includes(json.engine),
          `engine must be hybrid_rrf_reranked or in_memory_bm25, got: ${json.engine}`);
        resolve();
      });
    });
    req.on('error', (e) => reject(new Error(`/search failed: ${e.message}`)));
    req.write(body);
    req.end();
  });
});

// Live test: /health returns pg_chunks_count
test('27-03: live /health returns pg_chunks_count field', async () => {
  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(process.env.GSD_RLM_PORT || '18798'),
      path: '/health',
      method: 'GET',
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        assert.strictEqual(res.statusCode, 200);
        const json = JSON.parse(data);
        assert.ok(json.status === 'ok', 'status=ok required');
        assert.ok('pg_chunks_count' in json, `pg_chunks_count field required, got: ${JSON.stringify(json)}`);
        resolve();
      });
    });
    req.on('error', (e) => reject(new Error(`/health failed: ${e.message}`)));
    req.end();
  });
});
