---
phase: 45-intelligent-help-routing
plan: 45-02
subsystem: workflow
tags: [bearings, gsd-tools, help-routing, execute-phase, behav-06, HELP-01, HELP-03]

# Dependency graph
requires:
  - phase: 45-01
    provides: gsd-tools.cjs bearings subcommand with FROZEN JSON schema, 4 pattern stats, 6-rule recommendation precedence, Markdown renderer, 600/400-token budgets, graceful degradation
  - phase: 28-the-behavioral-upgrade
    provides: BEHAV-06 get-bearings 400-token contract and feature_list.json trigger condition

provides:
  - get-shit-done/workflows/help.md with dynamic bearings preamble (## Reference header + <bearings> shell-out block) above preserved 708-LOC static reference body
  - get-shit-done/workflows/execute-phase/steps/step-01-prepare.md with Get-Bearings BEHAV-06 subsection shelling out to gsd-tools bearings --terse --token-budget 400
  - get-shit-done/workflows/execute-phase-legacy.md with inline 4-slot Python heredoc replaced by gsd-tools shell-out (single source of truth)
  - tests/bearings-help-integration.test.cjs (3 hermetic tests: preamble present, static body preserved, ## Reference before <reference>)
  - tests/bearings-execute-phase-parity.test.cjs (3 tests: both files shell-out, HELP-01 determinism on Current Position, legacy heredoc absent)

affects:
  - Phase 46 (MCP server may wrap gsd-tools bearings as amauta/bearings MCP tool)
  - Phase 47 (agent hydration may extend bearings sections)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Brownfield prepend: dynamic section + ## Reference header above preserved static body — no deletion of existing content"
    - "Shell-out delegation: workflow .md calls gsd-tools subcommand instead of inlining Python/bash heredoc logic"
    - "Parity test via spawnSync: two consecutive invocations + Current Position extraction proves HELP-01 determinism"
    - "Ordering assertion: refHeaderIdx < refOpenerIdx (indexOf comparison) verifies section ordering in prepend-only edits"

key-files:
  created:
    - tests/bearings-help-integration.test.cjs
    - tests/bearings-execute-phase-parity.test.cjs
  modified:
    - get-shit-done/workflows/help.md
    - get-shit-done/workflows/execute-phase/steps/step-01-prepare.md
    - get-shit-done/workflows/execute-phase-legacy.md

key-decisions:
  - "help.md edit is PREPEND-ONLY: <purpose> updated, <bearings> block + ## Reference header inserted before <reference> opener; static 708-LOC body untouched"
  - "execute-phase token budget stays at 400 (BEHAV-06 contract); /amauta:help uses default 600"
  - "Both execute-phase surfaces (sharded step-01-prepare.md AND legacy execute-phase-legacy.md) use identical shell-out form — single source of truth via gsd-tools bearings"
  - "Determinism test scopes to ## Current Position only (STATE.md-derived, never truncated), not full output, because pattern stats are PG-dependent"

patterns-established:
  - "Brownfield-prepend pattern: ## Reference header between new dynamic block and old static opener for visual separation"
  - "Ordering integration test: for any prepend-only edit, assert indexOf(header) < indexOf(opener) not just presence"
  - "Shell-out delegation: legacy inline Python heredoc in workflow .md = extraction target for gsd-tools subcommand"
  - "HELP-01 parity test: spawnSync x2 + extract deterministic section + strictEqual"

requirements-completed:
  - HELP-01
  - HELP-03

# Metrics
duration: ~45min
completed: 2026-05-12
---

# Phase 45 Plan 02 Summary

**Wave 1 bearings subcommand wired into /amauta:help and both execute-phase surfaces; 5 new tests, 0 regressions across 22 total bearings tests**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-12T18:00:00Z
- **Completed:** 2026-05-12T18:20:00Z
- **Tasks:** 5
- **Files modified:** 3 modified, 2 created

## Accomplishments

- help.md: prepended `<bearings>` shell-out block + `## Reference` header above the existing 708-LOC static reference body; updated `<purpose>` paragraph to describe dual-section behavior. File grew from 708 to 718 lines.
- step-01-prepare.md: inserted Get-Bearings (BEHAV-06) subsection at the correct position (between Sync-chain-flag and Amauta-integration blocks) with FEATURE_LISTS trigger and `gsd-tools bearings --terse --token-budget 400` shell-out.
- execute-phase-legacy.md: replaced the inline 4-slot Python heredoc assembly with the same shell-out form — both execute-phase surfaces now delegate to a single source of truth.
- 5 new tests: bearings-help-integration (3 hermetic) + bearings-execute-phase-parity (3: text-match, HELP-01 determinism, legacy-heredoc-absent).
- 0 regressions: all 17 Wave 1 tests (bearings-rules, bearings-json-schema, bearings-token-budget, bearings-patterns) still pass.

## Task Commits

Each task was committed atomically:

1. **45-02-01: Prepend bearings block + ## Reference header to help.md** — `92126d9` (feat)
2. **45-02-02: Add Get-Bearings BEHAV-06 subsection to step-01-prepare.md** — `4670a85` (feat)
3. **45-02-03: Replace inline Python heredoc in execute-phase-legacy.md** — `fb60fd2` (feat)
4. **45-02-04: Add tests/bearings-help-integration.test.cjs** — `49b3ee7` (feat)
5. **45-02-05: Add tests/bearings-execute-phase-parity.test.cjs** — `d86cb28` (feat)

## Files Created/Modified

- `get-shit-done/workflows/help.md` — Updated purpose paragraph; prepended `<bearings>` shell-out block + `## Reference` header above `<reference>` static body opener (line 33 before line 35); static body 708 LOC preserved verbatim
- `get-shit-done/workflows/execute-phase/steps/step-01-prepare.md` — New Get-Bearings BEHAV-06 subsection inserted between Sync-chain-flag and Amauta-integration blocks; FEATURE_LISTS trigger + 400-token shell-out
- `get-shit-done/workflows/execute-phase-legacy.md` — Lines 62-81: 4-slot Python heredoc assembly replaced with Get-Bearings BEHAV-06 explanation + shell-out block + token-budget delegation note
- `tests/bearings-help-integration.test.cjs` — 3 hermetic tests: preamble present, static body preserved, ordering assertion
- `tests/bearings-execute-phase-parity.test.cjs` — 3 tests: text-match both files, HELP-01 determinism (spawnSync x2 + Current Position equality), legacy heredoc absent

## Decisions Made

- Scoped determinism assertion to `## Current Position` section only — pattern stats are PG-dependent and can show `(unavailable)` across invocations; Current Position is STATE.md-derived and always deterministic.
- `## Reference` header inserted as a blank-line-separated header (not inside the `<bearings>` tag) so it visually separates the two sections without requiring XML parsing to navigate.
- Token budget: 400 for execute-phase (BEHAV-06 contract preserved), default 600 for /amauta:help.

## Deviations from Plan

None — plan executed exactly as written. All 5 tasks already landed in git from a prior session; this execution verified state, ran tests, logged RPETD phases, and created closeout documentation.

## Issues Encountered

None. All file modifications were already committed when execution began. Test suite ran clean (6/6 new tests + 17/17 Wave 1 tests, 0 failures).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- HELP-01 (deterministic bearings, code-generated) and HELP-03 (get-bearings integration) are satisfied.
- HELP-02 (4 pattern stats) was satisfied in Wave 1 (45-01).
- Phase 45 is complete pending ROADMAP/STATE.md updates.
- Phase 46 (Standalone MCP Server) can begin — `gsd-tools bearings` is the canonical entry point Phase 46 will wrap as `amauta/bearings` MCP tool.

---
*Phase: 45-intelligent-help-routing*
*Completed: 2026-05-12*
