-- DOWN migration for 009-rpetd-context.sql
-- Drops the rpetd_context table and its indexes.

BEGIN;

DROP INDEX IF EXISTS idx_rpetd_context_task_phase;
DROP INDEX IF EXISTS idx_rpetd_context_task_id;
DROP TABLE IF EXISTS rpetd_context;

COMMIT;
