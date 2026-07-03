-- GSD-Amauta Migration 025: gsd_memory BM25 index + pg_trgm extension
-- Phase 66: Memory Ranking & Lifecycle
-- MEMR-03: BM25 leg for memory_search's hybrid RRF fusion (via
--          services/rlm_search.py's table-agnostic hybrid_search_generic,
--          Phase 65 / RETR-06 shared-primitive contract).
-- MEMR-06 (forward dependency): pg_trgm powers the trigram-scored ILIKE
--          rescue rung in memory_search (plan 66-03) and wave-4's
--          no-embedding write-time dedup fallback (plan 66-04/66-05).
--          Installed here so both consumers share one extension-create site.
--
-- This migration is idempotent: safe to re-run.
--
-- Predecessor: 012-rlm-chunks.sql (idx_rlm_chunks_bm25 = the live bm25-index
-- syntax precedent this migration copies verbatim); 011-paradedb-setup.sql
-- (defensive DO-block style for extension/version guards).
--
-- Live-verified before authoring (2026-07-03):
--   SELECT extversion FROM pg_extension WHERE extname='pg_search'; -> 0.24.1
--   grep -rn pg_trgm migrations/ services/pg_store.py -> zero hits (absent)

BEGIN;

-- MEMR-06 forward dependency: pg_trgm supplies similarity()/word_similarity()
-- for the trigram-scored ILIKE rescue rung (memory_search rung 3, plan 66-03)
-- and the no-embedding write-dedup fallback (wave 4). Not owned by the BM25
-- index below — see the DOWN migration's comment on why it stays installed
-- even if the index is dropped.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- MEMR-03: BM25 index on gsd_memory over (id, text), matching
-- idx_rlm_chunks_bm25's WITH syntax exactly. Guarded in a DO block that skips
-- with a RAISE NOTICE if pg_search is not installed (parity with 011's
-- defensive style) — index create is NOT wrapped in a transaction-unsafe
-- CONCURRENTLY clause, so this is safe inside the surrounding BEGIN/COMMIT.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
        RAISE NOTICE 'pg_search extension not installed — skipping idx_gsd_memory_bm25 (MEMR-03 BM25 leg will fall back to FTS/ILIKE at query time)';
    ELSE
        DROP INDEX IF EXISTS idx_gsd_memory_bm25;
        CREATE INDEX idx_gsd_memory_bm25 ON gsd_memory
            USING bm25 (id, text)
            WITH (key_field = 'id');
    END IF;
END $$;

COMMENT ON EXTENSION pg_trgm IS
    'Phase 66 MEMR-03/MEMR-06: trigram similarity for the ILIKE rescue rung '
    'in memory_search and the no-embedding write-dedup fallback. Not owned '
    'by any single index — see 025-memory-hybrid-index-DOWN.sql.';

COMMIT;
