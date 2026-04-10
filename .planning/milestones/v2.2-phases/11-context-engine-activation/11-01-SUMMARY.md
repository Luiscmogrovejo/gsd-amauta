---
phase: 11-context-engine-activation
plan: 11-01
subsystem: agents
tags: [pre-execution, mandate, security-checklist, executor, rpetd, cli-variables]

requires:
  - phase: 10-d-phase-structured-learning
    provides: cli-variables.md runtime Read pattern + TAG_RULES fallback structure

provides:
  - get-shit-done/references/pre-execution-checklist.md with 4 query templates + 8-item security checklist
  - PRE_EXECUTION_CHECKLIST variable in cli-variables.md (shell block, fallback, reference table)
  - <pre_execution_mandate> block in all 4 executor agents (backend/frontend/infra/general)
  - <pre_execution_mandate> block in gsd-debugger.md (Step 4: Fix)
  - PRE_EXECUTION_CHECKLIST fallback line in all 6 agent files (5 executors + validator)
  - EXEC-08 APPLIED_LEARNING citation requirement in D-phase of all 5 executor/debugger agents

affects: [11-context-engine-activation/11-02, gsd-validator, all executor tasks]

tech-stack:
  added: []
  patterns:
    - PRE_EXECUTION_EVIDENCE block format (parallel to LEARNING block, indented-field parsing)
    - pre_execution_mandate XML block for executor prompt injection
    - Kill switch pattern GSD_E_MANDATE=advisory|off following GSD_D_STRUCTURED pattern

key-files:
  created:
    - get-shit-done/references/pre-execution-checklist.md
    - .planning/milestones/v2.2-phases/11-context-engine-activation/11-01-SUMMARY.md
  modified:
    - get-shit-done/references/cli-variables.md
    - agents/gsd-executor-backend.md
    - agents/gsd-executor-frontend.md
    - agents/gsd-executor-infra.md
    - agents/gsd-executor-general.md
    - agents/gsd-debugger.md
    - agents/gsd-validator.md

key-decisions:
  - "Mandate block placed AFTER E-phase heading and BEFORE existing $RLM query line — closest to the action"
  - "Debugger uses distinct wording 'Before applying the fix' (not 'Before writing code') — mandate in Step 4 not Step 0"
  - "Fallback line is commented-out (# prefix) to mirror existing TAG_RULES pattern in all agent fallback blocks"
  - "PRE_EXECUTION_CHECKLIST added to Shell Variable Block (unquoted), Fallback block (commented), and Variable Reference table — 3 locations matching plan spec"

patterns-established:
  - "pre_execution_mandate XML block: Read checklist + run 3 queries + evaluate 8 security items + emit PRE_EXECUTION_EVIDENCE as first E-phase content"
  - "Evidence block skips: 'skipped -- non-code task' or 'skipped -- mandate disabled (GSD_E_MANDATE=off)'"
  - "EXEC-08 citation: D-phase must cite APPLIED_LEARNING or explicitly note 'no applicable prior learnings'"

requirements-completed:
  - EXEC-01
  - EXEC-02
  - EXEC-03
  - EXEC-05
  - EXEC-06
  - EXEC-07
  - EXEC-08

duration: 45min
completed: 2026-04-09
---

# Plan 11-01: Reference Infrastructure + Executor Mandate Prompts Summary

**Pre-execution checklist reference + PRE_EXECUTION_EVIDENCE block format wired into all 4 executor agents and debugger via shared mandate block**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-09
- **Completed:** 2026-04-09
- **Tasks:** 8 (11-01-01 through 11-01-08)
- **Files modified:** 8 (1 created + 7 edited)

## Accomplishments

- Created `pre-execution-checklist.md` (98 lines) with 4 query templates, 8-item security checklist with n/a vs skipped semantics, canonical PRE_EXECUTION_EVIDENCE block example, kill switch docs, and D-phase APPLIED_LEARNING citation requirement
- Added `PRE_EXECUTION_CHECKLIST` variable to `cli-variables.md` in all 3 required locations (shell block, fallback, reference table — confirmed 3 occurrences)
- Added identical `<pre_execution_mandate>` block to 4 executor agents in E-phase section, each within +25% prompt budget
- Added debugger-specific `<pre_execution_mandate>` block to `gsd-debugger.md` Step 4: Fix with distinct "Before applying the fix" wording
- Added `PRE_EXECUTION_CHECKLIST` fallback line (commented) to all 6 agent files: 5 executors + validator

## Task Commits

1. **Task 11-01-01: Create pre-execution-checklist.md** - `45b84bb` (feat)
2. **Task 11-01-02: Add PRE_EXECUTION_CHECKLIST to cli-variables.md** - `d4ac721` (feat)
3. **Task 11-01-03: Add mandate to gsd-executor-backend.md** - `e73e675` (feat)
4. **Task 11-01-04: Add mandate to gsd-executor-frontend.md** - `3325eb2` (feat)
5. **Task 11-01-05: Add mandate to gsd-executor-infra.md** - `b8b262d` (feat)
6. **Task 11-01-06: Add mandate to gsd-executor-general.md** - `0132f23` (feat)
7. **Task 11-01-07: Add mandate to gsd-debugger.md Step 4** - `411691e` (feat)
8. **Task 11-01-08: Add PRE_EXECUTION_CHECKLIST fallback to all 6 agent files** - `3b12230` (feat)

## Files Created/Modified

- `get-shit-done/references/pre-execution-checklist.md` - New reference: 4 query templates + 8-item checklist + evidence block format
- `get-shit-done/references/cli-variables.md` - Added PRE_EXECUTION_CHECKLIST in 3 locations
- `agents/gsd-executor-backend.md` - Added mandate block (E-phase) + EXEC-08 (D-phase) + fallback line (196 lines, budget 213)
- `agents/gsd-executor-frontend.md` - Added mandate block (E-phase) + EXEC-08 (D-phase) + fallback line (169 lines, budget 180)
- `agents/gsd-executor-infra.md` - Added mandate block (E-phase) + EXEC-08 (D-phase) + fallback line (173 lines, budget 185)
- `agents/gsd-executor-general.md` - Added mandate block (E-phase) + EXEC-08 (D-phase) + fallback line (176 lines, budget 189)
- `agents/gsd-debugger.md` - Added debugger mandate block (Step 4: Fix) + EXEC-08 (Step 6 Learn) + fallback line (216 lines, budget 238)
- `agents/gsd-validator.md` - Added PRE_EXECUTION_CHECKLIST fallback line only (187 lines, budget 232)

## Decisions Made

- Debugger mandate uses distinct wording "Before applying the fix" (not "Before writing code") because debugger Step 0 already does a broad symptom search — the pre-E mandate adds targeted per-file queries for the specific fix
- The fallback block entry is commented out (# prefix) to match the existing TAG_RULES pattern — agents uncomment only if the cli-variables.md Read fails
- Checklist reference file kept at 98 lines (within 80-130 target) by collapsing verbose prose into inline notes

## Deviations from Plan

None — plan executed exactly as written. All 8 acceptance criteria verified for each task.

## Issues Encountered

None. The fallback block in the plan referenced `# TAG_RULES=...` format which matched exactly what was in the agent files.

## Next Phase Readiness

- Plan 11-01 complete: reference file, cli-variables.md, and all executor/debugger agent mandates are in place
- Plan 11-02 can now proceed: adds gsd-validator advisory check that parses PRE_EXECUTION_EVIDENCE from E-phase content
- The `pre-execution-checklist.md` is already dynamically parsed by the mandate (agents Read it at E-phase start); validator will also Read it for dynamic checklist item discovery

---
*Phase: 11-context-engine-activation*
*Completed: 2026-04-09*
