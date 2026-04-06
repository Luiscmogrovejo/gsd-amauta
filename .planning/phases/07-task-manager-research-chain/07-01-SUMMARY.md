---
plan: 07-01
title: "Task Lifecycle Fixes -- Archive Routing + Watchdog + PG Sync Guard"
status: complete
completed_at: "2026-04-06"
commits:
  - "5d9bc21 feat(07-01-T1): add archive/reconcile to command_map and _EXEC_ALLOWLIST"
  - "083e28a feat(07-01-T2): make STALE_CHECK_INTERVAL configurable via GSD_STALE_INTERVAL env var"
  - "4004f99 test(07-01-T3): add 17 guard tests for task lifecycle routing, watchdog, PG sync"
tests: "17/17 pass"
---

# Plan 07-01 Summary: Task Lifecycle Fixes

## What Was Done

### T1 (critical): Archive/Reconcile Routing
- Added `"archive"` and `"reconcile"` to `_EXEC_ALLOWLIST` in `services/amauta-daemon.py`
- Added `"/api/archive"` and `"/api/reconcile"` routes to `command_map`
- Added special arg-building blocks for each:
  - `archive`: no task ID, optional `--days N` from `body["days"]`
  - `reconcile`: no task ID, optional `--fix` when `body["fix"] is True`
- The PG mirror handler for archive (extracting IDs + calling `task_delete`) was already written at lines 1560-1569 -- it was dead code until this fix made it reachable via command_map routing.

### T2 (high): STALE_CHECK_INTERVAL Env-Configurable
- Changed `STALE_CHECK_INTERVAL = 300` to `int(os.environ.get("GSD_STALE_INTERVAL", "300"))`
- Now consistent with `STALE_THRESHOLD_HOURS` (GSD_STALE_HOURS) and `RETRY_FLUSH_INTERVAL` (GSD_RETRY_FLUSH_INTERVAL)
- Default remains 300 seconds (5 minutes)

### T3 (high): Guard Tests (17 tests, 4 suites)
Created `tests/07-01-task-lifecycle.test.cjs` — static file analysis, no live daemon or PG needed:

| Suite | Tests | What's Guarded |
|-------|-------|----------------|
| ROUTE-01 | 6 | archive/reconcile in _EXEC_ALLOWLIST, command_map, special handlers |
| WATCHDOG-01 | 4 | GSD_STALE_INTERVAL, GSD_STALE_HOURS, WATCHDOG_EXEMPT, pending revert |
| PGSYNC-01 | 4 | task_upsert migration-007 cols, ON CONFLICT UPDATE safety |
| ARCHIVE-01 | 3 | _archived_ids extraction, task_delete call, _TASK_MUTATING_COMMANDS |

## Plan Deviation

- Tests 13/14 in the plan referenced `compare_fields` (a list expected in pg_store.py) which does not exist. Tests were adapted to verify `task_upsert` structure and ON CONFLICT UPDATE safety instead -- same regression risk, better actual invariant.
- Test 10 required a 4000-char slice (not 2000) to capture the full `_stale_task_watchdog` body where `"pending"` appears (~70 lines into the function).

## Severity Impact

- HIGH gap closed: `archive`/`reconcile` were missing from command routing -- the PG mirror sync for bulk archive operations was unreachable dead code.
- LOW risk mitigated: watchdog lockless-read is POSIX atomic rename + JSONDecodeError protected -- no locking overhead added (design documented in WATCHDOG-01 tests).

## Learnings

- Commands with no task ID (archive, reconcile) need explicit special-case arg builders in command_map handlers -- the generic `_build_args()` assumes `body['id']` is the first positional arg.
- Guard test slice size must account for full function length: `_stale_task_watchdog` is ~90 lines, requiring a 4000-char minimum slice.
