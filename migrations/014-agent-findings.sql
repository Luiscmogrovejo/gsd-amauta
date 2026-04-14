-- GSD-Amauta Migration 014: Agent findings blackboard table (COMM-01)
-- Phase 38: Blackboard Communication
-- Creates agent_findings table for agents to share findings with each other.
-- Queried by task_id (not semantic search -- pgvector is v3.1 scope).
-- NO embedding column: findings are written and read by task context, not similarity.

BEGIN;

-- COMM-01: Agent findings blackboard table.
-- Agents write observations, decisions, warnings, and blockers here
-- so other agents can read them during task execution.
CREATE TABLE agent_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name VARCHAR(64) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  finding_type VARCHAR(32) NOT NULL, -- 'observation', 'decision', 'warning', 'blocker'
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0.8,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primary lookup: retrieve all findings for a task in recency order.
CREATE INDEX idx_findings_task ON agent_findings(task_id);

COMMIT;
