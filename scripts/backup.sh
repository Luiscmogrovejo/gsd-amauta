#!/usr/bin/env bash
# RETIRED by Phase 89 plan 89-04. This script is kept as a loud refusal rather
# than deleted, so operator muscle memory and any stale doc link meet an
# explanation instead of "command not found". Replacement:
#   python3 services/backup_snapshot.py create --reason manual --scope all
# See docs/BACKUP-AND-RESTORE.md.
set -euo pipefail

cat >&2 <<'REFUSAL'
scripts/backup.sh is RETIRED and will not run. It was not a backup.

Three measured defects, each enough on its own:
  1. line 8 hard-coded a CREDENTIALED DSN as the default for GSD_POSTGRES_URL:
     the full scheme, the user `gsd`, its password, and the host and port of the
     operator's own PostgreSQL. Exactly the kind of literal the DSN-containment
     work of 2026-09-07 exists to forbid, because the day the variable goes
     missing it aims the command at whatever is on that port. The literal is
     deliberately NOT reproduced here: `grep -c '<scheme>://' scripts/*.sh` must
     stay at zero, and a refusal that quotes the hazard verbatim would keep it
     alive in the tree it was removed from. Read
     docs/dsn-containment-2026-09-07.md section 3.3 for the original.
  2. the dump line ended with `&& echo ok || echo skipped`, so a FAILED
     pg_dump exited 0 and the script carried on reporting success. The `||`
     also defeats `set -e`. A failed dump that reports success is worse than
     no backup, because it is believed.
  3. no checksum, no manifest, no verification and no restore test. Nothing
     ever proved one of its outputs could be restored.

Use the verb instead. It takes a pg_dump -Fc of the whole database, copies the
SQLite file through the online-backup API, copies tasks.json under the
product's own lock, writes per-file SHA-256 and a per-table census into a
manifest, and VERIFIES its own output before recording verified_at:

  python3 services/backup_snapshot.py create --reason manual --scope all
  python3 services/backup_snapshot.py verify --latest
  python3 services/backup_snapshot.py list

Read docs/BACKUP-AND-RESTORE.md first. Exit code 2.
REFUSAL
exit 2
