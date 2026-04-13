-- GSD-Amauta Migration 012 DOWN: Remove rlm_chunks table and BM25 index
-- Reverses 012-rlm-chunks.sql
-- WARNING: This drops all AST chunk data. Run only in development or test environments.

BEGIN;

DROP INDEX IF EXISTS idx_rlm_chunks_bm25;
DROP INDEX IF EXISTS idx_rlm_chunks_file_sha;
DROP INDEX IF EXISTS idx_rlm_chunks_file_path;
DROP INDEX IF EXISTS idx_rlm_chunks_upsert_key;
DROP TABLE IF EXISTS rlm_chunks CASCADE;

COMMIT;
