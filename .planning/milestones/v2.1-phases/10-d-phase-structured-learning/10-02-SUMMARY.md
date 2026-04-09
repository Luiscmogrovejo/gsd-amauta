---
phase: 10-d-phase-structured-learning
plan: 10-02
subsystem: database
tags: [postgresql, migration, schema, applied_count, gsd_memory, learn-05, echo-chamber]

# Dependency graph
requires:
  - phase: 01-init
    provides: gsd_memory table definition (id, text, tags jsonb, metadata jsonb, embedding vector)
  - phase: 10-01
    provides: tag-rules.json + learning-format.md + cli-variables.md foundation config (parallel wave-1 peer)
provides:
  - migrations/008-applied-count.sql (idempotent UP migration — ADD COLUMN IF NOT EXISTS applied_count INTEGER NOT NULL DEFAULT 0)
  - migrations/008-applied-count-DOWN.sql (idempotent DOWN migration — DROP INDEX IF EXISTS + DROP COLUMN IF EXISTS)
  - partial btree index idx_gsd_memory_applied_count ON gsd_memory (applied_count) WHERE applied_count > 0 (echo-chamber query optimization)
  - column comment documenting LEARN-05 citation-deduplication contract
  - dev DB (127.0.0.1:5432/gsd_amauta) applied + idempotency verified
affects: [10-04-daemon-api, 10-05-skb-commands, 10-06-operator-citation-scanner]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Idempotent migration pattern: BEGIN/COMMIT with ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS"
    - "Partial index for threshold queries: WHERE applied_count > 0 reduces index size since most rows are 0"
    - "Column COMMENT as self-documenting contract for downstream consumers"

key-files:
  created:
    - migrations/008-applied-count.sql
    - migrations/008-applied-count-DOWN.sql
  modified: []

key-decisions:
  - "Used ALTER TABLE ... ADD COLUMN IF NOT EXISTS pattern from migration 007 for idempotent dev re-runs"
  - "INTEGER NOT NULL DEFAULT 0 chosen over nullable — no sentinel values, counts start at zero cleanly"
  - "Partial index (WHERE applied_count > 0) instead of full index — new learnings start at 0, only cited ones need indexing; dramatically reduces index maintenance cost as gsd_memory grows"
  - "BEGIN/COMMIT wrapped around DDL — transactional so failed mid-migration leaves schema untouched"
  - "DOWN file drops INDEX before COLUMN (reverse creation order) to avoid orphaned index errors"
  - "Column COMMENT includes dedup key spec (mem_id, task_id) and threshold (>10) so future maintainers don't need to re-read plan docs"

patterns-established:
  - "Migration 008 idempotent pattern: next phases (009+) follow same BEGIN/ALTER TABLE IF NOT EXISTS/CREATE INDEX IF NOT EXISTS/COMMENT/COMMIT structure"
  - "Partial index for sparse boolean/threshold semantics: applied_count > 0 is the model for future 'interesting subset' indexes"

requirements-completed: [LEARN-05]

# Metrics
duration: ~5min
completed: 2026-04-09
---

# Plan 10-02: Applied-Count Schema Migration 008 Summary

**`gsd_memory.applied_count INTEGER NOT NULL DEFAULT 0` column + partial btree index shipped via idempotent migration 008 UP/DOWN pair, applied to dev DB, echo-chamber defense schema ready for downstream daemon and SKB-candidates consumers**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-09T21:35:00Z
- **Completed:** 2026-04-09T21:40:00Z
- **Tasks:** 2 atomic
- **Files modified:** 2 (both created)

## Accomplishments
- `migrations/008-applied-count.sql` created with idempotent ADD COLUMN + partial CREATE INDEX + COMMENT, wrapped in BEGIN/COMMIT — parses cleanly against Postgres 14.22
- `migrations/008-applied-count-DOWN.sql` created as reverse (DROP INDEX then DROP COLUMN) — 14 lines vs 21 lines UP, satisfies "simpler reverse" acceptance criterion
- Migration applied to dev database `127.0.0.1:5432/gsd_amauta`: `ALTER TABLE` + `CREATE INDEX` + `COMMENT` all succeeded
- Idempotency verified via re-run: second invocation produced `NOTICE: column already exists, skipping` + `NOTICE: relation already exists, skipping` + COMMIT — no error, safe for init-db.sh loop
- Column comment queryable via `col_description()` — reads back the full LEARN-05 dedup contract
- Phase 10 echo-chamber defense schema (LEARN-05) unblocked — downstream plans 10-04 (increment-applied endpoint) and 10-05 (skb candidates) now have the column they query

## Task Commits

Each task committed atomically on `master`:

1. **Task 1: Create migrations/008-applied-count.sql** — `6307d93` (feat)
2. **Task 2: Create migrations/008-applied-count-DOWN.sql** — `72ff620` (feat)

## Files Created/Modified
- `migrations/008-applied-count.sql` — 21 lines. Header comment references LEARN-05 + Phase 10. Body: BEGIN → ALTER TABLE gsd_memory ADD COLUMN IF NOT EXISTS applied_count INTEGER NOT NULL DEFAULT 0 → CREATE INDEX IF NOT EXISTS idx_gsd_memory_applied_count ON gsd_memory (applied_count) WHERE applied_count > 0 → COMMENT ON COLUMN (dedup contract) → COMMIT.
- `migrations/008-applied-count-DOWN.sql` — 14 lines. Header comment references LEARN-05 + Phase 10 + warns about data loss. Body: BEGIN → DROP INDEX IF EXISTS idx_gsd_memory_applied_count → ALTER TABLE gsd_memory DROP COLUMN IF EXISTS applied_count → COMMIT.

## Decisions Made
- **Partial index over full index:** `WHERE applied_count > 0` minimizes index size because new learnings start at 0. Index only tracks "cited at least once" rows, dramatically cheaper as gsd_memory grows toward thousands of entries. Matches the expected query pattern from plan 10-05 (`skb candidates` filters `applied_count > 0`, then threshold-checks against 5 and 10).
- **BEGIN/COMMIT wrapping:** Pattern richer than migration 007 (which used bare ALTER statements). Chosen because migration 008 has four DDL statements that must all land atomically; a partial apply on failure would leave an ambiguous state.
- **Column COMMENT as inline documentation:** Future maintainers reading `\d+ gsd_memory` see the LEARN-05 dedup contract directly in psql — no need to grep for plan docs. Worth the 4 extra SQL lines.
- **DOWN drops INDEX first, COLUMN second:** Reverse of creation order. Dropping the column first would orphan the index briefly — Postgres handles it, but explicit is safer.

## Deviations from Plan
None — both files exactly match the spec in `10-02-PLAN.md`. Acceptance criteria are the authoritative test.

## Issues Encountered
None. Task 1 + Task 2 completed in sequence, each committed atomically. Post-E verification flagged that the dev DB had not yet been applied; I ran `psql -f migrations/008-applied-count.sql` in the T-phase to close that gap and captured the output (BEGIN/ALTER TABLE/CREATE INDEX/COMMENT/COMMIT) plus the idempotent re-run NOTICE output for the T-phase RPETD log.

## Next Phase Readiness
- **LEARN-05 schema portion complete.** Downstream consumers ready to land:
  - Plan 10-04 (`/api/memory/:id/increment-applied` daemon endpoint) can UPDATE `applied_count = applied_count + 1` safely
  - Plan 10-05 (`gsd-memory skb candidates` CLI) can SELECT using the partial index for sub-50ms threshold queries
  - Plan 10-06 (operator APPLIED_LEARNING citation scanner) can call increment-applied with confidence the column exists
- **Rollback path proven:** `psql -f migrations/008-applied-count-DOWN.sql` will cleanly reverse the UP migration if the echo-chamber defense needs emergency revert. Combined with kill switch `GSD_D_STRUCTURED=false`, provides two layers of reversibility.
- **Production readiness:** Migration is idempotent — safe to re-run via `init-db.sh` on PG restart without error.
- **No blockers** for Phase 10 wave-2 plans.

---
*Phase: 10-d-phase-structured-learning*
*Completed: 2026-04-09*
