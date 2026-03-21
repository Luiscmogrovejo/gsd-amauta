# Phase 8: Data Durability -- SUMMARY

## Status: COMPLETE (pending validation)

## What Was Built

### DUR-01: `amauta backup create`
- New `services/backup.py` with `BackupManager` class
- Exports gsd_memory, gsd_tasks, gsd_shared_kb, gsd_task_validations,
  gsd_agent_performance to gzip-compressed JSON
- Each backup includes `schema_version`, `created_at`, per-table row counts,
  and SHA-256 checksum of all table data

### DUR-02: `amauta backup restore <file>`
- Supports `--mode merge` (INSERT OR IGNORE, add missing) and
  `--mode replace` (DELETE ALL + INSERT)
- Pre-restore validation: schema version compatibility check (major version
  must match), checksum integrity verification
- Raises clear errors: FileNotFoundError, ValueError for corrupt/incompatible

### DUR-03: Schema Version in Backups
- Every backup includes `schema_version: "2.1.0"`
- Compatibility check: major version must match (2.x.x <-> 2.y.z = ok)
- Restore refuses backups with different major version

### DUR-04: `amauta backup verify [file]`
- File verification: gzip readability, schema_version presence + compatibility,
  checksum match, per-table count cross-check
- Database verification: store health, table counts, export method availability
- Returns structured {valid, checks[], errors[]} response

### DUR-05: Auto-backup on Daemon Start
- `BackupManager.auto_backup()` called during `start_server()`
- Creates `~/.amauta/backups/gsd-auto-YYYYMMDD.json.gz` once per day
- Prunes to keep last 7 auto-backups
- Wrapped in try/except -- failure does not block daemon startup

## Files Changed

| File | Change |
|------|--------|
| `services/backup.py` | NEW: 290-line BackupManager class |
| `services/pg_store.py` | ADD: 6 export_all_* + 6 import_* methods (~250 lines) |
| `services/sqlite_store.py` | ADD: 6 export_all_* + 5 import_* methods (~220 lines) |
| `services/amauta-daemon.py` | ADD: backup module import, 4 API routes, auto-backup init |
| `get-shit-done/bin/gsd-amauta.cjs` | ADD: `backup` command with 4 subcommands, help text |
| `tests/test_backup.py` | NEW: 18 tests covering all DUR requirements |
| `.planning/phases/08-data-durability/PLAN.md` | NEW |
| `.planning/phases/08-data-durability/SUMMARY.md` | NEW (this file) |

## Test Results
```
Ran 18 tests in 0.230s -- OK
```
- test_create_produces_gzip_json
- test_create_includes_schema_version
- test_create_counts_match_rows
- test_verify_valid_backup
- test_verify_detects_tampered_backup
- test_verify_detects_count_mismatch
- test_verify_database_state
- test_restore_merge_adds_missing
- test_restore_merge_no_duplicates
- test_restore_replace_drops_and_imports
- test_restore_rejects_incompatible_version
- test_restore_rejects_corrupt_checksum
- test_restore_file_not_found
- test_auto_backup_creates_daily_file
- test_auto_backup_skips_if_exists
- test_auto_backup_prunes_to_7
- test_list_empty
- test_list_after_create

Existing tests (test_gates.py): 31 tests -- OK (no regressions)

## API Endpoints Added
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/backup/create | Create backup, returns path + counts + checksum |
| POST | /api/backup/restore | Restore from file with merge/replace mode |
| GET | /api/backup/verify[?file=PATH] | Verify backup file or database state |
| GET | /api/backup/list | List available backups in ~/.amauta/backups/ |

## CLI Commands Added
```
amauta backup create [--output PATH]
amauta backup restore <file> [--mode merge|replace]
amauta backup verify [file]
amauta backup list
```
