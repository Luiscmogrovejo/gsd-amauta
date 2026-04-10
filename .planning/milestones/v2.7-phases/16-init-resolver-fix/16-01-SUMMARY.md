---
phase: 16-init-resolver-fix
plan: 16-01
subsystem: infra
tags: [resolver, config, milestone-scoping, ghost-directory, core.cjs, config.cjs]

# Dependency graph
requires: []
provides:
  - config.json::current_milestone field as single source of truth for milestone identity
  - findPhaseInternal scoped to current milestone only — no archived-milestone fallback
  - getMilestoneInfo reads version from config.json as primary source
  - config-set uses atomic write-to-temp + rename pattern
affects:
  - phase 17 (init surface stable — execute-phase 17 resolves correctly now)
  - phase 18 (same)
  - phase 19 (same)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Milestone identity from config.json::current_milestone (not ROADMAP.md parsing)"
    - "Resolver reads config.json at call time; no cached state"
    - "Atomic config write: writeFileSync(tmpPath) + renameSync(tmpPath, configPath)"

key-files:
  created: []
  modified:
    - .planning/config.json
    - get-shit-done/bin/lib/config.cjs
    - get-shit-done/bin/lib/core.cjs

key-decisions:
  - "No fallback to archived milestones when current_milestone is set — hard null on miss, not ghost match"
  - "getMilestoneInfo version comes from config.json; ROADMAP.md consulted only for human-readable name"
  - "Backward compat: projects without current_milestone in config.json still fall back to ROADMAP.md parsing"

patterns-established:
  - "Single authoritative source pattern: one field (current_milestone) owns milestone identity across all resolver and display paths"
  - "Null-on-miss contract: resolver returns null for phases not in current milestone, never a stale archived ghost"

requirements-completed:
  - RESOLVE-01

# Metrics
duration: 25min
completed: 2026-04-10
---

# Plan 16-01: Milestone-Scoped Resolver + Config Identity Summary

**findPhaseInternal scoped to config.json::current_milestone, eliminating ghost directory matches that fired at depths 7, 8, and 10**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-10T00:00:00Z
- **Completed:** 2026-04-10T00:25:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- `findPhaseInternal` now reads `current_milestone` from `.planning/config.json` and searches only `.planning/milestones/v2.7-phases/`. Phase 15 returns `null` (not a v2.3 ghost), Phase 16 resolves to the correct v2.7 directory.
- `getMilestoneInfo` uses `config.json::current_milestone` as primary version source; ROADMAP.md consulted only for the display name.
- All 5 plan verification criteria pass against the live codebase.
- Task 16-01-01 was pre-committed (d3f781e) from prior session; verified all acceptance criteria before proceeding to 02 and 03.

## Task Commits

Each task was committed atomically:

1. **Task 16-01-01: Add current_milestone to config.json + VALID_CONFIG_KEYS + atomic write** - `d3f781e` (feat) — pre-committed, verified at session start
2. **Task 16-01-02: Make findPhaseInternal milestone-scoped via config.json** - `a3dd52e` (feat)
3. **Task 16-01-03: getMilestoneInfo reads current_milestone from config.json as primary source** - `be36977` (feat)

## Files Created/Modified
- `.planning/config.json` — `current_milestone: "v2.7"` field added
- `get-shit-done/bin/lib/config.cjs` — `current_milestone` added to VALID_CONFIG_KEYS; atomic write pattern (tmpPath + renameSync) for cmdConfigSet
- `get-shit-done/bin/lib/core.cjs` — `findPhaseInternal` rewritten to be milestone-scoped; `getMilestoneInfo` updated to read config.json as primary source

## Decisions Made
- No fallback to archived milestones when `current_milestone` is set. A phase number absent from the current milestone returns `null` — hard miss, never a ghost. This is the direct fix for depths 7, 8, and 10.
- `getMilestoneInfo` backward compatibility preserved: projects without `current_milestone` in config.json continue to use ROADMAP.md parsing.
- `searchPhaseInDir` and `getArchivedPhaseDirs` untouched — per plan spec, only `findPhaseInternal` and `getMilestoneInfo` were in scope.

## Deviations from Plan
None — plan executed exactly as written. Task 16-01-01 was pre-committed from prior session (d3f781e); all acceptance criteria verified before executing 16-01-02 and 16-01-03.

## Issues Encountered
None.

## Next Phase Readiness
- RESOLVE-01 complete. Phase 16 plan 02 (RESOLVE-02: `--phase-dir` override flag) can proceed.
- The init resolver now correctly scopes to v2.7-phases, so all downstream phases (17–19) can use `gsd-tools init execute-phase` without hand-routing.

---
*Phase: 16-init-resolver-fix*
*Completed: 2026-04-10*
