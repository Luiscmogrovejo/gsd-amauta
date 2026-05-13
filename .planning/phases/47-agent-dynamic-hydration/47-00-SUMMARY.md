---
phase: 47-agent-dynamic-hydration
plan: "47-00"
subsystem: database
tags: [postgresql, migrations, schema, agent-findings, phase-47]

# Dependency graph
requires:
  - phase: 38-blackboard-communication
    provides: agent_findings base table (7 columns: id, agent_name, task_id, finding_type, content, confidence, created_at)
provides:
  - migrations/020-agent-findings-hydration.sql — UP migration adding recipient_agent VARCHAR(64) + severity VARCHAR(16) + 2 indexes
  - migrations/020-agent-findings-hydration-DOWN.sql — DOWN migration reversing 020 UP idempotently
  - tests/test_migration_020.py — schema applies-check with PG-down skip (6 test functions)
affects: [47-01, 47-02]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "IF NOT EXISTS guards on ALTER TABLE ADD COLUMN + CREATE INDEX for idempotent migrations"
    - "IF EXISTS guards on DROP INDEX + DROP COLUMN for idempotent DOWN migrations"
    - "PG-down skip via _pg_available() + _PG_OK module constant + per-function @pytest.mark.skipif"
    - "information_schema.columns + pg_indexes introspection for schema applies-checks"

key-files:
  created:
    - migrations/020-agent-findings-hydration.sql
    - migrations/020-agent-findings-hydration-DOWN.sql
    - tests/test_migration_020.py
  modified: []

key-decisions:
  - "CHECK CONSTRAINT on severity intentionally omitted — vocabulary documented in comment (matches Phase 38 pattern for finding_type)"
  - "recipient_agent nullable by design: NULL = broadcast (no backfill required for Phase 38 baseline rows)"
  - "Indexes ordered: recipient index (hydration query) + finding_type_recent index (security pipeline filter)"
  - "DOWN migration drops indexes before columns — matches 018-task-completions-DOWN.sql ordering"

patterns-established:
  - "Migration 020 pattern: additive ALTER TABLE with IF NOT EXISTS; Phase 38 baseline untouched"
  - "Applies-check test pattern: _pg_available() tries real PGStore()._get_conn(); returns False on any Exception; no mocking"

requirements-completed:
  - HYDRA-01

# Metrics
duration: 25min
completed: 2026-05-12
---

# Plan 47-00: Migration 020 — extend agent_findings for Phase 47 hydration

**Additive idempotent migration adding recipient_agent VARCHAR(64) + severity VARCHAR(16) to agent_findings with 2 composite DESC indexes and a 6-function schema applies-check test with PG-down graceful skip**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-12
- **Completed:** 2026-05-12
- **Tasks:** 3
- **Files created:** 3

## Accomplishments

- Migration 020 UP adds `recipient_agent VARCHAR(64)` + `severity VARCHAR(16)` to `agent_findings` with IF NOT EXISTS idempotency; includes `idx_agent_findings_recipient` (recipient + created_at DESC) and `idx_agent_findings_finding_type_recent` (finding_type + created_at DESC); documents Phase 47 finding_type vocabulary (security_alert, lint_violation, circuit_breaker_open) in comments
- Migration 020 DOWN cleanly reverses UP: drops both indexes before dropping both columns, all with IF EXISTS guards
- test_migration_020.py provides 6 test functions that introspect the live schema via PGStore()._get_conn() and information_schema.columns / pg_indexes; skips gracefully when PG is unavailable; baseline columns preserved regression guard

## Task Commits

Each task was committed atomically:

1. **Task 47-00-01: Create migrations/020-agent-findings-hydration.sql (UP)** — `1a36a2f` (feat)
2. **Task 47-00-02: Create migrations/020-agent-findings-hydration-DOWN.sql** — `20bdee3` (feat)
3. **Task 47-00-03: Create tests/test_migration_020.py** — `39a2016` (feat)

## Files Created

- `migrations/020-agent-findings-hydration.sql` — UP migration: ALTER TABLE agent_findings ADD COLUMN IF NOT EXISTS recipient_agent VARCHAR(64) + severity VARCHAR(16); 2 composite indexes; COMMENT ON COLUMN for both; Phase 47 vocabulary documented
- `migrations/020-agent-findings-hydration-DOWN.sql` — DOWN migration: DROP INDEX IF EXISTS x2; ALTER TABLE DROP COLUMN IF EXISTS x2; idempotent
- `tests/test_migration_020.py` — 6 test functions: test_recipient_agent_column_exists, test_severity_column_exists, test_recipient_agent_index_exists, test_finding_type_recent_index_exists, test_recipient_agent_is_nullable, test_baseline_columns_preserved; each decorated @pytest.mark.skipif(not _PG_OK)

## Decisions Made

- CHECK CONSTRAINT on severity intentionally omitted: Phase 47 documents `info | warning | error | critical` vocabulary in a comment only, matching the Phase 38 pattern where finding_type values are documented in a comment (not enforced via CHECK)
- recipient_agent is nullable by design: NULL = broadcast, so Phase 38 existing rows have correct NULL semantics without backfill
- DOWN migration drops indexes before columns, matching the 018-task-completions-DOWN.sql ordering convention

## Deviations from Plan

None — all 3 tasks executed verbatim from the PLAN frozen bodies.

## Issues Encountered

None.

## Next Phase Readiness

- Migration 020 is the schema substrate for Plan 47-01 (hydrator implementation)
- Plan 47-01 can use `WHERE recipient_agent IS NULL OR recipient_agent = $1` directly — indexes are in place
- Plan 47-01 can use `content AS summary` alias — the Phase 38 `content` column is untouched (test_baseline_columns_preserved confirms this)
- No production code was modified in this plan; Plans 47-01 and 47-02 own the hydrator implementation

---
*Phase: 47-agent-dynamic-hydration*
*Completed: 2026-05-12*
