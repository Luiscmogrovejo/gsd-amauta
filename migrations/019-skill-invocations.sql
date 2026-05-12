-- GSD-Amauta Migration 019: Skill invocations table (SKILL-02)
-- Phase 43: Skills Architecture
-- Records every skill invocation with context embedding for hybrid BM25 + pgvector retrieval.
-- Mirrors migration 018 (task_completions) for the vector + ivfflat side; adds GIN tsvector
-- for the BM25 side per Area 3 retrieval strategy.
--
-- Columns:
--   id              UUID primary key (gen_random_uuid)
--   skill_name      VARCHAR(64) NOT NULL — canonical skill name (e.g. 'plan-phase')
--   invocation_text TEXT NOT NULL — embedded payload: skill_name + prompt + args + outcome_class
--   args            JSONB — invocation arguments dict (default empty)
--   outcome_class   VARCHAR(16) CHECK IN ('success','fail','escalation') — post-invocation outcome
--   context_embedding vector(1024) — voyage-code-3 embedding of invocation_text (NULL if unavailable)
--   invoked_at      TIMESTAMPTZ DEFAULT NOW() — when the invocation was recorded (pre-execute)
--   completed_at    TIMESTAMPTZ — when outcome_class was set (NULL until /api/skills/complete called)
--
-- Indexes:
--   idx_skill_invocations_embedding — ivfflat cosine (lists=100) on context_embedding
--   idx_skill_invocations_text_gin  — GIN on to_tsvector('english', invocation_text) for BM25
--   idx_skill_invocations_recency   — btree on (skill_name, invoked_at DESC) for recency filter

BEGIN;

CREATE TABLE skill_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name VARCHAR(64) NOT NULL,
  invocation_text TEXT NOT NULL,
  args JSONB DEFAULT '{}'::jsonb,
  outcome_class VARCHAR(16) CHECK (outcome_class IN ('success','fail','escalation')),
  context_embedding vector(1024),
  invoked_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_skill_invocations_embedding ON skill_invocations USING ivfflat (context_embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_skill_invocations_text_gin ON skill_invocations USING GIN (to_tsvector('english', invocation_text));
CREATE INDEX idx_skill_invocations_recency ON skill_invocations (skill_name, invoked_at DESC);

COMMIT;
