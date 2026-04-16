-- GSD-Amauta Migration 017 DOWN: Reverse step handoffs table (SHARD-04)
-- Phase 41: Sharded Workflows (FOUNDATION)
-- Drops step_handoffs table and its indexes.

BEGIN;

DROP INDEX IF EXISTS idx_handoffs_latest;
DROP INDEX IF EXISTS idx_handoffs_task;
DROP TABLE IF EXISTS step_handoffs;

COMMIT;
