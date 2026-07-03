-- GSD-Amauta Migration 026 DOWN: revert bi-temporal validity columns
-- Phase 66: Memory Ranking & Lifecycle / MEMR-08
--
-- Drops the partial validity index and both bi-temporal columns. This is a
-- destructive, lossy rollback -- any invalid_at history recorded by the
-- write-time classifier is discarded. Safe to re-run (IF EXISTS everywhere).

BEGIN;

DROP INDEX IF EXISTS idx_gsd_memory_currently_valid;

ALTER TABLE gsd_memory
  DROP COLUMN IF EXISTS invalid_at;

ALTER TABLE gsd_memory
  DROP COLUMN IF EXISTS valid_at;

COMMIT;
