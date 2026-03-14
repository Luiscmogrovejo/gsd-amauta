#!/usr/bin/env bash
# Amauta backup script — backs up tasks.json and PostgreSQL
set -euo pipefail

BACKUP_DIR="${AMAUTA_BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATA_DIR="${AMAUTA_DATA_DIR:-.}"
PG_URL="${GSD_POSTGRES_URL:-postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta}"

mkdir -p "$BACKUP_DIR"

# Backup tasks.json
if [ -f "$DATA_DIR/tasks.json" ]; then
  cp "$DATA_DIR/tasks.json" "$BACKUP_DIR/tasks_${TIMESTAMP}.json"
  echo "[backup] tasks.json → $BACKUP_DIR/tasks_${TIMESTAMP}.json"
fi

# Backup memory.jsonl
if [ -f "$DATA_DIR/memory.jsonl" ]; then
  cp "$DATA_DIR/memory.jsonl" "$BACKUP_DIR/memory_${TIMESTAMP}.jsonl"
  echo "[backup] memory.jsonl → $BACKUP_DIR/memory_${TIMESTAMP}.jsonl"
fi

# Backup PostgreSQL
if command -v pg_dump &>/dev/null; then
  pg_dump "$PG_URL" > "$BACKUP_DIR/pg_dump_${TIMESTAMP}.sql" 2>/dev/null && \
    echo "[backup] PostgreSQL → $BACKUP_DIR/pg_dump_${TIMESTAMP}.sql" || \
    echo "[backup] PostgreSQL dump skipped (connection failed)"
else
  echo "[backup] pg_dump not found, skipping PostgreSQL backup"
fi

# Rotate: keep last 30 backups
ls -t "$BACKUP_DIR"/tasks_*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
ls -t "$BACKUP_DIR"/pg_dump_*.sql 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

echo "[backup] Complete. Backups in $BACKUP_DIR"
