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
STALE_CHECK_INTERVAL = 300  # 5 minutes
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
    if path in ("/health", "/metrics"):
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

# ── RLM Service Management ───────────────────────────────────────────────────
RLM_SERVICE_PY = str(Path(__file__).resolve().parent / "rlm-service.py")
RLM_PORT = int(os.environ.get("GSD_RLM_PORT", "18798"))
RLM_MAX_RESTARTS = 3
_rlm_process = None
_rlm_restart_count = 0
_rlm_enabled = os.environ.get("GSD_RLM_ENABLED", "true").lower() != "false"


def _start_rlm():
    """Start RLM service as a subprocess."""
    global _rlm_process, _rlm_restart_count
    if not _rlm_enabled:
        log.info("rlm_disabled")
        return False
    if not Path(RLM_SERVICE_PY).exists():
        log.warning("rlm_not_found path=%s", RLM_SERVICE_PY)
        return False

    try:
        env = os.environ.copy()
        env["GSD_RLM_PORT"] = str(RLM_PORT)
        _rlm_process = subprocess.Popen(
            [sys.executable, RLM_SERVICE_PY, "run"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
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
    """Background thread: periodically check RLM health and restart if needed."""
    global _rlm_restart_count
    while True:
        time.sleep(30)  # Check every 30 seconds
        if not _rlm_enabled or _rlm_process is None:
            continue
        if _rlm_process.poll() is not None or not _check_rlm_health():
            if _rlm_restart_count < RLM_MAX_RESTARTS:
                _rlm_restart_count += 1
                log.warning("rlm_restart attempt=%d/%d", _rlm_restart_count, RLM_MAX_RESTARTS)
                _stop_rlm()
                _start_rlm()
            else:
                log.error("rlm_max_restarts_exceeded")


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
        if self.path not in ("/health", "/metrics") and not _check_auth(self):
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

        path = self.path.rstrip("/")

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
                "oidc_enabled": _oidc.is_enabled() if _oidc else False,
                "oidc_issuer": _oidc.issuer if _oidc and _oidc.is_enabled() else None,
            }
            if _pg_store:
                health["pg_health"] = _pg_store.health()
            elif _sqlite_store:
                health["sqlite_health"] = _sqlite_store.health()
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
                total = store.memory_count()
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

        # Generic command executor — limited to safe read/query operations
        # (destructive operations like delete/atomize must use specific routes)
        _EXEC_ALLOWLIST = {
            "show", "list", "board", "search", "score", "next", "health",
            "note", "rpetd", "validate", "status", "claim", "add", "assign",
            "link", "unlink", "update",
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
            try:
                kwargs = dict(
                    query=query,
                    project_id=body.get("project_id"),
                    source=body.get("source"),
                    limit=body.get("limit", 20),
                )
                # MEM-01: include_noise=true bypasses default source exclusion
                if body.get("include_noise"):
                    kwargs["exclude_sources"] = None
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
            try:
                kwargs = dict(
                    query=query,
                    project_id=body.get("project_id"),
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

        self._send_json({"error": f"Unknown POST route: {path}"}, 404)


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

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
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
