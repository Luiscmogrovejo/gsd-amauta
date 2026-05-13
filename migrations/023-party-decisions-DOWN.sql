-- GSD-Amauta Migration 023 DOWN: Reverse Phase 51 decision_type extension
-- Phase 51: PARTY-03
-- Drops the partial index added by 023 UP, then drops the decision_type column.
-- Idempotent (IF EXISTS guards).

BEGIN;
DROP INDEX IF EXISTS idx_agent_findings_session_decision;
ALTER TABLE agent_findings
  DROP COLUMN IF EXISTS decision_type;
COMMIT;
