#!/usr/bin/env bash
# Amauta restore script — restores from a backup
set -euo pipefail

BACKUP_DIR="${AMAUTA_BACKUP_DIR:-./backups}"
DATA_DIR="${AMAUTA_DATA_DIR:-.}"
PG_URL="${GSD_POSTGRES_URL:-postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta}"

if [ $# -lt 1 ]; then
  echo "Usage: restore.sh <timestamp>"
  echo "Available backups:"
  ls -1 "$BACKUP_DIR"/tasks_*.json 2>/dev/null | sed 's/.*tasks_//;s/\.json//' | sort -r | head -10
  exit 1
fi

TS="$1"

# Restore tasks.json
if [ -f "$BACKUP_DIR/tasks_${TS}.json" ]; then
  cp "$DATA_DIR/tasks.json" "$DATA_DIR/tasks.json.pre-restore" 2>/dev/null || true
  cp "$BACKUP_DIR/tasks_${TS}.json" "$DATA_DIR/tasks.json"
  echo "[restore] tasks.json restored from ${TS}"
else
  echo "[restore] No tasks backup found for ${TS}"
fi

# Restore PostgreSQL
if [ -f "$BACKUP_DIR/pg_dump_${TS}.sql" ] && command -v psql &>/dev/null; then
  psql "$PG_URL" < "$BACKUP_DIR/pg_dump_${TS}.sql" 2>/dev/null && \
    echo "[restore] PostgreSQL restored from ${TS}" || \
    echo "[restore] PostgreSQL restore failed"
fi

echo "[restore] Complete."
