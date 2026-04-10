---
phase: 16-init-resolver-fix
plan: 16-03
subsystem: testing
tags: [node-test, synthetic-fixtures, resolver, init, milestone-scoped]

requires:
  - phase: 16-01
    provides: findPhaseInternal milestone-scoped resolver
  - phase: 16-02
    provides: validatePhaseDirOverride --phase-dir override

provides:
  - 11-test regression suite for the milestone-scoped resolver (RESOLVE-01 + RESOLVE-02)
  - Dogfood depth 7/8/10 replay fixtures using exact historical directory names
  - process.exit capture pattern for testing hard-error paths in CJS modules

affects: [phase-17, phase-18, phase-19]

tech-stack:
  added: []
  patterns: [process.exit capture via sentinel throw for hard-error testing, createFixture helper for synthetic .planning trees]

key-files:
  created: [tests/16-init-resolver.test.cjs]
  modified: []

key-decisions:
  - "process.exit interception via sentinel throw: validatePhaseDirOverride calls error() which calls process.exit(1), not throw. Tests intercept process.exit, capture exitCode + stderr, then restore originals via finally. Sentinel object { __capturedExit: true } distinguishes the interception from a real test failure."
  - "11 tests instead of plan's 10 minimum: added belt-and-suspenders cross-milestone bleed test to cover both depth 7/8 ghosts in a single fixture alongside the depth 10 replay."
  - "captureError helper is self-contained in the test file — no external helper needed, following the isolation pattern from 13.1-manifest-check.test.cjs."

patterns-established:
  - "captureError(fn) helper: intercept process.exit without killing the test runner — useful for any CJS module that uses error() from core.cjs"
  - "createFixture(opts) helper: minimal .planning tree for init resolver tests, accepts config / milestones / phases keys"

requirements-completed: [RESOLVE-01, RESOLVE-02]

duration: 20min
completed: 2026-04-10
---

# Plan 16-03: Regression Tests for Milestone-Scoped Resolver Summary

**11 synthetic fixture tests replaying v2.6/v2.7 dogfood depths 7/8/10 with exact historical directory names; all pass via `node --test`; 0 new npm failures introduced**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-04-10
- **Tasks:** 2 (16-03-01: create test file, 16-03-02: verify npm test)
- **Files modified:** 1 (created tests/16-init-resolver.test.cjs)

## Accomplishments
- Created `tests/16-init-resolver.test.cjs` with 11 tests covering all plan requirements
- Verified `node --test tests/16-init-resolver.test.cjs` exits 0 (11 pass, 0 fail)
- Confirmed no new npm failures beyond the 4 known v2.6 baseline failures
- Live smoke test confirms real repo returns `v2.7-phases/16-init-resolver-fix` for phase 16

## Task Commits

1. **Task 16-03-01: Create synthetic fixture test cases** - `5ffd1e6` (tests)

## Files Created/Modified
- `tests/16-init-resolver.test.cjs` — 11-test suite: depth 7/8 replay, depth 10 replay, RESOLVE-02 override, 5 edge cases, cross-milestone bleed, live smoke test

## Decisions Made

1. **process.exit interception instead of child process spawn:** `validatePhaseDirOverride` calls `error()` which calls `process.exit(1)` — not `throw`. Rather than spawning a child process for each error test (complex, slow), we temporarily replace `process.exit` with a function that throws a sentinel object `{ __capturedExit: true }`. The sentinel is caught in the `captureError` helper's try/catch, and the original `process.exit` is restored in `finally`. This makes error-path tests fast, isolated, and readable.

2. **11 tests instead of minimum 10:** Added a distinct "no cross-milestone bleed" test that uses the same v2.3/v2.2 ghosts as the depth 7/8 replay but checks both ghost paths explicitly in the same fixture. Belt-and-suspenders: plan required >= 10, we shipped 11 because the belt-and-suspenders test adds meaningful coverage.

## Deviations from Plan

None — plan executed exactly as written. The one clarification (process.exit behavior) was discovered during R-phase by reading the source files before writing code.

## Issues Encountered

None — `validatePhaseDirOverride` uses `error()` from `core.cjs` which calls `process.exit(1)`, not `throw`. This was caught pre-implementation by reading the source; the `captureError` helper was designed accordingly. No rework needed.

## Next Phase Readiness

Phase 16 is now fully complete (RESOLVE-01 + RESOLVE-02 + regression tests all shipped). Phase 17 (Audit Script Hardening) can begin. The fixed resolver is available for Phase 17's executor to use via the normal `gsd-tools init` commands.

---
*Phase: 16-init-resolver-fix*
*Completed: 2026-04-10*
