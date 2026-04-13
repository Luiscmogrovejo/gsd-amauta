'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// RLM-01/RLM-02: Golden query fixture validation

test('27-01: 27-golden-queries.json exists', () => {
  assert.ok(
    fs.existsSync('tests/fixtures/27-golden-queries.json'),
    'Golden query fixture must exist at tests/fixtures/27-golden-queries.json'
  );
});

test('27-01: golden queries fixture has exactly 20 queries', () => {
  const d = JSON.parse(fs.readFileSync('tests/fixtures/27-golden-queries.json', 'utf8'));
  assert.strictEqual(d.queries.length, 20, `Expected 20 queries, got ${d.queries.length}`);
});

test('27-01: baseline_mrr is a positive float <= 1.0', () => {
  const d = JSON.parse(fs.readFileSync('tests/fixtures/27-golden-queries.json', 'utf8'));
  assert.ok(typeof d.baseline_mrr === 'number', 'baseline_mrr must be a number');
  assert.ok(d.baseline_mrr > 0, 'baseline_mrr must be > 0');
  assert.ok(d.baseline_mrr <= 1.0, 'baseline_mrr must be <= 1.0');
});

test('27-01: each query has id, query, expected_top3 with 3 entries', () => {
  const d = JSON.parse(fs.readFileSync('tests/fixtures/27-golden-queries.json', 'utf8'));
  for (const q of d.queries) {
    assert.ok(q.id, `Query missing id: ${JSON.stringify(q)}`);
    assert.ok(q.query, `Query missing query text: ${q.id}`);
    assert.ok(Array.isArray(q.expected_top3), `expected_top3 must be array: ${q.id}`);
    assert.strictEqual(q.expected_top3.length, 3, `expected_top3 must have 3 entries: ${q.id}`);
    for (const entry of q.expected_top3) {
      assert.ok(entry.filepath, `expected_top3 entry missing filepath: ${q.id}`);
      assert.ok(entry.label, `expected_top3 entry missing label: ${q.id}`);
    }
  }
});

test('27-01: fixture has baseline_engine and baseline_date', () => {
  const d = JSON.parse(fs.readFileSync('tests/fixtures/27-golden-queries.json', 'utf8'));
  assert.ok(d.baseline_engine, 'baseline_engine field required');
  assert.ok(d.baseline_date, 'baseline_date field required');
});

test('27-01: fixture has mrr_targets for hybrid and reranked', () => {
  const d = JSON.parse(fs.readFileSync('tests/fixtures/27-golden-queries.json', 'utf8'));
  assert.ok(d.mrr_targets, 'mrr_targets field required');
  assert.ok(d.mrr_targets.hybrid_rlm, 'hybrid_rlm target required');
  assert.ok(d.mrr_targets.reranked_rlm, 'reranked_rlm target required');
});

test('27-01: fixture version is 27-01', () => {
  const d = JSON.parse(fs.readFileSync('tests/fixtures/27-golden-queries.json', 'utf8'));
  assert.strictEqual(d.version, '27-01', 'version must be 27-01');
});

// RLM-02: Migration 012 file checks
test('27-01: migration 012 creates rlm_chunks with BM25 index', () => {
  const sql = fs.readFileSync('migrations/012-rlm-chunks.sql', 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS rlm_chunks'), 'rlm_chunks table creation required');
  assert.ok(sql.includes('USING bm25'), 'BM25 index required');
  assert.ok(sql.includes('key_field'), 'key_field parameter required');
  assert.ok(sql.includes('sha256'), 'sha256 column required for staleness detection');
  assert.ok(sql.includes('b=0.6'), 'BM25 tuning b=0.6 comment required');
  assert.ok(sql.includes('position_decay'), 'position_decay tuning comment required');
});

test('27-01: migration 012 DOWN exists and drops rlm_chunks', () => {
  const sql = fs.readFileSync('migrations/012-rlm-chunks-DOWN.sql', 'utf8');
  assert.ok(sql.includes('DROP TABLE IF EXISTS rlm_chunks'), 'rlm_chunks DROP required in DOWN');
});

// RLM-03: Migration 013 file checks
test('27-01: migration 013 adds embedding_code vector(1024) with HNSW', () => {
  const sql = fs.readFileSync('migrations/013-code-embeddings.sql', 'utf8');
  assert.ok(sql.includes('embedding_code vector(1024)'), 'embedding_code column required');
  assert.ok(sql.toLowerCase().includes('hnsw'), 'HNSW index required');
  assert.ok(sql.includes('vector_cosine_ops'), 'cosine ops required');
  assert.ok(
    sql.includes('SEPARATE') || sql.includes('separate'),
    'isolation comment (SEPARATE) required'
  );
  assert.ok(sql.includes('NULL'), 'NULL graceful degradation comment required');
});

test('27-01: migration 013 DOWN exists and drops embedding_code', () => {
  const sql = fs.readFileSync('migrations/013-code-embeddings-DOWN.sql', 'utf8');
  assert.ok(sql.includes('DROP COLUMN IF EXISTS embedding_code'), 'embedding_code DROP required in DOWN');
});

// RLM-01: AST chunker module content checks
test('27-01: ast_chunker.py exports required functions', () => {
  const src = fs.readFileSync('services/ast_chunker.py', 'utf8');
  assert.ok(src.includes('def chunk_file_ast'), 'chunk_file_ast function required');
  assert.ok(src.includes('def legacy_chunker'), 'legacy_chunker function required');
  assert.ok(src.includes('def is_code_file'), 'is_code_file function required');
  assert.ok(src.includes('"symbol_name"'), 'symbol_name in metadata schema required');
  assert.ok(src.includes('"symbol_type"'), 'symbol_type in metadata schema required');
  assert.ok(src.includes('"dependencies"'), 'dependencies in metadata schema required');
  assert.ok(src.includes('"dependents"'), 'dependents in metadata schema required');
});

// Requirements.txt checks
test('27-01: requirements.txt has networkx, voyageai, sentence-transformers', () => {
  const req = fs.readFileSync('requirements.txt', 'utf8');
  assert.ok(req.includes('networkx'), 'networkx required for dependency graph (Wave 3)');
  assert.ok(req.includes('voyageai'), 'voyageai required for Voyage Code 3 embeddings (Wave 2)');
  assert.ok(req.includes('sentence-transformers'), 'sentence-transformers required for reranker fallback (Wave 2)');
});
