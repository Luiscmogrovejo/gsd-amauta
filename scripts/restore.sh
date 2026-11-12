#!/usr/bin/env bash
# RETIRED by Phase 89 plan 89-04. Kept as a loud refusal rather than deleted,
# so operator muscle memory and any stale doc link meet an explanation instead
# of "command not found". Replacement:
#   python3 services/backup_snapshot.py restore <snapshot-dir> --mode replace --confirm
# See docs/BACKUP-AND-RESTORE.md.
set -euo pipefail

cat >&2 <<'REFUSAL'
scripts/restore.sh is RETIRED and will not run. It could report success after
restoring only part of a database.

Three measured defects:
  1. line 7 hard-coded a CREDENTIALED DSN as the default, the same literal
     scripts/backup.sh carried.
  2. `psql < dump` ran with NO ON_ERROR_STOP and with stderr sent to
     /dev/null, so a PARTIAL restore printed "[restore] PostgreSQL restored".
     A half-restored database that reports success is how data loss becomes
     invisible.
  3. `cp tasks.json tasks.json.pre-restore || true` silently skipped the
     pre-restore copy, so a failed restore had nothing to go back to.

Use the verb instead. It refuses a snapshot that carries no verified_at AND one
that fails a fresh verification; it uses pg_restore --clean --if-exists
--exit-on-error, so a partial restore is a FAILURE and never a "restored"
message; and it takes a reason=pre-restore snapshot of the target before it
writes anything, unless you pass --no-pre-restore-snapshot, which is recorded:

  python3 services/backup_snapshot.py list
  python3 services/backup_snapshot.py verify <snapshot-dir>
  python3 services/backup_snapshot.py restore <snapshot-dir> --mode replace --confirm

Read docs/BACKUP-AND-RESTORE.md first. Exit code 2.
REFUSAL
exit 2
