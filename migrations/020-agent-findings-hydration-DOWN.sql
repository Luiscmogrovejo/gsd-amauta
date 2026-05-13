-- GSD-Amauta Migration 020 DOWN: Reverse Phase 47 agent_findings extension
-- Phase 47: HYDRA-01
-- Drops the two indexes added by 020 UP, then drops the two columns.
-- Idempotent (IF EXISTS guards). Does NOT touch Phase 38 baseline rows beyond
-- removing the two NULL-able columns added in 020 UP.

BEGIN;
DROP INDEX IF EXISTS idx_agent_findings_finding_type_recent;
DROP INDEX IF EXISTS idx_agent_findings_recipient;
ALTER TABLE agent_findings
  DROP COLUMN IF EXISTS severity,
  DROP COLUMN IF EXISTS recipient_agent;
COMMIT;
