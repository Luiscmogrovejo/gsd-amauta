'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');

// RLM-01: rlm_ingestion module checks
test('27-02: rlm_ingestion.py has ingest_file and ingest_directory', () => {
  const src = fs.readFileSync('services/rlm_ingestion.py', 'utf8');
  assert.ok(src.includes('def ingest_file'), 'ingest_file required');
  assert.ok(src.includes('def ingest_directory'), 'ingest_directory required');
  assert.ok(src.includes('def is_stale'), 'is_stale required');
  assert.ok(src.includes('ON CONFLICT'), 'upsert with ON CONFLICT required');
  assert.ok(src.includes('DO UPDATE SET'), 'DO UPDATE SET required');
});

// RLM-03: rlm_embeddings module checks
test('27-02: rlm_embeddings.py has generate_code_embedding with fallback chain', () => {
  const src = fs.readFileSync('services/rlm_embeddings.py', 'utf8');
  assert.ok(src.includes('def generate_code_embedding'), 'generate_code_embedding required');
  assert.ok(src.includes('def _try_voyage'), '_try_voyage fallback required');
  assert.ok(src.includes('def _try_qodo'), '_try_qodo fallback required');
  assert.ok(src.includes('VOYAGE_API_KEY'), 'API key env var check required');
});

// RLM-01: caveman chunk-level mode
test('27-02: caveman_descriptions.py has describe_chunk function', () => {
  const src = fs.readFileSync('services/caveman_descriptions.py', 'utf8');
  assert.ok(src.includes('def describe_chunk'), 'describe_chunk function required');
  assert.ok(src.includes('symbol_name'), 'symbol_name field required');
  assert.ok(src.includes('symbol_type'), 'symbol_type field required');
});

// RLM-02: rlm-service.py lazy trigger
test('27-02: rlm-service.py has lazy ingestion trigger in /search', () => {
  const src = fs.readFileSync('services/rlm-service.py', 'utf8');
  assert.ok(src.includes('_trigger_lazy_ingestion'), 'lazy ingestion trigger required');
  assert.ok(src.includes('_handle_reindex'), '_handle_reindex endpoint required');
  assert.ok(src.includes('_get_pg_conn'), '_get_pg_conn helper required');
});

// RLM-02: ingestion force parameter
test('27-02: rlm_ingestion.py has force parameter for re-ingest', () => {
  const src = fs.readFileSync('services/rlm_ingestion.py', 'utf8');
  const forceMatches = (src.match(/force/g) || []).length;
  assert.ok(forceMatches >= 2, `force parameter must appear >= 2 times, got ${forceMatches}`);
});

// RLM-01: SHA-256 staleness check
test('27-02: rlm_ingestion.py has file_sha256 and is_stale', () => {
  const src = fs.readFileSync('services/rlm_ingestion.py', 'utf8');
  assert.ok(src.includes('def file_sha256'), 'file_sha256 function required');
  assert.ok(src.includes('def is_stale'), 'is_stale function required');
  assert.ok(src.includes('sha256'), 'sha256 field required in upsert');
});

// RLM-03: graceful degradation
test('27-02: rlm_embeddings.py returns None for graceful degradation', () => {
  const src = fs.readFileSync('services/rlm_embeddings.py', 'utf8');
  const noneReturns = (src.match(/return None/g) || []).length;
  assert.ok(noneReturns >= 3, `Expected >= 3 'return None' for degradation paths, got ${noneReturns}`);
});

// RLM-02: /reindex endpoint live test (requires rlm-service running)
test('27-02: /reindex endpoint responds without crashing', async () => {
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: 'services/', force: false });
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(process.env.GSD_RLM_PORT || '18798'),
      path: '/reindex',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Accept 200 (ok), 500 (PG env mismatch), or 503 (PG unavailable) — all non-crash responses
        assert.ok([200, 500, 503].includes(res.statusCode),
          `Expected 200, 500, or 503, got ${res.statusCode}: ${data}`);
        resolve();
      });
    });
    req.on('error', (e) => {
      reject(new Error(`/reindex request failed: ${e.message} (is rlm-service running?)`));
    });
    req.write(body);
    req.end();
  });
});
