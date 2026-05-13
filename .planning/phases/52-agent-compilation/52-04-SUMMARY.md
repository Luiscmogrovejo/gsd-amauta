---
phase: 52-agent-compilation
plan: "04"
subsystem: agent-compilation
tags: [nodejs, cli, gsd-tools, dispatch, case-block, spawnSync, integration-tests]

# Dependency graph
requires:
  - phase: 52-agent-compilation (52-03)
    provides: "scripts/agent-compiler.cjs — compile/validate/listAgents + SUPPORTED_TARGETS + TARGET_MAPS"

provides:
  - "get-shit-done/bin/gsd-tools.cjs case 'agents': dispatch — compile/validate/list subcommands + Usage banner"
  - "bin/cli.cjs agents branch — spawnSync passthrough to gsd-tools.cjs, mirrors module + party branches"
  - "tests/gsd-tools-agents-cli.test.cjs — 8 CLI integration tests via subprocess invocation, 8/8 pass"

affects:
  - 52-agent-compilation (Wave 5 --hydrate integration, COMPILE-04)
  - 52-05-canary (byte-preservation check for adjacent case blocks)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "case 'agents': dispatch mirrors case 'skills': (Phase 43) — require() JS-resident compiler, args[1] action, args.slice(2) rest"
    - "bin/cli.cjs spawnSync passthrough — pure forwarder, no action pre-validation, gsd-tools.cjs owns validation"
    - "extractJson() helper — strips dry-run prefix lines from stdout before JSON.parse (output.slice(output.indexOf('{')))"

key-files:
  created:
    - tests/gsd-tools-agents-cli.test.cjs
  modified:
    - get-shit-done/bin/gsd-tools.cjs
    - bin/cli.cjs

key-decisions:
  - "case 'agents': inserted after case 'agent-hydrate': (L3582) and before case 'module': (L3629) — new block at L3629, module pushed to L3757"
  - "No KNOWN_ACTIONS pre-validation in bin/cli.cjs — party branch precedent is pure passthrough; gsd-tools.cjs owns validation"
  - "Unknown target exits 2 (I/O class), missing --target exits 1 (validation class) — Phase 48/49 exit code convention frozen"

patterns-established:
  - "Dry-run JSON extraction: output.slice(output.indexOf('{')) handles mixed text+JSON stdout safely"
  - "Adjacent case block insertion: use exact surrounding context (3-4 lines) in Edit tool — file line numbers drift on insertion"

requirements-completed:
  - COMPILE-02
  - COMPILE-03

# Metrics
duration: 35min
completed: 2026-05-13
---

# Phase 52 Plan 04 Summary

**gsd-tools.cjs `case 'agents':` dispatch + bin/cli.cjs agents spawnSync branch + 8-test CLI integration suite, all live with 8/8 passing**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-05-13
- **Completed:** 2026-05-13
- **Tasks:** 3
- **Files created:** 1
- **Files modified:** 2

## Accomplishments

- Added `case 'agents':` block (128 lines) to `get-shit-done/bin/gsd-tools.cjs` between `case 'agent-hydrate':` and `case 'module':`. Implements compile/validate/list subcommands + no-arg Usage banner (stdout + exit 0, Phase 43 case 'skills' precedent). Args indexing: args[1] = action, args.slice(2) = rest. Exit codes: 0 success, 1 validation error, 2 I/O / unknown action / unknown target.
- Added `agents` branch to `bin/cli.cjs` (19 lines) after party branch, before status routing. Pure spawnSync passthrough mirroring module + party branches. `process.argv.slice(3)` forwards all subcommand args verbatim.
- Created `tests/gsd-tools-agents-cli.test.cjs` (195 lines): 8 integration tests via subprocess invocation (no direct require). All 8 pass in ~670ms.

## Task Commits

1. **Task 52-04-01: case 'agents' dispatch in gsd-tools.cjs** — `93baae3` (feat)
2. **Task 52-04-02: agents branch in bin/cli.cjs** — `28838ca` (feat)
3. **Task 52-04-03: tests/gsd-tools-agents-cli.test.cjs** — `f4ad199` (feat)

## Files Created/Modified

- `get-shit-done/bin/gsd-tools.cjs` — +128 lines: `case 'agents':` block with compile/validate/list subcommands; adjacent cases untouched
- `bin/cli.cjs` — +19 lines: agents spawnSync passthrough branch
- `tests/gsd-tools-agents-cli.test.cjs` — 195 lines: 8 CLI surface integration tests

## Decisions Made

1. **case 'agents' mirrors case 'skills' (not case 'party')**: Phase 52 compiler is JS-resident (agent-compiler.cjs), so dispatch uses `require()` directly rather than `spawnSync python3`. Symmetric with Phase 43 skill compiler case.
2. **No KNOWN_ACTIONS in bin/cli.cjs**: The `party` branch (Phase 50/51) added action pre-validation in gsd-tools.cjs but NOT in bin/cli.cjs. Phase 52 follows that convention — pure passthrough in cli.cjs, validation owned by gsd-tools.cjs.
3. **Exit code discipline**: `--target=invalid` exits 2 (I/O/unknown target class), `compile` with no `--target` exits 1 (validation/missing required flag class). Frozen per Phase 48/49 convention.

## Deviations from Plan

None — plan executed exactly as written. Block shape and indexing match plan verbatim.

## Issues Encountered

None. All acceptance criteria passed on first run.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `gsd-tools agents compile/validate/list` fully wired and tested.
- `bin/cli.cjs agents` passthrough live.
- SC1 byte-match lock from Wave 3 still passes (agent-compiler.cjs unchanged per constraint 9).
- Wave 5 (Plan 52-05): `--hydrate` integration wires Phase 47 `agent_hydrator.hydrate()` at compile time. Wave 5 can proceed — `opts.hydrate` is already accepted by the case 'agents' compile handler (passed through to agent-compiler.cjs as empty array no-op until Wave 5 wires it).

---
*Phase: 52-agent-compilation*
*Completed: 2026-05-13*
