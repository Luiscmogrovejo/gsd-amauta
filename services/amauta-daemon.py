#!/usr/bin/env python3
"""
Amauta Daemon — HTTP API wrapping amauta.py task manager.

Runs as a background service on localhost:18799.
Claude Code agents communicate via amauta.cjs → HTTP → this daemon → amauta.py.

Usage:
    python3 services/amauta-daemon.py start   # Start daemon (background)
    python3 services/amauta-daemon.py stop    # Stop daemon
    python3 services/amauta-daemon.py status  # Check if running
    python3 services/amauta-daemon.py run     # Run in foreground (debug)
"""

import http.server
import json
import os
import re
import signal
import subprocess

# ── Load .env file (project root or /srv/amauta) ──────────────────────────────
def _load_dotenv():
    """Load .env file into os.environ (simple parser, no dependency)."""
    for candidate in [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"),
        "/srv/amauta/.env",
    ]:
        if os.path.isfile(candidate):
            with open(candidate) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    if key and key not in os.environ:
                        os.environ[key] = val
            break

_load_dotenv()
import sys
import time
import threading
from collections import defaultdict
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse
import logging

# ── Structured Logging ─────────────────────────────────────────────────────────
_log_level = os.environ.get("AMAUTA_LOG_LEVEL", "INFO").upper()
_log_format = os.environ.get("AMAUTA_LOG_FORMAT", "text")  # "text" or "json"

if _log_format == "json":
    class _JsonFormatter(logging.Formatter):
        def format(self, record):
            import json as _json
            return _json.dumps({
                "ts": self.formatTime(record),
                "level": record.levelname,
                "module": record.name,
                "msg": record.getMessage()
            })
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(_JsonFormatter())
    logging.basicConfig(level=getattr(logging, _log_level, logging.INFO), handlers=[_handler])
else:
    logging.basicConfig(
        level=getattr(logging, _log_level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )

log = logging.getLogger("amauta.daemon")

# Infrastructure detection
_HAS_INFRA_DETECT = False
_infra_result = None
try:
    from infra_detect import detect_infrastructure
    _HAS_INFRA_DETECT = True
except ImportError:
    detect_infrastructure = None  # type: ignore

# Redis client (optional — graceful degradation)
_HAS_REDIS = False
_redis_client = None
try:
    import redis as redis_module
    _HAS_REDIS = True
except ImportError:
    pass

# PostgreSQL store (optional — graceful degradation)
_pg_store = None
_HAS_PG_MODULE = False
try:
    from pg_store import PGStore
    _HAS_PG_MODULE = True
except ImportError:
    PGStore = None  # type: ignore

# SQLite store (fallback when PG unavailable)
_sqlite_store = None
_HAS_SQLITE_MODULE = False
try:
    from sqlite_store import SQLiteStore
    _HAS_SQLITE_MODULE = True
except ImportError:
    SQLiteStore = None  # type: ignore

# Backup manager (Phase 8: Data Durability)
_backup_manager = None
_HAS_BACKUP_MODULE = False
try:
    from backup import BackupManager
    _HAS_BACKUP_MODULE = True
except ImportError:
    BackupManager = None  # type: ignore

# OIDC authentication (optional — graceful degradation)
_oidc = None
_HAS_OIDC_MODULE = False
try:
    from oidc_auth import OIDCAuth
    _HAS_OIDC_MODULE = True
except ImportError:
    OIDCAuth = None  # type: ignore

# ═══════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════

HOST = "127.0.0.1"
PORT = int(os.environ.get("GSD_AMAUTA_PORT", "18799"))
AMAUTA_PY = os.environ.get(
    "GSD_AMAUTA_PY",
    str(Path(__file__).resolve().parent.parent / "amauta.py"),
)
DATA_DIR = os.environ.get(
    "AMAUTA_DATA_DIR",
    str(Path(__file__).resolve().parent.parent / "data"),
)
PID_FILE = Path(__file__).resolve().parent / "amauta-daemon.pid"

# ── Stale Task Watchdog & Retry Queue Flush ───────────────────────────────────
STALE_CHECK_INTERVAL = int(os.environ.get("GSD_STALE_INTERVAL", "300"))  # 5 minutes
STALE_THRESHOLD_HOURS = int(os.environ.get("GSD_STALE_HOURS", "48"))
RETRY_FLUSH_INTERVAL = int(os.environ.get("GSD_RETRY_FLUSH_INTERVAL", "60"))
RETENTION_CHECK_INTERVAL = 86400  # 24 hours — retention cleanup runs daily
_shutdown_event = threading.Event()

# ── Authentication ─────────────────────────────────────────────────────────────
DAEMON_AUTH_TOKEN = os.environ.get("AMAUTA_DAEMON_TOKEN", "")

def _check_auth(handler) -> bool:
    """Validate bearer token if AMAUTA_DAEMON_TOKEN is set. Returns True if authorized."""
    if not DAEMON_AUTH_TOKEN:
        return True  # No token configured = open access (dev mode)
    import hmac
    auth = handler.headers.get("Authorization", "")
    expected = f"Bearer {DAEMON_AUTH_TOKEN}"
    if hmac.compare_digest(auth.encode(), expected.encode()):
        return True
    log.warning("auth_failed ip=%s path=%s", handler.client_address[0], handler.path)
    handler.send_response(401)
    handler.send_header("Content-Type", "application/json")
    handler.end_headers()
    handler.wfile.write(json.dumps({"error": "Unauthorized. Set Authorization: Bearer <AMAUTA_DAEMON_TOKEN>"}).encode())
    return False

# ── OIDC Authentication ───────────────────────────────────────────────────────
def _check_oidc(handler):
    """Validate OIDC Bearer token if GSD_OIDC_ISSUER is configured.

    Returns dict: {"valid": True, "sub": "...", ...} or {"valid": False, "error": "..."}.
    When OIDC is not enabled, returns valid with sub="local".
    """
    if _oidc is None or not _oidc.is_enabled():
        return {"valid": True, "sub": "local"}

    # Health and metrics endpoints bypass OIDC
    path = handler.path.split("?")[0].rstrip("/")
    if path in ("/health", "/metrics", "/metrics/cache", "/cache/stats"):
        return {"valid": True, "sub": "health-check"}

    auth_header = handler.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return {"valid": False, "error": "Missing or invalid Authorization header. Expected: Bearer <token>"}

    token = auth_header[7:]  # Strip "Bearer " prefix
    result = _oidc.validate_token(token)

    if result["valid"]:
        log.info("oidc_auth_ok sub=%s path=%s", result.get("sub", "?"), handler.path)
    else:
        log.warning("oidc_auth_failed error=%s path=%s ip=%s",
                     result.get("error", "?"), handler.path, handler.client_address[0])

    return result


# ── Rate Limiting ──────────────────────────────────────────────────────────────
class _RateLimiter:
    """Simple per-path rate limiter. 60 requests per minute per path."""
    def __init__(self, max_requests=60, window_seconds=60):
        self._max = max_requests
        self._window = window_seconds
        self._requests = defaultdict(list)
        self._lock = threading.Lock()

    def allow(self, path: str) -> bool:
        now = time.time()
        key = path.split("?")[0]  # strip query params
        with self._lock:
            self._requests[key] = [t for t in self._requests[key] if now - t < self._window]
            if len(self._requests[key]) >= self._max:
                return False
            self._requests[key].append(now)
            return True

_rate_limiter = _RateLimiter()

# ── Metrics ────────────────────────────────────────────────────────────────────
class _Metrics:
    """Lightweight Prometheus-compatible metrics. No external dependencies."""
    def __init__(self):
        self._counters = {}
        self._gauges = {}
        self._start_time = time.time()

    def inc(self, name, labels=None, count=1):
        key = (name, tuple(sorted((labels or {}).items())))
        self._counters[key] = self._counters.get(key, 0) + count

    def set_gauge(self, name, value, labels=None):
        key = (name, tuple(sorted((labels or {}).items())))
        self._gauges[key] = value

    def expose(self):
        """Return Prometheus text format."""
        lines = [
            "# HELP amauta_uptime_seconds Daemon uptime in seconds",
            "# TYPE amauta_uptime_seconds gauge",
            f"amauta_uptime_seconds {time.time() - self._start_time:.0f}",
            "",
        ]
        # Group counters by name
        names = {}
        for (name, label_tuple), value in sorted(self._counters.items()):
            if name not in names:
                lines.append(f"# HELP {name} Counter")
                lines.append(f"# TYPE {name} counter")
                names[name] = True
            if label_tuple:
                label_str = ",".join(f'{k}="{v}"' for k, v in label_tuple)
                lines.append(f"{name}{{{label_str}}} {value}")
            else:
                lines.append(f"{name} {value}")
        # Gauges
        gauge_names = {}
        for (name, label_tuple), value in sorted(self._gauges.items()):
            if name not in gauge_names:
                lines.append(f"# HELP {name} Gauge")
                lines.append(f"# TYPE {name} gauge")
                gauge_names[name] = True
            if label_tuple:
                label_str = ",".join(f'{k}="{v}"' for k, v in label_tuple)
                lines.append(f"{name}{{{label_str}}} {value}")
            else:
                lines.append(f"{name} {value}")
        return "\n".join(lines) + "\n"

_metrics = _Metrics()

# ── Prompt Cache Metrics (Phase 23 / CACHE-04) ────────────────────────────────
try:
    from services.prompt_cache import PromptCacheMetrics as _PromptCacheMetrics
    _prompt_cache_metrics = _PromptCacheMetrics()
except ImportError:
    _prompt_cache_metrics = None

# ── RLM Service Management ───────────────────────────────────────────────────
RLM_SERVICE_PY = str(Path(__file__).resolve().parent / "rlm-service.py")
RLM_PORT = int(os.environ.get("GSD_RLM_PORT", "18798"))
RLM_MAX_RESTARTS = 3
_rlm_process = None
_rlm_restart_count = 0
_rlm_last_successful_uptime = None  # epoch seconds of first healthy observation post-restart; resets to None after each restart event so the 300s uptime gate re-arms
_rlm_enabled = os.environ.get("GSD_RLM_ENABLED", "true").lower() != "false"


def _kill_port_holder(port):
    """Kill any process holding the given port. Returns True if port was freed."""
    import subprocess as _sp
    try:
        result = _sp.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            pids = result.stdout.strip().split("\n")
            for pid_str in pids:
                pid = int(pid_str.strip())
                if pid == os.getpid():
                    continue  # Never kill ourselves
                try:
                    os.kill(pid, signal.SIGTERM)
                    time.sleep(0.5)
                    try:
                        os.kill(pid, 0)  # Check if still alive
                        os.kill(pid, signal.SIGKILL)
                        time.sleep(0.3)
                    except ProcessLookupError:
                        pass
                    log.info("rlm_port_freed pid=%d port=%d", pid, port)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    log.warning("rlm_port_kill_permission pid=%d", pid)
            return True
    except Exception as e:
        log.warning("rlm_port_check_failed error=%s", str(e))
    return False


def _port_is_free(port):
    """Check if port is available for binding."""
    import socket as _socket
    with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def _validate_api_keys():
    """Validate API keys at startup. Returns status dict for health/logging."""
    keys_config = {
        "VOYAGE_API_KEY": {"min_len": 40, "max_len": 60},
        "PERPLEXITY_API_KEY": {"min_len": 40, "max_len": 70},
    }
    config_vars = {
        "PERPLEXITY_MODEL": os.environ.get("PERPLEXITY_MODEL", "NOT SET"),
    }
    results = {}
    for name, bounds in keys_config.items():
        val = os.environ.get(name, "")
        if not val:
            results[name] = {"set": False, "status": "missing"}
        else:
            length = len(val)
            if bounds["min_len"] <= length <= bounds["max_len"]:
                status = "ok"
            else:
                status = "suspicious_length"
            results[name] = {"set": True, "status": status, "length": length}
    for name, val in config_vars.items():
        results[name] = {"set": val != "NOT SET", "value": val}
    return results


def _start_rlm():
    """Start RLM service as a subprocess."""
    global _rlm_process, _rlm_restart_count
    if not _rlm_enabled:
        log.info("rlm_disabled")
        return False
    if not Path(RLM_SERVICE_PY).exists():
        log.warning("rlm_not_found path=%s", RLM_SERVICE_PY)
        return False

    # Pre-flight: ensure port is free, kill orphans if needed
    if not _port_is_free(RLM_PORT):
        log.warning("rlm_port_occupied port=%d", RLM_PORT)
        _kill_port_holder(RLM_PORT)
        time.sleep(0.5)
        if not _port_is_free(RLM_PORT):
            log.error("rlm_port_still_occupied port=%d", RLM_PORT)
            return False

    try:
        env = os.environ.copy()
        env["GSD_RLM_PORT"] = str(RLM_PORT)
        rlm_log_path = os.path.join(DATA_DIR, "rlm-service.log")
        rlm_log_file = open(rlm_log_path, "a")
        _rlm_process = subprocess.Popen(
            [sys.executable, RLM_SERVICE_PY, "run"],
            env=env,
            stdout=rlm_log_file,
            stderr=rlm_log_file,
            start_new_session=True,
        )
        # Wait for health check
        import urllib.request
        for _ in range(25):  # 5 seconds max
            time.sleep(0.2)
            try:
                req = urllib.request.urlopen(f"http://127.0.0.1:{RLM_PORT}/health", timeout=1)
                if req.status == 200:
                    log.info("rlm_started pid=%d port=%d", _rlm_process.pid, RLM_PORT)
                    _rlm_restart_count = 0  # Reset on successful start
                    return True
            except Exception:
                pass
        log.warning("rlm_start_timeout")
        return False
    except Exception as e:
        log.error("rlm_start_failed error=%s", str(e))
        return False


def _stop_rlm():
    """Stop managed RLM subprocess."""
    global _rlm_process
    if _rlm_process is None:
        return
    try:
        _rlm_process.terminate()
        try:
            _rlm_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _rlm_process.kill()
        log.info("rlm_stopped pid=%d", _rlm_process.pid)
    except Exception as e:
        log.warning("rlm_stop_error error=%s", str(e))
    _rlm_process = None


def _check_rlm_health():
    """Check if RLM is still responding. Returns True if healthy."""
    try:
        import urllib.request
        req = urllib.request.urlopen(f"http://127.0.0.1:{RLM_PORT}/health", timeout=2)
        return req.status == 200
    except Exception:
        return False


def _rlm_watchdog():
    """Background thread: periodically check RLM health and restart if needed.

    Resilience contract (post-13h-degraded-window fix):
      - First iteration runs immediately after thread start (sleep moved to bottom).
      - Healthy iterations arm an uptime timer; after >=300s continuous health with
        a non-zero restart count, the counter resets so future bursts get a fresh
        budget instead of permanent degradation.
      - Consecutive restarts within a burst back off exponentially (1,2,4,8,...,60s)
        to avoid burning the cap in seconds during a crash cascade.
      - When the cap is hit, enter a 300s cooldown then reset and continue rather
        than abandoning forever (yesterday's failure mode: 1 restart → cap → 13h
        silence until manual intervention).
    """
    global _rlm_restart_count, _rlm_last_successful_uptime
    while True:
        if not _rlm_enabled or _rlm_process is None:
            time.sleep(30)
            continue
        process_dead = _rlm_process.poll() is not None
        health_failed = not process_dead and not _check_rlm_health()
        if process_dead or health_failed:
            reason = "process_exited" if process_dead else "health_check_failed"
            if _rlm_restart_count < RLM_MAX_RESTARTS:
                _rlm_restart_count += 1
                backoff = min(2 ** (_rlm_restart_count - 1), 60)
                log.warning(
                    "rlm_restart attempt=%d/%d reason=%s backoff=%ds",
                    _rlm_restart_count, RLM_MAX_RESTARTS, reason, backoff,
                )
                _stop_rlm()
                time.sleep(backoff)
                _start_rlm()
                _rlm_last_successful_uptime = None  # re-arm uptime gate post-restart
            else:
                log.warning("rlm_max_restarts_cooldown duration=300")
                time.sleep(300)
                _rlm_restart_count = 0
                _rlm_last_successful_uptime = None
        else:
            # Healthy iteration: arm or evaluate the uptime-based counter reset.
            now = time.time()
            if _rlm_last_successful_uptime is None:
                _rlm_last_successful_uptime = now
            elif _rlm_restart_count > 0 and (now - _rlm_last_successful_uptime) >= 300:
                log.info(
                    "rlm_restart_counter_reset previous_count=%d uptime=%ds",
                    _rlm_restart_count, int(now - _rlm_last_successful_uptime),
                )
                _rlm_restart_count = 0
        time.sleep(30)


# ── Redis Service Management ──────────────────────────────────────────────────
REDIS_URL = os.environ.get("GSD_REDIS_URL", "redis://127.0.0.1:6379/0")
REDIS_MAX_RESTARTS = 3
_redis_restart_count = 0
_redis_last_successful_uptime = None  # epoch seconds of first healthy observation post-reconnect; resets to None after each reconnect event so the 300s uptime gate re-arms
_redis_enabled = os.environ.get("GSD_REDIS_ENABLED", "true").lower() != "false"
# TOK-06: Redis-backed Perplexity response cache constants
REDIS_PERPLEXITY_TTL = 21600  # 6 hours, matches file cache TTL
REDIS_PERPLEXITY_PREFIX = "gsd:ppx:"


def _start_redis():
    """Connect to Redis (auto-start via docker if needed). Returns True if connected."""
    global _redis_client, _redis_restart_count
    if not _redis_enabled or not _HAS_REDIS:
        if not _HAS_REDIS:
            log.info("redis_no_module pip install redis>=5.0 to enable")
        else:
            log.info("redis_disabled")
        return False
    try:
        _redis_client = redis_module.from_url(
            REDIS_URL, decode_responses=False, socket_timeout=2, socket_connect_timeout=2
        )
        _redis_client.ping()
        _redis_restart_count = 0
        log.info(
            "redis_connected url=%s",
            REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL,
        )
        return True
    except Exception as e:
        log.warning("redis_connect_failed error=%s", str(e))
        _redis_client = None
        # Try auto-starting redis container
        return _auto_start_redis_container()


def _auto_start_redis_container():
    """Try to start gsd-redis Docker container."""
    global _redis_client, _redis_restart_count
    try:
        import subprocess as _sp

        # Check if container exists (running or stopped)
        result = _sp.run(
            ["docker", "ps", "-a", "--filter", "name=gsd-redis", "--format", "{{.Status}}"],
            capture_output=True, text=True, timeout=5,
        )
        if result.stdout.strip():
            _sp.run(["docker", "start", "gsd-redis"], capture_output=True, text=True, timeout=15)
        else:
            # Use docker compose to create container
            compose_file = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "docker", "docker-compose.yml"
            )
            if os.path.isfile(compose_file):
                for cmd in [
                    ["docker", "compose", "-f", compose_file, "up", "-d", "redis"],
                    ["docker-compose", "-f", compose_file, "up", "-d", "redis"],
                ]:
                    try:
                        r = _sp.run(cmd, capture_output=True, text=True, timeout=30)
                        if r.returncode == 0:
                            break
                    except FileNotFoundError:
                        continue

        # Wait for Redis to come up (up to 5s)
        for _ in range(10):
            time.sleep(0.5)
            try:
                _redis_client = redis_module.from_url(
                    REDIS_URL, decode_responses=False, socket_timeout=2, socket_connect_timeout=2
                )
                _redis_client.ping()
                _redis_restart_count = 0
                log.info(
                    "redis_auto_started url=%s",
                    REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL,
                )
                return True
            except Exception:
                pass
        log.warning("redis_auto_start_failed")
        _redis_client = None
        return False
    except Exception as e:
        log.warning("redis_auto_start_error error=%s", str(e))
        _redis_client = None
        return False


def _stop_redis():
    """Close Redis connection (does not stop container)."""
    global _redis_client
    if _redis_client:
        try:
            _redis_client.close()
        except Exception:
            pass
        _redis_client = None


def _check_redis_health():
    """Check if Redis is still responding. Returns True if healthy."""
    if not _redis_client:
        return False
    try:
        return bool(_redis_client.ping())
    except Exception:
        return False


def _redis_watchdog():
    """Background thread: periodically check Redis health and reconnect if needed.

    Resilience contract (mirrors b41ad40 RLM watchdog fix; TK-B FOLLOWUP_NOTE):
      - First iteration runs immediately after thread start (sleep moved to bottom).
      - Healthy iterations arm an uptime timer; after >=300s continuous health with
        a non-zero restart count, the counter resets so future bursts get a fresh
        budget instead of permanent degradation.
      - Consecutive reconnect attempts within a burst back off exponentially
        (1,2,4,8,...,60s) to avoid burning the cap in seconds during a crash cascade.
      - When the cap is hit, enter a 300s cooldown then reset and continue rather
        than abandoning forever (pre-fix failure mode mirrored RLM's 13h silence).
    """
    global _redis_restart_count, _redis_last_successful_uptime
    while True:
        if not _redis_enabled or not _HAS_REDIS:
            time.sleep(30)
            continue
        if not _check_redis_health():
            if _redis_restart_count < REDIS_MAX_RESTARTS:
                _redis_restart_count += 1
                backoff = min(2 ** (_redis_restart_count - 1), 60)
                log.warning(
                    "redis_reconnect attempt=%d/%d backoff=%ds",
                    _redis_restart_count, REDIS_MAX_RESTARTS, backoff,
                )
                _stop_redis()
                time.sleep(backoff)
                _start_redis()
                _redis_last_successful_uptime = None  # re-arm uptime gate post-reconnect
            else:
                log.warning("redis_max_restarts_cooldown duration=300")
                time.sleep(300)
                _redis_restart_count = 0
                _redis_last_successful_uptime = None
        else:
            # Healthy iteration: arm or evaluate the uptime-based counter reset.
            now = time.time()
            if _redis_last_successful_uptime is None:
                _redis_last_successful_uptime = now
            elif _redis_restart_count > 0 and (now - _redis_last_successful_uptime) >= 300:
                log.info(
                    "redis_restart_counter_reset previous_count=%d uptime=%ds",
                    _redis_restart_count, int(now - _redis_last_successful_uptime),
                )
                _redis_restart_count = 0
        time.sleep(30)


# ── Stale Task Watchdog Thread ────────────────────────────────────────────────

def _stale_task_watchdog():
    """Background thread: auto-revert in-progress tasks with no RPETD activity > STALE_THRESHOLD_HOURS.

    Checks every STALE_CHECK_INTERVAL seconds. Reads tasks.json directly (no daemon dependency).
    Tasks with 'WATCHDOG_EXEMPT' in notes are skipped.
    """
    from datetime import datetime, timezone
    while True:
        try:
            tasks_file = Path(DATA_DIR) / "tasks.json"
            if tasks_file.exists():
                data = json.loads(tasks_file.read_text())
                items = data.get("items", [])
                now = datetime.now(timezone.utc)
                total_in_progress = 0
                stale_count = 0
                reverted_count = 0

                for item in items:
                    if item.get("status") != "in-progress":
                        continue
                    total_in_progress += 1

                    # Check WATCHDOG_EXEMPT opt-out
                    notes = item.get("notes", [])
                    if isinstance(notes, list):
                        exempt = any("WATCHDOG_EXEMPT" in str(n) for n in notes)
                    elif isinstance(notes, str):
                        exempt = "WATCHDOG_EXEMPT" in notes
                    else:
                        exempt = False
                    if exempt:
                        continue

                    # Determine staleness: use latest RPETD timestamp or claimed_at
                    latest_ts = None
                    rpetd = item.get("rpetd", {})
                    if isinstance(rpetd, dict):
                        for phase_data in rpetd.values():
                            ts_str = None
                            if isinstance(phase_data, dict):
                                ts_str = phase_data.get("timestamp") or phase_data.get("at")
                            elif isinstance(phase_data, str):
                                ts_str = phase_data
                            if ts_str:
                                try:
                                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                                    if latest_ts is None or ts > latest_ts:
                                        latest_ts = ts
                                except (ValueError, TypeError):
                                    pass

                    # Fallback to claimed_at
                    if latest_ts is None:
                        claimed_at = item.get("claimed_at", "")
                        if claimed_at:
                            try:
                                latest_ts = datetime.fromisoformat(claimed_at.replace("Z", "+00:00"))
                            except (ValueError, TypeError):
                                pass

                    if latest_ts is None:
                        continue

                    stale_hours = (now - latest_ts).total_seconds() / 3600
                    if stale_hours > STALE_THRESHOLD_HOURS:
                        stale_count += 1
                        task_id = item.get("id", "unknown")
                        try:
                            result = subprocess.run(
                                [sys.executable, AMAUTA_PY, "status", task_id, "pending",
                                 "--agent", "watchdog", "--force",
                                 "--note", f"Auto-reverted by watchdog: no RPETD activity in >{STALE_THRESHOLD_HOURS}h"],
                                capture_output=True, text=True, timeout=30,
                                env={**os.environ, "AMAUTA_DATA_DIR": DATA_DIR}
                            )
                            if result.returncode == 0:
                                reverted_count += 1
                                log.info("watchdog_revert task_id=%s stale_hours=%d",
                                         task_id, int(stale_hours))
                            else:
                                log.warning("watchdog_revert_failed task_id=%s rc=%d err=%s",
                                            task_id, result.returncode, result.stderr.strip()[:200])
                        except Exception as revert_err:
                            log.warning("watchdog_revert_error task_id=%s: %s", task_id, revert_err)

                log.info("watchdog_check total_in_progress=%d stale=%d reverted=%d",
                         total_in_progress, stale_count, reverted_count)
        except Exception as e:
            log.error("watchdog_error: %s", e)
        time.sleep(STALE_CHECK_INTERVAL)


# ── Retry Queue Flusher Thread ────────────────────────────────────────────────

def _retry_queue_flusher():
    """Background thread: flush PG retry queue every RETRY_FLUSH_INTERVAL seconds.

    Calls _pg_store.flush_retry_queue() to re-attempt failed task upserts.
    Uses exponential backoff on consecutive failures (max 5 minutes).
    Updates metrics counters for monitoring.
    """
    global _pg_store
    consecutive_failures = 0
    while True:
        try:
            if _pg_store:
                succeeded, failed, remaining = _pg_store.flush_retry_queue()
                if succeeded > 0 or failed > 0:
                    log.info("retry_flush succeeded=%d failed=%d remaining=%d",
                             succeeded, failed, remaining)
                    _metrics.inc("retry_flush_succeeded_total", count=succeeded)
                    _metrics.inc("retry_flush_failed_total", count=failed)
                _metrics.set_gauge("retry_queue_size", remaining)
                consecutive_failures = 0 if failed == 0 else consecutive_failures + 1
            else:
                # No PG store available -- check queue file size for metrics only
                retry_path = Path(DATA_DIR) / "pg_retry_queue.json"
                if retry_path.exists():
                    try:
                        queue = json.loads(retry_path.read_text())
                        _metrics.set_gauge("retry_queue_size", len(queue) if isinstance(queue, list) else 0)
                    except (json.JSONDecodeError, OSError):
                        pass
        except Exception as e:
            consecutive_failures += 1
            log.warning("retry_flush_error attempt=%d: %s", consecutive_failures, e)
        # Exponential backoff on consecutive failures, max 5 minutes
        sleep_time = min(RETRY_FLUSH_INTERVAL * (2 ** min(consecutive_failures, 3)), 300)
        time.sleep(sleep_time)


# ── Memory Retention Thread ──────────────────────────────────────────────────

def _memory_retention_thread():
    """Background thread: archive stale memory entries every RETENTION_CHECK_INTERVAL seconds.

    Calls store.memory_retention_cleanup() to move old task_event (>30d) and
    rpetd_phase (>90d) entries to gsd_memory_archive. Runs daily.
    Uses _shutdown_event.wait() instead of time.sleep() for interruptible blocking.
    """
    while not _shutdown_event.is_set():
        try:
            store = _get_store()
            if store and hasattr(store, 'memory_retention_cleanup'):
                result = store.memory_retention_cleanup()
                total = result.get("total", 0)
                if total > 0:
                    log.info("retention_cleanup archived=%d details=%s", total, result)
                else:
                    log.debug("retention_cleanup nothing_to_archive")
        except Exception as e:
            log.error("retention_cleanup_error: %s", e)
        _shutdown_event.wait(timeout=RETENTION_CHECK_INTERVAL)


# ── Request Body Size Limit ────────────────────────────────────────────────────
MAX_BODY_SIZE = int(os.environ.get("AMAUTA_MAX_BODY_SIZE", str(10 * 1024 * 1024)))  # 10MB default

def _safe_error(e):
    """Sanitize exception messages to prevent DSN/credential leakage."""
    msg = str(e)
    msg = re.sub(r'postgresql://[^@]+@', 'postgresql://[redacted]@', msg)
    msg = re.sub(r'postgres://[^@]+@', 'postgres://[redacted]@', msg)
    return msg


def _get_store():
    """Return the active store (PGStore or SQLiteStore), or None."""
    return _pg_store or _sqlite_store


def _make_compaction_llm_call():
    """Create an llm_call function for compact_conversation using model_routing.compaction.

    Phase 24 ROUTE-02: Reads model from config.json model_routing.compaction.
    The function wraps an HTTP call to a local LLM endpoint or returns None
    if no LLM provider is available.

    Returns:
        callable(prompt) -> str, or None if config unavailable.
    """
    try:
        config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                    '.planning', 'config.json')
        with open(config_path, 'r') as f:
            config = json.load(f)
        model_routing = config.get('model_routing', {})
        compaction_model = model_routing.get('compaction', 'haiku')
        log.info("compaction_model_resolved model=%s source=config.json", compaction_model)

        def llm_call(prompt):
            """Compaction LLM call using configured model.

            Currently a no-op that logs the model selection and returns None
            (triggering the fallback path in compact_conversation).
            Phase 24 wires the model selection; actual API integration requires
            an LLM provider endpoint (future: local Ollama or Anthropic API key).
            """
            log.info("compaction_llm_call model=%s prompt_len=%d", compaction_model, len(prompt))
            # Return None to trigger fallback — the model SELECTION is what ROUTE-02 verifies,
            # not the actual API call (GSD-Amauta delegates API calls to Claude Code).
            return None

        llm_call._compaction_model = compaction_model  # Test hook: verify model was resolved
        return llm_call
    except Exception as e:
        log.warning("compaction_config_read_failed error=%s", str(e)[:200])
        return None


def _enrich_with_rlm(task_output, body):
    """Query RLM for relevant code context based on task title/description.

    Returns enriched output with appended code context, or original output on failure.
    """
    if not _rlm_enabled or not _check_rlm_health():
        return task_output

    # Extract task title/description from body or output
    query = body.get("title", "") or body.get("description", "")
    if not query:
        # Try to parse title from the claim output
        for line in task_output.split("\n"):
            if "Title:" in line or "title:" in line:
                query = line.split(":", 1)[-1].strip()
                break
    if not query or len(query) < 5:
        return task_output

    # Get the project directory from body
    project_dir = body.get("project_dir") or os.environ.get("GSD_PROJECT_DIR", "")
    if not project_dir:
        return task_output

    try:
        import urllib.request
        payload = json.dumps({
            "query": query[:200],  # Truncate long descriptions
            "directory": project_dir,
            "top_k": 5,
            "max_files": 200,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"http://127.0.0.1:{RLM_PORT}/query",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            rlm_data = json.loads(resp.read().decode("utf-8"))

        results = rlm_data.get("results", [])
        if not results:
            return task_output

        # Append RLM context to output
        ctx_lines = ["\n\n## Relevant Code Context (auto-injected by RLM)\n"]
        for r in results[:5]:
            filepath = r.get("filepath", "")
            label = r.get("label", "")
            start = r.get("start_line", 0)
            end = r.get("end_line", 0)
            score = r.get("relevance_score", 0)
            ctx_lines.append(f"- `{filepath}:{start}-{end}` **{label}** (score: {score})")
        ctx_lines.append("")

        return task_output + "\n".join(ctx_lines)
    except Exception as e:
        log.debug("rlm_enrich_failed error=%s", str(e))
        return task_output


# ═══════════════════════════════════════════════════════
# Threaded HTTP Server
# ═══════════════════════════════════════════════════════

class ThreadedHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    """Handle requests in separate threads."""
    daemon_threads = True
    allow_reuse_address = True


class AmautaHandler(http.server.BaseHTTPRequestHandler):
    """Routes HTTP requests to amauta.py CLI commands."""

    def log_message(self, format, *args):
        """Suppress default request logging unless GSD_DEBUG set."""
        if os.environ.get("GSD_DEBUG"):
            super().log_message(format, *args)

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        length = max(0, length)
        if length > MAX_BODY_SIZE:
            self.close_connection = True  # Prevent keep-alive reuse with unread body
            self.send_response(413)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Payload too large. Max {MAX_BODY_SIZE} bytes"}).encode())
            return None
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON in request body"}).encode())
            return None

    def _resolve_project_id(self, body):
        """DATA-05/DATA-06: Auto-set project_id from request body, CWD, or test mode."""
        # DATA-06: Force __test__ in test mode (highest priority)
        if os.environ.get("NODE_ENV") == "test" or os.environ.get("GSD_TEST_MODE") == "1" or os.environ.get("PYTEST_CURRENT_TEST"):
            return "__test__"
        # DATA-05: Use explicit value or fall back to server CWD basename
        return body.get("project_id") or os.path.basename(os.getcwd())

    def _run_amauta(self, args):
        """Run amauta.py with given args, return (stdout, stderr, returncode)."""
        env = os.environ.copy()
        env["AMAUTA_DATA_DIR"] = DATA_DIR
        # Strip ANSI codes for clean JSON parsing
        env["NO_COLOR"] = "1"
        # Bridge GSD_POSTGRES_URL → AMAUTA_MEMORY_DATABASE_URL so amauta.py
        # enrichment layers (claim-time Layer 1, RPETD Layer 2) can reach PG.
        pg_url = os.environ.get("GSD_POSTGRES_URL", "")
        if pg_url and not env.get("AMAUTA_MEMORY_DATABASE_URL"):
            env["AMAUTA_MEMORY_DATABASE_URL"] = pg_url
        if not env.get("AMAUTA_MEMORY_BACKEND"):
            env["AMAUTA_MEMORY_BACKEND"] = "postgres" if pg_url else ""

        cmd = [sys.executable, AMAUTA_PY] + args
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
            return result.stdout, result.stderr, result.returncode
        except subprocess.TimeoutExpired:
            return "", "Command timed out after 30s", 1
        except Exception as e:
            return "", str(e), 1

    def _build_args(self, command, body):
        """Convert JSON body to amauta CLI args list."""
        args = [command]

        # Positional arguments (type for add, id for show/claim/etc)
        if "type" in body and command == "add":
            args.append(body["type"])
        if "title" in body and command == "add":
            args.append(body["title"])
        if "id" in body and command != "add":
            args.append(body["id"])
        # assign has TWO positional args: id (above) + agent (positional, not --agent)
        # amauta.py `assign` subparser: asgn.add_argument("id"); asgn.add_argument("agent")
        if command == "assign" and "agent" in body:
            args.append(body["agent"])
            # Skip the flag_map's --agent processing for assign (handled above as positional)
            body = {k: v for k, v in body.items() if k != "agent"}

        # link/unlink have TWO positional args: id (above) + dep_id
        # amauta.py: lk.add_argument("id"); lk.add_argument("dep_id")
        if command in ("link", "unlink") and "dep_id" in body:
            args.append(body["dep_id"])

        # Named arguments
        flag_map = {
            "agent": "--agent",
            "priority": "--priority",
            "parent": "--parent",
            "description": "--description",
            "details": "--details",
            "criteria": "--criteria",
            "importance": "--importance",
            "urgency": "--urgency",
            "phase": "--phase",
            "content": "--content",
            "status_to": None,  # handled specially (positional for status command)
            "validator": "--validator",
            "notes": "--notes",
            "note": "--note",
            "query": "--query",
            "text": "--text",
            "tags": "--tags",
            "subtasks": "--subtasks",  # validate --fail auto-atomize
            "force": None,   # boolean flag (add, status commands)
            "force_reason": "--force-reason",  # validate command: requires justification string
            "append": None,  # boolean flag (rpetd --append)
            "json_output": None,  # boolean flag
        }

        for key, flag in flag_map.items():
            if key not in body:
                continue
            val = body[key]

            if key == "force" and val:
                args.append("--force")
            elif key == "append" and val:
                args.append("--append")
            elif key == "json_output" and val:
                args.append("--json")
            elif flag and val is not None:
                args.append(flag)
                args.append(str(val))

        return args

    # ─── GET routes ──────────────────────────────────

    def do_GET(self):
        log.debug("request method=%s path=%s", self.command, self.path)
        if self.path not in ("/health", "/metrics", "/metrics/cache", "/cache/stats") and not _check_auth(self):
            return
        # OIDC validation (SSO-03: all endpoints except /health, /metrics)
        oidc_result = _check_oidc(self)
        if not oidc_result["valid"]:
            self._send_json({"error": oidc_result["error"]}, 401)
            return
        self._oidc_sub = oidc_result.get("sub", "anonymous")
        if not _rate_limiter.allow(self.path):
            log.warning("rate_limited path=%s", self.path)
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Too many requests. Try again later."}).encode())
            return
        if self.path == "/metrics":
            body = _metrics.expose().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        path = self.path.split("?")[0].rstrip("/")

        # ── GET /metrics/cache — Prompt cache performance (Phase 23 / CACHE-04) ──
        if path == "/metrics/cache":
            if _prompt_cache_metrics:
                self._send_json(_prompt_cache_metrics.stats())
            else:
                self._send_json({"error": "prompt_cache module not available"}, 503)
            return

        # ── GET /cache/stats — Semantic cache performance (Phase 24 / SEMANTIC-03) ──
        if path == "/cache/stats":
            try:
                from services.semantic_cache import _semantic_cache_manager
                if _semantic_cache_manager:
                    store = _get_store()
                    db_stats = store.semantic_cache_stats() if store and hasattr(store, "semantic_cache_stats") else {"entries": 0, "valid_entries": 0}
                    stats = _semantic_cache_manager.stats()
                    stats["entries"] = db_stats.get("valid_entries", 0)
                    self._send_json(stats)
                else:
                    self._send_json({"error": "semantic_cache module not available"}, 503)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/health":
            health = {
                "status": "ok",
                "daemon": "amauta-daemon",
                "port": PORT,
                "data_dir": DATA_DIR,
                "amauta_py": AMAUTA_PY,
                "pid": os.getpid(),
                "pg_available": _pg_store is not None,
                "backend": _infra_result.get("backend") if _infra_result else ("postgresql" if _pg_store else "file"),
                "features": _infra_result.get("features", []) if _infra_result else [],
                "rlm_managed": _rlm_enabled,
                "rlm_running": _check_rlm_health() if _rlm_enabled else False,
                "rlm_port": RLM_PORT if _rlm_enabled else None,
                "rlm_restarts": _rlm_restart_count,
                "redis_managed": _redis_enabled and _HAS_REDIS,
                "redis_running": _check_redis_health(),
                "redis_url": (
                    REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL
                ) if (_redis_enabled and _HAS_REDIS) else None,
                "redis_restarts": _redis_restart_count,
                "api_keys": {
                    k.lower(): {"set": v.get("set", False), "status": v.get("status", "unknown")}
                    for k, v in _validate_api_keys().items()
                    if "length" in v or not v.get("set")
                },
                "oidc_enabled": _oidc.is_enabled() if _oidc else False,
                "oidc_issuer": _oidc.issuer if _oidc and _oidc.is_enabled() else None,
            }
            if _pg_store:
                health["pg_health"] = _pg_store.health()
            elif _sqlite_store:
                health["sqlite_health"] = _sqlite_store.health()

            # INF-05: Pipeline status and data flow health
            service_errors = []
            # Check PG
            if _pg_store is None and _sqlite_store is None:
                service_errors.append("PostgreSQL: no database connection -- memory and task storage unavailable")
            # Check Redis
            if _redis_enabled and _HAS_REDIS and not _check_redis_health():
                service_errors.append("Redis: cache unreachable -- falling back to in-memory/file cache (slower)")
            # Check RLM
            if _rlm_enabled and not _check_rlm_health():
                service_errors.append("RLM: context engine not responding -- code search unavailable")
            # Check Voyage API key
            api_status = _validate_api_keys()
            if not api_status.get("VOYAGE_API_KEY", {}).get("set"):
                service_errors.append("Voyage API: key not set -- embeddings and semantic search disabled")
            # Check Perplexity API key
            if not api_status.get("PERPLEXITY_API_KEY", {}).get("set"):
                service_errors.append("Perplexity API: key not set -- web research disabled")

            # Compute pipeline status
            critical_down = _pg_store is None and _sqlite_store is None
            degraded = len(service_errors) > 0
            pipeline_status = "critical" if critical_down else ("degraded" if degraded else "healthy")

            health["pipeline_status"] = pipeline_status
            health["service_errors"] = service_errors

            # TOK-06: Cache hit/miss metrics
            cache_metrics = {}
            # Redis embedding cache stats
            if _redis_client and _check_redis_health():
                try:
                    info = _redis_client.info(section="stats")
                    cache_metrics["redis_keyspace_hits"] = info.get("keyspace_hits", 0)
                    cache_metrics["redis_keyspace_misses"] = info.get("keyspace_misses", 0)
                    total = cache_metrics["redis_keyspace_hits"] + cache_metrics["redis_keyspace_misses"]
                    cache_metrics["redis_hit_rate"] = round(cache_metrics["redis_keyspace_hits"] / total, 3) if total > 0 else 0.0
                except Exception:
                    cache_metrics["redis_stats"] = "unavailable"
            # RLM chunk cache stats (fetch from RLM /cache/stats)
            if _rlm_enabled and _check_rlm_health():
                try:
                    import urllib.request
                    req = urllib.request.urlopen(f"http://127.0.0.1:{RLM_PORT}/cache/stats", timeout=2)
                    if req.status == 200:
                        rlm_stats = json.loads(req.read().decode())
                        cache_metrics["rlm_cache_entries"] = rlm_stats.get("entries", 0)
                        cache_metrics["rlm_cache_hits"] = rlm_stats.get("hits", 0)
                        cache_metrics["rlm_cache_misses"] = rlm_stats.get("misses", 0)
                        cache_metrics["rlm_cache_hit_rate"] = rlm_stats.get("hit_rate", 0.0)
                except Exception:
                    cache_metrics["rlm_cache"] = "unavailable"
            # Prompt cache metrics (Phase 23 / CACHE-04)
            if _prompt_cache_metrics:
                prompt_stats = _prompt_cache_metrics.stats()
                cache_metrics["prompt_cache_hit_rate"] = prompt_stats.get("hit_rate", 0.0)
                cache_metrics["prompt_cache_tokens_saved"] = prompt_stats.get("total_tokens_saved", 0)
            health["cache_metrics"] = cache_metrics

            self._send_json(health)
            return

        if path == "/api/infra":
            infra = _infra_result or {
                "backend": "postgresql" if _pg_store else ("sqlite" if _sqlite_store else "file"),
                "features": [],
                "message": "Infrastructure detection not available",
            }
            # Add live counts
            store = _pg_store or _sqlite_store
            if store:
                try:
                    infra["memory_count"] = store.memory_count()
                except Exception:
                    infra["memory_count"] = -1
                try:
                    if hasattr(store, "task_count_by_status"):
                        infra["task_counts"] = store.task_count_by_status()
                except Exception:
                    pass
            self._send_json(infra)
            return

        if path == "/api/board":
            out, err, rc = self._run_amauta(["board"])
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        if path == "/api/stats":
            out, err, rc = self._run_amauta(["stats"])
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        if path.startswith("/api/show/"):
            item_id = path.split("/")[-1]
            out, err, rc = self._run_amauta(["show", item_id])
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        if path.startswith("/api/next/"):
            agent = path.split("/")[-1]
            out, err, rc = self._run_amauta(["next", agent, "--json"])
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        if path.startswith("/api/score/"):
            item_id = path.split("/")[-1]
            out, err, rc = self._run_amauta(["score", item_id])
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        if path == "/api/list" or path.startswith("/api/list?"):
            args = ["list"]
            # Parse query params
            if "?" in self.path:
                params = parse_qs(urlparse(self.path).query)
                if "type" in params:
                    args.extend(["--type", params["type"][0]])
                if "status" in params:
                    args.extend(["--status", params["status"][0]])
                if "agent" in params:
                    args.extend(["--agent", params["agent"][0]])
            out, err, rc = self._run_amauta(args)
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        # ─── Memory GET routes (PG or SQLite) ─────────
        if path == "/api/memory/list" or path.startswith("/api/memory/list?"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available", "hint": "Set GSD_POSTGRES_URL or enable SQLite"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            try:
                results = store.memory_list(
                    project_id=params.get("project_id", [None])[0],
                    source=params.get("source", [None])[0],
                    exclude_source=params.get("exclude_source", [None])[0],
                    limit=int(params.get("limit", ["50"])[0]),
                    offset=int(params.get("offset", ["0"])[0]),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/count":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                count = store.memory_count()
                self._send_json({"count": count})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/embedding-stats":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                stats = store.memory_embedding_stats()
                self._send_json(stats)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Memory Distill Status GET route ──────────
        if path == "/api/memory/distill-status":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                # MEM-01: exclude source='distilled' from total so threshold fires
                # on non-distilled content only. Previously source='distilled' entries
                # were counted, causing threshold to trigger late (distilled entries
                # are already processed and should not inflate the count).
                total = store.memory_count(exclude_source="distilled")
                source_counts = store.memory_count_by_source()
                threshold = int(os.environ.get("GSD_MEMORY_DISTILL_THRESHOLD", "500"))
                self._send_json({
                    "total": total,
                    "by_source": source_counts,
                    "distill_threshold": threshold,
                    "needs_distill": total >= threshold,
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Memory Tag Stats GET route ──────────────
        if path == "/api/memory/tag-stats":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                stats = store.memory_tag_stats()
                self._send_json(stats)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Embedding Coverage GET route ──────────────
        if path == "/api/memory/embedding-coverage":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                stats = store.memory_embedding_stats()
                self._send_json({
                    "total": stats.get("total", 0),
                    "with_embeddings": stats.get("with_embedding", 0),
                    "coverage_pct": stats.get("coverage_pct", 0),
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── SKB Candidates GET route (Phase 10 LEARN-05) ────────
        # GET /api/memory/skb-candidates?rising_min=5&needs_review_min=10&limit=100
        # Returns rising (5..9) + needs_review (>=10) applied_count buckets,
        # excluding entries already promoted (metadata.promoted_to_skb='true').
        if path == "/api/memory/skb-candidates":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'memory_skb_candidates'):
                self._send_json({"error": "skb-candidates not supported by this store"}, 501)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            try:
                rising_min = int(params.get("rising_min", ["5"])[0])
                needs_review_min = int(params.get("needs_review_min", ["10"])[0])
                limit = int(params.get("limit", ["100"])[0])
            except (ValueError, TypeError):
                self._send_json({"error": "Invalid query parameters"}, 400)
                return
            try:
                candidates = store.memory_skb_candidates(
                    rising_min=rising_min,
                    needs_review_min=needs_review_min,
                    limit=limit,
                )
                self._send_json({
                    "candidates": candidates,
                    "count": len(candidates),
                    "rising_min": rising_min,
                    "needs_review_min": needs_review_min,
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Agent Performance GET route (PG or SQLite) ──────
        if path.startswith("/api/agent-performance"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                import urllib.parse
                qs = urllib.parse.urlparse(self.path).query
                params = urllib.parse.parse_qs(qs)
                agent_id = params.get("agent_id", [""])[0]
                if not agent_id:
                    self._send_json({"error": "agent_id query param required"}, 400)
                    return
                summary = store.agent_performance_summary(agent_id)
                self._send_json(summary or {"total_tasks": 0, "agent_id": agent_id})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── SKB GET routes (PG or SQLite) ─────────────
        if path == "/api/skb/list" or path.startswith("/api/skb/list?"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            try:
                results = store.skb_list(
                    category=params.get("category", [None])[0],
                    limit=int(params.get("limit", ["50"])[0]),
                    offset=int(params.get("offset", ["0"])[0]),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Audit Log GET routes (PG or SQLite) ─────────
        if path == "/api/audit/query" or path.startswith("/api/audit/query?"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            try:
                results = store.audit_query(
                    task_id=params.get("task_id", [None])[0],
                    event_type=params.get("event_type", [None])[0],
                    start_date=params.get("start", [None])[0],
                    end_date=params.get("end", [None])[0],
                    limit=int(params.get("limit", ["100"])[0]),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/audit/export" or path.startswith("/api/audit/export?"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            fmt = params.get("format", ["json"])[0].lower()
            try:
                results = store.audit_query(
                    start_date=params.get("start", [None])[0],
                    end_date=params.get("end", [None])[0],
                    limit=int(params.get("limit", ["10000"])[0]),
                )
                if fmt == "csv":
                    import csv
                    import io
                    output = io.StringIO()
                    if results:
                        writer = csv.DictWriter(output, fieldnames=results[0].keys())
                        writer.writeheader()
                        for row in results:
                            # Flatten complex fields to JSON strings for CSV
                            flat = {}
                            for k, v in row.items():
                                flat[k] = json.dumps(v) if isinstance(v, (dict, list)) else v
                            writer.writerow(flat)
                    csv_text = output.getvalue()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv")
                    self.send_header("Content-Disposition", "attachment; filename=audit-export.csv")
                    self.end_headers()
                    self.wfile.write(csv_text.encode("utf-8"))
                else:
                    self._send_json({"results": results, "count": len(results), "format": "json"})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Validation GET routes (PG or SQLite) ──────
        if path.startswith("/api/validation/"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            task_id = path.split("/")[-1]
            try:
                results = store.validation_history(task_id)
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Backup GET routes (Phase 8: Data Durability) ──
        if path == "/api/backup/list":
            if not _backup_manager:
                self._send_json({"error": "Backup module not available"}, 503)
                return
            try:
                backups = _backup_manager.list_backups()
                self._send_json({"backups": backups, "count": len(backups)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/backup/verify" or path.startswith("/api/backup/verify?"):
            if not _backup_manager:
                self._send_json({"error": "Backup module not available"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            input_path = params.get("file", [None])[0]
            try:
                result = _backup_manager.verify(input_path)
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── RPETD Context GET route (Phase 20 HANDOFF-02) ────────────────────
        if path.startswith("/api/context/"):
            parts = path.split("/")
            # Expected: /api/context/<task_id>/<phase>
            # parts: ['', 'api', 'context', task_id, phase] — 5 elements
            if len(parts) == 5 and parts[4] in ('R', 'P', 'E', 'T', 'D'):
                ctx_task_id = parts[3]
                ctx_phase = parts[4]
                store = _get_store()
                if not store or not hasattr(store, 'rpetd_context_get'):
                    self._send_json({"error": "PG store not available for context retrieval"}, 503)
                    return
                try:
                    result = store.rpetd_context_get(ctx_task_id, ctx_phase)
                    if result:
                        self._send_json(result)
                    else:
                        self._send_json({"error": f"No context found for {ctx_task_id} phase {ctx_phase}"}, 404)
                except Exception as e:
                    self._send_json({"error": _safe_error(e)}, 500)
                return
            else:
                self._send_json({"error": "Invalid context path. Use /api/context/<task_id>/<phase> where phase is R, P, E, T, or D"}, 400)
                return

        # ─── Research Cache GET route (TOK-06: Redis-backed Perplexity cache) ──
        if path == "/api/research-cache" or path.startswith("/api/research-cache?"):
            from urllib.parse import urlparse as _urlparse, parse_qs as _parse_qs
            qs = _parse_qs(_urlparse(self.path).query)
            cache_key = qs.get("key", [None])[0]
            if not cache_key:
                self._send_json({"error": "missing key param"}, 400)
                return
            # Try Redis first
            if _redis_client and _check_redis_health():
                try:
                    raw = _redis_client.get(f"{REDIS_PERPLEXITY_PREFIX}{cache_key}")
                    if raw:
                        self._send_json({"hit": True, "data": json.loads(raw)})
                        return
                except Exception:
                    pass
            self._send_json({"hit": False}, 404)
            return

        # ─── Memory/SKB single-entry GET routes (Phase 10 LEARN-05) ─────────
        # GET /api/memory/mem-XXXX — fetch a single memory entry by ID.
        # Used by cmdSkbPromote to read metadata.promoted_to_skb + tags before
        # creating the SKB row. Path matches on the mem- prefix so it does not
        # clash with /api/memory/list, /api/memory/count, /api/memory/skb-candidates,
        # etc. Placed before the catch-all 404.
        if path.startswith("/api/memory/mem-"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'memory_get_by_id'):
                self._send_json({"error": "memory_get_by_id not supported by this store"}, 501)
                return
            mem_id = path[len("/api/memory/"):]
            try:
                entry = store.memory_get_by_id(mem_id)
                if entry is None:
                    self._send_json({"error": "memory not found"}, 404)
                    return
                self._send_json(entry)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # GET /api/skb/skb-XXXX — fetch a single SKB entry by ID.
        # Used by cmdSkbRemove to find the source_mem_id before deletion.
        if path.startswith("/api/skb/skb-"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'skb_get_by_id'):
                self._send_json({"error": "skb_get_by_id not supported by this store"}, 501)
                return
            skb_id = path[len("/api/skb/"):]
            try:
                entry = store.skb_get_by_id(skb_id)
                if entry is None:
                    self._send_json({"error": "skb not found"}, 404)
                    return
                self._send_json(entry)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # GET /api/circuit-breaker/{agent_name} — Read circuit breaker state (BEHAV-02)
        # Returns: {"state": "closed"|"open"|"half_open", "failures": N, "last_failure": ISO8601|null}
        # If key not found: returns {"state": "closed", "failures": 0, "last_failure": null}
        # gsd-executor-general: returns {"state": "exempt", "failures": 0}
        if path.startswith("/api/circuit-breaker/"):
            _CB_EXEMPT = {"gsd-executor-general", "executor-general"}
            agent_name = path[len("/api/circuit-breaker/"):]
            if not agent_name:
                self._send_json({"error": "agent_name required in path"}, 400)
                return
            if agent_name in _CB_EXEMPT:
                self._send_json({"state": "exempt", "failures": 0})
                return
            if not _redis_client or not _check_redis_health():
                self._send_json({"error": "valkey_unavailable"}, 503)
                return
            try:
                key = f"cb:{agent_name}"
                raw = _redis_client.get(key)
                if not raw:
                    self._send_json({"state": "closed", "failures": 0, "last_failure": None})
                    return
                state = json.loads(raw)
                self._send_json({
                    "state": state.get("state", "closed"),
                    "failures": state.get("failures", 0),
                    "last_failure": state.get("last_failure"),
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Blackboard GET routes (Phase 38 COMM-01, COMM-02) ───────────────────
        #
        # GET /api/findings/:task_id — retrieve all findings for a task, recency desc.
        # GET /api/messages/:agent_name — retrieve pending/approved messages for an agent.

        if path.startswith("/api/findings/"):
            task_id = path[len("/api/findings/"):]
            if not task_id:
                self._send_json({"error": "task_id required in path"}, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, agent_name, task_id, finding_type, content, confidence, created_at"
                        " FROM agent_findings WHERE task_id = %s ORDER BY created_at DESC",
                        (task_id,),
                    )
                    rows = cur.fetchall()
                results = [
                    {
                        "id": str(r[0]),
                        "agent_name": r[1],
                        "task_id": r[2],
                        "finding_type": r[3],
                        "content": r[4],
                        "confidence": r[5],
                        "created_at": r[6].isoformat() if r[6] else None,
                    }
                    for r in rows
                ]
                self._send_json({"findings": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path.startswith("/api/messages/"):
            agent_name = path[len("/api/messages/"):]
            if not agent_name:
                self._send_json({"error": "agent_name required in path"}, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, from_agent, to_agent, task_id, message_type, content,"
                        " response, status, operator_approved, created_at, responded_at"
                        " FROM agent_messages"
                        " WHERE to_agent = %s AND status IN ('pending', 'approved')"
                        " ORDER BY created_at ASC",
                        (agent_name,),
                    )
                    rows = cur.fetchall()
                messages = [
                    {
                        "id": str(r[0]),
                        "from_agent": r[1],
                        "to_agent": r[2],
                        "task_id": r[3],
                        "message_type": r[4],
                        "content": r[5],
                        "response": r[6],
                        "status": r[7],
                        "operator_approved": r[8],
                        "created_at": r[9].isoformat() if r[9] else None,
                        "responded_at": r[10].isoformat() if r[10] else None,
                    }
                    for r in rows
                ]
                self._send_json({"messages": messages, "count": len(messages)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Agent Metrics GET routes (Phase 39 LIFE-02) ────────────────────────
        #
        # GET /api/metrics/stats — return per-agent aggregated execution stats.

        if path == "/api/metrics/stats":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT agent_name,"
                        " COUNT(*) AS tasks_completed,"
                        " AVG(completion_time_ms)::int AS avg_time_ms,"
                        " AVG(token_usage)::int AS avg_tokens,"
                        " (SUM(error_count)::float / NULLIF(COUNT(*), 0)) AS error_rate,"
                        " (COUNT(*) FILTER (WHERE outcome = 'pass')::float / NULLIF(COUNT(*), 0)) AS pass_rate"
                        " FROM agent_metrics"
                        " GROUP BY agent_name"
                        " ORDER BY agent_name"
                    )
                    rows = cur.fetchall()
                stats = [
                    {
                        "agent_name": r[0],
                        "tasks_completed": r[1],
                        "avg_time_ms": r[2],
                        "avg_tokens": r[3],
                        "error_rate": float(r[4]) if r[4] is not None else None,
                        "pass_rate": float(r[5]) if r[5] is not None else None,
                    }
                    for r in rows
                ]
                self._send_json({"stats": stats, "count": len(stats)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Step Handoffs GET routes (Phase 41 SHARD-04) ────────────────────────
        #
        # GET /api/steps/:workflow/:phase — return current step state for a workflow+phase.

        if path.startswith("/api/steps/"):
            parts = path[len("/api/steps/"):].strip("/").split("/")
            if len(parts) < 2:
                self._send_json({"error": "Usage: /api/steps/:workflow/:phase"}, 400)
                return
            workflow_name = parts[0]
            try:
                phase_number = int(parts[1])
            except ValueError:
                self._send_json({"error": "phase must be integer"}, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, workflow_name, step_id, task_id, phase_number,"
                        " completed_steps, context_snapshot, artifacts, decisions,"
                        " user_inputs, next_step, escalation_flags, created_at"
                        " FROM step_handoffs"
                        " WHERE workflow_name = %s AND phase_number = %s"
                        " ORDER BY created_at DESC LIMIT 1",
                        (workflow_name, phase_number),
                    )
                    row = cur.fetchone()
                if row:
                    import json as _json
                    result = {
                        "id": str(row[0]),
                        "workflow_name": row[1],
                        "step_id": row[2],
                        "task_id": row[3],
                        "phase_number": row[4],
                        "completed_steps": row[5] or [],
                        "context_snapshot": row[6] or {},
                        "artifacts": row[7] or {},
                        "decisions": row[8] or [],
                        "user_inputs": row[9] or [],
                        "next_step": row[10],
                        "escalation_flags": row[11] or [],
                        "created_at": row[12].isoformat() if row[12] else None,
                    }
                    self._send_json(result)
                else:
                    self._send_json({"step_id": None, "message": "No handoff found"})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        self._send_json({"error": f"Unknown GET route: {path}"}, 404)

    # ─── POST routes ─────────────────────────────────

    def do_POST(self):
        log.debug("request method=%s path=%s", self.command, self.path)
        if not _check_auth(self):
            return
        # OIDC validation (SSO-03: all POST endpoints require valid token)
        oidc_result = _check_oidc(self)
        if not oidc_result["valid"]:
            self._send_json({"error": oidc_result["error"]}, 401)
            return
        self._oidc_sub = oidc_result.get("sub", "anonymous")
        if not _rate_limiter.allow(self.path):
            log.warning("rate_limited path=%s", self.path)
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Too many requests. Try again later."}).encode())
            return
        path = self.path.rstrip("/")
        body = self._read_body()
        if body is None:
            return

        # ── POST /metrics/cache/record — Accept cache telemetry (Phase 23 / CACHE-04) ──
        if path == "/metrics/cache/record":
            cache_read = body.get("cache_read_input_tokens", 0)
            cache_creation = body.get("cache_creation_input_tokens", 0)
            if _prompt_cache_metrics:
                _prompt_cache_metrics.record(
                    cache_read_input_tokens=int(cache_read),
                    cache_creation_input_tokens=int(cache_creation),
                )
                self._send_json({"recorded": True, "stats": _prompt_cache_metrics.stats()})
            else:
                self._send_json({"error": "prompt_cache module not available"}, 503)
            return

        # ─── Research Cache POST route (TOK-06: Store Perplexity response in Redis) ─
        if path == "/api/research-cache":
            if not _redis_client or not _check_redis_health():
                self._send_json({"stored": False, "reason": "redis_unavailable"})
                return
            try:
                cache_key = body.get("key")
                data = body.get("data")
                ttl = body.get("ttl", REDIS_PERPLEXITY_TTL)
                if not cache_key or data is None:
                    self._send_json({"error": "missing key or data"}, 400)
                    return
                _redis_client.setex(
                    f"{REDIS_PERPLEXITY_PREFIX}{cache_key}",
                    int(ttl),
                    json.dumps(data),
                )
                self._send_json({"stored": True, "key": cache_key, "ttl": ttl})
            except Exception as e:
                self._send_json({"stored": False, "reason": str(e)})
            return

        # ── POST /api/semantic-cache/search — Semantic cache lookup (Phase 24 / SEMANTIC-01) ──
        if path == "/api/semantic-cache/search":
            query = body.get("query", "")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                from services.semantic_cache import _semantic_cache_manager
                store = _get_store()
                if not store or not _semantic_cache_manager:
                    self._send_json({"hit": False, "reason": "cache_unavailable"})
                    return
                result = _semantic_cache_manager.lookup(query, store)
                if result:
                    self._send_json({"hit": True, "data": result})
                else:
                    self._send_json({"hit": False})
            except Exception as e:
                self._send_json({"hit": False, "error": str(e)})
            return

        # ── POST /api/semantic-cache/store — Store response in semantic cache (Phase 24 / SEMANTIC-01) ──
        if path == "/api/semantic-cache/store":
            query = body.get("query", "")
            response_text = body.get("response", "")
            response_tokens = body.get("response_tokens", 0)
            source_file_hashes = body.get("source_file_hashes", {})
            provider = body.get("provider", "perplexity")
            if not query or not response_text:
                self._send_json({"error": "query and response are required"}, 400)
                return
            try:
                from services.semantic_cache import _semantic_cache_manager
                store = _get_store()
                if not store or not _semantic_cache_manager:
                    self._send_json({"stored": False, "reason": "cache_unavailable"})
                    return
                entry_id = _semantic_cache_manager.store(
                    query, response_text, response_tokens,
                    source_file_hashes, store, provider
                )
                self._send_json({"stored": entry_id is not None, "id": entry_id})
            except Exception as e:
                self._send_json({"stored": False, "error": str(e)})
            return

        # Generic command executor — limited to safe read/query operations
        # (destructive operations like delete/atomize must use specific routes)
        _EXEC_ALLOWLIST = {
            "show", "list", "board", "search", "score", "next", "health",
            "note", "rpetd", "validate", "status", "claim", "add", "assign",
            "link", "unlink", "update", "archive", "reconcile",
        }
        if path == "/api/exec":
            args = body.get("args", [])
            if not args:
                self._send_json({"error": "args required"}, 400)
                return
            command = args[0] if args else ""
            if command not in _EXEC_ALLOWLIST:
                self._send_json(
                    {"error": f"Command '{command}' not allowed via /api/exec. Use specific endpoint."},
                    403,
                )
                return
            out, err, rc = self._run_amauta(args)
            if rc != 0:
                _metrics.inc("amauta_exec_errors_total", {"command": args[0] if args else "unknown"})
            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        # Specific command routes
        command_map = {
            "/api/add": "add",
            "/api/claim": "claim",
            "/api/rpetd": "rpetd",
            "/api/status": "status",
            "/api/validate": "validate",
            "/api/note": "note",
            "/api/assign": "assign",
            "/api/link": "link",
            "/api/unlink": "unlink",
            "/api/search": "search",
            "/api/atomize": "atomize",
            "/api/update": "update",
            "/api/delete": "delete",
            "/api/archive": "archive",
            "/api/reconcile": "reconcile",
        }

        if path in command_map:
            command = command_map[path]
            args = self._build_args(command, body)

            # Special handling for status command — status_to is a POSITIONAL arg
            # amauta.py: st.add_argument("id"); st.add_argument("status", choices=STATUSES)
            # It must come IMMEDIATELY after id (before any --flags), so we insert it at position 2
            if command == "status" and "status_to" in body:
                # args is currently ["status", "<id>", ...flags...]
                # Insert status_to at index 2 (after command + id, before flags)
                args.insert(2, body["status_to"])

            # Special handling for search command — query is a POSITIONAL arg in amauta.py
            # amauta.py: sr.add_argument("query") — positional, NOT --query
            # _build_args sends "query" → "--query" (from flag_map) which argparse rejects.
            # Rebuild as: ["search", "<query_value>"] with any remaining non-query flags appended.
            if command == "search" and "--query" in args:
                query_idx = args.index("--query")
                query_val = args[query_idx + 1] if query_idx + 1 < len(args) else ""
                # Remove the --query flag+value from args
                del args[query_idx:query_idx + 2]
                # Insert query_val as the first positional arg right after "search"
                args.insert(1, query_val)  # args is now ["search", "<query>", ...remaining-flags...]

            # Special handling for validate --pass/--fail
            # Note: --force is handled by _build_args() via flag_map
            if command == "validate":
                if body.get("pass_result") is True:
                    args.append("--pass")
                elif body.get("pass_result") is False:
                    args.append("--fail")

            # Special handling for archive command — no task ID, optional --days
            if command == "archive":
                args = ["archive"]
                if body.get("days"):
                    args.extend(["--days", str(body["days"])])

            # Special handling for reconcile command — no task ID, optional --fix
            if command == "reconcile":
                args = ["reconcile"]
                if body.get("fix") is True:
                    args.append("--fix")

            out, err, rc = self._run_amauta(args)

            # ── RLM context enrichment for claim commands ──
            if command == "claim" and rc == 0 and _rlm_enabled:
                out = _enrich_with_rlm(out, body)

            _pg_sync_warning = ""

            # ── Dual-write: mirror task mutations to PG (best-effort) ──
            # After amauta.py writes to tasks.json, mirror the affected task to gsd_tasks.
            # Only for commands that mutate tasks; read commands (show, list, search) skip this.
            _TASK_MUTATING_COMMANDS = {"add", "claim", "rpetd", "status", "validate",
                                       "assign", "note", "update", "delete", "link", "unlink", "atomize",
                                       "archive", "reconcile"}
            _mirror_store = _get_store()
            if _mirror_store and rc == 0 and command in _TASK_MUTATING_COMMANDS:
                try:
                    task_id = body.get("id") or ""
                    # For add, extract the new task ID from output
                    if command == "add" and not task_id:
                        import re as _re
                        m = _re.search(r"(TK|EP|ST|BG)-\d+", out)
                        task_id = m.group(0) if m else ""
                    if command == "delete" and task_id:
                        _mirror_store.task_delete(task_id)
                    elif command == "archive":
                        # Archive moves tasks OUT of tasks.json -- delete them from PG mirror.
                        # task_id may be empty for bulk archive; extract archived IDs from output.
                        import re as _re
                        _archived_ids = _re.findall(r"(TK|EP|ST|BG)-\d+", out)
                        for _aid in _archived_ids:
                            try:
                                _mirror_store.task_delete(_aid)
                            except Exception:
                                pass  # Best-effort per-task deletion
                    elif task_id:
                        # Re-read the task from tasks.json via show --json to get current state
                        show_out, _, show_rc = self._run_amauta(["show", task_id, "--json"])
                        if show_rc == 0 and show_out.strip():
                            import json as _json
                            item = _json.loads(show_out)
                            _mirror_store.task_upsert(item)
                except Exception as _pg_err:
                    _pg_sync_warning = f"\n[PG_SYNC_WARN] PG mirror failed for {body.get('id', '?')}: {_safe_error(_pg_err)}"
                    log.warning("store_mirror_failed task_id=%s error=%s", body.get("id", "?"), _safe_error(_pg_err))

            self._send_json({"output": out + _pg_sync_warning, "error": err, "exit_code": rc})
            return

        # ─── Memory POST routes (PG or SQLite) ────────
        if path == "/api/memory/store":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available", "hint": "Set GSD_POSTGRES_URL or enable SQLite"}, 503)
                return
            text = body.get("text")
            if not text:
                self._send_json({"error": "text is required"}, 400)
                return
            # DATA-05/DATA-06: Auto-set project_id from CWD or test mode
            project_id = self._resolve_project_id(body)
            try:
                # Auto-embed if an embedding API key is set and body doesn't opt out
                use_embedding = body.get("embed", True) and (
                    os.environ.get("VOYAGE_API_KEY") or os.environ.get("OPENAI_API_KEY")
                )
                if use_embedding and hasattr(store, 'memory_store_with_embedding'):
                    mem_id = store.memory_store_with_embedding(
                        text=text,
                        source=body.get("source", "agent"),
                        agent_id=body.get("agent_id"),
                        tags=body.get("tags"),
                        metadata=body.get("metadata"),
                        project_id=project_id,
                    )
                    # DATA-04: Handle dedup response from pre-store similarity check
                    if isinstance(mem_id, dict) and mem_id.get("dedup_skipped"):
                        self._send_json({
                            "stored": False,
                            "dedup_skipped": True,
                            "existing_id": mem_id["existing_id"],
                            "similarity": mem_id["similarity"],
                        })
                        return
                else:
                    mem_id = store.memory_store(
                        text=text,
                        source=body.get("source", "agent"),
                        agent_id=body.get("agent_id"),
                        tags=body.get("tags"),
                        metadata=body.get("metadata"),
                        project_id=project_id,
                    )
                self._send_json({"id": mem_id, "stored": True, "embedded": bool(use_embedding and _pg_store), "project_id": project_id})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/search":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            # DATA-05/DATA-06: Use same project_id resolution as store to ensure
            # consistent routing (test mode forces __test__, CWD fallback otherwise)
            project_id = self._resolve_project_id(body)
            try:
                kwargs = dict(
                    query=query,
                    project_id=project_id,
                    source=body.get("source"),
                    limit=body.get("limit", 20),
                )
                # MEM-01: include_noise=true bypasses default source exclusion
                if body.get("include_noise"):
                    kwargs["exclude_sources"] = None
                # Phase 10 LEARN-03: forward --tags and --category filter kwargs
                # through to pg_store.memory_search. Accept either a list or a
                # comma-separated string on the wire (parse_qs returns lists;
                # JSON clients may send either).
                tags_param = body.get("tags")
                if tags_param:
                    if isinstance(tags_param, list):
                        kwargs["tags"] = tags_param
                    elif isinstance(tags_param, str):
                        kwargs["tags"] = [t.strip() for t in tags_param.split(",") if t.strip()]
                category_param = body.get("category")
                if category_param:
                    kwargs["category"] = category_param
                results = store.memory_search(**kwargs)
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/delete":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            mem_id = body.get("id")
            if not mem_id:
                self._send_json({"error": "id is required"}, 400)
                return
            try:
                store.memory_delete(mem_id)
                self._send_json({"deleted": True, "id": mem_id})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/semantic-search":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available", "hint": "Set GSD_POSTGRES_URL or enable SQLite"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            # DATA-05/DATA-06: Use same project_id resolution as store
            project_id = self._resolve_project_id(body)
            try:
                kwargs = dict(
                    query=query,
                    project_id=project_id,
                    source=body.get("source"),
                    limit=body.get("limit", 20),
                )
                # MEM-01: include_noise=true bypasses default source exclusion
                if body.get("include_noise"):
                    kwargs["exclude_sources"] = None
                results, method = store.memory_semantic_search(**kwargs)
                self._send_json({"results": results, "count": len(results), "method": method})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/backfill-embeddings":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available", "hint": "Set GSD_POSTGRES_URL"}, 503)
                return
            try:
                result = store.memory_backfill_embeddings(
                    batch_size=body.get("batch_size", 50),
                )
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/memory/cross-project":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available", "hint": "Set GSD_POSTGRES_URL or enable SQLite"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                results = store.memory_cross_project_search(
                    query=query,
                    tags=body.get("tags"),
                    exclude_project=body.get("exclude_project"),
                    limit=body.get("limit", 20),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Auto-capture POST route (session learning) ──
        if path == "/api/memory/auto-capture":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            context = body.get("context")
            if not context:
                self._send_json({"error": "context is required"}, 400)
                return
            try:
                agent_id = body.get("agent_id", "unknown")
                # DATA-05/DATA-06: Auto-set project_id from CWD or test mode
                project_id = self._resolve_project_id(body)
                tags = body.get("tags", [])
                # Truncate oversized context to 4000 chars
                text = context[:4000] if len(context) > 4000 else context
                mem_id = store.memory_store(
                    text=text,
                    source="session-learning",
                    agent_id=agent_id,
                    tags=tags,
                    metadata={"auto_captured": True, "capture_reason": body.get("reason", "context_compaction")},
                    project_id=project_id,
                )
                self._send_json({"id": mem_id, "stored": True, "source": "session-learning", "chars": len(text), "project_id": project_id})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Memory Retention Cleanup POST route (MEM-02) ────────
        if path == "/api/memory/retention-cleanup":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'memory_retention_cleanup'):
                self._send_json({"error": "Retention cleanup not supported by this store"}, 501)
                return
            try:
                result = store.memory_retention_cleanup()
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Memory Increment Applied POST route (Phase 10 LEARN-05) ────────
        # POST /api/memory/<mem_id>/increment-applied
        # Body: {"task_id": "TK-XXXX", "phase": "E"?, "reason": "..."?}
        # Deduped by (mem_id, task_id) — repeat citations from the same task
        # are idempotent. Returns {incremented, already_cited, applied_count}.
        if path.startswith("/api/memory/") and path.endswith("/increment-applied"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'memory_increment_applied'):
                self._send_json({"error": "increment-applied not supported by this store"}, 501)
                return
            mem_id = path[len("/api/memory/"):-len("/increment-applied")]
            if not mem_id:
                self._send_json({"error": "memory id required in path"}, 400)
                return
            task_id = body.get("task_id")
            if not task_id:
                self._send_json({"error": "task_id is required"}, 400)
                return
            try:
                result = store.memory_increment_applied(
                    mem_id=mem_id,
                    task_id=task_id,
                    phase=body.get("phase"),
                    reason=body.get("reason"),
                )
                # Map result to HTTP status:
                #   incremented=True  → 200 (fresh citation)
                #   already_cited=True → 200 (idempotent no-op, not an error)
                #   error='memory not found' → 404
                #   other error → 500
                if result.get("incremented") or result.get("already_cited"):
                    self._send_json(result, 200)
                elif result.get("error") == "memory not found":
                    self._send_json(result, 404)
                else:
                    self._send_json(result, 500)
            except ValueError as ve:
                self._send_json({"error": str(ve)}, 400)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Audit Log POST route (PG or SQLite) ────────
        if path == "/api/audit/log":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            task_id = body.get("task_id")
            event_type = body.get("event_type")
            if not task_id or not event_type:
                self._send_json({"error": "task_id and event_type are required"}, 400)
                return
            try:
                row_id = store.audit_log(
                    task_id=task_id,
                    event_type=event_type,
                    agent_id=body.get("agent_id"),
                    actor=body.get("actor") or self._oidc_sub or None,
                    phase=body.get("phase"),
                    status=body.get("status"),
                    gate_results=body.get("gate_results"),
                    content=body.get("content"),
                    metadata=body.get("metadata"),
                )
                self._send_json({"id": row_id, "logged": True})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── SKB POST routes (PG or SQLite) ────────────
        if path == "/api/skb/store":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            title = body.get("title")
            content = body.get("content")
            if not title or not content:
                self._send_json({"error": "title and content are required"}, 400)
                return
            try:
                skb_id = store.skb_store(
                    title=title,
                    content=content,
                    category=body.get("category"),
                    agent_id=body.get("agent_id"),
                    tags=body.get("tags"),
                    importance=body.get("importance", 5),
                    source_task=body.get("source_task"),
                )
                self._send_json({"id": skb_id, "stored": True})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/skb/search":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                results = store.skb_search(
                    query=query,
                    category=body.get("category"),
                    limit=body.get("limit", 20),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Validation POST route (PG or SQLite) ──────
        if path == "/api/validation/record":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            task_id = body.get("task_id")
            validator_id = body.get("validator_id")
            status_val = body.get("status")
            if not all([task_id, validator_id, status_val]):
                self._send_json({"error": "task_id, validator_id, and status are required"}, 400)
                return
            try:
                vid = store.validation_record(
                    task_id=task_id,
                    validator_id=validator_id,
                    status=status_val,
                    evidence=body.get("evidence"),
                    rejection_reason=body.get("rejection_reason"),
                )
                self._send_json({"id": vid, "recorded": True})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Agent Performance POST route (PG or SQLite) ──────
        if path == "/api/agent-performance":
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            _ap_agent = body.get("agent_id", "")
            _ap_task = body.get("task_id", "")
            if not _ap_agent or not _ap_task:
                self._send_json({"error": "agent_id and task_id are required"}, 400)
                return
            try:
                store.record_agent_performance(
                    agent_id=_ap_agent,
                    task_id=_ap_task,
                    outcome=body.get("outcome", "pass"),
                    task_type=body.get("task_type", "task"),
                    project_id=body.get("project_id", "default"),
                    gate_failed=body.get("gate_failed"),
                    failure_reason=body.get("failure_reason"),
                    duration_minutes=body.get("duration_minutes"),
                    learning_captured=body.get("learning_captured"),
                )
                self._send_json({"recorded": True})
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Backup POST routes (Phase 8: Data Durability) ──
        if path == "/api/backup/create":
            if not _backup_manager:
                self._send_json({"error": "Backup module not available"}, 503)
                return
            try:
                output_path = body.get("output_path") if body else None
                path_result, counts, checksum = _backup_manager.create(output_path)
                self._send_json({
                    "path": path_result,
                    "counts": counts,
                    "checksum": checksum,
                    "created": True,
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/backup/restore":
            if not _backup_manager:
                self._send_json({"error": "Backup module not available"}, 503)
                return
            input_path = body.get("file") if body else None
            if not input_path:
                self._send_json({"error": "file is required"}, 400)
                return
            mode = body.get("mode", "merge")
            if mode not in ("merge", "replace"):
                self._send_json({"error": "mode must be 'merge' or 'replace'"}, 400)
                return
            try:
                result = _backup_manager.restore(input_path, mode)
                self._send_json(result)
            except FileNotFoundError as e:
                self._send_json({"error": str(e)}, 404)
            except ValueError as e:
                self._send_json({"error": str(e)}, 422)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── RPETD Context Compact route (Phase 20 HANDOFF-02/04) ───────────
        if path == "/api/context/compact":
            messages = body.get("messages")
            ctx_task_id = body.get("task_id")
            ctx_phase = body.get("phase", "R")

            if not messages or not isinstance(messages, list):
                self._send_json({"error": "messages (list) is required"}, 400)
                return
            if not ctx_task_id:
                self._send_json({"error": "task_id is required"}, 400)
                return

            ctx_phase = ctx_phase.upper()
            if ctx_phase not in ('R', 'P', 'E', 'T', 'D'):
                self._send_json({"error": f"Invalid phase: {ctx_phase}. Must be R, P, E, T, or D"}, 400)
                return

            try:
                from services.rpetd_context import compact_conversation

                # Compaction uses no LLM call in v1 — fallback extraction only.
                # LLM-backed compaction will be wired when model routing is available (Phase 24 ROUTE-02).
                context = compact_conversation(
                    messages=messages,
                    task_id=ctx_task_id,
                    phase=ctx_phase,
                    llm_call=_make_compaction_llm_call(),  # Phase 24 ROUTE-02: model_routing.compaction
                )
                compiled_view = context.to_compiled_view()

                # Compute file hashes for staleness detection (Phase 21 STALE-01)
                ctx_file_hashes = {}
                try:
                    from services.context_validator import ContextValidator
                    relevant = context.relevant_files if hasattr(context, 'relevant_files') else []
                    if relevant:
                        ctx_file_hashes = ContextValidator.compute_file_hashes(relevant)
                        # Embed commit ref for next cycle's changed_since
                        commit_ref = ContextValidator.get_current_commit()
                        if commit_ref:
                            ctx_file_hashes["__commit_ref__"] = commit_ref
                except Exception as e:
                    log.warning("file_hash_computation_failed error=%s", str(e)[:200])

                # Store to PG if available
                store = _get_store()
                stored_id = None
                if store and hasattr(store, 'rpetd_context_store'):
                    stored_id = store.rpetd_context_store(
                        task_id=ctx_task_id,
                        phase=ctx_phase,
                        compiled_view=compiled_view,
                        context_version=context.context_version,
                        file_hashes=ctx_file_hashes,
                    )

                self._send_json({
                    "compiled_view": compiled_view,
                    "context_version": context.context_version,
                    "stored": stored_id is not None,
                    "stored_id": stored_id,
                })
            except Exception as e:
                log.error(f"Context compaction failed: {e}")
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── RPETD Context Validate route (Phase 21 STALE-04) ─────────────
        if path == "/api/context/validate":
            ctx_task_id = body.get("task_id")
            ctx_phase = body.get("phase", "R")
            ctx_project_dir = body.get("project_dir", ".")

            if not ctx_task_id:
                self._send_json({"error": "task_id is required"}, 400)
                return

            ctx_phase = ctx_phase.upper()
            if ctx_phase not in ('R', 'P', 'E', 'T', 'D'):
                self._send_json({"error": f"Invalid phase: {ctx_phase}. Must be R, P, E, T, or D"}, 400)
                return

            try:
                from services.context_validator import validate_context

                # Phase 22 CAVE-01: wire caveman description generator
                cave_description_fn = None
                try:
                    from services.caveman_descriptions import generate_caveman_description
                    cave_description_fn = generate_caveman_description
                except ImportError:
                    log.warning("caveman_descriptions not available — descriptions disabled")

                store = _get_store()
                result = validate_context(
                    task_id=ctx_task_id,
                    phase=ctx_phase,
                    project_dir=ctx_project_dir,
                    pg_store=store,
                    description_fn=cave_description_fn,
                )

                # If we got updated hashes, store them back for next phase
                if result.get("had_prior_context") and result.get("file_hashes"):
                    if store and hasattr(store, 'rpetd_context_store'):
                        # Store updated hashes with commit_ref embedded
                        hashes_with_ref = dict(result["file_hashes"])
                        if result.get("commit_ref"):
                            hashes_with_ref["__commit_ref__"] = result["commit_ref"]
                        store.rpetd_context_store(
                            task_id=ctx_task_id,
                            phase=ctx_phase,
                            compiled_view={"file_descriptions": result.get("file_descriptions", {})},
                            file_hashes=hashes_with_ref,
                        )

                self._send_json({
                    "changed_files": result.get("changed_files", []),
                    "refreshed_count": result.get("refreshed_count", 0),
                    "cached_count": result.get("cached_count", 0),
                    "file_hashes": result.get("file_hashes", {}),
                    "commit_ref": result.get("commit_ref", ""),
                    "had_prior_context": result.get("had_prior_context", False),
                })
            except Exception as e:
                log.error("Context validation failed: %s", str(e))
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ── POST /api/circuit-breaker/record — Record agent task outcome (BEHAV-02) ──
        # Body: {"agent_name": "gsd-executor-backend", "outcome": "success"|"failure"}
        # Writes cb:{agent_name} key to Valkey.
        # Returns: {"agent_name": str, "outcome": str, "new_state": str, "failures": int}
        # gsd-executor-general: returns {"exempt": true} with 200.
        if path == "/api/circuit-breaker/record":
            _CB_EXEMPT = {"gsd-executor-general", "executor-general"}
            agent_name = body.get("agent_name", "")
            outcome = body.get("outcome", "")
            if not agent_name or outcome not in ("success", "failure"):
                self._send_json({"error": "agent_name and outcome (success|failure) required"}, 400)
                return
            if agent_name in _CB_EXEMPT:
                self._send_json({"exempt": True}, 200)
                return
            if not _redis_client or not _check_redis_health():
                self._send_json({"error": "valkey_unavailable"}, 503)
                return
            try:
                key = f"cb:{agent_name}"
                raw = _redis_client.get(key)
                current = json.loads(raw) if raw else {"state": "closed", "failures": 0, "last_failure": None}
                CB_FAILURE_THRESHOLD = 3
                if outcome == "success":
                    next_state = {"state": "closed", "failures": 0, "last_failure": current.get("last_failure")}
                else:
                    new_failures = (current.get("failures") or 0) + 1
                    next_state = {
                        "state": "open" if new_failures >= CB_FAILURE_THRESHOLD else "closed",
                        "failures": new_failures,
                        "last_failure": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                    }
                _redis_client.set(key, json.dumps(next_state))
                self._send_json({
                    "agent_name": agent_name,
                    "outcome": outcome,
                    "new_state": next_state["state"],
                    "failures": next_state["failures"],
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Step Handoffs POST routes (Phase 41 SHARD-04) ───────────────────────
        #
        # POST /api/steps/:workflow/:phase/handoff — save a step handoff.

        if path.startswith("/api/steps/") and path.endswith("/handoff"):
            inner = path[len("/api/steps/"):]
            # Strip trailing /handoff
            inner = inner[: inner.rfind("/handoff")]
            parts = inner.strip("/").split("/")
            if len(parts) < 2:
                self._send_json({"error": "Usage: /api/steps/:workflow/:phase/handoff"}, 400)
                return
            workflow_name = parts[0]
            try:
                phase_number = int(parts[1])
            except ValueError:
                self._send_json({"error": "phase must be integer"}, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                import json as _json
                body_data = _json.loads(self._read_body())
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO step_handoffs"
                        " (workflow_name, step_id, task_id, phase_number,"
                        "  completed_steps, context_snapshot, artifacts,"
                        "  decisions, user_inputs, next_step, escalation_flags)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
                        " RETURNING id, created_at",
                        (
                            workflow_name,
                            body_data.get("step_id", ""),
                            body_data.get("task_id", ""),
                            phase_number,
                            body_data.get("completed_steps", []),
                            _json.dumps(body_data.get("context_snapshot", {})),
                            _json.dumps(body_data.get("artifacts", {})),
                            _json.dumps(body_data.get("decisions", [])),
                            _json.dumps(body_data.get("user_inputs", [])),
                            body_data.get("next_step"),
                            body_data.get("escalation_flags", []),
                        ),
                    )
                    row = cur.fetchone()
                    conn.commit()
                self._send_json({"id": str(row[0]), "created_at": row[1].isoformat()}, 201)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Complexity Score POST routes (Phase 42 SCALE-01, SCALE-02) ──────────
        #
        # POST /api/complexity/score  — compute score + select phases, applying 4-layer override.
        # POST /api/complexity/complete — write task_completions row at workflow close.

        if path == "/api/complexity/score":
            try:
                # ── 0. Import scorer ──────────────────────────────────────────────
                import sys as _sys
                _svc_dir = os.path.dirname(os.path.abspath(__file__))
                if _svc_dir not in _sys.path:
                    _sys.path.insert(0, _svc_dir)
                import complexity_scorer as _cs

                # ── 1. Load .planning/config.json ────────────────────────────────
                _config_path = os.path.join(
                    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    ".planning", "config.json",
                )
                try:
                    with open(_config_path, "r", encoding="utf-8") as _fh:
                        _cfg = json.load(_fh)
                except Exception as _ce:
                    log.warning("/api/complexity/score: could not load config.json: %s", _ce)
                    _cfg = {}

                # ── 2. 4-layer override precedence: env > pin > project > auto ───
                _plan_path = body.get("plan_path") or ""
                _task_id   = body.get("task_id") or ""
                _phase_num = body.get("phase_number") or 0
                _wf_name   = body.get("workflow_name") or "execute-phase"
                _task_meta = body.get("task_meta") or {}

                # Layer 1 — env (set by gsd-amauta.cjs --force-phases)
                _env_phases_raw = os.environ.get("GSD_FORCE_PHASES", "").strip()
                _env_phases = [p.strip().upper() for p in _env_phases_raw.split(",") if p.strip()] if _env_phases_raw else []

                # Layer 2 — per-task pin (pinned_phases:<SET> note in amauta.py)
                _pin_phases = []
                if _task_id:
                    try:
                        _show_out, _, _show_rc = self._run_amauta(["show", _task_id, "--json"])
                        if _show_rc == 0:
                            _show_data = json.loads(_show_out)
                            _notes = _show_data.get("notes", [])
                            # Look for last pinned_phases note (most recent wins)
                            for _note in reversed(_notes):
                                _nc = _note.get("content", "")
                                if _nc.startswith("pinned_phases:"):
                                    _pin_raw = _nc[len("pinned_phases:"):].strip()
                                    if _pin_raw and _pin_raw != "CLEARED":
                                        _pin_phases = [p.strip().upper() for p in _pin_raw.split(",") if p.strip()]
                                    break
                    except Exception as _pe:
                        log.warning("/api/complexity/score: failed to read pinned_phases for %s: %s", _task_id, _pe)

                # Layer 3 — project config .planning/config.json workflow.force_phases
                _proj_phases_raw = (_cfg.get("workflow") or {}).get("force_phases") or ""
                _proj_phases = []
                if _proj_phases_raw and isinstance(_proj_phases_raw, str):
                    _proj_phases = [p.strip().upper() for p in _proj_phases_raw.split(",") if p.strip()]
                elif isinstance(_proj_phases_raw, list):
                    _proj_phases = [str(p).strip().upper() for p in _proj_phases_raw if p]

                # ── 3. Always compute the auto score for reporting ───────────────
                _features = _cs.extract_features(
                    _plan_path if _plan_path else None,
                    _task_meta,
                )
                _raw_score = _cs.score_features(_features)
                _auto_phases = _cs.select_phases(_raw_score, _cfg)

                # ── 4. Resolve override ──────────────────────────────────────────
                if _env_phases:
                    _chosen_phases = _env_phases
                    _override_source = "env"
                elif _pin_phases:
                    _chosen_phases = _pin_phases
                    _override_source = "pin"
                elif _proj_phases:
                    _chosen_phases = _proj_phases
                    _override_source = "project"
                else:
                    _chosen_phases = _auto_phases
                    _override_source = "auto"

                # ── 5. Derive bucket_label from chosen_phases length ─────────────
                # 1=trivial, 3=light, 4=medium, 5=heavy, 7=critical
                _len_map = {1: "trivial", 3: "light", 4: "medium", 5: "heavy", 7: "critical"}
                _bucket_label = _len_map.get(len(_chosen_phases), "medium")

                # ── 6. Build banner ──────────────────────────────────────────────
                _phases_str = ",".join(_chosen_phases)
                if _override_source == "auto":
                    _banner = (
                        f"Phase 42 score: {_raw_score}/100 → {_phases_str} ({_bucket_label})."
                        " Override: --force-phases=full."
                    )
                else:
                    _banner = (
                        f"Phase 42 score: {_raw_score}/100 → {_phases_str}"
                        f" (override:{_override_source}). Override: --force-phases=full."
                    )

                self._send_json({
                    "score": _raw_score,
                    "auto_phases": _auto_phases,
                    "chosen_phases": _chosen_phases,
                    "override_source": _override_source,
                    "bucket_label": _bucket_label,
                    "feature_vector": _features,
                    "banner": _banner,
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/complexity/complete":
            try:
                # ── 0. Import scorer ──────────────────────────────────────────────
                import sys as _sys
                _svc_dir = os.path.dirname(os.path.abspath(__file__))
                if _svc_dir not in _sys.path:
                    _sys.path.insert(0, _svc_dir)
                import complexity_scorer as _cs

                _VALID_OUTCOME_LABELS = {
                    "validator_pass", "task_fail", "gaps_found",
                    "manifest_overshoot", "escalation_fired",
                }
                _task_id    = body.get("task_id") or ""
                _phase_num  = int(body.get("phase_number") or 0)
                _wf_name    = body.get("workflow_name") or "execute-phase"
                _fv         = body.get("feature_vector") or {}
                _raw_score  = int(body.get("raw_score") or 0)
                _chosen     = body.get("chosen_phases") or []
                _phases_run = body.get("phases_run") or []
                _outcome    = body.get("outcome_label") or "task_fail"
                _esc_hist   = body.get("escalation_history") or []

                if _outcome not in _VALID_OUTCOME_LABELS:
                    self._send_json({
                        "error": f"outcome_label must be one of: {sorted(_VALID_OUTCOME_LABELS)}"
                    }, 400)
                    return

                # ── Attempt embedding via pg_store ────────────────────────────────
                _embedding = None
                if _HAS_PG_MODULE and _pg_store is not None:
                    try:
                        from pg_store import PGStore as _PGS
                        _embedding = _PGS.generate_embedding(
                            json.dumps(_fv), input_type="document"
                        )
                    except Exception as _ee:
                        log.warning("/api/complexity/complete: embedding failed: %s", _ee)

                # ── Write task_completions row ────────────────────────────────────
                _row_id = _cs.store_completion(
                    task_id=_task_id,
                    phase_number=_phase_num,
                    workflow_name=_wf_name,
                    features=_fv,
                    raw_score=_raw_score,
                    calibrated_score=None,
                    chosen_phases=_chosen,
                    phases_run=_phases_run,
                    outcome_label=_outcome,
                    escalation_history=_esc_hist,
                    embedding=_embedding,
                )
                if _row_id:
                    self._send_json({
                        "id": _row_id,
                        "stored": True,
                        "embedding_present": _embedding is not None,
                    }, 201)
                else:
                    self._send_json({
                        "id": "",
                        "stored": False,
                        "reason": "PG unavailable or store_completion returned empty",
                    })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Blackboard POST routes (Phase 38 COMM-01, COMM-02, COMM-04) ──────────
        #
        # POST /api/findings — write a finding to agent_findings table.
        # POST /api/messages — send a message to agent_messages table.
        # POST /api/handoff  — generate structured handoff JSON via handoff.cjs.

        if path == "/api/findings":
            _VALID_FINDING_TYPES = {"observation", "decision", "warning", "blocker"}
            required = ["agent_name", "task_id", "finding_type", "content"]
            missing = [f for f in required if not body.get(f)]
            if missing:
                self._send_json({"error": f"Missing required fields: {', '.join(missing)}"}, 400)
                return
            if body["finding_type"] not in _VALID_FINDING_TYPES:
                self._send_json({
                    "error": f"finding_type must be one of: {', '.join(sorted(_VALID_FINDING_TYPES))}"
                }, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO agent_findings (agent_name, task_id, finding_type, content, confidence)"
                        " VALUES (%s, %s, %s, %s, %s) RETURNING id, created_at",
                        (
                            body["agent_name"],
                            body["task_id"],
                            body["finding_type"],
                            body["content"],
                            float(body.get("confidence", 0.8)),
                        ),
                    )
                    row = cur.fetchone()
                    conn.commit()
                self._send_json({"id": str(row[0]), "created": True, "created_at": row[1].isoformat()}, 201)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/messages":
            _VALID_MESSAGE_TYPES = {"ASK_QUESTION", "SHARE_FINDING", "REQUEST_REVIEW", "DELEGATE_SUBTASK"}
            # Auto-approved types (informational/advisory — no operator gate needed)
            _AUTO_APPROVED = {"SHARE_FINDING", "REQUEST_REVIEW"}
            required = ["from_agent", "to_agent", "task_id", "message_type", "content"]
            missing = [f for f in required if not body.get(f)]
            if missing:
                self._send_json({"error": f"Missing required fields: {', '.join(missing)}"}, 400)
                return
            if body["message_type"] not in _VALID_MESSAGE_TYPES:
                self._send_json({
                    "error": f"message_type must be one of: {', '.join(sorted(_VALID_MESSAGE_TYPES))}"
                }, 400)
                return
            auto_approved = body["message_type"] in _AUTO_APPROVED
            status = "approved" if auto_approved else "pending"
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO agent_messages"
                        " (from_agent, to_agent, task_id, message_type, content, status, operator_approved)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id, created_at",
                        (
                            body["from_agent"],
                            body["to_agent"],
                            body["task_id"],
                            body["message_type"],
                            body["content"],
                            status,
                            auto_approved,
                        ),
                    )
                    row = cur.fetchone()
                    conn.commit()
                self._send_json({
                    "id": str(row[0]),
                    "created": True,
                    "status": status,
                    "operator_approved": auto_approved,
                    "created_at": row[1].isoformat(),
                }, 201)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        if path == "/api/handoff":
            # POST /api/handoff — generate structured handoff JSON via Node.js handoff.cjs.
            # Required: task_id, from_agent, handoff_type.
            required = ["task_id", "from_agent", "handoff_type"]
            missing = [f for f in required if not body.get(f)]
            if missing:
                self._send_json({"error": f"Missing required fields: {', '.join(missing)}"}, 400)
                return
            handoff_script = str(Path(__file__).resolve().parent / "handoff.cjs")
            input_json = json.dumps(body)
            try:
                result = subprocess.run(  # invoke handoff.cjs via node subprocess
                    ["node", "-e",
                     f"const h=require('{handoff_script}');"
                     f"const opts=JSON.parse(process.argv[1]);"
                     f"process.stdout.write(JSON.stringify(h.createHandoff(opts)));",
                     input_json],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode != 0:
                    self._send_json({
                        "error": "handoff generation failed",
                        "details": result.stderr.strip(),
                    }, 500)
                    return
                handoff_data = json.loads(result.stdout)
                self._send_json(handoff_data, 200)
            except subprocess.TimeoutExpired:
                self._send_json({"error": "handoff generation timed out"}, 500)
            except json.JSONDecodeError as e:
                self._send_json({"error": "invalid JSON from handoff.cjs", "details": str(e)}, 500)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Agent Metrics POST routes (Phase 39 LIFE-02) ───────────────────────
        #
        # POST /api/metrics — record an agent execution metric.
        # Required: agent_name, task_id, outcome: 'pass', 'fail', 'partial'
        # Optional: completion_time_ms, token_usage, error_count (default 0).

        if path == "/api/metrics":
            _VALID_OUTCOMES = {"pass", "fail", "partial"}
            required = ["agent_name", "task_id", "outcome"]
            missing = [f for f in required if not body.get(f)]
            if missing:
                self._send_json({"error": f"Missing required fields: {', '.join(missing)}"}, 400)
                return
            if body["outcome"] not in _VALID_OUTCOMES:  # outcome: 'pass', 'fail', 'partial'
                self._send_json({
                    "error": f"outcome must be one of: {', '.join(sorted(_VALID_OUTCOMES))}"
                }, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO agent_metrics"
                        " (agent_name, task_id, completion_time_ms, token_usage, error_count, outcome)"
                        " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id, created_at",
                        (
                            body["agent_name"],
                            body["task_id"],
                            body.get("completion_time_ms"),
                            body.get("token_usage"),
                            int(body.get("error_count", 0)),
                            body["outcome"],
                        ),
                    )
                    row = cur.fetchone()
                    conn.commit()
                self._send_json({"id": str(row[0]), "created": True, "created_at": row[1].isoformat()}, 201)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        self._send_json({"error": f"Unknown POST route: {path}"}, 404)

    # ─── PATCH routes (Phase 10 LEARN-05) ────────────
    #
    # Limited surface: only PATCH /api/memory/mem-XXXX is supported today,
    # for merge-patching the metadata jsonb column during SKB promotion /
    # demotion. Body: {"metadata_patch": {key: value, ...}}.
    def do_PATCH(self):
        log.debug("request method=%s path=%s", self.command, self.path)
        if not _check_auth(self):
            return
        oidc_result = _check_oidc(self)
        if not oidc_result["valid"]:
            self._send_json({"error": oidc_result["error"]}, 401)
            return
        self._oidc_sub = oidc_result.get("sub", "anonymous")
        if not _rate_limiter.allow(self.path):
            log.warning("rate_limited path=%s", self.path)
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Too many requests. Try again later."}).encode())
            return
        path = self.path.rstrip("/")
        body = self._read_body()
        if body is None:
            return

        if path.startswith("/api/memory/mem-"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'memory_patch_metadata'):
                self._send_json({"error": "memory_patch_metadata not supported by this store"}, 501)
                return
            mem_id = path[len("/api/memory/"):]
            patch = body.get("metadata_patch")
            if not isinstance(patch, dict):
                self._send_json({"error": "metadata_patch (dict) is required in body"}, 400)
                return
            try:
                result = store.memory_patch_metadata(mem_id, patch)
                if not result.get("ok"):
                    err = result.get("error", "unknown")
                    if err == "memory not found":
                        self._send_json(result, 404)
                    else:
                        self._send_json(result, 500)
                    return
                self._send_json(result, 200)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        # ─── Blackboard PATCH route (Phase 38 COMM-02) ──────────────────────────
        #
        # PATCH /api/messages/:id — update message status (approve/deny/respond).
        # Body: {"status": "approved"|"denied"|"responded", "response": "...", "operator_approved": bool}

        if path.startswith("/api/messages/"):
            msg_id = path[len("/api/messages/"):]
            if not msg_id:
                self._send_json({"error": "message id required in path"}, 400)
                return
            _VALID_STATUSES = {"approved", "denied", "responded"}
            new_status = body.get("status")
            if new_status and new_status not in _VALID_STATUSES:
                self._send_json({
                    "error": f"status must be one of: {', '.join(sorted(_VALID_STATUSES))}"
                }, 400)
                return
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            try:
                conn = store._get_conn()
                with conn.cursor() as cur:
                    # Build update SET clauses from provided fields
                    updates = []
                    params = []
                    if new_status:
                        updates.append("status = %s")
                        params.append(new_status)
                    if "response" in body:
                        updates.append("response = %s")
                        params.append(body["response"])
                        updates.append("responded_at = NOW()")
                    if "operator_approved" in body:
                        updates.append("operator_approved = %s")
                        params.append(bool(body["operator_approved"]))
                    if not updates:
                        self._send_json({"error": "No updatable fields provided"}, 400)
                        return
                    params.append(msg_id)
                    cur.execute(
                        f"UPDATE agent_messages SET {', '.join(updates)}"
                        f" WHERE id = %s RETURNING id, status, operator_approved, responded_at",
                        params,
                    )
                    row = cur.fetchone()
                    conn.commit()
                if not row:
                    self._send_json({"error": "message not found"}, 404)
                    return
                self._send_json({
                    "id": str(row[0]),
                    "status": row[1],
                    "operator_approved": row[2],
                    "responded_at": row[3].isoformat() if row[3] else None,
                    "updated": True,
                })
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        self._send_json({"error": f"Unknown PATCH route: {path}"}, 404)

    # ─── DELETE routes (Phase 10 LEARN-05) ───────────
    #
    # Limited surface: only DELETE /api/skb/skb-XXXX is supported today, for
    # the SKB demotion path. Returning 404 for not-found keeps the demotion
    # flow idempotent from the caller's perspective.
    def do_DELETE(self):
        log.debug("request method=%s path=%s", self.command, self.path)
        if not _check_auth(self):
            return
        oidc_result = _check_oidc(self)
        if not oidc_result["valid"]:
            self._send_json({"error": oidc_result["error"]}, 401)
            return
        self._oidc_sub = oidc_result.get("sub", "anonymous")
        if not _rate_limiter.allow(self.path):
            log.warning("rate_limited path=%s", self.path)
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Too many requests. Try again later."}).encode())
            return
        path = self.path.rstrip("/")

        if path.startswith("/api/skb/skb-"):
            store = _get_store()
            if not store:
                self._send_json({"error": "No database available"}, 503)
                return
            if not hasattr(store, 'skb_delete'):
                self._send_json({"error": "skb_delete not supported by this store"}, 501)
                return
            skb_id = path[len("/api/skb/"):]
            try:
                result = store.skb_delete(skb_id)
                if not result.get("ok"):
                    err = result.get("error", "unknown")
                    if err == "skb not found":
                        self._send_json(result, 404)
                    else:
                        self._send_json(result, 500)
                    return
                self._send_json(result, 200)
            except Exception as e:
                self._send_json({"error": _safe_error(e)}, 500)
            return

        self._send_json({"error": f"Unknown DELETE route: {path}"}, 404)


# ═══════════════════════════════════════════════════════
# Daemon lifecycle
# ═══════════════════════════════════════════════════════

def start_server(foreground=False):
    """Start the HTTP server."""
    if not foreground:
        # Check if already running
        if PID_FILE.exists():
            try:
                pid = int(PID_FILE.read_text().strip())
                os.kill(pid, 0)  # Check if process exists
                print(f"Daemon already running (PID {pid})")
                return
            except (ProcessLookupError, ValueError):
                PID_FILE.unlink(missing_ok=True)

    # Verify amauta.py exists
    if not Path(AMAUTA_PY).exists():
        print(f"ERROR: amauta.py not found at {AMAUTA_PY}", file=sys.stderr)
        sys.exit(1)

    # Ensure data dir exists
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)

    server = ThreadedHTTPServer((HOST, PORT), AmautaHandler)

    # Write PID file
    PID_FILE.write_text(str(os.getpid()))

    # Graceful shutdown
    def shutdown_handler(signum, frame):
        _shutdown_event.set()  # Wake sleeping threads for graceful exit
        log.info("daemon_shutdown")
        print("\nShutting down daemon...")
        _stop_redis()
        _stop_rlm()
        for s in (_pg_store, _sqlite_store):
            if s:
                try:
                    s.close()
                except Exception:
                    pass
        server.shutdown()
        PID_FILE.unlink(missing_ok=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    # ─── OIDC Authentication Init ───────────────────
    global _oidc
    if _HAS_OIDC_MODULE:
        try:
            _oidc = OIDCAuth()
            if _oidc.is_enabled():
                print(f"  OIDC: enabled (issuer: {_oidc.issuer})")
            else:
                print(f"  OIDC: disabled (GSD_OIDC_ISSUER or GSD_OIDC_CLIENT_ID not set)")
        except Exception as e:
            print(f"  OIDC: init failed ({e}) — running without OIDC")
            _oidc = None
    else:
        print(f"  OIDC: module not found — running without OIDC")

    # ─── Smart Infrastructure Detection ─────────────
    global _pg_store, _sqlite_store, _infra_result

    if _HAS_INFRA_DETECT:
        _infra_result = detect_infrastructure()
        log.info("infra_detected backend=%s", _infra_result["backend"])
        print(f"  Infrastructure: {_infra_result['message']}")
        print(f"  Features: {', '.join(_infra_result['features'])}")

        if _infra_result["backend"] == "postgresql":
            # Set env var so downstream components (amauta.py, etc.) can use it
            os.environ["GSD_POSTGRES_URL"] = _infra_result["connection_url"]
            if _HAS_PG_MODULE:
                try:
                    _pg_store = PGStore(dsn=_infra_result["connection_url"])
                    h = _pg_store.health()
                    print(f"  PostgreSQL: connected ({h.get('dsn_host', 'unknown')})")
                except Exception as e:
                    print(f"  PostgreSQL: FAILED ({_safe_error(e)}) — trying SQLite fallback")
                    _pg_store = None
            else:
                print("  PostgreSQL: pg_store module not found")

        if _infra_result["backend"] == "sqlite" or (_infra_result["backend"] == "postgresql" and _pg_store is None):
            # SQLite fallback
            if _HAS_SQLITE_MODULE:
                sqlite_path = _infra_result.get("connection_url", "").replace("sqlite:///", "")
                if not sqlite_path:
                    sqlite_path = None  # Let SQLiteStore use its default
                try:
                    _sqlite_store = SQLiteStore(db_path=sqlite_path or None)
                    h = _sqlite_store.health()
                    print(f"  SQLite: active ({h.get('path', 'unknown')})")
                    os.environ["GSD_BACKEND"] = "sqlite"
                    os.environ["GSD_SQLITE_PATH"] = _sqlite_store.db_path
                except Exception as e:
                    print(f"  SQLite: FAILED ({e})")
                    _sqlite_store = None
            else:
                print("  SQLite: sqlite_store module not found")
    else:
        # Legacy path: no infra_detect module, use original PG init
        pg_url = os.environ.get("GSD_POSTGRES_URL")
        if _HAS_PG_MODULE and pg_url:
            try:
                _pg_store = PGStore(dsn=pg_url)
                h = _pg_store.health()
                print(f"  PostgreSQL: connected ({h.get('dsn_host', 'unknown')})")
            except Exception as e:
                print(f"  PostgreSQL: FAILED ({_safe_error(e)}) — running without PG")
                _pg_store = None
        elif _HAS_PG_MODULE:
            try:
                _pg_store = PGStore()
                h = _pg_store.health()
                print(f"  PostgreSQL: connected ({h.get('dsn_host', 'unknown')})")
            except Exception as e:
                print(f"  PostgreSQL: not available ({_safe_error(e)}) — running without PG")
                _pg_store = None
        else:
            print("  PostgreSQL: pg_store module not found — running without PG")

    log.info("daemon_started port=%d pid=%d", PORT, os.getpid())
    print(f"Amauta daemon listening on {HOST}:{PORT}")
    print(f"  Data dir: {DATA_DIR}")
    print(f"  PID file: {PID_FILE}")
    print(f"  amauta.py: {AMAUTA_PY}")
    if _pg_store:
        print(f"  Store: PostgreSQL (active)")
    elif _sqlite_store:
        print(f"  Store: SQLite (fallback, path: {_sqlite_store.db_path})")
    else:
        print(f"  Store: inactive (file-only mode)")

    # ── Startup reconciliation: sync tasks.json → store ─────────────────
    def _reconcile_tasks_to_store():
        """Best-effort sync: load tasks.json and upsert all items to store mirror."""
        try:
            tasks_file = Path(DATA_DIR) / "tasks.json"
            if not tasks_file.exists():
                return
            import json as _json
            data = _json.loads(tasks_file.read_text())
            items = data.get("items", [])
            store = _get_store()
            if not items or not store:
                return
            synced = store.task_upsert_batch(items)
            backend = "PG" if _pg_store else "SQLite"
            if synced:
                log.info("reconcile_complete items=%d backend=%s", len(items), backend)
                print(f"[reconcile] Synced {len(items)} tasks to {backend} mirror", file=sys.stderr)
        except Exception as e:
            print(f"[reconcile] Warning: {e}", file=sys.stderr)

    _reconcile_tasks_to_store()

    # ── Initialize BackupManager + auto-backup (Phase 8: DUR-05) ─────────
    global _backup_manager
    _active_store = _get_store()
    if _HAS_BACKUP_MODULE and _active_store:
        try:
            _backup_manager = BackupManager(_active_store)
            auto_path = _backup_manager.auto_backup()
            if auto_path:
                log.info("auto_backup_created path=%s", auto_path)
                print(f"  Auto-backup: {auto_path}")
            else:
                print(f"  Auto-backup: already exists for today")
        except Exception as e:
            log.warning("auto_backup_failed error=%s", str(e))
            print(f"  Auto-backup: failed ({e})")
    elif _HAS_BACKUP_MODULE:
        print(f"  Backup: no store available (backup disabled)")
    else:
        print(f"  Backup: module not found")

    # ── Run memory retention cleanup at startup (MEM-02) ─────────────────────
    if _active_store and hasattr(_active_store, 'memory_retention_cleanup'):
        try:
            ret_result = _active_store.memory_retention_cleanup()
            ret_total = ret_result.get("total", 0)
            if ret_total > 0:
                print(f"  Memory retention: archived {ret_total} entries ({ret_result})")
            else:
                print(f"  Memory retention: nothing to archive")
        except Exception as e:
            print(f"  Memory retention: failed ({e})")
    else:
        print(f"  Memory retention: no store available")

    # ── API Key Validation ────────────────────────────────────────────────────
    _api_key_status = _validate_api_keys()
    print(f"  API Keys:")
    for key_name, info in _api_key_status.items():
        if "length" in info:
            print(f"    {key_name}: SET ({info['length']} chars) [{info['status']}]")
        elif "value" in info:
            print(f"    {key_name}: {info['value']}")
        else:
            print(f"    {key_name}: NOT SET [{info['status']}]")

    # ── Start RLM service ────────────────────────────────────────────────────
    if _rlm_enabled:
        rlm_started = _start_rlm()
        if rlm_started:
            print(f"  RLM: started (PID {_rlm_process.pid}, port {RLM_PORT})")
            # Start watchdog thread
            watchdog = threading.Thread(target=_rlm_watchdog, daemon=True)
            watchdog.start()
        else:
            print(f"  RLM: not started (set GSD_RLM_ENABLED=false to disable)")
    else:
        print(f"  RLM: disabled (GSD_RLM_ENABLED=false)")

    # ── Start Redis service ───────────────────────────────────────────────────
    if _redis_enabled and _HAS_REDIS:
        redis_started = _start_redis()
        if redis_started:
            print(
                f"  Redis: connected ({REDIS_URL.split('@')[-1] if '@' in REDIS_URL else REDIS_URL})"
            )
            # Inject Redis client into bridge module for pg_store access
            try:
                from amauta_daemon_redis import set_redis_client
                set_redis_client(_redis_client)
            except ImportError:
                pass
            redis_watchdog_thread = threading.Thread(target=_redis_watchdog, daemon=True)
            redis_watchdog_thread.start()
        else:
            print(f"  Redis: not available (cache falls back to in-memory/file)")
    elif not _HAS_REDIS:
        print(f"  Redis: disabled (pip install redis>=5.0 to enable)")
    else:
        print(f"  Redis: disabled (GSD_REDIS_ENABLED=false)")

    # ── Start stale task watchdog thread ──────────────────────────────────────
    stale_watchdog_thread = threading.Thread(target=_stale_task_watchdog, daemon=True)
    stale_watchdog_thread.start()
    print(f"  Watchdog: started (check every {STALE_CHECK_INTERVAL}s, stale threshold {STALE_THRESHOLD_HOURS}h)")

    # ── Start retry queue flusher thread ─────────────────────────────────────
    if _pg_store:
        retry_thread = threading.Thread(target=_retry_queue_flusher, daemon=True)
        retry_thread.start()
        print(f"  Retry flush: started (every {RETRY_FLUSH_INTERVAL}s)")
    else:
        print(f"  Retry flush: skipped (no PG store)")

    # ── Start memory retention thread (MEM-02) ────────────────────────────────
    retention_thread = threading.Thread(target=_memory_retention_thread, daemon=True)
    retention_thread.start()
    print(f"  Retention: started (check every {RETENTION_CHECK_INTERVAL}s)")

    # -- Startup Service Inventory (data flow alert) ---------------------------
    print(f"\n  --- Service Status ---")
    _svc_status = []
    # PG
    if _pg_store:
        print(f"  [OK]  PostgreSQL: connected")
    elif _sqlite_store:
        print(f"  [!!]  PostgreSQL: unavailable (using SQLite fallback)")
        _svc_status.append("PG down")
    else:
        print(f"  [XX]  PostgreSQL: no connection (memory/task storage disabled)")
        _svc_status.append("PG critical")
    # Redis
    if _redis_enabled and _HAS_REDIS and _check_redis_health():
        print(f"  [OK]  Redis: connected (L2 cache active)")
    elif _redis_enabled and _HAS_REDIS:
        print(f"  [!!]  Redis: unavailable (falling back to in-memory/file cache)")
        _svc_status.append("Redis down")
    elif not _HAS_REDIS:
        print(f"  [--]  Redis: not installed (pip install redis>=5.0)")
    else:
        print(f"  [--]  Redis: disabled")
    # RLM
    if _rlm_enabled and _check_rlm_health():
        print(f"  [OK]  RLM: running (port {RLM_PORT})")
    elif _rlm_enabled:
        print(f"  [XX]  RLM: not responding (code search unavailable)")
        _svc_status.append("RLM down")
    else:
        print(f"  [--]  RLM: disabled")
    # API Keys
    _ak = _validate_api_keys()
    if _ak.get("VOYAGE_API_KEY", {}).get("set"):
        print(f"  [OK]  Voyage API: key set")
    else:
        print(f"  [!!]  Voyage API: key missing (embeddings disabled)")
        _svc_status.append("Voyage missing")
    if _ak.get("PERPLEXITY_API_KEY", {}).get("set"):
        print(f"  [OK]  Perplexity API: key set")
    else:
        print(f"  [!!]  Perplexity API: key missing (web research disabled)")
        _svc_status.append("Perplexity missing")
    # Summary
    if not _svc_status:
        print(f"  --- Pipeline: HEALTHY ---\n")
    else:
        print(f"  --- Pipeline: DEGRADED ({', '.join(_svc_status)}) ---\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _stop_redis()
        _stop_rlm()
        for s in (_pg_store, _sqlite_store):
            if s:
                try:
                    s.close()
                except Exception:
                    pass
        server.server_close()
        PID_FILE.unlink(missing_ok=True)


def stop_server():
    """Stop the daemon by PID."""
    if not PID_FILE.exists():
        print("Daemon not running (no PID file)")
        return

    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to PID {pid}")
        # Wait briefly for process to die before removing PID file
        for _ in range(10):
            time.sleep(0.3)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
        PID_FILE.unlink(missing_ok=True)
    except ProcessLookupError:
        print("Daemon not running (stale PID file)")
        PID_FILE.unlink(missing_ok=True)
    except ValueError:
        print("Invalid PID file")
        PID_FILE.unlink(missing_ok=True)


def check_status():
    """Check if daemon is running."""
    if not PID_FILE.exists():
        print("Daemon not running")
        return False

    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)
        print(f"Daemon running (PID {pid}) on {HOST}:{PORT}")
        return True
    except (ProcessLookupError, ValueError):
        print("Daemon not running (stale PID file)")
        PID_FILE.unlink(missing_ok=True)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: amauta-daemon.py {start|stop|status|run}")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "start":
        # Fork to background
        if os.fork() == 0:
            os.setsid()
            start_server(foreground=False)
        else:
            print("Daemon starting in background...")
    elif cmd == "run":
        start_server(foreground=True)
    elif cmd == "stop":
        stop_server()
    elif cmd == "status":
        sys.exit(0 if check_status() else 1)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
