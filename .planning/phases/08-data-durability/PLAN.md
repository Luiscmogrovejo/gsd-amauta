# Phase 8: Data Durability (DUR-01 through DUR-05)

## Objective
Add backup/restore/verify capabilities to GSD-Amauta so all persistent data
(memory, tasks, SKB, validations, agent performance) can be exported as compressed
JSON, restored with merge/replace semantics, and verified for integrity.

## Requirements
| ID     | Description                                          |
|--------|------------------------------------------------------|
| DUR-01 | `amauta backup create` exports all data to gzip JSON |
| DUR-02 | `amauta backup restore <file>` imports with merge/replace |
| DUR-03 | Backup includes schema_version for compat checking   |
| DUR-04 | `amauta backup verify` checks integrity (checksums, counts) |
| DUR-05 | Auto-backup on daemon start, keep last 7 in ~/.amauta/backups/ |

## Files Changed
1. `services/backup.py` -- NEW: BackupManager class
2. `services/pg_store.py` -- ADD: export_all_* and import_* methods
3. `services/sqlite_store.py` -- ADD: matching export/import methods
4. `services/amauta-daemon.py` -- ADD: 4 backup API routes + auto_backup on start
5. `get-shit-done/bin/gsd-amauta.cjs` -- ADD: backup subcommand routing
6. `tests/test_backup.py` -- NEW: 7+ unit tests for backup lifecycle

## Risks
- Large datasets may take time to export; mitigated by gzip compression
- Schema version mismatch on restore; mitigated by version check + clear error
- No gsd_audit_log table exists; export gracefully returns [] for missing tables
