---
phase: 17-task-manager-reliability
plan: "03"
subsystem: database
tags: [postgres, dual-write, migration, reconcile, pg-mirror, field-sync]

requires:
  - phase: 17-01
    provides: TOCTOU fix ensures reconcile reads consistent state
  - phase: 17-02
    provides: Retry flusher ensures PG has latest data before reconciliation

provides:
  - Migration 007 adding 7 missing columns to gsd_tasks
  - Full 39-field task_upsert (was 32, now includes doc_refs, risks, validation_checklist, estimated_hours, due_date, sprint, children)
  - cmd_reconcile command for JSON-vs-PG diff and fix
affects: [task-manager, pg-mirror, data-integrity]

tech-stack:
  added: []
  patterns: [json-to-pg-reconcile, full-field-dual-write]

key-files:
  created:
    - migrations/007-task-fields.sql
    - migrations/007-task-fields-DOWN.sql
    - tests/17-03-field-sync.test.cjs
  modified:
    - services/pg_store.py
    - amauta.py

key-decisions:
  - "All 7 new columns nullable with safe defaults (non-blocking ADD COLUMN IF NOT EXISTS)"
  - "Reconcile default is dry-run; --fix required for writes (JSON always source of truth)"
  - "Field comparison normalizes JSONB via json.dumps(sort_keys=True) for stable diffs"
  - "Reconcile uses PGStore.task_upsert() for fix mode (inherits retry queue support)"

patterns-established:
  - "Reconcile pattern: load all JSON items, SELECT * from PG, set-diff IDs, field-level compare with normalization"
  - "JSONB param pattern: json.dumps(item.get(field, [])) for list fields, json.dumps(item.get(field, {})) for dict fields"

requirements-completed: [TASK-05, TASK-06]

duration: 12min
completed: 2026-03-25
---

# Plan 17-03: Full Field Sync + Reconcile Command Summary

**PG migration for 7 dropped fields, full 39-field task_upsert, and JSON-vs-PG reconcile command with --fix mode**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-25T03:30:00Z
- **Completed:** 2026-03-25T03:42:00Z
- **Tasks:** 4
- **Files modified:** 5

## Accomplishments
- Migration 007 adds 7 columns (doc_refs, risks, validation_checklist, estimated_hours, due_date, sprint, children) to gsd_tasks with proper types and defaults
- task_upsert now mirrors all 39 fields from JSON to PG (was 32, silently dropping 7)
- New `amauta reconcile` command diffs tasks.json vs PG, reports missing tasks and field-level mismatches, with `--fix` to sync
- 17 structural tests covering migration SQL, upsert field mapping, and reconcile function wiring

## Task Commits

Each task was committed atomically:

1. **Task 1: PG migration 007** - `b32239a` (feat: 7 new columns + DOWN migration)
2. **Task 2: task_upsert full field sync** - `fe7ebd2` (feat: INSERT/VALUES/ON CONFLICT/params for 7 fields)
3. **Task 3: cmd_reconcile command** - `6eca271` (feat: diff + fix with PGStore upsert)
4. **Task 4: Structural tests** - `60188f1` (test: 17 tests covering all 3 tasks)

## Files Created/Modified
- `migrations/007-task-fields.sql` - ADD COLUMN IF NOT EXISTS for 7 fields
- `migrations/007-task-fields-DOWN.sql` - DROP COLUMN IF EXISTS for rollback
- `services/pg_store.py` - task_upsert expanded from 32 to 39 fields
- `amauta.py` - cmd_reconcile + argparse subparser + dispatch entry
- `tests/17-03-field-sync.test.cjs` - 17 structural tests (migration, upsert, reconcile)

## Decisions Made
- All new columns nullable with safe defaults (JSONB fields default to '[]'::jsonb, scalars default to NULL)
- Reconcile normalizes JSONB comparison via json.dumps(sort_keys=True) to avoid false positives from key ordering
- Reconcile handles parent/parent_id field name mapping (JSON uses "parent", PG uses "parent_id")
- Fix mode imports PGStore lazily to avoid circular dependency

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
- Test regex for params dict extraction hit premature match due to nested `{}` in rpetd_phases mapping. Fixed by using indexOf-based extraction instead of regex.

## User Setup Required
Run migration 007 on PG: `psql $GSD_POSTGRES_URL -f migrations/007-task-fields.sql`
Then reconcile existing data: `python3 amauta.py reconcile --fix`

## Next Phase Readiness
- Phase 17 complete (3/3 plans done)
- All dual-write fields now fully synced
- Reconcile command available for ongoing data integrity checks
- Ready for next milestone phase

---
*Phase: 17-task-manager-reliability*
*Completed: 2026-03-25*
