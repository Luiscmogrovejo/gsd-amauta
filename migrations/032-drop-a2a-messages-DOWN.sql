-- GSD-Amauta Migration 032 DOWN: recreate a2a_messages (Phase 89 plan 89-05)
--
-- A real reverse, not an apology: the DDL below is COPIED VERBATIM from
-- migrations/024-a2a-messages.sql -- same column order, same types, same
-- nullability, same default, same CHECK constraint name, same index name, same
-- table COMMENT. A paraphrased DOWN recreates a table that merely looks like the
-- original, and the difference only shows up in whatever reads it next.
--
-- Running this DOWN does NOT bring the feature back: the client, the breaker, the
-- registry, the CLI verbs and GET /a2a/exchanges were deleted in the same plan.
-- It restores the SCHEMA, which is what a DOWN owes its UP.

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
