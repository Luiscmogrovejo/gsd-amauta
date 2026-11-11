-- GSD-Amauta Migration 028 DOWN: revert the TK-2229 project backfill.
-- Restores gsd_tasks.project_id to the value recorded in the journal, then drops
-- the journal table. Reverts EVERY batch; to revert one batch only, run the
-- UPDATE below with an extra `AND b.batch_id = '<uuid>'` and do not drop the table.
--
-- Only rows whose current value still matches what the backfill wrote are
-- reverted -- a row a human has since re-assigned is left alone rather than
-- silently clobbered.
BEGIN;

UPDATE gsd_tasks t
   SET project_id = b.old_project_id,
       updated_at = NOW()
  FROM gsd_task_project_backfill b
 WHERE t.id = b.task_id
   AND t.project_id = b.new_project_id;

DROP INDEX IF EXISTS idx_task_project_backfill_rule;
DROP INDEX IF EXISTS idx_task_project_backfill_batch;
DROP TABLE IF EXISTS gsd_task_project_backfill;

COMMIT;
