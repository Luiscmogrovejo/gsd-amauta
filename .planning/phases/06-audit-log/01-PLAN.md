# Phase 6: Audit Log — PLAN

**Date:** 2026-03-21
**Agent:** executor-backend
**Task IDs:** AUDIT-01 through AUDIT-05

## Research Findings (R)

- `pg_store.py`: PGStore class with connection pool, `_get_conn()` context manager, existing tables: gsd_memory, gsd_shared_kb, gsd_tasks, gsd_task_validations, gsd_agent_performance
- `sqlite_store.py`: SQLiteStore class mirroring PGStore API, uses `_get_conn()` with WAL mode, FTS5 for search
- `amauta-daemon.py`: HTTP daemon (ThreadedHTTPServer) with GET/POST routes, `_get_store()` returns PG or SQLite store
- `amauta.py`: CLI with `cmd_validate()`, `cmd_rpetd()`, `cmd_status()`, `cmd_claim()` — each does task mutation + best-effort telemetry
- `gsd-amauta.cjs`: Node CLI dispatcher with daemon + direct fallback modes, switch/case routing in `main()`
- Migrations: numbered `NNN-name.sql` + `NNN-name-DOWN.sql` pairs

## Approach (P)

### 1. Database: `gsd_audit_log` table

**Files:** `migrations/006-audit-log.sql`, `migrations/006-audit-log-DOWN.sql`, `services/pg_store.py`, `services/sqlite_store.py`

- Add `gsd_audit_log` table via migration (PG with SERIAL/JSONB/TIMESTAMPTZ)
- Add `gsd_audit_log` table to SQLite `_ensure_schema()` (TEXT for JSON fields)
- Implement 3 methods on both stores: `audit_log()`, `audit_query()`, `audit_count()`
- CRITICAL: No UPDATE/DELETE methods on audit table — append-only

### 2. Wire audit logging into amauta.py

**File:** `amauta.py`

- Add `_audit_log_event()` helper (wraps daemon HTTP POST, best-effort like `_record_agent_performance`)
- Wire into `cmd_validate()`, `cmd_rpetd()`, `cmd_status()`, `cmd_claim()` — all try/except wrapped

### 3. Daemon endpoints

**File:** `services/amauta-daemon.py`

- `POST /api/audit/log` — direct audit log entry
- `GET /api/audit/query?task_id=X&event_type=Y&start=Z&end=W&limit=N` — query with filters
- `GET /api/audit/export?format=json|csv&start=X&end=Y` — export report

### 4. CLI commands

**File:** `get-shit-done/bin/gsd-amauta.cjs`

- `audit export [--format json|csv] [--start DATE] [--end DATE]`
- `audit show TK-XXXX` — formatted audit trail

### 5. Tests

**File:** `tests/test_audit.py`

- Test audit_log INSERT works
- Test audit_query filters correctly
- Test no UPDATE/DELETE methods exist
- Test export format (JSON and CSV)
- Test show for specific task

## Risks

- Large amauta.py file — must surgically insert audit calls
- Must ensure all audit logging is non-blocking (try/except)
- SQLite TEXT columns must store valid JSON strings for gate_results/metadata

## Execution Order

1. Create migration SQL files
2. Add audit methods to `pg_store.py`
3. Add audit methods + schema to `sqlite_store.py`
4. Add daemon endpoints to `amauta-daemon.py`
5. Add `_audit_log_event()` helper to `amauta.py`
6. Wire into cmd_validate, cmd_rpetd, cmd_status, cmd_claim
7. Add CLI commands to `gsd-amauta.cjs`
8. Create test file `tests/test_audit.py`
9. Run tests
