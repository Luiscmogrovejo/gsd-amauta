-- Migration 009: Create rpetd_context table for structured RPETD phase handoffs
-- Phase 20 / HANDOFF-03 (v2.8 "Metabolism")
-- Each RPETD phase boundary stores a typed RPETDContext object (<= 600 tokens)
-- that replaces full conversation forwarding between phases.
-- file_hashes column preps for Phase 21 STALE-01 (avoid second ALTER TABLE).

BEGIN;

CREATE TABLE IF NOT EXISTS rpetd_context (
  id            SERIAL PRIMARY KEY,
  task_id       TEXT NOT NULL,
  phase         TEXT NOT NULL CHECK (phase IN ('R', 'P', 'E', 'T', 'D')),
  compiled_view JSONB NOT NULL,
  full_context  JSONB,
  context_version TEXT,
  file_hashes   JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint: one context per task per phase (upsert target)
CREATE UNIQUE INDEX IF NOT EXISTS idx_rpetd_context_task_phase
  ON rpetd_context (task_id, phase);

-- Fast lookup by task_id for listing all phases of a task
CREATE INDEX IF NOT EXISTS idx_rpetd_context_task_id
  ON rpetd_context (task_id);

COMMENT ON TABLE rpetd_context IS
  'Phase 20 HANDOFF-03: Stores structured RPETDContext objects at each phase boundary. compiled_view is the <= 600 token typed context; full_context is optional raw backup. file_hashes preps for Phase 21 staleness detection.';

COMMIT;
