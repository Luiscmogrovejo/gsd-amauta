---
phase: 22-core-system-tests
plan: 02
subsystem: testing
tags: [unittest, mock, pgvector, semantic-search, dedup, distill, auto-learn, skb, retention]

# Dependency graph
requires:
  - phase: 20-critical-bug-fixes
    provides: FIX-03 distill removedCount off-by-1 fix
  - phase: 21-minor-bug-fixes
    provides: FIX-10 SKB promotion Jaccard dedup
provides:
  - test_pg_integration.py: 12 tests for PGStore (semantic search, dedup, retention, task_upsert)
  - test_distill.py: 9 tests for distill workflow (exclude-source, removedCount, dedup interaction, idempotency)
  - test_auto_learn.py: 13 tests for _auto_write_learning (RPETD extraction, full content, SKB dedup, web_search)
affects: [23-integration-e2e-tests]

# Tech tracking
tech-stack:
  added: []
  patterns: [contextmanager-based _get_conn mock, _make_mock_cursor context manager helper, _simulate_distill algorithm helper]

key-files:
  created: [tests/test_pg_integration.py, tests/test_distill.py, tests/test_auto_learn.py]
  modified: []

key-decisions:
  - "PGStore._get_conn mocked via @contextmanager wrapper yielding mock conn (not MagicMock return_value) to match generator-based original"
  - "Distill algorithm simulated in test helper since actual endpoint lives in amauta-daemon.py, not amauta.py"
  - "PropertyMock(side_effect=[5, 3]) for retention rowcount -- only 1 access per RETENTION_DAYS source (after INSERT, not DELETE)"

patterns-established:
  - "PGStore mock pattern: _make_pg_store() + _patch_get_conn(store, [cursor1, cursor2]) for multi-cursor methods"
  - "_simulate_distill(entries, keep_count=1) returns (summaries, removedCount) for FIX-03 validation"
  - "_auto_write_learning mock trio: patch _mem_pg_available, _mem_log_event, _skb_promote"

requirements-completed: [TEST-04, TEST-05, TEST-06]

# Metrics
duration: 6min
completed: 2026-03-25
---

# Plan 22-02: PG Integration, Distill, and Auto-Learn Test Suites Summary

**34 tests across 3 suites covering PGStore semantic search/dedup/retention/task_upsert, distill data layer, and auto-learn workflow with SKB promotion**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-25T15:29:07Z
- **Completed:** 2026-03-25T15:35:47Z
- **Tasks:** 3
- **Files created:** 3

## Accomplishments
- 12 PG integration tests with proper @contextmanager mocking for _get_conn (semantic search query type, text fallback, __test__ exclusion, dedup skip/insert/threshold, retention moves/preserves/archive-first, task_upsert 40 fields/rpetd extraction/error handling)
- 9 distill tests covering exclude-source filtering, FIX-03 removedCount validation, dedup coexistence, and idempotency
- 13 auto-learn tests covering RPETD phase inclusion, full content storage (2000+ chars, multilines), SKB promotion with Jaccard dedup (FIX-10), web_search extraction, and edge cases (exception safety, flooding prevention)

## Task Commits

Each task was committed atomically:

1. **Task T04: PG integration test suite** - `e06f892` (test)
2. **Task T05: Distill test suite** - `1b8f0d7` (test)
3. **Task T06: Auto-learn test suite** - `276cb20` (test)

## Files Created/Modified
- `tests/test_pg_integration.py` - 12 tests for PGStore: semantic search, memory dedup, retention cleanup, task_upsert round-trip
- `tests/test_distill.py` - 9 tests for distill: exclude-source, removedCount (FIX-03), dedup interaction, idempotency
- `tests/test_auto_learn.py` - 13 tests for _auto_write_learning: RPETD extraction, full content, SKB dedup (FIX-10), web_search capture

## Decisions Made
- PGStore._get_conn mocked via @contextmanager (not MagicMock) because source uses generator-yield pattern
- Distill algorithm simulated via _simulate_distill helper since endpoint lives in amauta-daemon.py
- Retention rowcount uses PropertyMock(side_effect=[5,3]) -- only 1 access per source after INSERT

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] PGStore context manager mock pattern**
- **Found during:** Task T04 (PG integration tests)
- **Issue:** Initial MagicMock return_value approach failed because _get_conn is a @contextmanager generator -- `with self._get_conn() as conn:` requires proper __enter__/__exit__ protocol
- **Fix:** Created _patch_get_conn helper using @contextmanager wrapper that yields mock_conn, with _make_mock_cursor helper for cursor context managers
- **Files modified:** tests/test_pg_integration.py
- **Verification:** All 12 tests pass after fix
- **Committed in:** e06f892

**2. [Rule 1 - Bug] Retention rowcount PropertyMock side_effect count**
- **Found during:** Task T04 (retention cleanup test)
- **Issue:** Used side_effect=[5, 5, 3, 3] assuming 2 rowcount accesses per source, but code only accesses rowcount once (after INSERT, not DELETE)
- **Fix:** Changed to side_effect=[5, 3] matching actual code path
- **Files modified:** tests/test_pg_integration.py
- **Verification:** test_retention_cleanup_moves_old_task_events passes with correct total=8
- **Committed in:** e06f892

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both were mock configuration issues caught by running tests. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 22 complete (both plans 22-01 and 22-02 done)
- All 6 test suites (TEST-01 through TEST-06) created with 68 total tests
- Ready for Phase 23: Integration + E2E Tests

---
*Phase: 22-core-system-tests*
*Completed: 2026-03-25*
