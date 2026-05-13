-- GSD-Amauta Migration 020: Extend agent_findings for Phase 47 Agent Dynamic Hydration
-- Phase 47: HYDRA-01
-- Adds recipient_agent + severity columns and two supporting indexes for the hydrator
-- query `WHERE recipient_agent IS NULL OR recipient_agent = $1`. Additive + idempotent.
-- Existing rows (Phase 38 baseline) have NULL recipient_agent which the hydrator
-- treats as broadcast — no backfill required.

BEGIN;

-- Phase 47 Agent Dynamic Hydration — extend agent_findings for HYDRA-01..02
ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS recipient_agent VARCHAR(64),
  ADD COLUMN IF NOT EXISTS severity VARCHAR(16);

-- Index for the `WHERE recipient_agent IS NULL OR recipient_agent = $1` hydration query
CREATE INDEX IF NOT EXISTS idx_agent_findings_recipient
  ON agent_findings (recipient_agent, created_at DESC);

-- Index for security pipeline filter
CREATE INDEX IF NOT EXISTS idx_agent_findings_finding_type_recent
  ON agent_findings (finding_type, created_at DESC);

COMMENT ON COLUMN agent_findings.recipient_agent IS
  'Target agent name for direct messages. NULL = broadcast. Phase 47 HYDRA-01.';
COMMENT ON COLUMN agent_findings.severity IS
  'Severity classification: info | warning | error | critical. Phase 47 HYDRA-01.';

-- Phase 47 finding_type vocabulary extension (documented, not enforced via CHECK):
--   security_alert  (security pipeline)
--   lint_violation  (BEHAV-04 lint guardrails)
--   circuit_breaker_open  (BEHAV-02 circuit breakers)

COMMIT;
