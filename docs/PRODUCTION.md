# Production Deployment Guide

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Python 3.10+
- Node.js 18+
- Docker + Docker Compose (for PostgreSQL)
- 2GB+ RAM, 10GB+ disk

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git
cd gsd-amauta

# 2. Configure environment
cp .env.example .env
# Edit .env — set AMAUTA_DAEMON_TOKEN and POSTGRES_PASSWORD

# 3. Install dependencies
npm install
pip install -r requirements.txt

# 4. Start PostgreSQL
docker compose -f docker/docker-compose.yml up -d
# Wait for healthcheck
docker compose -f docker/docker-compose.yml exec postgres pg_isready

# 5. Run migrations
for f in migrations/*.sql; do
  PGPASSWORD="${POSTGRES_PASSWORD:-gsd}" psql -h 127.0.0.1 -p 5433 -U "${POSTGRES_USER:-gsd}" -d gsd_amauta -f "$f"
done

# 6. Start services
python3 services/amauta-daemon.py &   # Port 18799
python3 services/rlm-service.py &     # Port 18798

# 7. Verify
curl http://127.0.0.1:18799/health
curl http://127.0.0.1:18798/health
npm test
```

## Systemd Service Units

### Amauta Daemon

```ini
# /etc/systemd/system/amauta-daemon.service
[Unit]
Description=Amauta Task Manager Daemon
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=amauta
WorkingDirectory=/opt/amauta
EnvironmentFile=/opt/amauta/.env
ExecStart=/usr/bin/python3 services/amauta-daemon.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### RLM Context Engine

```ini
# /etc/systemd/system/amauta-rlm.service
[Unit]
Description=Amauta RLM Context Engine
After=network.target

[Service]
Type=simple
User=amauta
WorkingDirectory=/opt/amauta
EnvironmentFile=/opt/amauta/.env
ExecStart=/usr/bin/python3 services/rlm-service.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable amauta-daemon amauta-rlm
sudo systemctl start amauta-daemon amauta-rlm
```

## Nginx Reverse Proxy (Optional)

```nginx
# /etc/nginx/sites-available/amauta
server {
    listen 443 ssl;
    server_name amauta.example.com;

    ssl_certificate /etc/letsencrypt/live/amauta.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/amauta.example.com/privkey.pem;

    location /api/ {
        proxy_pass http://127.0.0.1:18799;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /metrics {
        proxy_pass http://127.0.0.1:18799;
        # Restrict to monitoring network
        allow 10.0.0.0/8;
        deny all;
    }
}
```

## Backup Schedule

`scripts/backup.sh` is **retired** (Phase 89, plan 89-04): it hard-coded a
credentialed DSN and a failed `pg_dump` exited 0. Running it now prints the
three defects and exits 2. Use the verb, which verifies its own output:

```bash
# /etc/cron.d/amauta-backup
0 */6 * * * amauta python3 /opt/amauta/services/backup_snapshot.py create --reason auto --scope all >> /var/log/amauta-backup.log 2>&1
```

Retention is by reason, not by count alone: `auto` keeps the last 7, `manual` is
never pruned automatically, every other reason is kept 30 days and never fewer
than the last 3, and the newest **verified** snapshot of any reason is never
deleted. Apply it with `python3 services/backup_snapshot.py prune` (add
`--dry-run` first). See [docs/BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md).

## Log Rotation

```
# /etc/logrotate.d/amauta
/var/log/amauta-*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 amauta amauta
}
```

## Monitoring

### Health Checks

```bash
# Daemon health (includes PG status)
curl -s http://127.0.0.1:18799/health | jq .

# RLM health (includes cache stats)
curl -s http://127.0.0.1:18798/health | jq .

# PostgreSQL
docker compose -f docker/docker-compose.yml exec postgres pg_isready
```

### Prometheus Metrics

Scrape `http://127.0.0.1:18799/metrics` every 30s. Available metrics:
- `amauta_uptime_seconds` — daemon uptime
- `amauta_http_requests_total{method,path}` — request counts
- `amauta_auth_failures_total` — failed auth attempts
- `amauta_rate_limited_total` — rate-limited requests

### Structured Logging

Set `AMAUTA_LOG_FORMAT=json` for machine-parseable logs:
```bash
AMAUTA_LOG_FORMAT=json AMAUTA_LOG_LEVEL=INFO python3 services/amauta-daemon.py
```

Output:
```json
{"ts":"2026-03-14 12:00:00,000","level":"INFO","module":"amauta.daemon","msg":"daemon_started port=18799 pid=1234"}
```

## Environment Variables Reference

See `.env.example` for all variables with descriptions.

## Disaster Recovery

`scripts/restore.sh` is **retired** (Phase 89, plan 89-04): it piped a dump into
`psql` with no `ON_ERROR_STOP` and with stderr discarded, so a partial restore
printed "restored". Running it now prints the three defects and exits 2.

```bash
# List snapshots, with each one's verified_at
python3 services/backup_snapshot.py list

# Verify before you trust it (a snapshot can rot on disk)
python3 services/backup_snapshot.py verify --latest

# Restore. It refuses an unverified or now-failing snapshot, takes a
# reason=pre-restore snapshot of the target first, and treats a PARTIAL
# restore as a failure (pg_restore --clean --if-exists --exit-on-error).
python3 services/backup_snapshot.py restore <snapshot-dir> --mode replace --confirm
```

See [docs/BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) for the manifest, the
`pg_dump` resolution order and the 24-hour backup guard.

## Security Hardening

1. Set `AMAUTA_DAEMON_TOKEN` to a strong random value
2. Set unique `POSTGRES_PASSWORD` (not the default `gsd`)
3. Restrict daemon to localhost: it binds to `127.0.0.1` by default
4. Use nginx + TLS for external access
5. Run as dedicated `amauta` user (not root)
6. File permissions: tasks.json is `0o640` (owner+group only)
