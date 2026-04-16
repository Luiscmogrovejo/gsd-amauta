-- GSD-Amauta Migration 017: Step handoffs table (SHARD-04)
-- Phase 41: Sharded Workflows (FOUNDATION)
-- Creates step_handoffs table for tracking step-level execution state across sharded workflows.
-- Enables step resumption, rollback, and handoff validation between workflow steps.
-- Used by GET /api/steps/:workflow/:phase and POST /api/steps/:workflow/:phase/handoff.

BEGIN;

-- SHARD-04: Step handoffs table.
-- Records one row per step transition — append-only log, not upserted.
-- context_snapshot is the RPETD-compatible carry-forward (<=600 tokens).
CREATE TABLE step_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(32) NOT NULL,
  step_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  phase_number INTEGER NOT NULL,
  completed_steps TEXT[] DEFAULT '{}',
  context_snapshot JSONB NOT NULL,
  artifacts JSONB DEFAULT '{}',
  decisions JSONB DEFAULT '[]',
  user_inputs JSONB DEFAULT '[]',
  next_step VARCHAR(64),
  escalation_flags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primary lookup: retrieve handoffs for a specific task across workflows.
CREATE INDEX idx_handoffs_task ON step_handoffs(task_id, workflow_name);

-- Recency lookup: find latest handoff for a workflow+phase to resume execution.
CREATE INDEX idx_handoffs_latest ON step_handoffs(workflow_name, phase_number, created_at DESC);

COMMIT;
