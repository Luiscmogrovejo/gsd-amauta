---
phase: 22-core-system-tests
plan: 01
subsystem: testing
tags: [unittest, mock, archive, reconcile, rlm, psycopg2, enrichment]

# Dependency graph
requires:
  - phase: 20-critical-bug-fixes
    provides: FIX-05 reconcile archive cross-ref, FIX-06 enrichment isolation
  - phase: 21-minor-bug-fixes
    provides: FIX-09 archive genealogy update
provides:
  - test_archive.py: 11 tests for cmd_archive (dry-run, age, persistence, genealogy, show fallback)
  - test_reconcile.py: 11 tests for cmd_reconcile (dry-run, fix, archive cross-ref, field comparison)
  - test_rlm_wiring.py: 12 tests for _rlm_query + _rpetd_phase_enrich (HTTP, BM25, enrichment, dedup)
affects: [23-integration-e2e-tests]

# Tech tracking
tech-stack:
  added: []
  patterns: [psycopg2.extras pre-import for submodule patching, _noop_lock context manager for _file_lock, _make_response helper for urllib mock]

key-files:
  created: [tests/test_archive.py, tests/test_reconcile.py, tests/test_rlm_wiring.py]
  modified: []

key-decisions:
  - "Pre-import psycopg2.extras at module level to make submodule patchable (AttributeError without it)"
  - "Adapted plan test 'non_r_phase_skips_rlm' to test _mem_semantic_search not called (all phases call _rlm_query, only R calls semantic search)"

patterns-established:
  - "psycopg2 submodule patching: import psycopg2.extras before using patch('psycopg2.extras')"
  - "_noop_lock context manager pattern: @contextmanager def _noop_lock(): yield"
  - "Reconcile mock: _mock_pg_cursor returns MagicMock conn with cursor().fetchall() returning row dicts"

requirements-completed: [TEST-01, TEST-02, TEST-03]

# Metrics
duration: 12min
completed: 2026-03-25
---

# Plan 22-01: Archive, Reconcile, and RLM Test Suites Summary

**34 tests across 3 suites covering cmd_archive, cmd_reconcile, and RLM wiring with full mock isolation**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-25
- **Completed:** 2026-03-25
- **Tasks:** 3
- **Files created:** 3

## Accomplishments
- Archive test suite: dry-run accuracy, age threshold filtering, idempotent persistence, FIX-09 genealogy cleanup, show --archive fallback
- Reconcile test suite: dry-run reporting, --fix upsert/delete, FIX-05 archive cross-reference, 37-field comparison with rpetd mapping, JSONB normalization
- RLM wiring test suite: HTTP transport endpoint selection, BM25 result formatting, Layer 1+2 enrichment orchestration, ENRICHMENT_DEDUP_WINDOW cache hit/miss logic

## Task Commits

Each task was committed atomically:

1. **T01: Archive command test suite** - `762b3ef` (test)
2. **T02: Reconcile command test suite** - `84a8328` (test)
3. **T03: RLM wiring test suite** - `bdf0d60` (test)

## Files Created/Modified
- `tests/test_archive.py` - 11 tests: dry-run, age, persistence, genealogy, show fallback
- `tests/test_reconcile.py` - 11 tests: dry-run, fix, archive cross-ref, field comparison, edge case
- `tests/test_rlm_wiring.py` - 12 tests: HTTP transport, BM25, enrichment flow, dedup window, edge case

## Decisions Made
- Pre-import psycopg2.extras at test module level to enable patching (psycopg2 submodules aren't attributes until imported)
- Adapted "non-R phase skips RLM" test: all phases call _rlm_query, so tested that P-phase doesn't call _mem_semantic_search (the R-phase-only "related experiences" path)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] psycopg2.extras AttributeError**
- **Found during:** T02 (reconcile test suite)
- **Issue:** `patch("psycopg2.extras")` fails because psycopg2.extras is a submodule not loaded by default
- **Fix:** Added `import psycopg2.extras` at module level before tests
- **Files modified:** tests/test_reconcile.py
- **Verification:** All 11 reconcile tests pass
- **Committed in:** 84a8328 (T02 commit)

**2. [Rule 1 - Inaccurate] Plan test "non_r_phase_skips_rlm" incorrect**
- **Found during:** T03 (RLM wiring test suite)
- **Issue:** Plan assumed only R-phase calls _rlm_query, but all 5 phases do
- **Fix:** Changed test to verify P-phase calls _rlm_query but NOT _mem_semantic_search (which is R-phase only)
- **Files modified:** tests/test_rlm_wiring.py
- **Verification:** 12 tests pass, behavior matches actual code
- **Committed in:** bdf0d60 (T03 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 inaccurate plan)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 22-02 (PG integration + distill + auto-learn tests) ready for execution
- All 3 suites from 22-01 pass cleanly (346 total tests, 0 regressions)

---
*Phase: 22-core-system-tests*
*Completed: 2026-03-25*
