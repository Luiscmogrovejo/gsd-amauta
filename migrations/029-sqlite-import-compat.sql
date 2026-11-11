-- GSD-Amauta Migration 029: make the PG schema able to hold the live SQLite data
-- Prerequisite for services/migrate_sqlite_to_pg.py.
--
-- Two gaps found by measuring the real SQLite database before writing the
-- importer (~/.amauta/data/gsd_amauta.db, read-only snapshot, 2026-11-11):
--
--   1. gsd_tasks.title is VARCHAR(512) in 001-init.sql, but 58 of the 2 917
--      live task rows have a title longer than 512 characters (longest: 1 281).
--      SQLite's TEXT has no length limit, so those rows were accepted there and
--      would each raise 22001 (string_data_right_truncation) on import. Widening
--      to TEXT keeps every row intact instead of silently truncating titles.
--      No index, constraint or view depends on the declared length, so the
--      ALTER is a catalog-only change on PostgreSQL (no table rewrite).
--
--   2. gsd_memory_archive existed only as a lazy CREATE TABLE IF NOT EXISTS
--      inside services/pg_store.py (_ensure_archive_table), so a freshly
--      migrated database has no archive table until memory_retention_cleanup()
--      happens to run. The live SQLite DB holds 537 archived rows that would
--      have nowhere to land. Declared here with EXACTLY the column list
--      _ensure_archive_table creates, so the lazy path stays a no-op.
--
-- This migration is idempotent: safe to re-run.
--
-- Predecessor: 026-bitemporal-memory.sql (additive ALTER + IF NOT EXISTS
-- precedent); 027-audit-findings.sql (previous highest number).

BEGIN;

-- 1. Widen gsd_tasks.title so long titles survive the SQLite import.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gsd_tasks'
          AND column_name = 'title'
          AND character_maximum_length IS NOT NULL
    ) THEN
        ALTER TABLE gsd_tasks ALTER COLUMN title TYPE TEXT;
    END IF;
END $$;

-- 2. Declare gsd_memory_archive up front (same shape as pg_store.py's lazy
--    _ensure_archive_table, which keeps working and becomes a no-op).
CREATE TABLE IF NOT EXISTS gsd_memory_archive (
    id          VARCHAR(64) PRIMARY KEY,
    text        TEXT NOT NULL,
    agent_id    VARCHAR(64),
    source      VARCHAR(64),
    tags        JSONB DEFAULT '[]'::jsonb,
    metadata    JSONB DEFAULT '{}'::jsonb,
    project_id  VARCHAR(128),
    embedding   vector(1024),
    created_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ,
    archived_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gsd_memory_archive_archived_at
    ON gsd_memory_archive (archived_at DESC);

COMMENT ON TABLE gsd_memory_archive IS
    'Soft-deleted gsd_memory rows (memory_retention_cleanup). Declared in '
    'migration 029 so a SQLite import has somewhere to put archived rows.';

COMMIT;
