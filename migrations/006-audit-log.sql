-- Migration 006: Audit Log (Phase 6)
-- Immutable, append-only audit trail for all task lifecycle events.
-- Tracks validations (pass/fail/force), RPETD phase logs, status changes, and claims.
-- CRITICAL: No UPDATE or DELETE operations on this table — only INSERT and SELECT.

CREATE TABLE IF NOT EXISTS gsd_audit_log (
    id              SERIAL PRIMARY KEY,
    task_id         VARCHAR(20) NOT NULL,
    event_type      VARCHAR(50) NOT NULL,   -- 'validation', 'rpetd_phase', 'status_change', 'claim'
    agent_id        VARCHAR(100),
    actor           VARCHAR(200),           -- SSO subject or agent name
    phase           VARCHAR(5),             -- R/P/E/T/D for rpetd events
    status          VARCHAR(20),            -- pass/fail/force for validations
    gate_results    JSONB,                  -- structured gate pass/fail for validations
    content         TEXT,                   -- phase content or validation notes
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_task    ON gsd_audit_log(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_type    ON gsd_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_created ON gsd_audit_log(created_at);
