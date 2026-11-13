-- DOWN for 034-embedding-blue-green.sql
-- Drops the blue/green staging columns, their partial indexes and
-- embedding_state. The LIVE vector columns are untouched. What is lost: any
-- half-built target vectors (they can be rebuilt by the backfill), and the
-- record of which model produced each vector on the five tables that gained
-- embedding_model here. rlm_chunks.embedding_model belongs to migration 030 and
-- is NOT dropped.

BEGIN;

DROP INDEX IF EXISTS idx_gsd_memory_embedding_next_hnsw;
DROP INDEX IF EXISTS idx_gsd_memory_archive_embedding_next_hnsw;
DROP INDEX IF EXISTS idx_semantic_cache_query_embedding_next_hnsw;
DROP INDEX IF EXISTS idx_rlm_chunks_embedding_code_next_hnsw;
DROP INDEX IF EXISTS idx_task_completions_embedding_next_hnsw;
DROP INDEX IF EXISTS idx_skill_invocations_context_embedding_next_hnsw;

ALTER TABLE gsd_memory DROP COLUMN IF EXISTS embedding_next;
ALTER TABLE gsd_memory DROP COLUMN IF EXISTS embedding_model_next;
ALTER TABLE gsd_memory DROP COLUMN IF EXISTS embedding_model;

ALTER TABLE gsd_memory_archive DROP COLUMN IF EXISTS embedding_next;
ALTER TABLE gsd_memory_archive DROP COLUMN IF EXISTS embedding_model_next;
ALTER TABLE gsd_memory_archive DROP COLUMN IF EXISTS embedding_model;

ALTER TABLE semantic_cache DROP COLUMN IF EXISTS query_embedding_next;
ALTER TABLE semantic_cache DROP COLUMN IF EXISTS embedding_model_next;
ALTER TABLE semantic_cache DROP COLUMN IF EXISTS embedding_model;

ALTER TABLE rlm_chunks DROP COLUMN IF EXISTS embedding_code_next;
ALTER TABLE rlm_chunks DROP COLUMN IF EXISTS embedding_model_next;

ALTER TABLE task_completions DROP COLUMN IF EXISTS embedding_next;
ALTER TABLE task_completions DROP COLUMN IF EXISTS embedding_model_next;
ALTER TABLE task_completions DROP COLUMN IF EXISTS embedding_model;

ALTER TABLE skill_invocations DROP COLUMN IF EXISTS context_embedding_next;
ALTER TABLE skill_invocations DROP COLUMN IF EXISTS embedding_model_next;
ALTER TABLE skill_invocations DROP COLUMN IF EXISTS embedding_model;

DROP TABLE IF EXISTS embedding_state;

COMMIT;
