-- GSD-Amauta Migration 011: pgvector upgrade (INFRA-02) + ParadeDB pg_search (INFRA-03)
-- Phase 26: The Substrate (v2.9 Nervous System)
-- Installs pg_search (BM25) and verifies pgvector >= 0.8.0 is active.
-- Both extensions must be available as binaries in the paradedb/paradedb:latest-pg16 image.
-- This migration is idempotent: safe to re-run.
--
-- Image versions: pgvector 0.8.1 (shipped by paradedb:latest-pg16), pg_search 0.22.6
--
-- Prerequisites:
--   docker-compose.yml postgres command must include: -c shared_preload_libraries=pg_search
--   (pg_search v0.22.6 requires shared_preload_libraries before CREATE EXTENSION)
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
SET ivfflat.iterative_scan = relaxed_order;

-- INFRA-03: Install ParadeDB pg_search extension (BM25 full-text search in PostgreSQL).
-- Requires paradedb/paradedb:latest-pg16 image with pg_search in shared_preload_libraries.
-- pg_search version in this image: 0.22.6
CREATE EXTENSION IF NOT EXISTS pg_search;

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

-- INFRA-03: Create BM25 index on bm25_test_table using pg_search v0.22.6 syntax.
-- DROP and recreate to ensure idempotency (pg_search indexes cannot use IF NOT EXISTS).
-- API note: paradedb.create_bm25() proc does not exist in v0.22.6; use CREATE INDEX USING bm25.
DROP INDEX IF EXISTS bm25_test_idx;
CREATE INDEX bm25_test_idx ON bm25_test_table
    USING bm25 (id, content)
    WITH (key_field = 'id');

COMMENT ON TABLE bm25_test_table IS
    'Phase 26 INFRA-03: BM25 smoke-test table. Verify with: SELECT * FROM bm25_test_table WHERE bm25_test_table @@@ ''content:hello'';';

COMMIT;
