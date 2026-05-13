-- GSD-Amauta Migration 021: Party sessions table (Phase 50 PARTY-01)
-- Phase 50: Party Mode Foundation
-- Creates party_sessions table + extends agent_findings with session_id FK.
-- Mirrors Phase 47 migration 020 + Phase 42 migration 018 conventions:
-- IF NOT EXISTS guards, BEGIN/COMMIT wrap, COMMENT on table, DOWN file.

BEGIN;

CREATE TABLE IF NOT EXISTS party_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(16) NOT NULL DEFAULT 'created',  -- created|active|paused|terminated
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["gsd-planner","gsd-checker",...]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  CONSTRAINT party_sessions_status_chk CHECK (status IN ('created','active','paused','terminated'))
);

CREATE INDEX IF NOT EXISTS idx_party_sessions_status_recent
  ON party_sessions (status, updated_at DESC);

COMMENT ON TABLE party_sessions IS
  'Phase 50 PARTY-01: multi-agent collaboration session anchor. Findings reference session_id via agent_findings.session_id column added by this migration.';

ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES party_sessions(session_id);

CREATE INDEX IF NOT EXISTS idx_agent_findings_session
  ON agent_findings (session_id, created_at)
  WHERE session_id IS NOT NULL;

COMMIT;
