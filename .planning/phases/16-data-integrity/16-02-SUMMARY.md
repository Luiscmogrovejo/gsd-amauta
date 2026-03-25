---
phase: 16-data-integrity
plan: "02"
subsystem: database, api, testing
tags: [project_id, test-isolation, memory, postgresql, sqlite, data-integrity]

requires:
  - phase: 16-01
    provides: exclude_source param, distill fix, embedding dedup, daemon dedup response
provides:
  - Auto project_id on all memory writes (daemon, CLI, Python)
  - Test isolation via __test__ project_id
  - Default search excludes test entries
  - Legacy table name fixed (amauta_memory -> gsd_memory)
affects: [memory-optimization, token-efficiency]

tech-stack:
  added: []
  patterns:
    - "Auto project_id from CWD basename on every memory write"
    - "Test mode detection (NODE_ENV/GSD_TEST_MODE/PYTEST_CURRENT_TEST) -> __test__"
    - "Default search excludes __test__ entries; explicit project_id='__test__' includes them"

key-files:
  created: []
  modified:
    - services/amauta-daemon.py
    - amauta.py
    - get-shit-done/bin/gsd-memory.cjs
    - services/pg_store.py
    - services/sqlite_store.py
    - tests/test_data_integrity.py
    - tests/test_semantic_search.py

key-decisions:
  - "Replace all 12 amauta_memory references in amauta.py with gsd_memory (bulk replace, including comments)"
  - "Test mode checks 3 env vars: NODE_ENV=test, GSD_TEST_MODE=1, PYTEST_CURRENT_TEST"
  - "Default search excludes __test__ using (project_id IS NULL OR project_id != '__test__') to preserve NULL entries"

patterns-established:
  - "_resolve_project_id(body) pattern in daemon for consistent project_id resolution"
  - "autoProjectId(explicit) pattern in CJS for same"

requirements-completed: [DATA-05, DATA-06]

duration: 6min
completed: 2026-03-25
---

# Phase 16 Plan 02: Auto Project ID and Test Isolation Summary

**Auto project_id from CWD basename on all memory writes, __test__ isolation in test mode, legacy amauta_memory table references eliminated**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-25T00:57:29Z
- **Completed:** 2026-03-25T01:03:40Z
- **Tasks:** 5
- **Files modified:** 7

## Accomplishments
- Every memory write (daemon, amauta.py CLI, gsd-memory.cjs) auto-sets project_id from CWD basename
- Test mode (NODE_ENV=test, GSD_TEST_MODE=1, PYTEST_CURRENT_TEST) forces project_id to '__test__'
- Default search (PG and SQLite) excludes __test__ entries while preserving NULL project entries
- BLOCKING-2 fixed: all 12 references to legacy table 'amauta_memory' replaced with 'gsd_memory'
- 11 new tests added (20 total in test_data_integrity.py), 267 tests pass across full suite

## Task Commits

Each task was committed atomically:

1. **Task 1: Auto-set project_id in daemon /store and /auto-capture** - `d7c54ea` (feat)
2. **Task 2: Fix legacy table name + add project_id to amauta.py writes** - `1a541bc` (fix)
3. **Task 3: Auto-set project_id in gsd-memory.cjs** - `2ca476e` (feat)
4. **Task 4: Exclude __test__ from default search** - `b69e262` (feat)
5. **Task 5: Tests for project_id, test isolation, table fix** - `1eea089` (test)

## Files Created/Modified
- `services/amauta-daemon.py` - _resolve_project_id helper, wired into /store and /auto-capture
- `amauta.py` - 12x amauta_memory->gsd_memory, project_id in _mem_log_event and _mem_pg_add
- `get-shit-done/bin/gsd-memory.cjs` - autoProjectId helper, wired into cmdStore/cmdLearn/cmdAutoCapture
- `services/pg_store.py` - __test__ exclusion in memory_search and memory_semantic_search
- `services/sqlite_store.py` - __test__ exclusion in memory_search (parity)
- `tests/test_data_integrity.py` - 11 new tests (20 total)
- `tests/test_semantic_search.py` - Fixed assertion for gsd_memory table name

## Decisions Made
- Replaced all 12 amauta_memory references including comments (clean break, no migration comments)
- Test mode detects 3 env vars for broad coverage across Python and Node.js test runners
- Default search uses (project_id IS NULL OR project_id != '__test__') to include legacy NULL entries

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] test_semantic_search.py assertion still referenced amauta_memory**
- **Found during:** Task 5 (running full test suite)
- **Issue:** test_fallback_to_direct_sql asserted "INSERT INTO amauta_memory" but table was renamed
- **Fix:** Changed assertion to "INSERT INTO gsd_memory"
- **Files modified:** tests/test_semantic_search.py
- **Verification:** 267 tests pass
- **Committed in:** 1eea089 (Task 5 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 16 complete: DATA-03, DATA-04, DATA-05, DATA-06 all satisfied
- All memory writes now include project_id automatically
- Test entries are isolated and invisible to default search
- Ready for Phase 17 (Task Manager Reliability)

---
*Phase: 16-data-integrity*
*Completed: 2026-03-25*
