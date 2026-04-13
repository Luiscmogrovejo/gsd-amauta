---
phase: 25-tech-debt-sweep
plan: "25-01"
subsystem: testing
tags: [ghost-fallback, plan-to-tasks, regression, workflow, node-test]

# Dependency graph
requires:
  - phase: 16-init-resolver-fix
    provides: findPhaseInternal milestone-scoped ghost fix (core.cjs lines 299-331)
provides:
  - DEBT-02 fix: GSD_P_AUTO_TASK defaults to true in execute-phase.md (plan-to-tasks ON by default)
  - DEBT-01 regression tests: 4 ghost elimination tests through cmdInitPhaseOp with v2.8 context
  - DEBT-02 regression tests: 3 plan-to-tasks default tests (workflow guard + kill switch behavior)
affects: [25-02, future-plans-with-phase-14-registration]

# Tech tracking
tech-stack:
  added: []
  patterns: [captureOutput helper for testing functions that call process.exit]

key-files:
  created:
    - tests/25-debt-sweep.test.cjs
  modified:
    - get-shit-done/workflows/execute-phase.md

key-decisions:
  - "captureOutput helper pattern: intercept process.stdout.write AND process.exit to test cmdInitPhaseOp without killing the test runner"
  - "DEBT-01 test 4 (depth-11 replay): v2.8 context with both v2.7 and v2.3 archived dirs returns null — confirms milestone scoping is strict"
  - "DEBT-02 test 7: unset GSD_P_AUTO_TASK triggers planToTasks pass-through (connects to daemon, may fail there, but never returns kill_switch)"

patterns-established:
  - "captureOutput: intercepts process.stdout.write + process.exit for functions that call output() then exit(0)"
  - "Temp-dir cleanup: cleanupOrPreserve preserves dir on failure for post-mortem, removes on success"

requirements-completed: [DEBT-01, DEBT-02]

# Metrics
duration: 20min
completed: 2026-04-12
---

# Plan 25-01: Ghost Elimination + Plan-to-Tasks Default Fix

**GSD_P_AUTO_TASK default inverted in execute-phase.md (:-false to :-true) + 7 regression tests for DEBT-01 ghost elimination and DEBT-02 default fix**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-12T00:00:00Z
- **Completed:** 2026-04-12T00:20:00Z
- **Tasks:** 3 (25-01-01, 25-01-02, 25-01-03)
- **Files modified:** 2

## Accomplishments

- Fixed DEBT-02: changed `${GSD_P_AUTO_TASK:-false}` to `${GSD_P_AUTO_TASK:-true}` in execute-phase.md line 133; plan-to-tasks now runs by default for all phases >= 14 unless explicitly disabled
- Added 4 DEBT-01 regression tests through cmdInitPhaseOp with v2.8 context: v2.3 ghost returns null, .planning/phases/ secondary location found, ROADMAP fallback (not ghost), depth-11 replay
- Added 3 DEBT-02 regression tests: workflow file guard check, kill switch fires on explicit 'false', unset env var does not trigger kill switch
- Zero new test failures introduced (13 pre-existing failures, all pre-dated this plan)

## Task Commits

1. **Task 25-01-01: Fix execute-phase.md DEBT-02** - `f636d1c` (fix)
2. **Task 25-01-02: DEBT-01+02 regression tests** - `c06f147` (test)
3. **Task 25-01-03: Zero-regression verification** - (no commit, test-only task)

## Files Created/Modified

- `get-shit-done/workflows/execute-phase.md` - Changed GSD_P_AUTO_TASK default from false to true; added clarifying comment
- `tests/25-debt-sweep.test.cjs` - 7 regression tests (4 DEBT-01 ghost, 3 DEBT-02 default)

## Decisions Made

- captureOutput helper (intercepts process.stdout.write + process.exit): needed because cmdInitPhaseOp calls output() which prints JSON and calls process.exit(0). Without interception, the first test using cmdInitPhaseOp would kill the test runner.
- DEBT-01 test 3 uses cmdInitPhaseOp directly (not findPhaseInternal) to verify the full entry point chain: resolver null → ROADMAP fallback → phase_dir: null.
- DEBT-01 test 4 (depth-11 replay) verifies that v2.8 context ignores BOTH v2.7-phases and v2.3-phases for phase 16 — milestone scoping is strict, not a cascading fallback.

## Deviations from Plan

None — plan executed exactly as specified. The only observation: test 25-01-03 confirmed the `live smoke: init phase-op 16` test in 16-init-resolver.test.cjs was already failing before this plan (pre-existing: repo moved to v2.8, that test hardcodes v2.7 expectation).

## Issues Encountered

None of consequence. The captureOutput pattern was required by the test design — cmdInitPhaseOp calls process.exit(0) via output(), which is expected behavior. Resolved cleanly with the captureOutput helper pattern (modeled after captureError in 16-init-resolver.test.cjs).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- DEBT-01 and DEBT-02 closed with regression guards
- 25-debt-sweep.test.cjs is ready for Plan 25-02 to add DEBT-03/DEBT-04 tests to the same file
- Full test suite: 2207 tests, 13 pre-existing failures, 0 new failures

---
*Phase: 25-tech-debt-sweep*
*Completed: 2026-04-12*
