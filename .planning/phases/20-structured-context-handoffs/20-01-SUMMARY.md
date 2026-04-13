---
phase: 20-structured-context-handoffs
plan: 20-01
subsystem: database
tags: [pydantic, postgresql, psycopg2, jsonb, migration, sha256]

# Dependency graph
requires:
  - phase: migrations/008-applied-count
    provides: migration number sequence (009 is next)
  - phase: services/pg_store.py
    provides: _get_conn pattern, RealDictCursor, upsert pattern, section header style
provides:
  - RPETDContext Pydantic model (8 fields, SHA-256 context_version auto-computed)
  - migrations/009-rpetd-context.sql (rpetd_context table + UNIQUE INDEX on task_id+phase)
  - PGStore.rpetd_context_store (upsert), rpetd_context_get (single row), rpetd_context_list (all phases)
  - 11 unit tests (7 model + 4 PGStore mock)
affects: [phase-20-02, phase-20-03, phase-21, phase-22]

# Tech tracking
tech-stack:
  added: [pydantic BaseModel, hashlib.sha256, model_validator(mode="after")]
  patterns: [8-field typed context object, SHA-256 version fingerprinting, upsert via ON CONFLICT, dataclass fallback shim for optional dependencies]

key-files:
  created:
    - services/rpetd_context.py
    - migrations/009-rpetd-context.sql
    - migrations/009-rpetd-context-DOWN.sql
    - tests/test_rpetd_context.py
  modified:
    - services/pg_store.py

key-decisions:
  - "model_validator(mode='after') auto-computes context_version so callers never manually compute SHA-256"
  - "file_hashes JSONB column included in migration now to avoid a second ALTER TABLE in Phase 21"
  - "Fallback dataclass shim in rpetd_context.py prevents daemon crash if pydantic is missing"
  - "PGStore methods inserted between agent_performance_summary (line 1604) and Embedding section (line 1606) to keep domain grouping clean"
  - "ON CONFLICT (task_id, phase) DO UPDATE upsert semantics match UNIQUE INDEX from migration"

patterns-established:
  - "RPETDContext: always use from_compiled_view(model_dump()) for round-trips — context_version is recomputed on reconstruction"
  - "PGStore section headers use ═══ divider + comment block — follow this style for all new method groups"
  - "Phase CHECK constraint uses exact strings: 'R', 'P', 'E', 'T', 'D' — upper() normalize before validation"

requirements-completed: [HANDOFF-01, HANDOFF-03]

# Metrics
duration: 25min
completed: 2026-04-12
---

# Plan 20-01: RPETDContext Model + PostgreSQL Migration + PGStore Methods Summary

**RPETDContext Pydantic model (8 fields, SHA-256 fingerprint), PostgreSQL migration 009 with JSONB+UNIQUE INDEX, and PGStore upsert/get/list methods — storage foundation for Phase 20 context handoffs**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-12T00:00:00Z
- **Completed:** 2026-04-12T00:25:00Z
- **Tasks:** 4
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments
- `services/rpetd_context.py` — 8-field Pydantic model with SHA-256 auto-computed `context_version` via `model_validator(mode="after")`, `to_compiled_view()` / `from_compiled_view()` helpers, and optional pydantic fallback shim
- `migrations/009-rpetd-context.sql` — `rpetd_context` table with JSONB columns, phase CHECK constraint (R/P/E/T/D), UNIQUE INDEX on (task_id, phase) for upsert semantics; `file_hashes` column pre-added for Phase 21
- `services/pg_store.py` — 3 new methods: `rpetd_context_store` (upsert), `rpetd_context_get` (RealDictCursor), `rpetd_context_list` (ordered by created_at); inserted in correct section
- 11 unit tests all pass; 72 JS core tests pass with 0 regressions

## Task Commits

Each task was committed atomically:

1. **Task 20-01-01: RPETDContext Pydantic model** - `0b2d845` (feat)
2. **Task 20-01-02: Migration 009 rpetd_context table** - `e7626ca` (feat)
3. **Task 20-01-03: PGStore CRUD methods** - `ce6d02f` (feat)
4. **Task 20-01-04: Unit tests** - `c733017` (test)

## Files Created/Modified
- `services/rpetd_context.py` — RPETDContext Pydantic model, 8 fields, SHA-256 auto-version
- `migrations/009-rpetd-context.sql` — UP migration: rpetd_context table + indexes
- `migrations/009-rpetd-context-DOWN.sql` — DOWN migration: drops table + indexes
- `services/pg_store.py` — Added rpetd_context_store, rpetd_context_get, rpetd_context_list after agent_performance_summary
- `tests/test_rpetd_context.py` — 11 tests: 7 model + 4 PGStore mock

## Decisions Made
- `model_validator(mode="after")` chosen so context_version is always auto-computed; callers pass `context_version=""` or any value and it gets overwritten with the correct SHA-256
- `file_hashes JSONB DEFAULT '{}'` added to migration 009 now (not Phase 21) to avoid a second ALTER TABLE on rpetd_context — the column exists but is empty until Phase 21 STALE-01 fills it
- Fallback shim guards against `ImportError` if pydantic is absent — daemon startup does not crash; methods degrade gracefully
- PGStore insertion point is line 1605-1606 boundary (after `agent_performance_summary` return, before `# Embedding / Semantic Search Operations` section) — keeps domain grouping clean

## Deviations from Plan
None — plan executed exactly as written. All 4 tasks match `files_expected` blocks. No scope expansion.

## Issues Encountered
None. All acceptance criteria pass on first run.

## User Setup Required
None — no external service configuration required. Migration 009 must be applied to the target PostgreSQL database before PGStore methods can write rows, but this is standard migration workflow.

## Next Phase Readiness
- Plan 20-02 (daemon endpoints POST /api/context/compact and GET /api/context/:task_id/:phase) is unblocked — PGStore methods and RPETDContext model are in place
- Plan 20-03 (compaction function + phase runner integration) is unblocked
- Phase 21 (staleness detection) can begin once Phase 20 is fully complete — `file_hashes` column is pre-provisioned

---
*Phase: 20-structured-context-handoffs*
*Completed: 2026-04-12*
