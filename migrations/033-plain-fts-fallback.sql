-- GSD-Amauta Migration 033: plain-PostgreSQL full-text substitutes for the
-- BM25 indexes that 011, 012 and 025 skip when pg_search is absent.
-- Phase 89 / decision D3, plan 89-06 (requirements RET-02, FND-02).
--
-- WHY THIS FILE EXISTS
-- ────────────────────
-- pg_search is OPTIONAL as of plan 89-06: it has no Windows build, and until
-- ParadeDB v0.26.6 (2026-11-08) no macOS build either, so the 412
-- Postgres-gated tests could not run on two of the three supported systems.
-- 011 and 012 now skip their BM25 objects with a RAISE NOTICE instead of
-- aborting the whole schema, and the lexical leg of every search routes to
-- to_tsvector/ts_rank_cd (services/rlm_search.py `_has_pg_search`). This file
-- gives that leg its indexes.
--
-- A ParadeDB DATABASE MUST COME OUT OF THIS FILE BYTE-UNCHANGED
-- ─────────────────────────────────────────────────────────────
-- Every statement sits inside the inverse of 025's guard -- `IF NOT EXISTS
-- (SELECT 1 FROM pg_extension WHERE extname = 'pg_search')` -- so on a
-- database that HAS the extension nothing here runs at all and `pg_indexes` is
-- identical before and after. tests/test_89_06_pg_search_optional.py asserts
-- exactly that by diffing pg_indexes across the apply.
--
-- THE INDEX EXPRESSIONS ARE NOT FREE-HAND SQL
-- ───────────────────────────────────────────
-- They are the text `services/rlm_search.py:fts_vector_sql()` emits for the
-- same column list, because an expression index is only used when the query's
-- expression parses to the same tree. tests/test_89_06_lexical_fallback.py
-- pins the builder's output against the two literals below, so the pair cannot
-- drift into a silent sequential scan.
--
--   weight A = the Phase 22 caveman `description` (the ^2.0-boosted field of
--              services/rlm_search.py `_boosted_rlm_query`)
--   weight B = `content`
--   weight C = `symbol_name`
--
-- ts_rank_cd's weight array {D,C,B,A} = {0.1, 0.4, 0.4, 0.8} then reproduces
-- that boost exactly: description counts 2x content, symbol_name 1x content.
-- `file_path` rides in the BM25 index but in NEITHER engine's query (see
-- `_boosted_rlm_query`), so it is deliberately absent here too.
--
-- `coalesce(col, '')` is defensive, not decorative: `to_tsvector(NULL)` is NULL
-- and NULL || tsvector is NULL, which would make a row invisible rather than
-- loud. Every column named here is NOT NULL today (012:19-39, 001-init.sql).
--
-- gsd_memory: migration 004-fulltext-indexes.sql:6-7 already carries
-- `idx_gsd_memory_fts` = to_tsvector('english', text), UNCONDITIONALLY. That
-- index serves memory_search's legacy ts_rank rung and is NOT this file's; the
-- weighted expression below is a different expression and therefore needs its
-- own index, under its own distinct name. Reusing the name `idx_gsd_memory_fts`
-- would collide with 004 on every engine and would make "the substitutes exist
-- only where the BM25 indexes do not" untestable.
--
-- 011's bm25_test_idx gets NO substitute: bm25_test_table is a three-row
-- INFRA-03 smoke table, its only reader is
-- tests/test_pg_substrate.py::test_infra03_bm25_query_returns_results, and a
-- sequential to_tsvector scan over three rows needs no index. 011's sentinel
-- therefore rests on bm25_test_table, which 011 creates unconditionally.
--
-- This migration is idempotent: safe to re-run (CREATE INDEX IF NOT EXISTS
-- inside the guard).
-- DOWN: 033-plain-fts-fallback-DOWN.sql drops exactly these two indexes.

BEGIN;

-- RLM-02 substitute: the lexical leg of hybrid_search/bm25_only_search over
-- rlm_chunks when idx_rlm_chunks_bm25 was skipped by 012's guard.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
        RAISE NOTICE 'pg_search extension installed — skipping idx_rlm_chunks_fts (the ParadeDB BM25 leg answers; this database is unchanged by migration 033)';
    ELSE
        CREATE INDEX IF NOT EXISTS idx_rlm_chunks_fts ON rlm_chunks
            USING GIN ((setweight(to_tsvector('english', coalesce(description, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B') || setweight(to_tsvector('english', coalesce(symbol_name, '')), 'C')));
    END IF;
END $$;

-- MEMR-03 substitute: the lexical leg of memory_search's rung 1 over
-- gsd_memory when idx_gsd_memory_bm25 was skipped by 025's guard.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
        RAISE NOTICE 'pg_search extension installed — skipping idx_gsd_memory_fts_fallback (the ParadeDB BM25 leg answers; this database is unchanged by migration 033)';
    ELSE
        CREATE INDEX IF NOT EXISTS idx_gsd_memory_fts_fallback ON gsd_memory
            USING GIN ((setweight(to_tsvector('english', coalesce(text, '')), 'A')));
    END IF;
END $$;

COMMIT;
