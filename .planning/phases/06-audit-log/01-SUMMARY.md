# Phase 6: Audit Log — SUMMARY

**Date:** 2026-03-21
**Agent:** executor-backend
**Status:** Implementation complete, pending validation

## What Was Built

### AUDIT-01: Validation decisions logged with full context
- `cmd_validate()` in `amauta.py` now calls `_audit_log_event()` after both pass and fail paths
- Logs timestamp, validator agent, task ID, gate_results array, status (pass/fail/force), and notes
- Forced passes are recorded with `status: "force"` and `metadata.forced: true`

### AUDIT-02: RPETD phase logs timestamped with agent
- `cmd_rpetd()` in `amauta.py` now calls `_audit_log_event()` after every phase write
- Records agent_id, phase letter (R/P/E/T/D), full content, and rpetd_complete status

### AUDIT-03: `amauta audit export` CLI command
- `GET /api/audit/export?format=json|csv&start=X&end=Y` daemon endpoint
- `amauta audit export --format json --start 2026-03-01 --end 2026-03-31` CLI command
- JSON and CSV export formats supported

### AUDIT-04: `amauta audit show TK-XXXX` CLI command
- `GET /api/audit/query?task_id=TK-XXXX` daemon endpoint
- `amauta audit show TK-0010` displays formatted chronological trail
- Shows timestamps, event types, agents, phases, gate results, and content previews

### AUDIT-05: Immutable append-only table
- `gsd_audit_log` table has only INSERT and SELECT operations
- No `audit_update`, `audit_delete`, or `audit_modify` methods exist
- Both PGStore and SQLiteStore implement identical 3-method API: `audit_log()`, `audit_query()`, `audit_count()`

## Files Changed

| File | Change |
|------|--------|
| `migrations/006-audit-log.sql` | New: CREATE TABLE + indexes for PostgreSQL |
| `migrations/006-audit-log-DOWN.sql` | New: DROP TABLE + indexes |
| `services/pg_store.py` | Added: `audit_log()`, `audit_query()`, `audit_count()` methods |
| `services/sqlite_store.py` | Added: schema + `audit_log()`, `audit_query()`, `audit_count()` methods |
| `services/amauta-daemon.py` | Added: `POST /api/audit/log`, `GET /api/audit/query`, `GET /api/audit/export` endpoints |
| `amauta.py` | Added: `_audit_log_event()` helper; wired into `cmd_claim()`, `cmd_rpetd()`, `cmd_status()`, `cmd_validate()` |
| `get-shit-done/bin/gsd-amauta.cjs` | Added: `audit show`, `audit export` CLI commands + help text |
| `tests/test_audit.py` | New: 20 tests covering INSERT, query filters, immutability, export formats |
| `.planning/phases/06-audit-log/01-PLAN.md` | New: plan document |

## Test Results

```
Ran 20 tests in 0.162s — OK
  - TestAuditLogInsert: 6 tests (basic, gate_results, rpetd_phase, claim, status_change, all_fields)
  - TestAuditLogQuery: 6 tests (task_id, event_type, combined, limit, no_filters, count)
  - TestAuditLogImmutability: 4 tests (no update/delete/modify methods, only 3 audit methods)
  - TestAuditLogExport: 3 tests (JSON format, CSV format, gate_results in export)
  - Plus: show for specific task test
```

Existing test suites verified: `test_gates.py` (31 tests OK), `test_memory_parity.py` (16 tests OK)

## Architecture Decisions

1. **Best-effort pattern**: All `_audit_log_event()` calls are wrapped in try/except (same pattern as `_record_agent_performance`). Audit logging never blocks the main workflow.

2. **Daemon HTTP bridge**: `_audit_log_event()` in amauta.py POSTs to `/api/audit/log` on the daemon, which writes to PG or SQLite via the store. This keeps the store layer decoupled from the CLI.

3. **Content truncation**: Content field is truncated to 4000 chars in `_audit_log_event()` to prevent oversized audit entries from phase logs.

4. **CSV export**: Complex fields (gate_results, metadata) are JSON-serialized in CSV output for lossless round-trip.

## LEARNING

Append-only audit tables in multi-store architectures (PG + SQLite) need identical method signatures across both stores. The 3-method API (log/query/count) with no update/delete ensures immutability is enforced at the application layer, not just the database layer. Wiring audit calls into existing command functions requires careful placement after save() but before print() to ensure the data is persisted before the audit event fires.
