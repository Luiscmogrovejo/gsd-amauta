-- 034-embedding-blue-green.sql
-- Phase 89 plan 89-08 (RET-05): the embedding model is a setting, and a model
-- change is a BLUE/GREEN re-embed. New vectors are built beside the old ones,
-- queries stay on the old set until the new one is complete and passes the
-- relevance check, and the switch is one recorded cutover.
--
-- Per vector table this adds:
--   <col>_next            vector(1024)  the vectors being built for the target model
--   embedding_model       TEXT          which model produced <col>   (rlm_chunks has it since 030)
--   embedding_model_next  TEXT          which model produced <col>_next
--   a PARTIAL HNSW index on <col>_next  (WHERE <col>_next IS NOT NULL: free while empty)
--
-- and one table, embedding_state, keyed by use (memory | code_index | rerank).
--
-- NO TABLE IS REWRITTEN. `ALTER TABLE ... ADD COLUMN` with no DEFAULT and no
-- NOT NULL is a catalog-only change on PostgreSQL: it writes pg_attribute and
-- nothing else, however many rows the table holds. The same reasoning
-- 029-sqlite-import-compat.sql:7-13 used for widening gsd_tasks.title. The test
-- (tests/test_89_08_blue_green_backfill.py) asserts it through
-- pg_class.relfilenode, which changes when and only when a table is rewritten.
--
-- No dimension changes: voyage-code-4, voyage-code-3, voyage-4 and
-- voyage-4-large all return 1024 dimensions by default, and all six columns are
-- vector(1024). Vectors of two models are still not comparable, which is what
-- embedding_model records and what services/embedding_backfill.py enforces.
--
-- embedding_model IS NULL on a row that carries a vector means "provenance
-- unknown". From this migration on that is treated as ANOTHER model: a store
-- holding such a row refuses a vector query (`embedding_model_mixed`) until the
-- backfill has rebuilt it. Migration 030 called NULL "acceptable"; that was
-- right while provenance was being introduced and is exactly how a mixed store
-- would keep answering.
--
-- The seeded active models are the catalogue defaults
-- (get-shit-done/config/embedding-models.json `uses.*.default`); a test asserts
-- the two agree. ON CONFLICT DO NOTHING: re-running never resets a live state.
--
-- This migration is idempotent: safe to re-run.
-- Predecessor: 033-plain-fts-fallback.sql.

BEGIN;

-- gsd_memory.embedding
ALTER TABLE gsd_memory ADD COLUMN IF NOT EXISTS embedding_next vector(1024);
ALTER TABLE gsd_memory ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE gsd_memory ADD COLUMN IF NOT EXISTS embedding_model_next TEXT;
CREATE INDEX IF NOT EXISTS idx_gsd_memory_embedding_next_hnsw
  ON gsd_memory USING hnsw (embedding_next vector_cosine_ops)
  WHERE embedding_next IS NOT NULL;

-- gsd_memory_archive.embedding
ALTER TABLE gsd_memory_archive ADD COLUMN IF NOT EXISTS embedding_next vector(1024);
ALTER TABLE gsd_memory_archive ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE gsd_memory_archive ADD COLUMN IF NOT EXISTS embedding_model_next TEXT;
CREATE INDEX IF NOT EXISTS idx_gsd_memory_archive_embedding_next_hnsw
  ON gsd_memory_archive USING hnsw (embedding_next vector_cosine_ops)
  WHERE embedding_next IS NOT NULL;

-- semantic_cache.query_embedding
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS query_embedding_next vector(1024);
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE semantic_cache ADD COLUMN IF NOT EXISTS embedding_model_next TEXT;
CREATE INDEX IF NOT EXISTS idx_semantic_cache_query_embedding_next_hnsw
  ON semantic_cache USING hnsw (query_embedding_next vector_cosine_ops)
  WHERE query_embedding_next IS NOT NULL;

-- rlm_chunks.embedding_code (embedding_model exists since migration 030)
ALTER TABLE rlm_chunks ADD COLUMN IF NOT EXISTS embedding_code_next vector(1024);
ALTER TABLE rlm_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE rlm_chunks ADD COLUMN IF NOT EXISTS embedding_model_next TEXT;
CREATE INDEX IF NOT EXISTS idx_rlm_chunks_embedding_code_next_hnsw
  ON rlm_chunks USING hnsw (embedding_code_next vector_cosine_ops)
  WHERE embedding_code_next IS NOT NULL;

-- task_completions.embedding
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS embedding_next vector(1024);
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS embedding_model_next TEXT;
CREATE INDEX IF NOT EXISTS idx_task_completions_embedding_next_hnsw
  ON task_completions USING hnsw (embedding_next vector_cosine_ops)
  WHERE embedding_next IS NOT NULL;

-- skill_invocations.context_embedding
ALTER TABLE skill_invocations ADD COLUMN IF NOT EXISTS context_embedding_next vector(1024);
ALTER TABLE skill_invocations ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE skill_invocations ADD COLUMN IF NOT EXISTS embedding_model_next TEXT;
CREATE INDEX IF NOT EXISTS idx_skill_invocations_context_embedding_next_hnsw
  ON skill_invocations USING hnsw (context_embedding_next vector_cosine_ops)
  WHERE context_embedding_next IS NOT NULL;

-- The progress, provenance and single-switch record, one row per use.
CREATE TABLE IF NOT EXISTS embedding_state (
    use             TEXT PRIMARY KEY
                    CHECK (use IN ('memory', 'code_index', 'rerank')),
    active_model    TEXT NOT NULL,
    target_model    TEXT,
    previous_model  TEXT,
    phase           TEXT NOT NULL DEFAULT 'steady'
                    CHECK (phase IN ('steady', 'backfilling', 'cutover_ready')),
    started_at      TIMESTAMPTZ,
    rows_total      BIGINT NOT NULL DEFAULT 0,
    rows_done       BIGINT NOT NULL DEFAULT 0,
    tokens_spent    BIGINT NOT NULL DEFAULT 0,
    budget_tokens   BIGINT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO embedding_state (use, active_model) VALUES
    ('memory',     'voyage-code-4'),
    ('code_index', 'voyage-code-4'),
    ('rerank',     'rerank-3')
ON CONFLICT (use) DO NOTHING;

COMMENT ON TABLE embedding_state IS
  'One row per use (memory, code_index, rerank). active_model is the model whose '
  'vectors queries read; target_model is the model a blue/green backfill is '
  'building in the *_next columns. Written only by services/embedding_backfill.py.';

COMMENT ON COLUMN rlm_chunks.embedding_model IS
  'Model that produced embedding_code. NULL on a row that carries a vector means '
  'provenance unknown and is treated as ANOTHER model: a vector query is refused '
  '(embedding_model_mixed) until the backfill rebuilds it (migration 034).';

COMMIT;
