-- GSD-Amauta Migration 025 DOWN: drop gsd_memory BM25 index
-- Phase 66: Memory Ranking & Lifecycle (MEMR-03)
--
-- Drops idx_gsd_memory_bm25 ONLY. pg_trgm is deliberately LEFT INSTALLED:
-- extensions are not owned by a single index/migration, and MEMR-06's
-- write-time dedup fallback (wave 4, plan 66-04/66-05) and memory_search's
-- trigram rescue rung (plan 66-03) both hold a live dependency on
-- similarity()/word_similarity() independent of this BM25 index's lifecycle.
-- Dropping pg_trgm here would silently break those consumers on a rollback
-- that has nothing to do with the BM25 leg.

BEGIN;

DROP INDEX IF EXISTS idx_gsd_memory_bm25;

-- pg_trgm intentionally NOT dropped — see header comment.

COMMIT;
