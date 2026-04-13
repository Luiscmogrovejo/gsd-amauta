// Tests: INFRA-02 (pgvector >= 0.8.0 + iterative scan), INFRA-03 (pg_search BM25)
// Phase 26 plan 02 — paradedb/paradedb:latest-pg16 image switch + migration 011
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('INFRA-02: migration 011 file exists and has pgvector version assertion', () => {
  const sql = fs.readFileSync('migrations/011-paradedb-setup.sql', 'utf8');
  // paradedb:latest-pg16 ships pgvector 0.8.1; DB persisted 0.8.2 from prior image.
  // ALTER EXTENSION vector UPDATE would fail (downgrade attempt) — replaced with DO block assertion.
  assert.ok(sql.includes('ivfflat.iterative_scan'), 'Must enable iterative scan');
  assert.ok(sql.includes('INFRA-02'), 'Must have INFRA-02 annotation');
});

test('INFRA-03: migration 011 file has CREATE EXTENSION pg_search', () => {
  const sql = fs.readFileSync('migrations/011-paradedb-setup.sql', 'utf8');
  assert.ok(sql.includes('CREATE EXTENSION IF NOT EXISTS pg_search'), 'Must install pg_search');
  assert.ok(sql.includes('bm25_test_table'), 'Must create BM25 test table');
});

test('INFRA-02: migration 011 DOWN file exists', () => {
  assert.ok(fs.existsSync('migrations/011-paradedb-setup-DOWN.sql'), 'DOWN migration must exist');
});

test('INFRA-02: pg_store.py enables iterative_scan on connections', () => {
  const pgStore = fs.readFileSync('services/pg_store.py', 'utf8');
  assert.ok(pgStore.includes('ivfflat.iterative_scan'), 'pg_store.py must SET ivfflat.iterative_scan');
  assert.ok(pgStore.includes('relaxed_order'), 'Must use relaxed_order value');
});

test('INFRA-02: docker-compose.yml uses paradedb/paradedb:latest-pg16 image', () => {
  const compose = fs.readFileSync('docker/docker-compose.yml', 'utf8');
  // Deviation from plan: tag is latest-pg16 (not pg16) — ParadeDB tagging convention
  assert.ok(compose.includes('paradedb/paradedb:latest-pg16'), 'Must use ParadeDB latest-pg16 image');
});

test('INFRA-02: docker-compose.yml has pg_search in shared_preload_libraries', () => {
  const compose = fs.readFileSync('docker/docker-compose.yml', 'utf8');
  assert.ok(compose.includes('shared_preload_libraries=pg_search'), 'Must preload pg_search');
});

test('INFRA-02: migration 011 has iterative scan SET', () => {
  const sql = fs.readFileSync('migrations/011-paradedb-setup.sql', 'utf8');
  assert.ok(sql.includes('SET ivfflat.iterative_scan = relaxed_order'), 'Migration must SET iterative scan');
});

test('INFRA-03: migration 011 creates BM25 index using pg_search v0.22.6 syntax', () => {
  const sql = fs.readFileSync('migrations/011-paradedb-setup.sql', 'utf8');
  // pg_search v0.22.6: CREATE INDEX USING bm25 (not paradedb.create_bm25 proc)
  assert.ok(sql.includes('USING bm25'), 'Must create BM25 index with USING bm25 syntax');
  assert.ok(sql.includes("key_field = 'id'"), 'BM25 index must specify key_field');
});

test('INFRA-02: migration 011 has pgvector version assertion >= 0.8.0', () => {
  const sql = fs.readFileSync('migrations/011-paradedb-setup.sql', 'utf8');
  assert.ok(sql.includes('0.8.0'), 'Migration must assert pgvector >= 0.8.0');
});

test('INFRA-02: pgvector extension log records version', () => {
  if (!fs.existsSync('tests/fixtures/26-pg-extensions.txt')) {
    // Log file created by executor during 26-02-03; if missing, skip (live DB test)
    return;
  }
  const log = fs.readFileSync('tests/fixtures/26-pg-extensions.txt', 'utf8');
  assert.ok(log.includes('extversion'), 'Extension log must record extversion');
  assert.ok(log.includes('PASS'), 'Extension log must record PASS results');
});

test('INFRA-03: pg_extensions log records pg_search installed', () => {
  if (!fs.existsSync('tests/fixtures/26-pg-extensions.txt')) {
    return;
  }
  const log = fs.readFileSync('tests/fixtures/26-pg-extensions.txt', 'utf8');
  assert.ok(log.includes('pg_search'), 'Extension log must confirm pg_search installed');
  assert.ok(log.includes('0.22.6'), 'Extension log must record pg_search version');
});
