-- DOWN for 029-sqlite-import-compat.sql
--
-- NOT fully reversible by design:
--   * gsd_tasks.title is NOT narrowed back to VARCHAR(512). 58 live rows are
--     longer than that; narrowing would raise 22001 or silently truncate real
--     titles. Leaving the column as TEXT is harmless — every VARCHAR(512)
--     value is a valid TEXT value.
--   * gsd_memory_archive is NOT dropped. It holds soft-deleted memory rows
--     that exist nowhere else; dropping it is data loss, and pg_store.py's
--     _ensure_archive_table would recreate it empty on the next retention run.
--
-- Only the index this migration added is removed.

BEGIN;

DROP INDEX IF EXISTS idx_gsd_memory_archive_archived_at;

COMMIT;
