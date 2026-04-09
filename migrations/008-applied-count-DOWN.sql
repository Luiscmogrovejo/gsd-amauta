-- Migration 008 DOWN: Remove applied_count column from gsd_memory
-- Phase 10 / LEARN-05 (v2.6 "Sight Beyond Sight")
-- Rolls back migration 008-applied-count.sql.
-- WARNING: Dropping this column loses all citation counts. Only use for dev rollback
-- or emergency revert when the kill switch GSD_D_STRUCTURED=false is insufficient.

BEGIN;

DROP INDEX IF EXISTS idx_gsd_memory_applied_count;

ALTER TABLE gsd_memory
  DROP COLUMN IF EXISTS applied_count;

COMMIT;
