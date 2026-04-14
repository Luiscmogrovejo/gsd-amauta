-- GSD-Amauta Migration 016: Agent metrics table (LIFE-02)
-- Phase 39: Agent Lifecycle (CAPSTONE)
-- Creates agent_metrics table for tracking agent execution performance.
-- Records task completion times, token usage, error counts, and outcomes.
-- Used by GET /api/metrics/stats for per-agent aggregated reporting.

BEGIN;

-- LIFE-02: Agent metrics table.
-- Records one row per task execution per agent.
-- Outcome must be one of: 'pass', 'fail', 'partial'.
CREATE TABLE agent_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name VARCHAR(64) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  completion_time_ms INTEGER,
  token_usage INTEGER,
  error_count INTEGER DEFAULT 0,
  outcome VARCHAR(16) NOT NULL, -- 'pass', 'fail', 'partial'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primary lookup: retrieve all metrics for a specific agent.
CREATE INDEX idx_metrics_agent ON agent_metrics(agent_name);

COMMIT;
