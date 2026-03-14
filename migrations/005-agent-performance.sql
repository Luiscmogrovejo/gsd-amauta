-- Migration 005: Agent Performance Tracking (Auto-Learning Feedback Loop)
-- Records task validation outcomes per agent to enable performance-aware enrichment.
-- Agents that frequently fail specific gates receive targeted tips at claim time.

CREATE TABLE IF NOT EXISTS gsd_agent_performance (
    id              SERIAL PRIMARY KEY,
    agent_id        VARCHAR(64) NOT NULL,
    task_id         VARCHAR(32) NOT NULL,
    task_type       VARCHAR(32) DEFAULT 'task',
    project_id      VARCHAR(128) DEFAULT 'default',
    outcome         VARCHAR(16) NOT NULL CHECK (outcome IN ('pass', 'fail')),
    gate_failed     VARCHAR(32),          -- NULL if pass; 'BRANCH_EVIDENCE', 'LEARNING_BLOCK', etc.
    failure_reason  TEXT,                 -- validator notes
    duration_minutes INTEGER,             -- time from claim to validate
    learning_captured TEXT,               -- LEARNING block text (if any)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agent_perf_agent
    ON gsd_agent_performance (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_perf_agent_outcome
    ON gsd_agent_performance (agent_id, outcome);
CREATE INDEX IF NOT EXISTS idx_agent_perf_created
    ON gsd_agent_performance (created_at DESC);
