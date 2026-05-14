---
phase: 54-stability-hardening
plan: "54-02"
subsystem: infra
tags: [path-collision, init, spawnSync, which, pipx, bin-map]

requires:
  - phase: 53-polish-upgrade-uninstall
    provides: bin/init.cjs with 7-step flow and execFileSync pattern

provides:
  - detectAmautaAiConflict() function in bin/init.cjs — advisory PATH collision detection
  - Warning block in main() emitting amauta-ai conflict message with gsd-amauta recommendation
  - tests/stab04-path-collision.test.cjs — 6 deterministic unit tests for STAB-04

affects: [54-01, 54-04, 54-05, 58-public-launch]

tech-stack:
  added: [spawnSync (added to existing child_process require)]
  patterns: [advisory-only PATH probe pattern via spawnSync with try/catch, module-level detector after stepDetectIdes]

key-files:
  created:
    - tests/stab04-path-collision.test.cjs
  modified:
    - bin/init.cjs

key-decisions:
  - "detectAmautaAiConflict() is module-level (not nested inside stepDetectIdes) — mirrors the advisory pattern of cliOnPath but callable from main()"
  - "Warning injected in main() after --upgrade/--uninstall dispatch, before startTime — runs on every normal init invocation"
  - "catch block discards error (_e) — advisory only, never blocks startup"

patterns-established:
  - "STAB-04 pattern: spawnSync('which', ['binary'], { stdio: pipe, encoding: utf-8 }) + result.status===0 + stdout.trim() for advisory PATH checks"

requirements-completed: [STAB-04]

duration: 15min
completed: "2026-05-14"
---

# Plan 54-02: STAB-04 PATH Collision Detect-and-Warn Summary

**`detectAmautaAiConflict()` added to bin/init.cjs: spawnSync-based PATH probe emits pipx/amauta-ai conflict warning with gsd-amauta recommendation and pipx uninstall remediation**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-14T19:50:00Z
- **Completed:** 2026-05-14T20:00:00Z
- **Tasks:** 2 (TK-1399, TK-1400)
- **Files modified:** 2

## Accomplishments

- Added `spawnSync` to `child_process` require destructure in `bin/init.cjs`
- Added module-level `detectAmautaAiConflict()` function using same advisory pattern as `cliOnPath` but callable from `main()`
- Inserted STAB-04 warning block in `main()` that emits PATH collision message with amauta-ai path, gsd-amauta recommendation, and `pipx uninstall amauta-ai` remediation
- Created `tests/stab04-path-collision.test.cjs` with 6 CJS node:test cases, all PASS

## Task Commits

1. **TK-1399: Add detectAmautaAiConflict PATH collision warning to bin/init.cjs** — `c51bbaa` (feat)
2. **TK-1400: Write tests/stab04-path-collision.test.cjs** — `0c95521` (feat)

## Files Created/Modified

- `bin/init.cjs` — added spawnSync to require, detectAmautaAiConflict() function, STAB-04 warning block in main()
- `tests/stab04-path-collision.test.cjs` — 6 deterministic unit tests covering bin map values, function presence, warning text, pipx remediation, gsd-amauta-mcp entry

## Decisions Made

- `detectAmautaAiConflict()` placed as module-level function (after `stepDetectIdes`, before `stepInstall`) rather than nested inside `stepDetectIdes`. This makes it callable from `main()` without extracting a closure.
- `cliOnPath` is nested inside `stepDetectIdes` — plan description said "AFTER cliOnPath" but since cliOnPath is nested, the new function goes at module level after the enclosing `stepDetectIdes` closes. Semantically equivalent.
- Warning injected in `main()` before `const startTime = Date.now()` — runs on every normal init invocation (not upgrade/uninstall paths, which short-circuit earlier).

## Deviations from Plan

None — plan executed as specified. The note about `cliOnPath` placement was a plan description ambiguity (cliOnPath is nested, not standalone), resolved by placing `detectAmautaAiConflict()` at module scope after `stepDetectIdes`. This matches the intent of "AFTER cliOnPath and BEFORE stepInstall".

## Issues Encountered

None.

## Next Phase Readiness

- STAB-04 closed. `package.json` bin map unchanged. `node --check bin/init.cjs` passes.
- Remaining Phase 54 plans: 54-01 (STAB-01 coverage), 54-04 (STAB-06 doctor command), 54-05 (STAB-02 Redis watchdog).
- 54-03 (STAB-05 LLM quarantine) already shipped by parallel dispatch.

---
*Phase: 54-stability-hardening*
*Completed: 2026-05-14*
