---
phase: 04-task-management
plan: 01
subsystem: task-lifecycle
tags: [state-machine, retry-queue, dependency-enforcement, postgresql, sqlite]

requires:
  - phase: 03-memory-rlm
    provides: memory and RLM integration with daemon
provides:
  - PG dual-write retry queue with file-based persistence
  - State machine (ALLOWED_TRANSITIONS) enforced in cmd_status
  - Dependency enforcement at claim, validate --pass, and status done
  - Pure-function test suite for all three features
affects: [04-task-management, amauta-daemon]

tech-stack:
  added: []
  patterns:
    - "File-based retry queue for resilient PG mirror writes"
    - "ALLOWED_TRANSITIONS dict for state machine enforcement"
    - "Triple-point dependency enforcement (claim + validate + status)"

key-files:
  created:
    - tests/task-lifecycle.test.cjs
  modified:
    - amauta.py
    - services/pg_store.py
    - services/sqlite_store.py

key-decisions:
  - "PG retry queue: file-based JSON at ~/.amauta/data/pg_retry_queue.json, max 1000 items, oldest evicted"
  - "State machine: ALLOWED_TRANSITIONS dict enforced in cmd_status; cmd_claim/cmd_validate have their own guards"
  - "Dependency enforcement: _deps_met() checked at claim, validate --pass, AND status done"

patterns-established:
  - "Retry queue pattern: enqueue on failure, flush on next save, dedup by ID, cap+evict"
  - "State machine pattern: dict of allowed transitions, --force override, clear error messages"
  - "Defense-in-depth: same check (_deps_met) enforced at multiple command entry points"

requirements-completed: [TASK-01, TASK-02, TASK-03]

duration: 6min
completed: 2026-03-21
---

# Phase 4 Plan 01: Task Lifecycle Hardening Summary

**PG retry queue with file-based persistence, ALLOWED_TRANSITIONS state machine, and triple-point dependency enforcement**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-21T22:00:00Z
- **Completed:** 2026-03-21T22:06:00Z
- **Tasks:** 4
- **Files modified:** 4

## Accomplishments
- PG dual-write failures now queue items for retry instead of silently diverging
- Invalid state transitions rejected with clear error messages and --force override
- Dependent tasks cannot be marked done until all dependencies are complete (checked at claim, validate --pass, and status done)
- 9 pure-function tests verify all three features without requiring a daemon

## Task Commits

Each task was committed atomically:

1. **Task 1: PG retry queue** - `b826535` (feat)
2. **Task 2: State machine** - `ee82a62` (feat)
3. **Task 3: Dependency enforcement** - `dcb9b02` (feat)
4. **Task 4: Tests** - `6a4a9b8` (test)

## Files Created/Modified
- `services/pg_store.py` - Added retry queue: _retry_queue_path, _load/_save_retry_queue, enqueue_retry, flush_retry_queue; modified task_upsert to enqueue on failure
- `services/sqlite_store.py` - Added no-op enqueue_retry/flush_retry_queue stubs for interface parity
- `amauta.py` - Added ALLOWED_TRANSITIONS dict, state machine enforcement in cmd_status, --force flag, dependency checks at validate --pass and status done
- `tests/task-lifecycle.test.cjs` - 9 pure-function tests covering state machine, dependency enforcement, and retry queue

## Decisions Made
- PG retry queue is file-based JSON (no Redis/threading) to maintain zero-dependency architecture
- State machine allows "failed" from any non-done status and "deferred" from pending/in-progress/failed for flexibility
- Dependency enforcement uses existing _deps_met() helper at three enforcement points rather than a centralized middleware

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Ready for Plan 04-02 (board view and advanced task management)
- All 95 existing tests pass with no regressions
- 9 new tests added for lifecycle features

---
*Phase: 04-task-management*
*Completed: 2026-03-21*
