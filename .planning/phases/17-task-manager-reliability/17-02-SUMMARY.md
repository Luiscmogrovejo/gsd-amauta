---
phase: 17-task-manager-reliability
plan: "02"
subsystem: daemon
tags: [watchdog, retry-queue, threading, staleness, metrics]

requires:
  - phase: 16-data-integrity
    provides: clean task data, PG store with flush_retry_queue method
provides:
  - stale task auto-revert watchdog (>48h in-progress with no RPETD)
  - automatic retry queue flush (every 60s with exponential backoff)
  - retry queue metrics (retry_queue_size gauge, flush counters)
  - _Metrics.set_gauge() for gauge-type Prometheus metrics
affects: [daemon-operations, monitoring, task-lifecycle]

tech-stack:
  added: []
  patterns:
    - "Daemon background thread: module-level function + threading.Thread(daemon=True)"
    - "Exponential backoff: sleep_time = min(base * 2^failures, max_cap)"
    - "Gauge metrics via _Metrics.set_gauge() alongside counter inc()"

key-files:
  created:
    - tests/17-02-daemon-threads.test.cjs
  modified:
    - services/amauta-daemon.py

key-decisions:
  - "Watchdog reads tasks.json directly (not subprocess list) for efficiency and daemon independence"
  - "Retry flusher only starts when _pg_store is available (no-op without PG)"
  - "Extended _Metrics.inc() with count param for batch counter increments"

patterns-established:
  - "WATCHDOG_EXEMPT note opt-out pattern for long-running tasks"
  - "GSD_STALE_HOURS / GSD_RETRY_FLUSH_INTERVAL env var config pattern"

requirements-completed: [TASK-03, TASK-04]

duration: 4min
completed: 2026-03-25
---

# Phase 17 Plan 02: Daemon Watchdog + Retry Queue Flush Summary

**Stale task watchdog (auto-revert >48h orphans every 5min) and PG retry queue auto-flush (every 60s with exponential backoff) added to amauta-daemon.py**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-25T03:05:00Z
- **Completed:** 2026-03-25T03:08:43Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Stale task watchdog thread detects in-progress tasks >48h with no RPETD activity and auto-reverts them to pending
- Retry queue flusher thread calls pg_store.flush_retry_queue() every 60s with exponential backoff on consecutive failures
- Three new Prometheus metrics: retry_queue_size (gauge), retry_flush_succeeded_total and retry_flush_failed_total (counters)
- _Metrics class extended with set_gauge() for gauge-type metrics and count param on inc()
- 16 tests covering AST checks, config verification, detection logic, and metrics

## Task Commits

Each task was committed atomically:

1. **Tasks 1+2: Stale watchdog + retry flusher** - `7ff05e5` (feat)
2. **Task 3: Tests for both threads** - `e54f71d` (test)

## Files Created/Modified
- `services/amauta-daemon.py` - +_stale_task_watchdog, +_retry_queue_flusher, +thread starts, +metrics gauges, +config constants
- `tests/17-02-daemon-threads.test.cjs` - 16 tests (AST, grep, integration)

## Decisions Made
- Watchdog reads tasks.json directly rather than running `amauta.py list` -- avoids subprocess overhead and daemon dependency loop
- Retry flusher only starts when _pg_store is available -- no point flushing if there's no PG to flush to
- Extended _Metrics.inc() with optional count parameter to support batch increments from flush results

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added _Metrics.set_gauge() method**
- **Found during:** Task 2 (retry queue metrics)
- **Issue:** Plan specified retry_queue_size as a metric but _Metrics only had inc() for counters -- retry_queue_size is a gauge (current value, not monotonically increasing)
- **Fix:** Added set_gauge() method and _gauges dict to _Metrics class, expose() now outputs gauge-type metrics
- **Files modified:** services/amauta-daemon.py
- **Verification:** AST test confirms set_gauge method exists in _Metrics class
- **Committed in:** 7ff05e5

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Required extension to support gauge-type metrics. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Watchdog and retry flush threads active on daemon startup
- Ready for Plan 17-03 (PG dual-write field completeness)

---
*Phase: 17-task-manager-reliability*
*Completed: 2026-03-25*
