-- GSD-Amauta Migration 015 DOWN: Drop agent messages blackboard table (COMM-02)
-- Phase 38: Blackboard Communication
-- Reverses 015-agent-messages.sql

BEGIN;

DROP INDEX IF EXISTS idx_messages_to;
DROP INDEX IF EXISTS idx_messages_task;
DROP TABLE IF EXISTS agent_messages;

COMMIT;
