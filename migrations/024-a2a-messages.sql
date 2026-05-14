-- GSD-Amauta Migration 024: A2A messages table (Phase 55 A2A-01)
-- Phase 55: A2A Protocol Foundation
-- Creates a2a_messages for direct agent-to-agent request/response/error/retry.
-- Mirrors Phase 50 migration 021 + Phase 51 migration 023 conventions:
-- IF NOT EXISTS guards, BEGIN/COMMIT wrap, COMMENT on table, DOWN file.
-- Distinct from agent_messages (Phase 38 blackboard): this is request/response RPC.

BEGIN;

CREATE TABLE IF NOT EXISTS a2a_messages (
  correlation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_correlation_id UUID,                               -- nullable: Phase 56 threading
  from_agent            VARCHAR(64) NOT NULL,
  to_agent              VARCHAR(64) NOT NULL,
  capability            VARCHAR(128) NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb, -- empty body is '{}'::jsonb, never NULL
  kind                  VARCHAR(16) NOT NULL,               -- frozen vocab: request|response|error|retried
  status                VARCHAR(64) NOT NULL DEFAULT 'pending',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at          TIMESTAMPTZ,                        -- set when kind IN ('response','error')
  CONSTRAINT a2a_messages_kind_chk CHECK (kind IN ('request','response','error','retried'))
);

CREATE INDEX IF NOT EXISTS idx_a2a_messages_to_agent_status
  ON a2a_messages (to_agent, status);

COMMENT ON TABLE a2a_messages IS
  'Phase 55 A2A-01: direct agent-to-agent RPC message store. Distinct from agent_messages (Phase 38 blackboard). kind vocab frozen: request|response|error|retried. parent_correlation_id reserved for Phase 56 threading (A2A-06).';

COMMIT;
