-- GSD-Amauta Migration 018 DOWN: Drop task completions table (SCALE-03)
-- Reverses migration 018-task-completions.sql

BEGIN;
DROP INDEX IF EXISTS idx_task_completions_embedding;
DROP INDEX IF EXISTS idx_task_completions_outcome;
DROP TABLE IF EXISTS task_completions;
COMMIT;
