-- GSD-Amauta Migration 019 DOWN: Drop skill_invocations table.
-- Reverses migration 019-skill-invocations.sql.
-- Drops indexes first (implicit on DROP TABLE, but explicit for safety),
-- then drops the table.

BEGIN;
DROP INDEX IF EXISTS idx_skill_invocations_recency;
DROP INDEX IF EXISTS idx_skill_invocations_text_gin;
DROP INDEX IF EXISTS idx_skill_invocations_embedding;
DROP TABLE IF EXISTS skill_invocations;
COMMIT;
