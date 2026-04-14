-- @testing-only: Phase 36 safe migration fixture for gsd-executor-data testing.
-- This migration is SAFE: purely additive, no destructive operations.
-- Expected behavior: gsd-executor-data generates this without expand-and-contract warning.

-- UP migration: Add nullable columns to gsd_tasks
-- Safe operations: ADD COLUMN IF NOT EXISTS with nullable or DEFAULT values

BEGIN;

ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS review_status VARCHAR(32);
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(64);
ALTER TABLE gsd_tasks ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Safe index addition
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_review_status
    ON gsd_tasks(review_status)
    WHERE review_status IS NOT NULL;

COMMENT ON COLUMN gsd_tasks.review_status IS
    'Phase 36 fixture: nullable review status column (safe additive migration)';

COMMIT;

-- DOWN migration (rollback)
-- BEGIN;
-- ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS review_status;
-- ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS reviewed_by;
-- ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS reviewed_at;
-- DROP INDEX IF EXISTS idx_gsd_tasks_review_status;
-- COMMIT;
