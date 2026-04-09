-- Migration 008: Add applied_count column to gsd_memory for echo-chamber defense
-- Phase 10 / LEARN-05 (v2.6 "Sight Beyond Sight")
-- Incremented when a learning is cited via APPLIED_LEARNING: mem-XXXX in task notes.
-- Learnings with applied_count > 10 surface as `needs_review` in `gsd-memory skb candidates`.
-- Exception to "no new PG column" rule in v2.6 — explicitly required by LEARN-05.

BEGIN;

ALTER TABLE gsd_memory
  ADD COLUMN IF NOT EXISTS applied_count INTEGER NOT NULL DEFAULT 0;

-- Index on applied_count for efficient "skb candidates" queries filtering by threshold
CREATE INDEX IF NOT EXISTS idx_gsd_memory_applied_count
  ON gsd_memory (applied_count)
  WHERE applied_count > 0;

-- Document the column for future maintainers
COMMENT ON COLUMN gsd_memory.applied_count IS
  'Phase 10 LEARN-05: incremented when an APPLIED_LEARNING: mem-XXXX citation is detected in task RPETD content. Deduped by (mem_id, task_id). Values > 10 trigger SKB manual review gate.';

COMMIT;
