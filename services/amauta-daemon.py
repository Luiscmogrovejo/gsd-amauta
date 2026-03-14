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
import signal
import subprocess
import sys
import threading
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

# PostgreSQL store (optional — graceful degradation)
_pg_store = None
_HAS_PG_MODULE = False
try:
    from pg_store import PGStore
    _HAS_PG_MODULE = True
except ImportError:
    PGStore = None  # type: ignore

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
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

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
            "force": None,   # boolean flag
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
            }
            if _pg_store:
                health["pg_health"] = _pg_store.health()
            self._send_json(health)
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

        # ─── Memory GET routes (PG required) ─────────
        if path == "/api/memory/list" or path.startswith("/api/memory/list?"):
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available", "hint": "Set GSD_POSTGRES_URL"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            try:
                results = _pg_store.memory_list(
                    project_id=params.get("project_id", [None])[0],
                    source=params.get("source", [None])[0],
                    limit=int(params.get("limit", ["50"])[0]),
                    offset=int(params.get("offset", ["0"])[0]),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/count":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            try:
                count = _pg_store.memory_count()
                self._send_json({"count": count})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/embedding-stats":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            try:
                stats = _pg_store.memory_embedding_stats()
                self._send_json(stats)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # ─── Agent Performance GET route (PG required) ──────
        if path.startswith("/api/agent-performance"):
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            try:
                import urllib.parse
                qs = urllib.parse.urlparse(self.path).query
                params = urllib.parse.parse_qs(qs)
                agent_id = params.get("agent_id", [""])[0]
                if not agent_id:
                    self._send_json({"error": "agent_id query param required"}, 400)
                    return
                summary = _pg_store.agent_performance_summary(agent_id)
                self._send_json(summary or {"total_tasks": 0, "agent_id": agent_id})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # ─── SKB GET routes (PG required) ─────────────
        if path == "/api/skb/list" or path.startswith("/api/skb/list?"):
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            params = parse_qs(urlparse(self.path).query) if "?" in self.path else {}
            try:
                results = _pg_store.skb_list(
                    category=params.get("category", [None])[0],
                    limit=int(params.get("limit", ["50"])[0]),
                    offset=int(params.get("offset", ["0"])[0]),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # ─── Validation GET routes (PG required) ──────
        if path.startswith("/api/validation/"):
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            task_id = path.split("/")[-1]
            try:
                results = _pg_store.validation_history(task_id)
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        self._send_json({"error": f"Unknown GET route: {path}"}, 404)

    # ─── POST routes ─────────────────────────────────

    def do_POST(self):
        path = self.path.rstrip("/")
        body = self._read_body()

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

            # ── Dual-write: mirror task mutations to PG (best-effort) ──
            # After amauta.py writes to tasks.json, mirror the affected task to gsd_tasks.
            # Only for commands that mutate tasks; read commands (show, list, search) skip this.
            _TASK_MUTATING_COMMANDS = {"add", "claim", "rpetd", "status", "validate",
                                       "assign", "note", "update", "delete", "link", "unlink", "atomize"}
            if _pg_store and rc == 0 and command in _TASK_MUTATING_COMMANDS:
                try:
                    task_id = body.get("id") or ""
                    # For add, extract the new task ID from output
                    if command == "add" and not task_id:
                        import re as _re
                        m = _re.search(r"(TK|EP|ST|BG)-\d+", out)
                        task_id = m.group(0) if m else ""
                    if command == "delete" and task_id:
                        _pg_store.task_delete(task_id)
                    elif task_id:
                        # Re-read the task from tasks.json via show --json to get current state
                        show_out, _, show_rc = self._run_amauta(["show", task_id, "--json"])
                        if show_rc == 0 and show_out.strip():
                            import json as _json
                            item = _json.loads(show_out)
                            _pg_store.task_upsert(item)
                except Exception:
                    pass  # PG mirror is best-effort — never block task responses

            self._send_json({"output": out, "error": err, "exit_code": rc})
            return

        # ─── Memory POST routes (PG required) ────────
        if path == "/api/memory/store":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available", "hint": "Set GSD_POSTGRES_URL"}, 503)
                return
            text = body.get("text")
            if not text:
                self._send_json({"error": "text is required"}, 400)
                return
            try:
                # Auto-embed if an embedding API key is set and body doesn't opt out
                use_embedding = body.get("embed", True) and (
                    os.environ.get("VOYAGE_API_KEY") or os.environ.get("OPENAI_API_KEY")
                )
                if use_embedding:
                    mem_id = _pg_store.memory_store_with_embedding(
                        text=text,
                        source=body.get("source", "agent"),
                        agent_id=body.get("agent_id"),
                        tags=body.get("tags"),
                        metadata=body.get("metadata"),
                        project_id=body.get("project_id"),
                    )
                else:
                    mem_id = _pg_store.memory_store(
                        text=text,
                        source=body.get("source", "agent"),
                        agent_id=body.get("agent_id"),
                        tags=body.get("tags"),
                        metadata=body.get("metadata"),
                        project_id=body.get("project_id"),
                    )
                self._send_json({"id": mem_id, "stored": True, "embedded": bool(use_embedding)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/search":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                results = _pg_store.memory_search(
                    query=query,
                    project_id=body.get("project_id"),
                    source=body.get("source"),
                    limit=body.get("limit", 20),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/delete":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            mem_id = body.get("id")
            if not mem_id:
                self._send_json({"error": "id is required"}, 400)
                return
            try:
                _pg_store.memory_delete(mem_id)
                self._send_json({"deleted": True, "id": mem_id})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/semantic-search":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available", "hint": "Set GSD_POSTGRES_URL"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                results, method = _pg_store.memory_semantic_search(
                    query=query,
                    project_id=body.get("project_id"),
                    source=body.get("source"),
                    limit=body.get("limit", 20),
                )
                self._send_json({"results": results, "count": len(results), "method": method})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/backfill-embeddings":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available", "hint": "Set GSD_POSTGRES_URL"}, 503)
                return
            try:
                result = _pg_store.memory_backfill_embeddings(
                    batch_size=body.get("batch_size", 50),
                )
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/memory/cross-project":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available", "hint": "Set GSD_POSTGRES_URL"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                results = _pg_store.memory_cross_project_search(
                    query=query,
                    tags=body.get("tags"),
                    exclude_project=body.get("exclude_project"),
                    limit=body.get("limit", 20),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # ─── SKB POST routes (PG required) ────────────
        if path == "/api/skb/store":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            title = body.get("title")
            content = body.get("content")
            if not title or not content:
                self._send_json({"error": "title and content are required"}, 400)
                return
            try:
                skb_id = _pg_store.skb_store(
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
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/skb/search":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            query = body.get("query")
            if not query:
                self._send_json({"error": "query is required"}, 400)
                return
            try:
                results = _pg_store.skb_search(
                    query=query,
                    category=body.get("category"),
                    limit=body.get("limit", 20),
                )
                self._send_json({"results": results, "count": len(results)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # ─── Validation POST route (PG required) ──────
        if path == "/api/validation/record":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            task_id = body.get("task_id")
            validator_id = body.get("validator_id")
            status_val = body.get("status")
            if not all([task_id, validator_id, status_val]):
                self._send_json({"error": "task_id, validator_id, and status are required"}, 400)
                return
            try:
                vid = _pg_store.validation_record(
                    task_id=task_id,
                    validator_id=validator_id,
                    status=status_val,
                    evidence=body.get("evidence"),
                    rejection_reason=body.get("rejection_reason"),
                )
                self._send_json({"id": vid, "recorded": True})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # ─── Agent Performance POST route (PG required) ──────
        if path == "/api/agent-performance":
            if not _pg_store:
                self._send_json({"error": "PostgreSQL not available"}, 503)
                return
            _ap_agent = body.get("agent_id", "")
            _ap_task = body.get("task_id", "")
            if not _ap_agent or not _ap_task:
                self._send_json({"error": "agent_id and task_id are required"}, 400)
                return
            try:
                _pg_store.record_agent_performance(
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
                self._send_json({"error": str(e)}, 500)
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
        print("\nShutting down daemon...")
        server.shutdown()
        PID_FILE.unlink(missing_ok=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    # ─── Initialize PostgreSQL store (optional) ─────
    global _pg_store
    pg_url = os.environ.get("GSD_POSTGRES_URL")
    if _HAS_PG_MODULE and pg_url:
        try:
            _pg_store = PGStore(dsn=pg_url)
            h = _pg_store.health()
            print(f"  PostgreSQL: connected ({h.get('dsn_host', 'unknown')})")
        except Exception as e:
            print(f"  PostgreSQL: FAILED ({e}) — running without PG")
            _pg_store = None
    elif _HAS_PG_MODULE:
        # Try default DSN
        try:
            _pg_store = PGStore()
            h = _pg_store.health()
            print(f"  PostgreSQL: connected ({h.get('dsn_host', 'unknown')})")
        except Exception as e:
            print(f"  PostgreSQL: not available ({e}) — running without PG")
            _pg_store = None
    else:
        print("  PostgreSQL: pg_store module not found — running without PG")

    print(f"Amauta daemon listening on {HOST}:{PORT}")
    print(f"  Data dir: {DATA_DIR}")
    print(f"  PID file: {PID_FILE}")
    print(f"  amauta.py: {AMAUTA_PY}")
    print(f"  PG store: {'active' if _pg_store else 'inactive (file-only mode)'}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
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
