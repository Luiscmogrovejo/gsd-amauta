-- GSD-Amauta Migration 013 DOWN: Remove code embedding column from rlm_chunks
-- Reverses 013-code-embeddings.sql

BEGIN;

DROP INDEX IF EXISTS idx_rlm_chunks_has_embedding;
DROP INDEX IF EXISTS idx_rlm_chunks_embedding_hnsw;
ALTER TABLE rlm_chunks DROP COLUMN IF EXISTS embedding_code;

COMMIT;
