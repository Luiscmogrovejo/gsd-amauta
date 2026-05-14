---
phase: 56-a2a-orchestration
plan: 56-03
subsystem: api
tags: [a2a, daemon, http, polling, cursor-pagination, postgresql]

# Dependency graph
requires:
  - phase: 56-01
    provides: a2a_breaker.py circuit breaker + _check_breaker wired into send_request
  - phase: 56-02
    provides: get_thread() recursive CTE + 14-test threading suite
  - phase: 55-03
    provides: a2a_messages table Phase 55 writes every exchange row before delivery
provides:
  - GET /a2a/exchanges daemon endpoint with from/to/since filters and next_cursor pagination
  - gsd-amauta a2a tail 500ms polling CLI action
  - 11 structural audit endpoint tests (always run, no PG required)
  - 12 tail CLI structural tests (no daemon required)
affects: [phase-57, phase-58]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Cursor-based polling via next_cursor = max(created_at) + 1ms ISO string
    - Node.js setTimeout(poll, 500) non-SSE polling loop with SIGINT clean exit
    - Inline urllib.parse/datetime/psycopg2.extras imports in daemon handlers (daemon pattern)

key-files:
  created:
    - tests/test_a2a_audit.py
    - tests/test_a2a_tail_cli.py
  modified:
    - services/amauta-daemon.py
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "Endpoint path /a2a/exchanges (not /api/a2a/exchanges) — A2A endpoints use /a2a/ prefix distinct from /api/"
  - "No limit param in this phase — deferred to v3.4 per divergence-protocol lock"
  - "tail action is Node.js polling loop, NOT a Python subprocess — calls daemon HTTP directly"
  - "_get_store() used (not raw PGStore import) — consistent with all other daemon handlers"
  - "Default since = NOW()-24h (not epoch/0) — prevents full-table scan on first poll"

patterns-established:
  - "Cursor-based audit endpoint: next_cursor = max(created_at)+1ms; empty result echoes current time"
  - "Tail polling: setTimeout (not setInterval) for better error-path handling; sinceTs tracks window"

requirements-completed:
  - A2A-07

# Metrics
duration: 35min
completed: 2026-05-14
---

# Plan 56-03: A2A Audit Endpoint Summary

**GET /a2a/exchanges cursor-polling endpoint + gsd-amauta a2a tail CLI — Phase 56 capstone closes A2A-07 operator audit visibility requirement**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-05-14T
- **Completed:** 2026-05-14T
- **Tasks:** 4
- **Files modified:** 4 (2 modified, 2 created)

## Accomplishments

- Daemon `do_GET` extended with `/a2a/exchanges` handler: optional `from`/`to`/`since` filters, `{schema_version:"1.0", exchanges:[...], next_cursor}` response shape, default `since=NOW()-24h`, cursor advances by max(created_at)+1ms
- `gsd-amauta a2a tail` added to `gsd-tools.cjs` `case 'a2a':` block: 500ms `setTimeout` polling loop, `sinceTs` cursor tracking from `next_cursor`, SIGINT clean exit, `fromFilter`/`toFilter` from `--from`/`--to` flags
- 11 structural audit tests + 4 PG-gated integration tests in `tests/test_a2a_audit.py` (11 always pass)
- 12 structural tail CLI tests in `tests/test_a2a_tail_cli.py` (all 12 pass without daemon)

## Task Commits

1. **56-03-01/TK-1428: /a2a/exchanges daemon handler** - `4ebb2ec` (feat)
2. **56-03-02/TK-1429: gsd-tools tail action** - `1c3aaf2` (feat)
3. **56-03-03/TK-1430: tests/test_a2a_audit.py** - `a7f918a` (feat)
4. **56-03-04/TK-1431: tests/test_a2a_tail_cli.py** - `7fbc127` (feat)

## Files Created/Modified

- `services/amauta-daemon.py` — added `/a2a/exchanges` GET handler before final 404 fallthrough (L1873); 100 lines inserted
- `get-shit-done/bin/gsd-tools.cjs` — extended `case 'a2a':` with `tail` action; KNOWN_ACTIONS updated; 77 lines net
- `tests/test_a2a_audit.py` — 4 test classes, 15 tests total (11 structural + 4 PG-gated)
- `tests/test_a2a_tail_cli.py` — 4 test classes, 12 structural tests

## Decisions Made

- `/a2a/exchanges` path (not `/api/a2a/exchanges`) — A2A prefix is distinct from `/api/` to signal daemon-internal vs blackboard API
- No `limit` param added — plan locked it as deferred to v3.4; stayed within scope
- `_get_store()` used throughout — consistent with every other daemon GET handler
- `tail` implemented as Node.js `setTimeout` loop (not SSE, not WebSocket) — matches plan lock
- `sinceTs` initialized to `NOW()-24h` when no `--since` flag — prevents full-scan on fresh start

## Deviations from Plan

None — plan executed exactly as written. All locked decisions honored.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. `/a2a/exchanges` endpoint requires PG (daemon already needs PG for other endpoints). `a2a tail` requires running daemon on `AMAUTA_PORT` (default 8899).

## Next Phase Readiness

- Phase 56 COMPLETE (3/3 plans: 56-01 circuit breaker, 56-02 threading, 56-03 audit endpoint)
- A2A-05, A2A-06, A2A-07 all closed
- Phase 57 (Module Marketplace) is unblocked — depends on Phases 48-49 (shipped v3.2), not Phase 56

---
*Phase: 56-a2a-orchestration*
*Completed: 2026-05-14*
