-- GSD-Amauta Migration 030: RLM chunk provenance + cheap staleness short-circuit
--
-- Three columns on rlm_chunks, all additive:
--
--   embedding_model TEXT
--     services/rlm_embeddings.py writes Voyage `voyage-code-3` vectors and
--     Qodo `qodo-embed-1-1.5b` vectors (zero-padded from 1536 to 1024) into the
--     SAME embedding_code column, with nothing recording which produced a row.
--     Cosine distance between two different embedding spaces is noise, so a
--     mixed table silently degrades every vector leg. This column records the
--     producing model per row; services/rlm_search.py filters the vector leg to
--     the model that embedded the query, and rows from any other model fall
--     back to their BM25 rank instead of polluting the ranking.
--     NULL = written before this migration, provenance unknown.
--
--   file_mtime DOUBLE PRECISION / file_size BIGINT
--     services/rlm_ingestion.py's is_stale() SHA-256s every byte of every file
--     on every /query, because rlm-service.py calls ingest_directory() per
--     query. Recording stat() results lets the common case (file untouched)
--     short-circuit before the hash. NULL = unknown, so the hash still runs.
--
-- This migration is idempotent: safe to re-run.
--
-- Predecessor: 013-code-embeddings.sql (added embedding_code to rlm_chunks via
-- the same ADD COLUMN IF NOT EXISTS form); 029-sqlite-import-compat.sql.

BEGIN;

ALTER TABLE rlm_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

ALTER TABLE rlm_chunks
  ADD COLUMN IF NOT EXISTS file_mtime DOUBLE PRECISION;

ALTER TABLE rlm_chunks
  ADD COLUMN IF NOT EXISTS file_size BIGINT;

-- The vector leg filters on embedding_model; without this index that filter is
-- a seq-scan predicate on a table that grows with the codebase.
CREATE INDEX IF NOT EXISTS idx_rlm_chunks_embedding_model
  ON rlm_chunks (embedding_model)
  WHERE embedding_code IS NOT NULL;

COMMENT ON COLUMN rlm_chunks.embedding_model IS
  'Model that produced embedding_code (e.g. voyage-code-3, qodo-embed-1-1.5b). '
  'NULL = pre-migration-029 row, provenance unknown. Search filters the vector '
  'leg to the active model so Voyage and Qodo vectors are never compared.';

COMMENT ON COLUMN rlm_chunks.file_mtime IS
  'st_mtime of the source file at ingest time — staleness short-circuit.';

COMMENT ON COLUMN rlm_chunks.file_size IS
  'st_size of the source file at ingest time — staleness short-circuit.';

COMMIT;
