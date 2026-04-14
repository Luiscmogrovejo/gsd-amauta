-- GSD-Amauta Migration 016 DOWN: Agent metrics table rollback (LIFE-02)
-- Phase 39: Agent Lifecycle (CAPSTONE)
-- Drops agent_metrics table and its indexes.

BEGIN;

DROP INDEX IF EXISTS idx_metrics_agent;
DROP TABLE IF EXISTS agent_metrics;

COMMIT;
