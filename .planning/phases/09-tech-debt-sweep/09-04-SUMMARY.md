---
phase: 09-tech-debt-sweep
plan: "09-04"
subsystem: testing
tags: [pytest, unittest, PropertyMock, side_effect, retention, pg_store]

# Dependency graph
requires: []
provides:
  - TestRetentionMovesOldEntries passes with 3-entry RETENTION_DAYS mock (StopIteration fixed)
  - Stale comment updated to reflect actual production dict
affects: [phase-10, phase-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PropertyMock side_effect list length must equal number of rowcount reads in production loop"

key-files:
  created: []
  modified:
    - tests/test_pg_integration.py

key-decisions:
  - "Test-only change: no production code modified"
  - "Third rowcount value chosen as 2 (arbitrary, consistent with 5+3+2=10 total)"
  - "Added assertIn + assertEqual for rpetd_phase_archived and web_search_result_archived for completeness"

patterns-established:
  - "When RETENTION_DAYS grows, PropertyMock(side_effect=[...]) list must grow by 1 per new key"

requirements-completed: [TECH-04]

# Metrics
duration: 10min
completed: 2026-04-09
---

# Plan 09-04: Fix RETENTION_DAYS Mock Summary

**PropertyMock side_effect extended from [5,3] to [5,3,2] so TestRetentionMovesOldEntries no longer raises StopIteration on the third web_search_result rowcount read**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-04-09T18:00:00Z
- **Completed:** 2026-04-09T18:10:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Fixed StopIteration crash in `TestRetentionMovesOldEntries` — test now passes with 3 mocked rowcount values
- Updated stale comment from "RETENTION_DAYS has 2 entries" to "RETENTION_DAYS has 3 entries (task_event, rpetd_phase, web_search_result)"
- Added assertions for `rpetd_phase_archived` and `web_search_result_archived` keys, and updated `total` assertion from 8 to 10 (5+3+2)
- All 12 tests in `test_pg_integration.py` pass, 0 regressions

## Task Commits

1. **Task 09-04-01: Update retention mock side_effect [5,3] → [5,3,2]** — `46b02c2` (fix(test))

## Files Created/Modified
- `tests/test_pg_integration.py` — Updated `TestRetentionMovesOldEntries.test_retention_cleanup_moves_old_task_events`: comment, PropertyMock side_effect, two new assertions, total assertion

## Decisions Made
- Third rowcount value is `2` (arbitrary non-zero integer; plan specified `2`; total becomes 5+3+2=10)
- Added explicit `assertIn` + `assertEqual` for both `rpetd_phase_archived` and `web_search_result_archived` to make the test fully document the return dict contract

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None. Root cause was clear from research: `RETENTION_DAYS` grew from 2 to 3 keys in production (web_search_result: 180 added at pg_store.py:91), but the test's PropertyMock was not updated to match. Fix was mechanical.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- TECH-04 complete. Phase 9 has 5 of 6 TECH requirements addressed (TECH-01..05); TECH-06 remains.
- No blockers from this plan.

---
*Phase: 09-tech-debt-sweep*
*Completed: 2026-04-09*
