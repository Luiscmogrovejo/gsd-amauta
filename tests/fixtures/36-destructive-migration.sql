-- @testing-only: Phase 36 destructive migration fixture for gsd-executor-data testing.
-- This migration is DESTRUCTIVE: contains all 4 operations that trigger
-- the expand-and-contract warning in gsd-executor-data.
-- Expected behavior: agent warns and suggests 3-step alternative for each operation.

-- WARNING: These operations are DESTRUCTIVE and should use expand-and-contract pattern.

BEGIN;

-- 1. DROP COLUMN (data loss) -- triggers expand-and-contract
ALTER TABLE gsd_tasks DROP COLUMN IF EXISTS sprint;

-- 2. RENAME COLUMN (breaks callers) -- triggers expand-and-contract
ALTER TABLE gsd_memory RENAME COLUMN agent_id TO owner_id;

-- 3. ALTER TYPE with data loss risk (narrowing) -- triggers expand-and-contract
ALTER TABLE gsd_shared_kb ALTER COLUMN category TYPE VARCHAR(16);

-- 4. DROP TABLE (data loss) -- triggers expand-and-contract
DROP TABLE IF EXISTS gsd_agent_performance;

COMMIT;
