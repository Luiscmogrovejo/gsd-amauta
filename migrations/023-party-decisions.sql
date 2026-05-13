-- GSD-Amauta Migration 023: Add decision_type column for Phase 51 Party Mode Decisions
-- Phase 51: PARTY-03
-- Adds decision_type VARCHAR(16) (nullable, no CHECK — enforced at write site in
-- services/party_session.post_decision()) and one partial index for trail queries.
-- Additive + idempotent. Existing rows have NULL decision_type which list_decisions
-- treats as non-decision findings (filtered out by WHERE decision_type IS NOT NULL).

BEGIN;

ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS decision_type VARCHAR(16);

CREATE INDEX IF NOT EXISTS idx_agent_findings_session_decision
  ON agent_findings (session_id, decision_type, created_at)
  WHERE decision_type IS NOT NULL;

COMMENT ON COLUMN agent_findings.decision_type IS
  'Phase 51 PARTY-03 frozen vocabulary: propose | agree | dissent | block. NULL = non-decision finding. CHECK constraint deliberately omitted; vocabulary enforced at write site in services/party_session.post_decision().';

COMMIT;
