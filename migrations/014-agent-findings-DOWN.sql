-- GSD-Amauta Migration 014 DOWN: Drop agent findings blackboard table (COMM-01)
-- Phase 38: Blackboard Communication
-- Reverses 014-agent-findings.sql

BEGIN;

DROP INDEX IF EXISTS idx_findings_task;
DROP TABLE IF EXISTS agent_findings;

COMMIT;
