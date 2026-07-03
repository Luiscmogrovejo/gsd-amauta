-- GSD-Amauta Migration 026: bi-temporal validity columns on gsd_memory
-- Phase 66: Memory Ranking & Lifecycle
-- MEMR-08 (LAST plan of the phase): valid_at/invalid_at columns SHIP
--          TOGETHER with the write-time mem0-style ADD/UPDATE/DELETE/NOOP
--          classifier (services/memory_classifier.py) and its pg_store.py
--          wiring in the SAME plan (66-05) -- research pitfall 4: columns
--          without a classifier that populates them silently never get
--          used, so this migration is never landed alone.
--
-- Bi-temporal contract:
--   valid_at    -- when the fact became true from the store's perspective.
--                  Existing rows become valid-from-migration-time (DEFAULT
--                  now() backfills every pre-existing row on ALTER).
--   invalid_at  -- when the fact's validity window was closed. NULL means
--                  "currently valid". The write-time classifier is the ONLY
--                  writer of this column (UPDATE/DELETE ops set it via
--                  `invalid_at = now()`); no row is ever physically
--                  DELETEd for a classifier decision -- bi-temporal means
--                  history is preserved, only the validity window closes.
--
-- Partial index (WHERE invalid_at IS NULL) keeps the "currently valid"
-- read path (memory_search / memory_semantic_search / dedup candidate
-- queries, all guarded by pg_store.py's cached _has_bitemporal() check)
-- cheap without indexing invalidated (historical) rows.
--
-- This migration is idempotent: safe to re-run (IF NOT EXISTS everywhere).
--
-- Predecessor: 008-applied-count.sql (additive ALTER + DOWN precedent);
-- 025-memory-hybrid-index.sql (wave-3 file -- confirms the ceiling at 025
-- before this migration's number was discovered dynamically via `ls
-- migrations/`).

BEGIN;

ALTER TABLE gsd_memory
  ADD COLUMN IF NOT EXISTS valid_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE gsd_memory
  ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;

-- Partial index: only currently-valid rows (invalid_at IS NULL) are ever
-- queried by the read/dedup paths guarded by _has_bitemporal() -- this
-- keeps the index small even as invalidated (historical) rows accumulate.
CREATE INDEX IF NOT EXISTS idx_gsd_memory_currently_valid
  ON gsd_memory (created_at)
  WHERE invalid_at IS NULL;

COMMENT ON COLUMN gsd_memory.valid_at IS
  'Phase 66 MEMR-08: bi-temporal validity start. Existing rows backfilled to migration time; new rows default to now() at INSERT.';

COMMENT ON COLUMN gsd_memory.invalid_at IS
  'Phase 66 MEMR-08: bi-temporal validity end. NULL = currently valid. Set ONLY by the write-time classifier (UPDATE/DELETE ops close a target''s window); rows are never physically deleted for a classifier decision.';

COMMIT;
