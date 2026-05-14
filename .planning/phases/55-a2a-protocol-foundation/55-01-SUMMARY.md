---
phase: 55-a2a-protocol-foundation
plan: 55-01
subsystem: database
tags: [postgres, migration, jsonb, uuid, check-constraint, a2a]

# Dependency graph
requires:
  - phase: 54-stability-hardening
    provides: stable PG schema baseline (migrations 001-023), no carry-forward debt
provides:
  - migrations/024-a2a-messages.sql — 10-column a2a_messages table (UUID PK, JSONB payload, frozen kind CHECK, to_agent/status index)
  - migrations/024-a2a-messages-DOWN.sql — reversible rollback (DROP TABLE CASCADE)
  - tests/test_a2a_migration.py — 10 structural tests, no PG connection required
affects:
  - Phase 55 plans 55-02+ (a2a_registry.py, a2a_client.py, retry logic)
  - Phase 56 (circuit breakers, threading via parent_correlation_id)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "UUID PK with gen_random_uuid() — correlates request/response rows in Phase 56 threading"
    - "frozen kind CHECK constraint at DB level (a2a_messages_kind_chk) — 4 values only, expansion via payload not kind"
    - "JSONB NOT NULL DEFAULT '{}'::jsonb — empty body is the sentinel, never NULL"
    - "structural test pattern: read SQL as text, assertIn string invariants, no PG connection needed"

key-files:
  created:
    - migrations/024-a2a-messages.sql
    - migrations/024-a2a-messages-DOWN.sql
    - tests/test_a2a_migration.py
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md

key-decisions:
  - "correlation_id UUID PRIMARY KEY (not unique-on-anything-else) — enables Phase 56 parent_correlation_id thread chains"
  - "kind frozen to 4 values (request|response|error|retried); breaker_open goes in payload not kind (gray-area decision 5)"
  - "parent_correlation_id nullable/reserved — column exists now, Phase 56 wires it into threading logic"
  - "55-01-02 DOWN task has no TK ID (Amauta dedup-blocked); committed as standalone atomic commit without task log"

patterns-established:
  - "Phase 55 migration convention: mirrors migration 021 (BEGIN/COMMIT, IF NOT EXISTS, UUID PK, named CHECK, COMMENT ON TABLE)"
  - "A2A structural test: read both UP+DOWN SQL as text in setUp, assertIn for all 10 columns + constraints"

requirements-completed:
  - A2A-01

# Metrics
duration: ~15min
completed: 2026-05-14
---

# Plan 55-01: A2A Migration 024 Summary

**PostgreSQL a2a_messages table (migration 024) with 10-column schema, frozen kind CHECK constraint, UUID PK, JSONB NOT NULL payload, and (to_agent, status) inbox index — complete foundation for Phase 55 A2A request/response protocol**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-14
- **Completed:** 2026-05-14
- **Tasks:** 3 (55-01-01 UP, 55-01-02 DOWN, 55-01-03 structural test)
- **Files created:** 3

## Accomplishments

- Migration 024 UP: 10-column a2a_messages schema with UUID PK, JSONB NOT NULL payload, frozen 4-value kind CHECK constraint (request|response|error|retried), named constraint (a2a_messages_kind_chk), (to_agent,status) composite index, COMMENT ON TABLE referencing Phase 55 A2A-01
- Migration 024 DOWN: idempotent DROP TABLE IF EXISTS a2a_messages CASCADE in BEGIN/COMMIT — index dropped automatically via CASCADE
- Structural test suite: 10 tests in TestA2AMigrationStructure verify all schema invariants without requiring a live PG connection; all 10 pass

## Task Commits

Each task committed atomically:

1. **Task 55-01-01: migration UP** — `ca30aa9` (feat: 024-a2a-messages.sql 10-column schema)
2. **Task 55-01-02: migration DOWN** — `66b8966` (feat: 024-a2a-messages-DOWN.sql rollback)
3. **Task 55-01-03: structural test** — `d8849b3` (feat: tests/test_a2a_migration.py 10 tests)

## Files Created/Modified

- `migrations/024-a2a-messages.sql` — a2a_messages DDL: UUID PK, JSONB NOT NULL, CHECK(kind), (to_agent,status) index
- `migrations/024-a2a-messages-DOWN.sql` — DROP TABLE IF EXISTS a2a_messages CASCADE
- `tests/test_a2a_migration.py` — 10 structural tests (no live PG required)
- `.planning/STATE.md` — updated to Phase 55 in progress, plan 55-01 complete
- `.planning/ROADMAP.md` — Phase 55 progress updated, plan 55-01 ship note added

## Decisions Made

- `correlation_id UUID PRIMARY KEY` chosen over any other keying strategy so Phase 56 `parent_correlation_id` thread chains have a single canonical row per correlation ID
- `kind` frozen to exactly 4 values at DB level (CHECK constraint); `breaker_open` from Phase 56 goes in `payload`, not `kind` (gray-area decision 5 from planning context)
- `parent_correlation_id` added as nullable column now even though Phase 56 wires it — column exists in schema from day 1, avoids a later ALTER TABLE migration
- DOWN uses CASCADE — correct because the index is a dependent object; matches pattern from 021 (indexes drop automatically)

## Deviations from Plan

None — plan executed exactly as written. Note: 55-01-02 (migration DOWN) has no TK ID because Amauta dedup-blocked the task as too similar to the UP task. Committed as standalone atomic commit. Logged in TK-1413 RPETD.

## Issues Encountered

None — all 10 plan-level verification criteria and all per-task acceptance criteria passed on first run.

## User Setup Required

None — no external service configuration required. Migration is applied to the local PG instance via `psql -f migrations/024-a2a-messages.sql` (operator action).

## Next Phase Readiness

- `a2a_messages` table definition is locked; Phase 55 plans 55-02+ can proceed with:
  - `services/a2a_registry.py` — capability negotiation registry (A2A-02)
  - `services/a2a_client.py` — send/receive client with timeout (A2A-03)
  - Retry logic with exponential backoff and `status=retried` rows (A2A-04)
- Phase 56 circuit breakers and threading (parent_correlation_id) depend on this schema being stable
- No blockers

---
*Phase: 55-a2a-protocol-foundation*
*Completed: 2026-05-14*
