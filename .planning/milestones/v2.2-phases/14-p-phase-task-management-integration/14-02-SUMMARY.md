---
phase: 14-p-phase-task-management-integration
plan: 02
subsystem: backend
tags: [nodejs, python, plan-to-tasks, validation, dedup, dag, cycle-detection]

requires:
  - phase: 14-01
    provides: divergence-protocol.md v1.1.0 with agent_assignment_conflict + plan_amauta_drift enum values

provides:
  - scoped dedup bypass in amauta.py _dedup_check (LOCK B, plan-to-tasks idempotency)
  - --source and --from-plan argparse flags in amauta.py cmd_add
  - gsd-amauta.cjs cmdAdd flag pass-through for --source and --from-plan
  - planToTasks() Pass 0 validation engine in gsd-tools.cjs
  - _validatePlanShape, _detectCycles, _checkAgentConflicts, _filesDisjointSplit, _renderDagText, _diffPlanVsAmauta helpers
  - GSD_P_AUTO_TASK=false kill switch in planToTasks()
  - plan-to-tasks CLI dispatch case in gsd-tools.cjs
  - 20 unit tests in tests/14-plan-to-tasks.test.cjs (all pass)

affects:
  - 14-03 (Pass 1+2 implementation consumes planToTasks() stub from this plan)
  - 14-04 (PLAN_REGISTRATION operator parser needs planToTasks() exported functions)

tech-stack:
  added: []
  patterns:
    - "_validatePlanShape returns {valid, errors[], taskCount, tasks[]} — all Pass 0 callers check .valid before proceeding"
    - "_detectCycles uses DFS with visited/inStack sets — cycle array includes the path from first repeat node back to itself"
    - "_filesDisjointSplit tries all N-1 candidate boundaries; returns first disjoint boundary or least-overlap cut"
    - "module.exports guard (require.main !== module) exports both production API (planToTasks) and test-only helpers (_validatePlanShape etc.)"

key-files:
  created:
    - tests/14-plan-to-tasks.test.cjs
  modified:
    - amauta.py (already had bypass + flags from prior partial work — verified complete)
    - get-shit-done/bin/gsd-amauta.cjs (added --source/--from-plan pass-through)
    - get-shit-done/bin/gsd-tools.cjs (planToTasks + 6 helpers + exports + CLI dispatch)

key-decisions:
  - "amauta.py _dedup_check scoped bypass was already in place from a prior partial implementation; only the CJS cmdAdd direct-CLI path was missing the flag pass-through"
  - "_filesDisjointSplit returns the FIRST disjoint boundary (smallest valid cut), not a boundary close to the midpoint — this matches the spec's 'largest contiguous prefix' language"
  - "_renderDagText truncation ensures total output <= 500 chars (not just the pre-marker portion); marker is 30 chars so truncation point is 470"
  - "planToTasks() Pass 1+2 are stubs returning {pass0: complete, tasks, story} — full implementation in plan 14-03"

patterns-established:
  - "Pure-function unit tests for Pass 0 logic use inline XML fixture strings (no tmpdir needed) — more maintainable for pure-function testing"
  - "Kill switch (GSD_P_AUTO_TASK=false) checked as first thing in planToTasks — returns before any file I/O"

requirements-completed:
  - PLAN-02
  - PLAN-03
  - PLAN-04
  - PLAN-05

duration: 45min
completed: 2026-04-10
---

# Plan 14-02: Dedup Bypass + Pass 0 Validation Engine Summary

**planToTasks() Pass 0 validation engine (cycles, cap, schema, agent conflicts, file-disjoint split) + scoped _dedup_check bypass in amauta.py/CJS, 20 unit tests all green**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-10T17:30:00Z
- **Completed:** 2026-04-10T18:15:00Z
- **Tasks:** 3
- **Files modified:** 3 modified, 1 created

## Accomplishments

- `planToTasks()` with full Pass 0 validation (cycle detection, 10-task cap, missing story, missing files_expected, agent-assignment conflict via routeExecutor) exported and CLI-dispatched
- Six pure-function helpers: `_validatePlanShape`, `_detectCycles`, `_checkAgentConflicts`, `_filesDisjointSplit`, `_renderDagText`, `_diffPlanVsAmauta`
- CJS `cmdAdd` flag pass-through for `--source`/`--from-plan` (daemon path already passed through via `...flags` spread; only direct CLI path was missing)
- 20 unit tests, 20/20 pass — no daemon required for any test

## Task Commits

Each task committed atomically:

1. **Task 14-02-01: CJS flag pass-through** — `0965af3` (feat)
2. **Task 14-02-02: planToTasks() + helpers** — `db50900` (feat)
3. **Task 14-02-03: 20 unit tests + DAG truncation fix** — `eef17f2` (feat)

## Files Created/Modified

- `/Users/luismogrovejo/Code/gsd-amauta/get-shit-done/bin/gsd-amauta.cjs` — Added `--source`/`--from-plan` pass-through in `cmdAdd` direct CLI path
- `/Users/luismogrovejo/Code/gsd-amauta/get-shit-done/bin/gsd-tools.cjs` — planToTasks() + 6 helpers + module.exports additions + `case 'plan-to-tasks':` CLI dispatch (439 lines added)
- `/Users/luismogrovejo/Code/gsd-amauta/tests/14-plan-to-tasks.test.cjs` — 20 unit tests created

## Decisions Made

- `_filesDisjointSplit` returns the FIRST disjoint boundary (index 1 if tasks[0] and tasks[1] have no shared files), not the midpoint — the spec says "largest contiguous prefix where files are disjoint from the next batch" which means the algorithm walks forward and takes the first clean cut.
- `_renderDagText` truncation: the total output (including the `...(full DAG in sidecar file)` marker) must be <= 500 chars, so the truncation point is `500 - marker.length = 470` chars.

## Deviations from Plan

### Observations (not divergences — pre-existing correct state)

**1. amauta.py task 14-02-01 was already partially done**
- `_dedup_check` scoped bypass, `cmd_add` source/from_plan stamping, and argparse flags were already implemented from a prior session.
- Only the CJS `cmdAdd` direct CLI path was missing the flag pass-through.
- No plan deviation — plan said "add pass-through" and the CJS side was genuinely missing.

**2. DAG truncation produces output slightly over 500 chars with naive 490-char cut**
- The `_renderDagText` function initially truncated at 490 chars and appended `\n...(full DAG in sidecar file)` (30 chars), producing 520 total.
- Fixed to ensure total output <= 500 by using `500 - marker.length` as the cut point.
- Caught by test assertion; fixed before commit.

## Issues Encountered

None beyond the DAG truncation calculation above.

## Next Phase Readiness

- Plan 14-03 (Pass 1+2: actual task creation) can now consume `planToTasks()` — it returns `{pass0: 'complete', tasks, story}` for a valid plan.
- All Pass 0 exports available: `_validatePlanShape`, `_detectCycles`, `_checkAgentConflicts`, `_filesDisjointSplit`, `_renderDagText`, `_diffPlanVsAmauta`.
- Kill switch `GSD_P_AUTO_TASK=false` functional and tested.

---
*Phase: 14-p-phase-task-management-integration*
*Completed: 2026-04-10*
