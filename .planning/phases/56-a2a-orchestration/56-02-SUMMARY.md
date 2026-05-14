---
phase: 56-a2a-orchestration
plan: 56-02
subsystem: database
tags: [postgres, recursive-cte, a2a, threading, psycopg2]

# Dependency graph
requires:
  - phase: 55-a2a-foundation
    provides: a2a_messages table with parent_correlation_id column (migration 024), pg_store._get_conn() pattern
  - phase: 56-01
    provides: a2a_client.py base with _send_retried_row as last function (append point)
provides:
  - get_thread(root_correlation_id, depth_limit=10, conn=None) in services/a2a_client.py
  - THREAD_DEFAULT_DEPTH_LIMIT = 10 constant
  - 14 threading unit tests (9 structural, 5 PG-gated)
affects: [56-03, phase-57, phase-58]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - PostgreSQL WITH RECURSIVE CTE for parent_correlation_id chain traversal
    - depth tracking column in anchor (0 AS depth) and recursive branch (t.depth + 1)
    - bare except -> empty list contract (no exception raised for unknown root or PG down)
    - inspect.getsource() structural SQL keyword verification in tests

key-files:
  created:
    - tests/test_a2a_threading.py
  modified:
    - services/a2a_client.py

key-decisions:
  - "Append get_thread() AFTER _send_retried_row() to preserve Phase 55 frozen surface"
  - "depth_limit enforced via WHERE t.depth < %s in recursive branch (not MAXRECURSION hint)"
  - "Return empty list on ALL exceptions (PG down, invalid UUID format) — no exception propagation"
  - "Each returned dict includes depth (int) and schema_version fields in addition to 10 schema columns"
  - "parent_correlation_id cast as ::text in SELECT but join uses t.correlation_id::uuid for type safety"

patterns-established:
  - "Recursive CTE for tree traversal: anchor on PK, recursive on FK, depth guard in WHERE"
  - "PG-gated integration tests: direct cursor inserts (no a2a_client helpers) to avoid test coupling"

requirements-completed:
  - A2A-06

# Metrics
duration: 25min
completed: 2026-05-14
---

# Plan 56-02: A2A Conversation Threading Summary

**PostgreSQL WITH RECURSIVE CTE on parent_correlation_id chains enabling get_thread() for multi-turn A2A dialogue history, with 14-test suite (9 structural, 5 PG-gated)**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-14T23:40:00Z
- **Completed:** 2026-05-14T23:55:00Z
- **Tasks:** 2
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- `THREAD_DEFAULT_DEPTH_LIMIT: int = 10` constant added to `services/a2a_client.py` after the retry constants block
- `get_thread(root_correlation_id, depth_limit=10, conn=None)` function appended to `services/a2a_client.py` using WITH RECURSIVE CTE — traverses parent_correlation_id chains from root, returns rows ORDER BY created_at ASC, empty list on PG unavailability or unknown root
- 14-test suite in `tests/test_a2a_threading.py`: 9 structural tests (constants, signature, SQL structure via inspect.getsource) pass without PG; 5 PG-gated tests (3-turn dialogue, depth_limit=1, depth_limit=0, unknown root, required keys) behind GSD_PG_INTEGRATION=1
- Phase 55 frozen surface completely unchanged: SCHEMA_VERSION="1.0", RETRY_BASE=2, MAX_RETRIES=2, all 4 error_code tokens

## Task Commits

1. **56-02-01: add get_thread() recursive CTE + THREAD_DEFAULT_DEPTH_LIMIT** — `237f583` (feat)
2. **56-02-02: add tests/test_a2a_threading.py — 14 threading tests** — `bc1896c` (feat)

## Files Created/Modified
- `services/a2a_client.py` — appended THREAD_DEFAULT_DEPTH_LIMIT constant and get_thread() function (123 insertions)
- `tests/test_a2a_threading.py` — new file, 4 test classes, 14 tests (259 insertions)

## Decisions Made
- Appended after `_send_retried_row()` (end of file) to preserve Phase 55 frozen surface — zero modifications to existing functions
- depth_limit enforced via `WHERE t.depth < %s` in the recursive branch; depth=0 is anchor (root), depth=N is Nth-level child
- `t.correlation_id::uuid` cast in the JOIN condition for type safety (PG UUID vs text)
- `responded_at` not included in required_keys test list to match the PLAN spec (which lists responded_at as optional ISO8601|None)

## Deviations from Plan

None — plan executed exactly as written. The `WITH RECURSIVE thread AS` keyword appears twice in the file (once in get_thread docstring CTE diagram, once in actual SQL) — both verified, acceptance criteria require `>= 1`.

## Issues Encountered

Edit tool collision: services/a2a_client.py had been modified by plan 56-01 (adding _check_breaker wiring) since the original briefing read, causing stale-file errors on first edit attempts. Resolved by re-reading the file at the correct offset before editing. No functional impact.

## Next Phase Readiness
- A2A-06 complete. Plan 56-03 (A2A-07 operator audit endpoint: `GET /a2a/exchanges` + `gsd-amauta a2a tail`) is the final plan in Phase 56.
- No blockers. `get_thread()` is PG read-only with no Valkey dependency — no interaction with the 56-01 circuit breaker surface.

---
*Phase: 56-a2a-orchestration*
*Completed: 2026-05-14*
