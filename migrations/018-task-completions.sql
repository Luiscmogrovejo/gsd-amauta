-- GSD-Amauta Migration 018: Task completions table (SCALE-03)
-- Phase 42: Scale-Adaptive Intelligence
-- Creates task_completions table for recording per-task complexity scoring outcomes.
-- Enables SCALE-03 logistic regression calibration over historical feature vectors.
-- Embedding column (vector(1024)) matches existing voyage-code-3 stack (see migration 013).
-- ivfflat index (lists=100) appropriate for O(1K-100K) rows in early training phase.

BEGIN;

CREATE TABLE task_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id VARCHAR(128) NOT NULL,
  phase_number INTEGER NOT NULL,
  workflow_name VARCHAR(32) NOT NULL,
  feature_vector JSONB NOT NULL,
  raw_score INTEGER NOT NULL CHECK (raw_score BETWEEN 0 AND 100),
  calibrated_score INTEGER CHECK (calibrated_score BETWEEN 0 AND 100),
  chosen_phases TEXT[] NOT NULL,
  phases_run TEXT[] NOT NULL,
  outcome_label VARCHAR(32) NOT NULL CHECK (outcome_label IN ('validator_pass','task_fail','gaps_found','manifest_overshoot','escalation_fired')),
  escalation_history JSONB DEFAULT '[]',
  embedding vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_completions_outcome ON task_completions(outcome_label, created_at DESC);
CREATE INDEX idx_task_completions_embedding ON task_completions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMIT;
