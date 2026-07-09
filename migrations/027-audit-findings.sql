-- GSD-Amauta Migration 027: Audit-findings substrate (Phase 78 SUBS-01/02)
-- Extends agent_findings so a finding can be an auditable, routable, dedup-able,
-- closeable defect (not just a task-scoped note). ADDITIVE + backward-compatible:
-- existing columns and all four readers (hydrator, security pipeline, MCP,
-- party_session) are untouched. task_id is relaxed to NULLABLE so a standalone
-- audit finding needs no originating task. Idempotent (IF NOT EXISTS everywhere).
BEGIN;

ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS rule_id       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS domain        VARCHAR(32),
  ADD COLUMN IF NOT EXISTS file_path     TEXT,
  ADD COLUMN IF NOT EXISTS evidence      TEXT,
  ADD COLUMN IF NOT EXISTS suggested_fix TEXT,
  ADD COLUMN IF NOT EXISTS dedup_key     VARCHAR(128),
  ADD COLUMN IF NOT EXISTS status        VARCHAR(16) DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS ticket_id     VARCHAR(128),
  ADD COLUMN IF NOT EXISTS audit_run_id  UUID;

-- SUBS-02: standalone audit findings predate any task. Existing rows keep their
-- task_id; existing readers filter `task_id = %s`, so a NULL simply never matches.
ALTER TABLE agent_findings ALTER COLUMN task_id DROP NOT NULL;

-- Support indexes for the sweep (SUBS-04) and dedup (SUBS-05) query paths.
CREATE INDEX IF NOT EXISTS idx_agent_findings_dedup
  ON agent_findings (dedup_key, status);
CREATE INDEX IF NOT EXISTS idx_agent_findings_domain
  ON agent_findings (domain, severity);
CREATE INDEX IF NOT EXISTS idx_agent_findings_audit_run
  ON agent_findings (audit_run_id);

COMMENT ON COLUMN agent_findings.dedup_key IS
  'Phase 78 SUBS-05: rule_id || '':'' || sha1(file_path). Enforced open/ticketed uniqueness at write time.';
COMMENT ON COLUMN agent_findings.status IS
  'Phase 78 SUBS-01: open|ticketed|fixed|cleared|wontfix. Default open.';

COMMIT;
