---
phase: 06-multi-agent-rpetd-audit
plan: "06-05"
subsystem: routing
tags: [agent-capabilities, routing, json-index, gsd-tools]

requires:
  - phase: 06-multi-agent-rpetd-audit
    provides: routeExecutor function in gsd-tools.cjs (plan 06-02)

provides:
  - get-shit-done/agent-capabilities.json: static capability index for all 11 GSD agents
  - routeExecutor reads file_patterns from JSON index (AGT-07 single source of truth)
  - 21 test cases verifying index completeness, structure, lane assignments, and wire-up

affects: [execute-phase, execute-plan, operator routing, agent onboarding]

tech-stack:
  added: []
  patterns: [static JSON capability index, glob-to-regex pattern conversion, lazy-loaded singleton]

key-files:
  created:
    - get-shit-done/agent-capabilities.json
    - tests/06-05-capability-index.test.cjs
  modified:
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "Option A (static JSON) chosen for agent capability index -- single file, machine-readable, no runtime dependencies"
  - "getCapabilityIndex() loads and caches agent-capabilities.json once per process -- lazy singleton pattern"
  - "glob-to-regex conversion handles 4 patterns: *.ext (extension), prefix* (prefix-anchored), dir/* (directory), exact (path-anchored)"
  - "Routing priority order (frontend > infra > backend > general) preserved in routingOrder array"

patterns-established:
  - "AGT-07 data flow: agent-capabilities.json -> routeExecutor() -> execute-phase.md/execute-plan.md"
  - "Glob pattern types: *.ext, prefix*, dir/*, exact -- all converted to anchored regex to avoid false positives"

requirements-completed:
  - AGT-07

duration: 18min
completed: 2026-04-06
---

# Plan 06-05: Agent Capability Index + Routing Wire-Up Summary

**agent-capabilities.json created with 11 agents, routeExecutor wired to read file_patterns from JSON index as single source of truth (AGT-07)**

## Performance

- **Duration:** 18 min
- **Started:** 2026-04-06T17:00:00Z
- **Completed:** 2026-04-06T17:18:00Z
- **Tasks:** 3
- **Files modified:** 3 (1 created + 1 modified + 1 test)

## Accomplishments
- Created get-shit-done/agent-capabilities.json with all 11 GSD agents: id, lane, file_patterns, task_types, tools, patterns fields
- Wired routeExecutor in gsd-tools.cjs to load file_patterns from JSON index via getCapabilityIndex() singleton; routing behavior identical to hardcoded version
- Added AGT-07 data flow comment; 27 existing 06-02 routing tests still pass after refactor
- Created 21-test suite (INDEX-01..05, WIRE-01) verifying index completeness, structure, lane assignments, and backward-compatible routing

## Task Commits

Each task was committed atomically:

1. **T1: Create agent-capabilities.json with all 11 agent entries** - `2e3629b` (feat)
2. **T2: Wire routeExecutor to read from agent-capabilities.json** - `51391da` (feat)
3. **T3: Create capability index tests** - `4cd79e6` (test)

## Files Created/Modified
- `get-shit-done/agent-capabilities.json` - Static JSON capability index for all 11 GSD agents
- `get-shit-done/bin/gsd-tools.cjs` - getCapabilityIndex() singleton + routeExecutor rewritten to use JSON index
- `tests/06-05-capability-index.test.cjs` - 21 tests across 6 suites: INDEX-01..05, WIRE-01

## Decisions Made
- Static JSON file chosen (Option A from research) -- simple, no external deps, machine-readable for operators
- glob-to-regex conversion built inline in routeExecutor: 4 pattern types (*.ext, prefix*, dir/*, exact) each anchored to avoid false positives; same semantics as hardcoded regex
- getCapabilityIndex() uses module-level `_capabilityIndex` null-guard pattern (lazy singleton) -- loaded once per process, no repeated disk I/O

## Deviations from Plan

None - plan executed exactly as written. The glob-to-regex implementation matches the plan's code exactly.

## Issues Encountered

None.

## Next Phase Readiness
- AGT-07 requirement complete. agent-capabilities.json is the single source of truth for routing.
- Phase 06 wave 2 plans (06-04, 06-05) complete. Phase 06 all 5 plans done.
- Ready for phase wrap-up / STATE.md update.

---
*Phase: 06-multi-agent-rpetd-audit*
*Completed: 2026-04-06*
