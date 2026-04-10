---
phase: 12-semantic-memory-pipeline
plan: 12-03
subsystem: testing
tags: [validator, advisory, qa-blocks, red-green, spec-inheritance, gsd-amauta]

# Dependency graph
requires:
  - phase: 12-01
    provides: _inherit_parent_spec() helper + inherited_success_criteria JSON field
  - phase: 12-02
    provides: qa-checklist.md reference + _checkQaBlocks/_checkRedGreenOrder function bodies (partial)

provides:
  - _checkQaBlocks() pure function exported from gsd-amauta.cjs for test imports
  - _checkRedGreenOrder() pure function exported from gsd-amauta.cjs for test imports
  - checkSpecInheritanceAdvisory() async advisory function wired into cmdValidate
  - [ADVISORY] SPEC_INHERITANCE log message in validation output (non-blocking)
  - GSD_T_SPEC_INHERIT=false kill switch for advisory
  - Spec Inheritance + QA Advisory section in gsd-validator.md

affects: [12-04, phase-14, gsd-validator]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure function + async advisory wrapper: same daemon/direct pattern as checkEvidenceAdvisory"
    - "spawnSync('git') for RED-GREEN detection inside async advisory (non-fatal on failure)"
    - "module.exports conditional block for require.main guard (test-only exports)"

key-files:
  created: []
  modified:
    - get-shit-done/bin/gsd-amauta.cjs
    - agents/gsd-validator.md

key-decisions:
  - "Functions _checkQaBlocks and _checkRedGreenOrder were already present from a previous partial implementation; only module.exports update was needed for task 12-03-02"
  - "checkSpecInheritanceAdvisory placed AFTER checkEvidenceAdvisory, called AFTER evidence advisory in cmdValidate, BEFORE const body = { id, ...flags }"
  - "Advisory never affects gateFailures -- non-blocking in v2.6; hard gate deferred to v2.7"

patterns-established:
  - "Advisory pattern: kill switch -> fetch task -> call pure check fn -> results array -> return { advisory, reason }"
  - "All advisory blocks in cmdValidate: if (flags.pass_result && !flags.force_reason) { try { ... } catch { /* best-effort */ } }"

requirements-completed: [QA-04, QA-05, QA-06, QA-07, QA-08]

# Metrics
duration: ~25min
completed: 2026-04-09
---

# Plan 12-03: Validator Advisory + Regression Sweep + RED-GREEN Detection Summary

**checkSpecInheritanceAdvisory() wired into cmdValidate with _checkQaBlocks() + _checkRedGreenOrder() pure functions exported for testing, and gsd-validator.md updated with Phase 12 advisory section**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-09T21:55:15Z
- **Completed:** 2026-04-09T22:25:00Z
- **Tasks:** 3 (12-03-02, 12-03-03, 12-03-04; 12-03-01 already committed in e713ed1)
- **Files modified:** 2

## Accomplishments

- Exported `_checkQaBlocks` and `_checkRedGreenOrder` from gsd-amauta.cjs test-only module.exports block (task 12-03-02)
- Implemented `checkSpecInheritanceAdvisory()` async function with kill switch, QA block checks, and RED-GREEN git log detection; wired non-blocking into `cmdValidate` after Phase 11 evidence advisory (task 12-03-03)
- Added Phase 12 Spec Inheritance + QA Advisory section to gsd-validator.md documenting EDGE_CASES/REGRESSION/ADVERSARIAL/QA_REPORT checks, RED-GREEN guidance, and GSD_T_SPEC_INHERIT kill switch (task 12-03-04)

## Task Commits

Each task was committed atomically:

1. **Task 12-03-02: Export _checkQaBlocks and _checkRedGreenOrder** - `1900dd5` (feat)
2. **Task 12-03-03: Implement checkSpecInheritanceAdvisory + wire into cmdValidate** - `8f8d7ee` (feat)
3. **Task 12-03-04: Add Spec Inheritance + QA Advisory to gsd-validator.md** - `47f32ac` (feat)

Note: Task 12-03-01 was pre-committed: `e713ed1` (feat: regression_sweep step + inherited spec pull to test-phase.md)

## Files Created/Modified

- `get-shit-done/bin/gsd-amauta.cjs` - Added `checkSpecInheritanceAdvisory()` + updated module.exports to include all 3 new exported functions
- `agents/gsd-validator.md` - Added Phase 12 Spec Inheritance + QA Advisory section (28 new lines, total 236 < 250 budget)

## Decisions Made

- `_checkQaBlocks()` and `_checkRedGreenOrder()` function bodies were already present in gsd-amauta.cjs from a prior partial implementation (part of task 12-02 work). Task 12-03-02 only needed to add them to `module.exports`.
- `checkSpecInheritanceAdvisory()` uses `spawnSync('git')` (not async child_process) to keep RED-GREEN detection synchronous inside the async advisory wrapper, matching the plan spec exactly.
- Advisory is non-blocking in v2.6: `gateFailures` array is never modified; hard gate deferred to v2.7 after compliance measurement.

## Deviations from Plan

None - plan executed exactly as written. Functions were already partially implemented; only exports and the async wrapper were missing.

## Issues Encountered

None.

## Next Phase Readiness

- Plan 12-04 (Tests + STATE.md baseline) is next
- `_checkQaBlocks` and `_checkRedGreenOrder` are now importable for CJS tests via `require('./gsd-amauta.cjs')._checkQaBlocks` etc.
- QA-04..QA-08 all addressed; QA-01..QA-03 addressed by plans 12-01 and 12-02

---
*Phase: 12-semantic-memory-pipeline*
*Completed: 2026-04-09*
