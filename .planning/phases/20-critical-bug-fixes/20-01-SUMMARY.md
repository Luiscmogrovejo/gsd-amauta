---
phase: 20-critical-bug-fixes
plan: 01
subsystem: daemon, memory, cli
tags: [bug-fix, daemon-mirror, idempotency, distill, postgresql]

# Dependency graph
requires:
  - phase: none
    provides: first fix phase in v2.4
provides:
  - archive+reconcile PG mirror sync in daemon
  - _mem_log_event idempotency guard on HTTP fallback
  - correct distill removedCount reporting
affects: [22-core-system-tests, 23-integration-e2e-tests]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Idempotency guard: SELECT COUNT with time window before fallback INSERT"
    - "Regex ID extraction for bulk operations (archive)"

key-files:
  created: []
  modified:
    - services/amauta-daemon.py
    - amauta.py
    - get-shit-done/bin/gsd-memory.cjs

key-decisions:
  - "Archive uses regex extraction from output (not task_id param) because bulk archive has no single ID"
  - "Idempotency check uses 10-second window -- covers 5s HTTP timeout + processing time"
  - "Idempotency fails open: if check errors, proceeds with insert (better duplicate than lost data)"

patterns-established:
  - "HTTP-fallback idempotency: always check before fallback INSERT when daemon may have committed"

requirements-completed: [FIX-01, FIX-02, FIX-03]

# Metrics
duration: 3min
completed: 2026-03-25
---

# Phase 20 Plan 01: Critical Bug Fixes -- Daemon Mirror, HTTP Race, Distill Count Summary

**3 surgical fixes: daemon PG mirror now syncs archive+reconcile, HTTP timeout race prevented by idempotency guard, distill removedCount correctly counts all deleted entries**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-25T05:12:30Z
- **Completed:** 2026-03-25T05:16:06Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Archive and reconcile commands now trigger daemon PG mirror sync (12 lines added)
- HTTP timeout double-write prevented by SELECT COUNT idempotency guard before fallback INSERT (10 lines)
- Distill removedCount off-by-1 fixed -- keep entry now counted in deletion total (1 line)

## Task Commits

Each task was committed atomically:

1. **FIX-01: Add archive+reconcile to daemon _TASK_MUTATING_COMMANDS** - `63773f9` (fix)
2. **FIX-02: Fix HTTP timeout race in _mem_log_event -- idempotency guard** - `7b17ddd` (fix)
3. **FIX-03: Fix distill removedCount off-by-1 in gsd-memory.cjs** - `2070d05` (fix)

## Files Created/Modified
- `services/amauta-daemon.py` - Added archive+reconcile to _TASK_MUTATING_COMMANDS set, archive-specific DELETE handler with regex ID extraction
- `amauta.py` - Added idempotency guard (SELECT COUNT with 10s window) before fallback SQL INSERT in _mem_log_event
- `get-shit-done/bin/gsd-memory.cjs` - Fixed removedCount += remove.length to remove.length + 1

## Decisions Made
- Archive uses regex extraction from output (not task_id param) because bulk archive has no single ID
- Idempotency check uses 10-second window -- covers 5s HTTP timeout + processing time
- Idempotency fails open: if check errors, proceeds with insert (better duplicate than lost data)
- Reconcile needs no special handler -- it already calls PGStore.task_upsert directly; being in _TASK_MUTATING_COMMANDS is a safety net

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 20-01 complete, ready for 20-02 (silent errors + reconcile archive + enrichment isolation)
- All 3 fixes verified with grep checks, syntax validation, and full test suite (291 passed)

---
*Phase: 20-critical-bug-fixes*
*Completed: 2026-03-25*
