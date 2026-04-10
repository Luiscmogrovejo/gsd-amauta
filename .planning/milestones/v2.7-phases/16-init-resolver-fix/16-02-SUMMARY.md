---
phase: 16-init-resolver-fix
plan: 16-02
subsystem: infra
tags: [gsd-tools, init, phase-dir, resolver, cli]

requires:
  - phase: 16-01
    provides: milestone-scoped resolver that findPhaseInternal now consults

provides:
  - "--phase-dir override on all four phase-aware init subcommands (execute-phase, plan-phase, verify-work, phase-op)"
  - "validatePhaseDirOverride() helper: existence, directory, empty-dir hard errors with sibling suggestion"
  - "Relpath normalization from absolute or relative input"
  - "phaseInfo-compatible return object with override:true flag for caller tracing"
  - "validatePhaseDirOverride exported for testability"

affects: [phase 17, phase 18, phase 19, gsd-executor agents, gsd-validator]

tech-stack:
  added: []
  patterns:
    - "ternary resolver bypass: phaseDirOverride ? validatePhaseDirOverride() : findPhaseInternal()"
    - "--phase-dir= (equals form) and --phase-dir <value> (space form) both stripped from args before subcommand dispatch"

key-files:
  created: []
  modified:
    - get-shit-done/bin/lib/init.cjs

key-decisions:
  - "validatePhaseDirOverride returns a phaseInfo-compatible shape so callers need zero special-case logic downstream"
  - "override:true flag added to return shape so callers can distinguish resolver-resolved vs override-provided paths"
  - "Empty directory (no PLAN.md files) is a hard error with sibling suggestion, not a soft warning"
  - "Relative paths are normalized to relative-from-cwd (not absolute) for consistency with how findPhaseInternal returns paths"

patterns-established:
  - "Pattern: escape-hatch parameter as 4th arg — non-phase subcommands (new-project, new-milestone, etc.) are NOT modified; only the four phase-aware ones accept phaseDirOverride"

requirements-completed:
  - RESOLVE-02

duration: 20min
completed: 2026-04-10
---

# Plan 16-02: --phase-dir Override Flag Summary

**RESOLVE-02 escape hatch: all four phase-aware init subcommands now accept `--phase-dir <path>` to bypass the resolver entirely, with hard validation on nonexistent paths and empty directories**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-10
- **Completed:** 2026-04-10
- **Tasks:** 2 (16-02-01 already committed; 16-02-02 implemented and committed this session)
- **Files modified:** 2 (gsd-tools.cjs — prior commit; init.cjs — this session)

## Accomplishments

- `validatePhaseDirOverride()` helper added: existence check, directory check, empty-dir hard error with sibling suggestion, relpath normalization, full phaseInfo-compatible return with `override: true` flag
- All four phase-aware init subcommands (`cmdInitExecutePhase`, `cmdInitPlanPhase`, `cmdInitVerifyWork`, `cmdInitPhaseOp`) updated to accept and use `phaseDirOverride` as 4th parameter
- `findPhaseInternal` calls replaced with ternary bypass in all four functions
- `validatePhaseDirOverride` exported from module.exports for testability
- Cross-milestone override verified: `--phase-dir .planning/milestones/v2.3-phases/16-data-integrity` returns that exact path, bypassing the milestone-scoped resolver from 16-01

## Task Commits

1. **Task 16-02-01: Extract --phase-dir from CLI args in gsd-tools.cjs init dispatch** - `019d767` (feat)
2. **Task 16-02-02: Add --phase-dir validation and bypass logic to all four init subcommands** - `e2c37d7` (feat)

## Files Created/Modified

- `get-shit-done/bin/gsd-tools.cjs` - `--phase-dir` extraction before subcommand dispatch (space and equals forms), `phaseDirOverride` passed as 4th arg to all four phase-aware subcommands
- `get-shit-done/bin/lib/init.cjs` - `validatePhaseDirOverride()` helper added, four function signatures updated, four `findPhaseInternal` calls replaced with ternary bypass, `validatePhaseDirOverride` exported

## Decisions Made

- `validatePhaseDirOverride` returns a phaseInfo-compatible shape (same fields as `findPhaseInternal` output) so downstream `result` object assembly in each subcommand requires zero changes
- `override: true` field added to distinguish override-provided paths from resolver-provided ones
- Non-phase-aware subcommands (`new-project`, `new-milestone`, `quick`, `resume`, `todos`, `milestone-op`, `map-codebase`, `progress`) are NOT modified — the override concept only applies to phase-aware operations

## Deviations from Plan

None — plan executed exactly as specified. Task 16-02-01 was pre-committed from a prior session; confirmed via `git log` before starting 16-02-02.

## Issues Encountered

None.

## Next Phase Readiness

- Phase 16 is complete (both plans 16-01 and 16-02 shipped)
- Phase 17 (Audit Script Hardening) can now proceed — the init resolver is clean and `--phase-dir` override exists for any cross-milestone edge case
- All four phase-aware init subcommands are now safe to use against v2.7 directories without risk of ghost resolver returns

---
*Phase: 16-init-resolver-fix*
*Completed: 2026-04-10*
