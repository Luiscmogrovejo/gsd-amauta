-- GSD-Amauta Migration 021 DOWN: Reverse Phase 50 party_sessions extension
-- Phase 50: Party Mode Foundation (PARTY-01)
-- Drops in reverse order: agent_findings index, session_id column,
-- party_sessions index, party_sessions table.
-- Idempotent (IF EXISTS guards). DROP TABLE is not cascading (deletion
-- semantics deferred per 50-CONTEXT.md §Specifics).

BEGIN;
DROP INDEX IF EXISTS idx_agent_findings_session;
ALTER TABLE agent_findings DROP COLUMN IF EXISTS session_id;
DROP INDEX IF EXISTS idx_party_sessions_status_recent;
DROP TABLE IF EXISTS party_sessions;
COMMIT;
