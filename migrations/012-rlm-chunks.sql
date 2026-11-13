-- GSD-Amauta Migration 012: RLM chunks table + ParadeDB BM25 index (RLM-01, RLM-02)
-- Phase 27: The Retrieval Rewrite (v2.9 Nervous System)
-- Creates rlm_chunks table for AST-aware code chunks indexed via pg_search BM25.
-- BM25 params match current rlm-service.py tuning (v2.5 Phase 3 MIT Paper Audit):
--   b=0.6 (length normalization, reduced from Tantivy default 0.75)
--   position_decay=0.05 (later chunks scored lower)
--   label boost: 1.5x with 3.0*idf cap
-- Upsert key: (file_path, symbol_name, start_line)
-- Staleness detection: sha256 column (Phase 21 SHA-256 pattern from 009-rpetd-context.sql)
-- This migration is idempotent: safe to re-run.
--
-- Predecessor: 011-paradedb-setup.sql (pg_search installed IF AVAILABLE, bm25_test_table created)
-- Dependency: the BM25 index below needs the pg_search extension; the table does
--   not. Phase 89 / D3 (plan 89-06) made that index conditional -- see its guard.

BEGIN;

-- RLM-01: Create rlm_chunks table for AST-aware code chunks.
-- Each row represents one complete function, class, method, or legacy fixed-char chunk.
CREATE TABLE IF NOT EXISTS rlm_chunks (
    id              SERIAL PRIMARY KEY,
    file_path       TEXT NOT NULL,
    symbol_name     TEXT NOT NULL DEFAULT '',
    symbol_type     TEXT NOT NULL DEFAULT 'legacy',
    -- symbol_type values: 'function', 'class', 'method', 'module', 'legacy'
    start_line      INTEGER NOT NULL DEFAULT 0,
    end_line        INTEGER NOT NULL DEFAULT 0,
    content         TEXT NOT NULL,
    -- caveman description (chunk-level, from Phase 22 chunk-mode extension)
    description     TEXT NOT NULL DEFAULT '',
    -- SHA-256 of content for staleness detection (Phase 21 pattern, b=0.6 tuning preserved)
    sha256          CHAR(64) NOT NULL DEFAULT '',
    -- dependencies extracted by AST walker (array of symbol_name strings)
    dependencies    TEXT[] NOT NULL DEFAULT '{}',
    -- dependents (callers) extracted by AST walker
    dependents      TEXT[] NOT NULL DEFAULT '{}',
    -- embedding_code vector(1024) added in migration 013
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint for upsert-by-identity (file_path + symbol_name + start_line)
CREATE UNIQUE INDEX IF NOT EXISTS idx_rlm_chunks_upsert_key
    ON rlm_chunks (file_path, symbol_name, start_line);

-- Index for staleness check by file_path + sha256
CREATE INDEX IF NOT EXISTS idx_rlm_chunks_file_sha
    ON rlm_chunks (file_path, sha256);

-- Index for fast file-level chunk retrieval
CREATE INDEX IF NOT EXISTS idx_rlm_chunks_file_path
    ON rlm_chunks (file_path);

-- RLM-02: Create BM25 index on rlm_chunks using pg_search.
-- BM25 tuning: b=0.6 matches rlm-service.py BM25_B=0.6 (MIT Paper Audit, v2.5 Phase 3).
-- position_decay=0.05: later chunks in a file scored lower (applied at query time).
-- pg_search 0.22.6 uses CREATE INDEX USING bm25 WITH (key_field, ...).
-- Index both content and description for label-boost equivalent:
--   content: the actual code text
--   description: caveman description (symbol_name|type|params|returns|deps)
-- Note: pg_search does not expose b/position_decay as index params in 0.22.6;
--   b=0.6 and position_decay=0.05 are implemented at query time via custom scoring SQL
--   (see Wave 3 RRF hybrid query in plan 27-03). The index uses pg_search defaults
--   for storage; ranking adjustments apply in the search query.
--
-- Phase 89 / decision D3 (plan 89-06): guarded in the DO block
-- migrations/025-memory-hybrid-index.sql:35-46 already uses. The rlm_chunks
-- TABLE above is unconditional -- only this index needs pg_search. Testing
-- `pg_extension` (not `pg_available_extensions`) is right HERE: 011 is the file
-- that installs the extension, so by the time 012 runs the catalogue already
-- carries the answer, including 011's `gsd.lexical_engine = 'postgres_fts'`
-- opt-out. The substitute for this index is idx_rlm_chunks_fts, created by
-- migrations/033-plain-fts-fallback.sql with the condition inverted.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
        RAISE NOTICE 'pg_search extension not installed — skipping idx_rlm_chunks_bm25 (RLM-02 BM25 leg falls back to plain PostgreSQL full-text via migration 033''s idx_rlm_chunks_fts; ranking differs from the ParadeDB BM25 leg)';
    ELSE
        DROP INDEX IF EXISTS idx_rlm_chunks_bm25;
        CREATE INDEX idx_rlm_chunks_bm25 ON rlm_chunks
            USING bm25 (id, content, description, symbol_name, file_path)
            WITH (key_field = 'id');
    END IF;
END $$;

COMMENT ON TABLE rlm_chunks IS
    'Phase 27 RLM-01/RLM-02: AST-aware code chunks with pg_search BM25 index. '
    'Each row = one complete function/class/method or legacy fixed-char chunk. '
    'Upsert key: (file_path, symbol_name, start_line). '
    'SHA-256 staleness detection. BM25 tuning (b=0.6, position_decay=0.05) applied at query time.';

COMMIT;
