-- GSD-Amauta Migration 031: phase_number becomes NUMERIC(10,3) (Phase 89, FND-11)
--
-- THE DEFECT. `/amauta:insert-phase` creates decimal phases (72.1 between 72 and
-- 73) and this milestone already carries 77.1, 94.1 and 99.1. SQLite stores
-- step_handoffs.phase_number as TEXT and carries them
-- (services/sqlite_store.py:386-395, with the reason in its own comment).
-- PostgreSQL declared the column INTEGER (017-step-handoffs.sql:17), so
-- services/amauta-daemon.py `_parse_phase_arg` answered HTTP 400
-- {"error": "decimal_phase_unsupported_on_postgres"} rather than filing a
-- truncated row under the wrong phase. Its docstring said why: "changing that
-- column is a schema migration this change does not own". This migration owns it.
--
-- The blast radius is not cosmetic. The sharded execute-phase workflow posts a
-- handoff after EVERY step and HALTs when the handoff is not readable back
-- (get-shit-done/workflows/execute-phase/workflow.md:78-142), so on PostgreSQL any
-- inserted phase broke the whole loop at step 01.
--
-- WHY NUMERIC(10,3), AND NOT THE TWO ALTERNATIVES:
--
--   * TEXT would make `ORDER BY phase_number` sort '10' before '9', which breaks
--     the usefulness of idx_handoffs_latest (017:32) — the index whose whole job is
--     "latest handoff for a workflow+phase".
--   * DOUBLE PRECISION makes `= 72.1` an exact comparison against a binary float.
--     72.1 is not representable in binary, so the lookup is a coin toss between a
--     hit and a silent miss. That is the classic defect of storing a decimal
--     identifier in a float.
--   * NUMERIC compares exactly, sorts numerically, and treats 72 and 72.0 as equal
--     — which is exactly the contract services/sqlite_store.py:135-150
--     `normalize_phase_number` already implements (int when integral, else float,
--     ValueError on a non-number). Precision 10 and scale 3 give phase numbers up
--     to 9 999 999 with three decimal places, far beyond 77.1 / 94.1 / 99.1, and
--     keep the column 8 bytes of storage rather than an unbounded one.
--
-- BOTH tables move together: task_completions.phase_number is INTEGER too
-- (018-task-completions.sql:13) and services/complexity_scorer.py store_completion
-- writes it, so leaving it behind would only move the 500 one endpoint along.
--
-- Each ALTER rewrites its table and rebuilds its indexes with it:
-- idx_handoffs_task and idx_handoffs_latest on step_handoffs,
-- idx_task_completions_outcome and the ivfflat idx_task_completions_embedding on
-- task_completions. Both tables are small (handoffs and completions are thousands
-- of rows at most); tests/test_89_02_decimal_phase.py MEASURES the row counts and
-- the applied duration on the disposable database rather than asserting the size.
--
-- Idempotent: the ALTERs are guarded on information_schema, so a re-run on an
-- already-converted database is a catalogue read and nothing else. The normal
-- re-run guard is still schema_migrations (services/migrate_runner.py); no
-- MIGRATION_SENTINELS entry is needed — sentinels exist only for files that
-- predate schema_migrations tracking.
--
-- Predecessor: 030-rlm-chunk-provenance.sql (previous highest number).
-- House shape for a type-changing migration: 029-sqlite-import-compat.sql.
-- DOWN: 031-decimal-phase-number-DOWN.sql (it REFUSES rather than rounding — see
-- that file for what it loses).

BEGIN;

-- 1. step_handoffs.phase_number INTEGER -> NUMERIC(10,3)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'step_handoffs'
          AND column_name = 'phase_number'
          AND data_type <> 'numeric'
    ) THEN
        ALTER TABLE step_handoffs
            ALTER COLUMN phase_number TYPE NUMERIC(10,3)
            USING phase_number::numeric;
    END IF;
END $$;

-- 2. task_completions.phase_number INTEGER -> NUMERIC(10,3)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'task_completions'
          AND column_name = 'phase_number'
          AND data_type <> 'numeric'
    ) THEN
        ALTER TABLE task_completions
            ALTER COLUMN phase_number TYPE NUMERIC(10,3)
            USING phase_number::numeric;
    END IF;
END $$;

COMMENT ON COLUMN step_handoffs.phase_number IS
    'Phase identifier, NUMERIC(10,3) since migration 031 (FND-11). Decimal phases '
    'come from /amauta:insert-phase (72.1). NUMERIC, not DOUBLE PRECISION: = 72.1 '
    'must be an exact comparison. NUMERIC, not TEXT: idx_handoffs_latest orders on '
    'this column.';

COMMENT ON COLUMN task_completions.phase_number IS
    'Phase identifier, NUMERIC(10,3) since migration 031 (FND-11). Same reasoning as '
    'step_handoffs.phase_number; written by services/complexity_scorer.py '
    'store_completion.';

COMMIT;
