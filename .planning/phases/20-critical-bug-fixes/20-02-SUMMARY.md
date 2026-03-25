---
phase: 20-critical-bug-fixes
plan: "02"
subsystem: api
tags: [bug-fix, research-chain, reconcile, archive, enrichment, project-isolation, semantic-search]

# Dependency graph
requires:
  - phase: 17-task-manager-reliability
    provides: cmd_reconcile, _load_archive, archive persistence
  - phase: 12-semantic-memory-pipeline
    provides: _mem_semantic_search, enrichment pipeline
provides:
  - stderr logging for research chain parse errors (FIX-04)
  - archive-aware reconcile with separate report category (FIX-05)
  - project-scoped enrichment semantic search (FIX-06)
affects: [22-test-suites-core, 23-test-suites-extended]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "sys.stderr.write for best-effort diagnostic logging in silent-fallback functions"
    - "Set intersection for archive cross-referencing in reconcile"
    - "project_id=os.path.basename(os.getcwd()) convention for project scoping"

key-files:
  created: []
  modified:
    - amauta.py

key-decisions:
  - "Use locals().get('result') for safe access to subprocess result in except block"
  - "Separate archived_still_in_pg from truly orphaned extra_in_pg using set intersection"
  - "project_id as optional kwarg (default None) for backward compatibility"

patterns-established:
  - "Diagnostic stderr logging: [MODULE_NAME] prefix + error + first N chars of raw data"
  - "Archive cross-reference: load archive, compute archive_ids set, filter before reporting"

requirements-completed: [FIX-04, FIX-05, FIX-06]

# Metrics
duration: 3min
completed: 2026-03-25
---

# Phase 20 Plan 02: Critical Bug Fixes -- Silent Errors, Reconcile Archive, Enrichment Isolation Summary

**Stderr logging for research chain parse errors, archive-aware reconcile cross-referencing, and project-scoped enrichment semantic search**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-25T05:12:59Z
- **Completed:** 2026-03-25T05:16:04Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments
- Research chain parse errors now write diagnostics to stderr instead of silently swallowing
- Reconcile command cross-references tasks-archive.json, separating archived-but-in-PG from truly orphaned entries
- All 4 enrichment semantic search call sites pass project_id, preventing cross-project memory pollution

## Task Commits

Each task was committed atomically:

1. **FIX-04: Add logging to _research_chain_query parse errors** - `1885d7e` (fix)
2. **FIX-05: Make cmd_reconcile cross-reference tasks-archive.json** - `2a0cf60` (fix)
3. **FIX-06: Pass project_id to _mem_semantic_search in all enrichment calls** - `412aabf` (fix)

## Files Created/Modified
- `amauta.py` - All 3 fixes: stderr logging in _research_chain_query, archive cross-referencing in cmd_reconcile, project_id in _mem_semantic_search

## Decisions Made
- Used `locals().get('result')` to safely access subprocess result variable in the except block (may not be in scope if error occurs before subprocess.run)
- Separated archived_still_in_pg from extra_in_pg using set intersection rather than filtering, keeping the two categories cleanly distinct
- Added project_id=None as keyword argument for full backward compatibility -- existing callers without project_id continue to work unchanged

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 20-02 complete. If 20-01 is also complete, Phase 20 is done.
- Phase 21 (Integration Bug Fixes) can proceed independently.
- Phases 22-23 (Test Suites) depend on both 20 and 21 completing first.

---
*Phase: 20-critical-bug-fixes*
*Completed: 2026-03-25*
