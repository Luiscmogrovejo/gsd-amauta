-- GSD-Amauta Migration 033 DOWN: drop the plain-PostgreSQL full-text
-- substitutes (Phase 89 plan 89-06).
--
-- Exactly the two indexes 033 creates, by name, and nothing else:
--
--   * idx_rlm_chunks_fts            -- 033's own
--   * idx_gsd_memory_fts_fallback   -- 033's own
--
-- `idx_gsd_memory_fts` is deliberately NOT dropped here. It belongs to
-- migration 004-fulltext-indexes.sql:6-7, it exists on every engine, and
-- memory_search's legacy ts_rank rung reads it -- dropping another migration's
-- index on the way out is how a rollback breaks a feature it never owned
-- (the same reasoning 025-memory-hybrid-index-DOWN.sql gives for leaving
-- pg_trgm installed).
--
-- Unconditional DROP ... IF EXISTS: on a ParadeDB database neither index was
-- ever created, so both statements are no-ops and the database is unchanged --
-- the same shape as its UP.

BEGIN;

DROP INDEX IF EXISTS idx_rlm_chunks_fts;
DROP INDEX IF EXISTS idx_gsd_memory_fts_fallback;

COMMIT;
