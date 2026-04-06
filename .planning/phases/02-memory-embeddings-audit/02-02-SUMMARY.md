---
phase: 02-memory-embeddings-audit
plan: 02-02
subsystem: database
tags: [python, sqlite, postgres, memory, retention, recency-decay, testing]

# Dependency graph
requires:
  - phase: 02-01
    provides: memory dedup constants and scoring audit baseline

provides:
  - web_search_result:180 retention tier in pg_store.py and sqlite_store.py
  - 3 new retention tests (web_search_result archival, recent preservation, distilled permanent)
  - 6 recency decay guard tests across constants + formula + disabled-env cases

affects: [02-03, 02-04, any plan reading RETENTION_DAYS or _score_memories]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Dynamic RETENTION_DAYS iteration -- memory_retention_cleanup() uses .items() so adding a tier key requires zero logic changes
    - SQLiteStore._score_memories() as unit-test target for recency decay -- no PG connection needed
    - _parse_constant_from_file() helper strips inline #-comments before float() parsing

key-files:
  created:
    - tests/test_memory_recency_decay.py
  modified:
    - services/pg_store.py
    - services/sqlite_store.py
    - tests/test_memory_retention.py

key-decisions:
  - "sqlite_store also updated alongside pg_store -- both stores must stay in sync for retention tiers"
  - "Recency decay guard tests use sqlite_store not PG -- faster, isolated, no infrastructure dependency"
  - "Split constants test into two named tests (DECAY_PER_30D + MAX_PENALTY) for clearer failure messages"
  - "distilled excluded from RETENTION_DAYS by design (permanent) -- confirmed and tested"

patterns-established:
  - "Retention tier addition: update RETENTION_DAYS dict key only -- no logic change needed (dynamic iteration)"
  - "Recency decay unit tests: instantiate SQLiteStore, call _score_memories() with synthetic row dicts"

requirements-completed:
  - MEM-07
  - MEM-08

# Metrics
duration: 35min
completed: 2026-04-06
---

# Plan 02-02: Retention Completion & Recency Verification Summary

**web_search_result:180d retention tier added to both stores; 21 tests confirm MEM-07 recency decay and MEM-08 tiered archival are correct and complete**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-04-06T19:00:00Z
- **Completed:** 2026-04-06T19:35:00Z
- **Tasks:** 3
- **Files modified:** 4 (pg_store.py, sqlite_store.py, test_memory_retention.py, test_memory_recency_decay.py)

## Accomplishments

- Added `web_search_result: 180` to `RETENTION_DAYS` in both `pg_store.py` and `sqlite_store.py`. `memory_retention_cleanup()` iterates `RETENTION_DAYS.items()` dynamically -- no logic changes needed.
- Added MEM-02/MEM-08 comment header documenting all tiers and permanent sources. Updated docstrings in both stores to list all 3 tiers and return dict shape.
- Verified auto-trigger is already present: daemon startup (line 1885) + `_memory_retention_thread` background loop (line 584). No changes needed.
- Added 3 tests to `test_memory_retention.py` (total 15): `test_retention_archives_web_search_result_after_180_days`, `test_recent_web_search_result_not_archived`, `test_retention_preserves_distilled_entries_forever`.
- Created `tests/test_memory_recency_decay.py` with 6 guard tests. MEM-07 decay was already implemented in `amauta.py` `_mem_pg_search()` (lines 617-631) -- these are guard tests to prevent future regression.

## Task Commits

1. **T1: Add web_search_result:180 to RETENTION_DAYS** - `8af18a8` (feat)
2. **T2: Retention tests for web_search_result and distilled** - `6cf64f8` (test)
3. **T3: Recency decay guard tests** - `1216e00` (test)

## Files Created/Modified

- `/Users/luismogrovejo/Code/gsd-amauta/services/pg_store.py` - RETENTION_DAYS dict + comment header + docstring updated
- `/Users/luismogrovejo/Code/gsd-amauta/services/sqlite_store.py` - Same changes (both stores must stay in sync)
- `/Users/luismogrovejo/Code/gsd-amauta/tests/test_memory_retention.py` - 3 new tests added (web_search_result + distilled)
- `/Users/luismogrovejo/Code/gsd-amauta/tests/test_memory_recency_decay.py` - Created with 6 guard tests

## Decisions Made

- Updated `sqlite_store.py` even though the plan only mentioned `pg_store.py`. Both stores share the same RETENTION_DAYS pattern and the existing retention tests use `SQLiteStore` -- the update was required for test correctness.
- Used `SQLiteStore._score_memories()` for recency decay unit tests. This method applies the identical formula as PGStore but without a live PG connection, making tests fast and infrastructure-free.
- Wrote 6 decay tests rather than the plan's minimum of 5. The "constants match" requirement naturally became two tests (DECAY_PER_30D + MAX_PENALTY) for clearer failure messages.

## Deviations from Plan

### Auto-fixed Issues

**1. sqlite_store.py also updated (not mentioned in plan)**
- **Found during:** T1 (adding web_search_result tier)
- **Issue:** The existing retention test suite imports `RETENTION_DAYS` from `sqlite_store`. Updating only `pg_store.py` would leave test assertions inconsistent and `sqlite_store.memory_retention_cleanup()` not archiving web_search_result entries.
- **Fix:** Applied identical RETENTION_DAYS and docstring changes to `sqlite_store.py`.
- **Files modified:** `services/sqlite_store.py`
- **Verification:** All 15 retention tests pass using SQLiteStore.
- **Committed in:** `8af18a8` (T1 commit)

---

**Total deviations:** 1 auto-fixed (scope extension to keep both stores in sync)
**Impact on plan:** Essential for test correctness. No scope creep.

## Issues Encountered

- `_parse_constant_from_file()` helper initially failed to parse `MAX_RECENCY_PENALTY = 3.0  # Cap at 6 months of decay` because `float("3.0  # Cap...")` raises `ValueError`. Fixed by splitting on `#` and stripping before `float()` call.

## Next Phase Readiness

- MEM-07 and MEM-08 fully tested and confirmed correct.
- Phase 2 retention infrastructure complete: tiered archival (task_event 30d, rpetd_phase 90d, web_search_result 180d) + recency decay (0.5/30d capped at 3.0) both in production and guarded by tests.
- 02-01 and 02-03 plans can proceed in parallel.

---
*Phase: 02-memory-embeddings-audit*
*Completed: 2026-04-06*
