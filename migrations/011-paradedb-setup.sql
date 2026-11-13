-- GSD-Amauta Migration 011: pgvector upgrade (INFRA-02) + ParadeDB pg_search (INFRA-03)
-- Phase 26: The Substrate (v2.9 Nervous System)
-- Installs pg_search (BM25) WHEN IT IS AVAILABLE and verifies pgvector >= 0.8.0.
-- This migration is idempotent: safe to re-run.
--
-- Phase 89 / decision D3 (plan 89-06): pgvector is REQUIRED and its assertion
-- below stays HARD; pg_search is OPTIONAL. On a server without it the
-- extension and its BM25 index are skipped with a RAISE NOTICE, migration
-- 033-plain-fts-fallback.sql creates plain-PostgreSQL full-text substitutes,
-- and the lexical leg of every search routes to to_tsvector/ts_rank_cd
-- (services/rlm_search.py `_has_pg_search`). `doctor` and `/health` name the
-- engine that is actually answering, so the ranking divergence is reported and
-- never silent.
--
-- Image versions: pgvector 0.8.1 (shipped by paradedb:latest-pg16), pg_search 0.22.6
--
-- Prerequisites:
--   pgvector >= 0.8.0 installed (001-init.sql); the assertion below is hard.
--   For the pg_search half ONLY: docker-compose.yml's postgres command must
--   include -c shared_preload_libraries=pg_search (pg_search v0.22.6 requires
--   it before CREATE EXTENSION). Its absence is now a degradation, not a
--   migration failure.
--
-- Note on ALTER EXTENSION vector UPDATE: skipped — paradedb:latest-pg16 ships pgvector 0.8.1
-- which satisfies INFRA-02 (>= 0.8.0). The running DB already has 0.8.1 installed.
-- ALTER EXTENSION UPDATE to a lower version is not supported by PostgreSQL and would fail.

BEGIN;

-- INFRA-02: Verify pgvector version is >= 0.8.0 (assertion — no UPDATE needed).
-- paradedb/paradedb:latest-pg16 ships pgvector 0.8.1 which satisfies this requirement.
-- The DO block raises an exception if the installed version is below the required minimum.
DO $$
DECLARE
  v TEXT;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  IF v IS NULL THEN
    RAISE EXCEPTION 'pgvector extension not installed';
  END IF;
  -- Version check: require >= 0.8.0
  IF string_to_array(v, '.')::int[] < string_to_array('0.8.0', '.')::int[] THEN
    RAISE EXCEPTION 'pgvector version % is below required 0.8.0', v;
  END IF;
END $$;

-- INFRA-02: Enable iterative index scans for filtered vector queries.
-- This session-level SET is also applied in pg_store.py _get_conn() for application connections.
-- Setting it here ensures it is applied for any psql session during migration testing.
-- Phase 66 MEMR-07: corrected from ivfflat (the only vector index is HNSW;
-- session-scoped SET -- safe to edit in an applied migration).
SET hnsw.iterative_scan = relaxed_order;

-- INFRA-03: Create a BM25 test table for smoke-test verification.
-- This table is used only for INFRA-03 acceptance testing; Phase 27 will create production rlm_chunks.
CREATE TABLE IF NOT EXISTS bm25_test_table (
    id      SERIAL PRIMARY KEY,
    content TEXT NOT NULL
);

-- INFRA-03: Populate test table with sample rows for BM25 smoke test.
INSERT INTO bm25_test_table (content)
SELECT content FROM (VALUES
    ('hello world from gsd-amauta BM25 test'),
    ('tree-sitter parses JavaScript and Python source code'),
    ('Valkey replaces Redis as the cache layer')
) AS t(content)
WHERE NOT EXISTS (SELECT 1 FROM bm25_test_table LIMIT 1);

-- INFRA-03 / Phase 89 D3: install pg_search and create its BM25 index ONLY when
-- the extension can actually be installed. pg_search is OPTIONAL as of plan
-- 89-06: it has no Windows build at all, and a plain `pgvector/pgvector:pg16`
-- answers `CREATE EXTENSION pg_search` with
--   sqlstate 0A000: extension "pg_search" is not available
-- which used to abort apply_migrations on its FIRST failing file -- so 011
-- failing meant NO schema from 011 onward (every table the party, findings,
-- memory, RLM and handoff tests need). Measured in CI run 43173591322.
--
-- The guard is the block migrations/025-memory-hybrid-index.sql:35-46 already
-- uses (DO $$ ... RAISE NOTICE ... ELSE ... END IF), with two differences this
-- site needs and 025 does not:
--
--   1. 025 tests `pg_extension` (is it INSTALLED here) because 011 is what
--      installs it. 011 itself must test `pg_available_extensions` (is the
--      control file on the server AT ALL) -- a `pg_extension` test here would
--      be self-defeating, since this is the statement that would satisfy it.
--   2. `pg_search` can be available and still unusable: v0.22.6 requires it in
--      shared_preload_libraries, and the macOS .pkg route (plan 89-07) lays the
--      files down before postgresql.conf is edited and the cluster restarted.
--      The two pg_search statements therefore run inside an EXCEPTION block
--      that degrades to the same NOTICE instead of taking the whole schema
--      down. SQLSTATE and SQLERRM are always reported, never swallowed.
--
-- `gsd.lexical_engine = 'postgres_fts'` forces the plain-PostgreSQL leg even
-- where pg_search IS available. It is a real operator switch (pin one engine
-- across a fleet whose macOS and Windows boxes cannot have ParadeDB; reproduce
-- a fallback-engine ranking question on a ParadeDB box) and it is how this
-- plan's own tests obtain a genuinely pg_search-less DATABASE on a ParadeDB
-- CLUSTER. Set it with `ALTER DATABASE <db> SET gsd.lexical_engine =
-- 'postgres_fts'` before the first migration runs. The SETTING is read only
-- here, at create time; every consumer afterwards keys off the single ground
-- truth `pg_extension` (services/infra_detect.py `lexical_engine()`), so the
-- two can never disagree.
--
-- API note: paradedb.create_bm25() proc does not exist in v0.22.6; use
-- CREATE INDEX USING bm25. DROP and recreate for idempotency (pg_search
-- indexes cannot use IF NOT EXISTS).
-- Substitutes for every index skipped here: migrations/033-plain-fts-fallback.sql.
DO $$
DECLARE
    engine_pref TEXT := coalesce(current_setting('gsd.lexical_engine', true), '');
BEGIN
    IF engine_pref = 'postgres_fts' THEN
        RAISE NOTICE 'pg_search skipped: gsd.lexical_engine = postgres_fts — skipping CREATE EXTENSION pg_search and bm25_test_idx (lexical search runs on plain PostgreSQL full-text; ranking differs from the ParadeDB BM25 leg)';
    ELSIF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') THEN
        RAISE NOTICE 'pg_search extension not available on this server — skipping CREATE EXTENSION pg_search and bm25_test_idx (lexical search runs on plain PostgreSQL full-text; ranking differs from the ParadeDB BM25 leg)';
    ELSE
        BEGIN
            CREATE EXTENSION IF NOT EXISTS pg_search;
            DROP INDEX IF EXISTS bm25_test_idx;
            CREATE INDEX bm25_test_idx ON bm25_test_table
                USING bm25 (id, content)
                WITH (key_field = 'id');
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'pg_search available but unusable (sqlstate=%, %) — skipping CREATE EXTENSION pg_search and bm25_test_idx (lexical search runs on plain PostgreSQL full-text; ranking differs from the ParadeDB BM25 leg)', SQLSTATE, SQLERRM;
        END;
    END IF;
END $$;

COMMENT ON TABLE bm25_test_table IS
    'Phase 26 INFRA-03: BM25 smoke-test table. Verify with: SELECT * FROM bm25_test_table WHERE bm25_test_table @@@ ''content:hello'';';

COMMIT;
