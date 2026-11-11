-- GSD-Amauta Migration 028: project-scoping backfill journal (TK-2229)
-- Every gsd_tasks row said project_id = 'default' because nothing ever wrote the
-- column: tasks.json carried no project_id key at all, and pg_store.task_upsert
-- fell back to item.get("project_id", "default") for every row.
--
-- This migration adds NO column and changes NO task row. It creates the journal
-- that makes the backfill REVERSIBLE: scripts/backfill-project-id.py writes one
-- row here for every task whose project_id it changes, recording the old value
-- and the evidence rule that claimed it. 028-DOWN restores project_id from this
-- journal and drops the table, so the backfill is undoable in SQL alone.
--
-- Idempotent (IF NOT EXISTS everywhere).
BEGIN;

CREATE TABLE IF NOT EXISTS gsd_task_project_backfill (
  task_id         VARCHAR(16)  NOT NULL,
  old_project_id  VARCHAR(128) NOT NULL,
  new_project_id  VARCHAR(128) NOT NULL,
  rule            VARCHAR(32)  NOT NULL,
  evidence        TEXT,
  batch_id        UUID         NOT NULL,
  applied_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_task_project_backfill_batch
  ON gsd_task_project_backfill (batch_id);
CREATE INDEX IF NOT EXISTS idx_task_project_backfill_rule
  ON gsd_task_project_backfill (rule);

COMMENT ON TABLE gsd_task_project_backfill IS
  'TK-2229: one row per task whose project_id the backfill changed. Read by 028-DOWN to revert.';
COMMENT ON COLUMN gsd_task_project_backfill.rule IS
  'TK-2229: which evidence rule claimed the row -- repo_tag | repo_path | plan_owner | title_prefix.';
COMMENT ON COLUMN gsd_task_project_backfill.evidence IS
  'TK-2229: the literal evidence string the rule matched, so a reviewer can check the attribution.';

COMMIT;
