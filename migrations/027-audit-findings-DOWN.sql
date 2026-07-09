-- GSD-Amauta Migration 027 DOWN: revert Phase 78 audit-findings substrate.
-- Restores the prior schema: task_id back to NOT NULL (backfilling any NULL from
-- audit_run_id first), then drops the three support indexes and the nine columns.
-- Lossy: audit-only columns and any NULL-task_id findings' audit metadata are discarded.
BEGIN;

-- Backfill so the NOT NULL restore cannot fail (must run BEFORE audit_run_id is dropped).
UPDATE agent_findings
   SET task_id = COALESCE(audit_run_id::text, 'audit')
 WHERE task_id IS NULL;

ALTER TABLE agent_findings ALTER COLUMN task_id SET NOT NULL;

DROP INDEX IF EXISTS idx_agent_findings_audit_run;
DROP INDEX IF EXISTS idx_agent_findings_domain;
DROP INDEX IF EXISTS idx_agent_findings_dedup;

ALTER TABLE agent_findings
  DROP COLUMN IF EXISTS audit_run_id,
  DROP COLUMN IF EXISTS ticket_id,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS dedup_key,
  DROP COLUMN IF EXISTS suggested_fix,
  DROP COLUMN IF EXISTS evidence,
  DROP COLUMN IF EXISTS file_path,
  DROP COLUMN IF EXISTS domain,
  DROP COLUMN IF EXISTS rule_id;

COMMIT;
