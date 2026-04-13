-- DOWN: Migration 011 rollback
-- Note: ALTER EXTENSION vector UPDATE cannot be rolled back (no DOWNGRADE).
-- DROP EXTENSION pg_search removes pg_search and its indexes.

BEGIN;

DROP TABLE IF EXISTS bm25_test_table CASCADE;
DROP EXTENSION IF EXISTS pg_search;

-- pgvector downgrade is not supported by the extension mechanism.
-- Comment: ALTER EXTENSION vector UPDATE to prior version requires manual intervention.

COMMIT;
