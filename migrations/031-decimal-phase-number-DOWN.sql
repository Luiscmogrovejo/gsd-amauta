-- DOWN for 031-decimal-phase-number.sql — NUMERIC(10,3) back to INTEGER.
--
-- WHAT THIS DOWN LOSES, AND WHY IT REFUSES RATHER THAN ROUNDING
--
-- Going back to INTEGER cannot keep a row whose scale is non-zero: phase 72.1 has
-- no INTEGER representation. There are exactly two honest options, and this file
-- chooses the first:
--
--   (a) REFUSE — raise, change nothing, and name the rows that block the rollback.
--   (b) ROUND — turn 72.1 into 72 and log a warning.
--
-- (b) is rejected. Rounding files a handoff under a DIFFERENT PHASE: a handoff for
-- 72.1 becomes a handoff for 72, and the next lookup for phase 72 reads back work
-- that belongs to 72.1. That is exactly the silent-collision defect migration 031
-- exists to end, and a DOWN must not reintroduce it under the cover of a log line
-- nobody reads. Worse, it is not reversible in the other direction either: once
-- 72.1 has become 72 there is nothing left that says it was ever 72.1, so re-running
-- the UP cannot restore it.
--
-- (a) therefore: if ANY row in either table has a non-integral phase_number, this
-- DOWN raises `22000 data_exception` with the two counts and the distinct offending
-- values, and rolls back whole. The operator's choice is then explicit and recorded
-- — delete or re-file those rows by hand, then re-run the DOWN.
--
-- So what this DOWN loses when it DOES succeed:
--   * the COLUMN COMMENTs migration 031 added (dropped with the type change);
--   * the ability to store a decimal phase at all, which is the point of a rollback;
--   * nothing else. Every integral NUMERIC(10,3) value survives the cast to INTEGER
--     exactly, and NOT NULL is carried through by ALTER COLUMN TYPE.
--
-- Both ALTERs rewrite their table and rebuild its indexes, exactly as the UP did:
-- idx_handoffs_task, idx_handoffs_latest, idx_task_completions_outcome and the
-- ivfflat idx_task_completions_embedding.
--
-- Idempotent and safe on a database where the UP never ran: both steps are guarded
-- on information_schema, and the refusal check is guarded on the tables existing.

BEGIN;

-- 1. Refuse the rollback while a decimal phase exists in either table.
DO $$
DECLARE
    bad_handoffs    BIGINT := 0;
    bad_completions BIGINT := 0;
    sample          TEXT   := '';
BEGIN
    IF to_regclass('public.step_handoffs') IS NOT NULL THEN
        SELECT count(*) INTO bad_handoffs
        FROM step_handoffs
        WHERE phase_number IS NOT NULL
          AND phase_number <> trunc(phase_number);
    END IF;

    IF to_regclass('public.task_completions') IS NOT NULL THEN
        SELECT count(*) INTO bad_completions
        FROM task_completions
        WHERE phase_number IS NOT NULL
          AND phase_number <> trunc(phase_number);
    END IF;

    IF bad_handoffs > 0 OR bad_completions > 0 THEN
        SELECT coalesce(string_agg(DISTINCT v::text, ', ' ORDER BY v::text), '(none)')
          INTO sample
          FROM (
            SELECT phase_number AS v FROM step_handoffs
             WHERE phase_number IS NOT NULL AND phase_number <> trunc(phase_number)
            UNION
            SELECT phase_number AS v FROM task_completions
             WHERE phase_number IS NOT NULL AND phase_number <> trunc(phase_number)
          ) AS decimals;

        RAISE EXCEPTION
            'migration 031 DOWN refuses: % step_handoffs row(s) and % '
            'task_completions row(s) carry a non-integral phase_number (%). '
            'Returning the column to INTEGER would round them into a DIFFERENT '
            'phase, which is the silent collision migration 031 removed. Re-file '
            'or delete those rows, then re-run this DOWN.',
            bad_handoffs, bad_completions, sample
            USING ERRCODE = 'data_exception';
    END IF;
END $$;

-- 2. step_handoffs.phase_number NUMERIC(10,3) -> INTEGER
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'step_handoffs'
          AND column_name = 'phase_number'
          AND data_type = 'numeric'
    ) THEN
        ALTER TABLE step_handoffs
            ALTER COLUMN phase_number TYPE INTEGER
            USING phase_number::integer;
    END IF;
END $$;

-- 3. task_completions.phase_number NUMERIC(10,3) -> INTEGER
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'task_completions'
          AND column_name = 'phase_number'
          AND data_type = 'numeric'
    ) THEN
        ALTER TABLE task_completions
            ALTER COLUMN phase_number TYPE INTEGER
            USING phase_number::integer;
    END IF;
END $$;

COMMIT;
