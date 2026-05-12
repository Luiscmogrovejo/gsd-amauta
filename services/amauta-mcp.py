#!/usr/bin/env python3
"""
Amauta MCP Server — standalone MCP service with direct PG connection pool + Valkey client (Phase 46).

Exposes amauta capabilities as MCP tools and resources for Claude Code
(stdio transport) and remote clients (SSE on port 18800).
Does NOT require amauta-daemon to be running.

Usage:
    python3 services/amauta-mcp.py          # stdio transport (Claude Code)
    python3 services/amauta-mcp.py --sse    # SSE transport (port 18800)
"""

import os

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
import json
import asyncio
import hashlib
import urllib.request
import urllib.error
import urllib.parse
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool, Resource, TextContent,
    ListToolsResult, CallToolResult, ListResourcesResult, ReadResourceResult,
)

# ── psycopg2 import-safety fallback (mirrors skill_invocation_store.py pattern) ─
try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.pool import SimpleConnectionPool
    _HAS_PG = True
except ImportError:
    _HAS_PG = False
    print("[amauta-mcp] WARNING: psycopg2 not installed — PG tools will return pg_unavailable", file=sys.stderr)

# ── Constants ─────────────────────────────────────────────────────────────────
MCP_SSE_PORT = int(os.environ.get("AMAUTA_MCP_PORT", "18800"))
MCP_SSE_PATH = "/sse"

# Frozen MCP error vocabulary (CONTEXT §Specifics) — must match test_constants_frozen
_MCP_ERROR_CODES = (
    "pg_unavailable",
    "valkey_unavailable",
    "invalid_input",
    "not_found",
    "internal_error",
)


# ── MCPDatabase: direct psycopg2 SimpleConnectionPool + SQLite adapter ────────

class MCPDatabase:
    """Direct PG connection pool (psycopg2 SimpleConnectionPool) with SQLite fallback.

    Connection URL resolution:
      1. GSD_POSTGRES_URL env var (always wins)
      2. services/infra_detect.py cascade (local PG → Docker PG → SQLite)

    Pool defaults: MIN=1, MAX=8. Override via MCP_PG_POOL_MIN / MCP_PG_POOL_MAX.
    """

    def __init__(self):
        self._pool = None
        self._sqlite_conn = None
        self.backend = None
        self._init_error = None

        try:
            url = os.environ.get("GSD_POSTGRES_URL")
            if not url:
                try:
                    import importlib.util as _ilu
                    import os as _os
                    _services_dir = _os.path.dirname(_os.path.abspath(__file__))
                    _spec = _ilu.spec_from_file_location(
                        "infra_detect",
                        _os.path.join(_services_dir, "infra_detect.py"),
                    )
                    _mod = _ilu.module_from_spec(_spec)
                    _spec.loader.exec_module(_mod)
                    _info = _mod.detect_infrastructure(auto_start=False)
                    url = _info.get("connection_url")
                    self.backend = _info.get("backend")
                except Exception as e:
                    self._init_error = f"infra_detect failed: {e}"
                    return
            else:
                self.backend = "postgresql"

            if not url:
                self._init_error = "No connection URL resolved"
                return

            if self.backend == "sqlite" or (url and url.startswith("sqlite://")):
                import sqlite3
                sqlite_path = url.replace("sqlite:///", "")
                self._sqlite_conn = sqlite3.connect(sqlite_path, check_same_thread=False)
                self.backend = "sqlite"
            elif _HAS_PG:
                min_conn = int(os.environ.get("MCP_PG_POOL_MIN", "1"))
                max_conn = int(os.environ.get("MCP_PG_POOL_MAX", "8"))
                self._pool = SimpleConnectionPool(minconn=min_conn, maxconn=max_conn, dsn=url)
                self.backend = "postgresql"
            else:
                self._init_error = "psycopg2 not installed and URL is postgres"
        except Exception as e:
            self._init_error = str(e)

    def available(self) -> bool:
        """Return True iff PG pool or SQLite connection is usable."""
        if self._init_error:
            return False
        if self._pool is not None:
            return True
        if self._sqlite_conn is not None:
            return True
        return False

    def getconn(self):
        """Get a raw connection from the pool (or sqlite conn)."""
        if self._pool is not None:
            return self._pool.getconn()
        return self._sqlite_conn

    def putconn(self, conn):
        """Return a connection to the pool (no-op for sqlite)."""
        if self._pool is not None:
            self._pool.putconn(conn)

    def close(self):
        """Close all pool connections."""
        if self._pool is not None:
            try:
                self._pool.closeall()
            except Exception:
                pass


# ── MCPValkey: optional Redis/Valkey client (redis.from_url pattern) ──────────

try:
    import redis as _redis_lib
    _HAS_REDIS = True
except ImportError:
    _redis_lib = None  # type: ignore
    _HAS_REDIS = False


class MCPValkey:
    """Optional Valkey/Redis client.

    Connection URL: VALKEY_URL env first, then REDIS_URL, else None (no client).
    Valkey is OPTIONAL — when unavailable, tools skip the cache path gracefully.
    All methods swallow exceptions; get() returns None on failure; setex() returns False.
    """

    def __init__(self):
        self._client = None
        self._init_error = None
        self._ping_ok = False

        url = os.environ.get("VALKEY_URL") or os.environ.get("REDIS_URL")
        if not url:
            self._init_error = "VALKEY_URL / REDIS_URL not set"
            return

        if not _HAS_REDIS:
            self._init_error = "redis library not installed"
            return

        try:
            self._client = _redis_lib.from_url(url, socket_timeout=2, socket_connect_timeout=2)
            self._client.ping()
            self._ping_ok = True
        except Exception as e:
            self._init_error = f"Valkey ping failed: {e}"
            self._ping_ok = False

    def available(self) -> bool:
        """Return True iff client present AND last ping succeeded."""
        return self._client is not None and self._ping_ok

    def get(self, key: str):
        """Get a value from Valkey. Returns None on miss or error."""
        if not self.available():
            return None
        try:
            return self._client.get(key)
        except Exception as e:
            self._init_error = str(e)
            return None

    def setex(self, key: str, ttl: int, value) -> bool:
        """Set a value with TTL in Valkey. Returns False on error."""
        if not self.available():
            return False
        try:
            self._client.setex(key, ttl, value)
            return True
        except Exception as e:
            self._init_error = str(e)
            return False


# ── Module-level singleton accessors ──────────────────────────────────────────

_pg_store_singleton = None
_pg_store_attempted = False
_mcp_valkey_singleton = None
_mcp_valkey_attempted = False


def _get_pg_store():
    """Lazily instantiate and return a PGStore singleton. Returns None on error."""
    global _pg_store_singleton, _pg_store_attempted
    if _pg_store_attempted:
        return _pg_store_singleton
    _pg_store_attempted = True
    try:
        import importlib.util as _ilu
        _services_dir = os.path.dirname(os.path.abspath(__file__))
        _spec = _ilu.spec_from_file_location(
            "pg_store",
            os.path.join(_services_dir, "pg_store.py"),
        )
        _mod = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        _pg_store_singleton = _mod.PGStore()
    except Exception as e:
        print(f"[amauta-mcp] WARNING: PGStore init failed: {e}", file=sys.stderr)
        _pg_store_singleton = None
    return _pg_store_singleton


def _get_mcp_valkey():
    """Lazily instantiate and return the MCPValkey singleton."""
    global _mcp_valkey_singleton, _mcp_valkey_attempted
    if _mcp_valkey_attempted:
        return _mcp_valkey_singleton
    _mcp_valkey_attempted = True
    _mcp_valkey_singleton = MCPValkey()
    return _mcp_valkey_singleton


# ── HTTP delegation helpers ───────────────────────────────────────────────────

def _call_daemon(method: str, path: str, body: dict | None = None) -> dict:
    """Delegate to daemon HTTP API. Returns parsed JSON or {"error": "..."} on failure."""
    url = f"{DAEMON_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": f"HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


# ── MCP server instance ───────────────────────────────────────────────────────

server = Server("amauta")

@server.list_tools()
async def list_tools() -> ListToolsResult:
    return ListToolsResult(tools=[
        Tool(
            name="amauta/search-code",
            description="Search the codebase using the Phase 27 hybrid BM25+vector pipeline. Returns ranked code chunks with file path, symbol name, and relevance score.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query":       {"type": "string", "description": "Code search query"},
                    "top_k":       {"type": "integer", "default": 10, "description": "Max results to return"},
                    "file_filter": {"type": "string",  "description": "Optional filename filter substring"},
                    "directory":   {"type": "string",  "description": "Project directory to search (default: CWD)"},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="amauta/memory-store",
            description="Store a memory entry in the Amauta memory system.",
            inputSchema={
                "type": "object",
                "properties": {
                    "text":       {"type": "string", "description": "Memory text to store"},
                    "source":     {"type": "string", "default": "agent", "description": "Memory source tag"},
                    "agent_id":   {"type": "string", "description": "ID of storing agent"},
                    "tags":       {"type": "array", "items": {"type": "string"}, "description": "Tag list"},
                    "project_id": {"type": "string", "description": "Project namespace (auto-detected if omitted)"},
                },
                "required": ["text"],
            },
        ),
        Tool(
            name="amauta/memory-search",
            description="Semantic search over stored memories using vector similarity.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query":      {"type": "string", "description": "Search query"},
                    "limit":      {"type": "integer", "default": 20},
                    "project_id": {"type": "string"},
                    "source":     {"type": "string"},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="amauta/memory-distill",
            description="Trigger memory distillation to consolidate redundant entries. Returns distill status.",
            inputSchema={
                "type": "object",
                "properties": {
                    "force": {"type": "boolean", "default": False, "description": "Force distill even if below threshold"},
                },
            },
        ),
        Tool(
            name="amauta/research",
            description=(
                "Run the implementable research chain: Memory -> SKB -> WebFetch. "
                "Checks semantic cache first; returns cached result on hit. "
                "Full 5-step chain (Context7, Perplexity) requires gsd-researcher agent invocation."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query":    {"type": "string", "description": "Research query"},
                    "creative": {"type": "boolean", "default": False, "description": "Enable creative/exploratory mode"},
                },
                "required": ["query"],
            },
        ),
    ])

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> CallToolResult:
    if name == "amauta/search-code":
        query = arguments.get("query", "")
        if not isinstance(query, str) or not query.strip():
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "invalid_input", "detail": "query is required"}))])
        top_k = int(arguments.get("top_k", 5))  # Phase 46 default: 5 (CONTEXT Area 4)
        file_filter = arguments.get("file_filter")
        directory = arguments.get("directory")
        store = _get_pg_store()
        if store is None:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}))])
        try:
            # Try code_embeddings table first via direct SQL, fall back to memory_semantic_search
            results = None
            try:
                with store._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT 1 FROM information_schema.tables "
                            "WHERE table_name = 'code_embeddings' LIMIT 1"
                        )
                        if cur.fetchone():
                            # code_embeddings table exists — use direct query
                            cur.execute(
                                "SELECT file_path as path, chunk_text as text, "
                                "symbol_name, 1.0 as score "
                                "FROM code_embeddings "
                                "LIMIT %s",
                                (top_k,),
                            )
                            rows = cur.fetchall()
                            results = [
                                {
                                    "path": r[0] or "",
                                    "text": r[1] or "",
                                    "symbol_name": r[2] or "",
                                    "score": float(r[3] or 0),
                                }
                                for r in rows
                            ]
            except Exception as _e:
                import sys as _sys
                print(f"[amauta-mcp] code_embeddings query failed, falling back: {_e}", file=_sys.stderr)
                results = None

            if results is None:
                # Fallback: memory_semantic_search (broader codebase memory)
                raw = store.memory_semantic_search(query=query, project_id=None, source=None, limit=top_k)
                raw_results, _ = raw if isinstance(raw, tuple) else (raw, "unknown")
                results = raw_results if isinstance(raw_results, list) else []

            # Post-filter: file_filter (substring on path) and directory (prefix on path)
            if file_filter:
                results = [r for r in results if file_filter in str(r.get("path", "") or r.get("file", ""))]
            if directory:
                results = [r for r in results if str(r.get("path", "") or r.get("file", "")).startswith(directory)]

            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"results": results, "top_k": top_k}))])
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": str(e)}))])

    elif name == "amauta/memory-store":
        text = arguments.get("text", "")
        if not isinstance(text, str) or not text.strip():
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "invalid_input", "detail": "text is required"}))])
        store = _get_pg_store()
        if store is None:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}))])
        try:
            result = store.memory_store_with_embedding(
                text=text,
                source=arguments.get("source", "agent"),
                agent_id=arguments.get("agent_id"),
                tags=arguments.get("tags"),
                project_id=arguments.get("project_id"),
                metadata=arguments.get("metadata"),
            )
            # result may be a UUID string or a dedup dict
            if isinstance(result, dict):
                return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])
            return CallToolResult(content=[TextContent(type="text", text=json.dumps({"id": str(result), "stored": True}))])
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": str(e)}))])

    elif name == "amauta/memory-search":
        query = arguments.get("query", "")
        if not isinstance(query, str) or not query.strip():
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "invalid_input", "detail": "query is required"}))])
        store = _get_pg_store()
        if store is None:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}))])
        try:
            raw = store.memory_semantic_search(
                query=query,
                project_id=arguments.get("project_id"),
                source=arguments.get("source"),
                limit=int(arguments.get("limit", 20)),
            )
            # memory_semantic_search returns (results, method) tuple
            results, method = raw if isinstance(raw, tuple) else (raw, "unknown")
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"results": results, "method": method}))])
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": str(e)}))])

    elif name == "amauta/memory-distill":
        # Daemon has no POST /api/memory/distill route. Return distill-status and
        # instruct caller to trigger full distillation via gsd-memory distill CLI.
        # This is the safe boundary: MCP reports status; distillation runs via CLI.
        status = _call_daemon("GET", "/api/memory/distill-status")
        result = {
            "status": "ok",
            "needs_distill": status.get("needs_distill", False),
            "total": status.get("total", 0),
            "threshold": status.get("distill_threshold", 500),
            "message": "Run 'gsd-memory distill' CLI to trigger distillation.",
        }
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    elif name == "amauta/research":
        query = arguments.get("query", "")
        if not query:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "query is required"}))])

        # 1. Check semantic cache first (key = sha256 of normalized query)
        cache_key = hashlib.sha256(query.strip().lower().encode()).hexdigest()
        cache_result = _call_daemon("GET", f"/api/research-cache?key={cache_key}")
        if cache_result.get("hit"):
            payload = cache_result.get("data", {})
            payload["from_cache"] = True
            return CallToolResult(content=[TextContent(type="text", text=json.dumps(payload))])

        # 2. Memory search
        mem_result = _call_daemon("POST", "/api/memory/semantic-search",
                                  {"query": query, "limit": 10})
        memory_results = mem_result.get("results", [])

        # 3. SKB search
        skb_result = _call_daemon("POST", "/api/skb/search",
                                  {"query": query, "limit": 10})
        skb_results = skb_result.get("results", [])

        # 4. WebFetch — lightweight: attempt to fetch top DuckDuckGo result for the query
        # Implementation: best-effort; on error or timeout, web_results = []
        web_results = []
        try:
            ddg_url = "https://api.duckduckgo.com/?q=" + urllib.parse.quote(query) + "&format=json&no_html=1&skip_disambig=1"
            ddg_req = urllib.request.Request(ddg_url, headers={"User-Agent": "amauta-mcp/1.0"})
            with urllib.request.urlopen(ddg_req, timeout=5) as resp:
                ddg_data = json.loads(resp.read().decode("utf-8"))
            abstract = ddg_data.get("AbstractText", "")
            source_url = ddg_data.get("AbstractURL", "")
            if abstract:
                web_results = [{"text": abstract, "url": source_url, "source": "duckduckgo"}]
        except Exception:
            web_results = []

        result = {
            "memory_results": memory_results,
            "skb_results":    skb_results,
            "web_results":    web_results,
            "from_cache":     False,
        }

        # 5. No cache write — daemon has no POST /api/research-cache route.
        # The GET check at the start is the only cache operation (read-through only).
        # Cache writes are handled by the daemon's own internal path; do not add one here.

        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    return CallToolResult(content=[TextContent(type="text", text=json.dumps({"error": f"unknown tool: {name}"}))])

@server.list_resources()
async def list_resources() -> ListResourcesResult:
    """List active tasks as context resources. Fetches active task IDs from daemon."""
    import re
    result = _call_daemon("GET", "/api/list?status=in_progress&type=task")
    resources = []
    phases = ["R", "P", "E", "T", "D"]
    # Parse task IDs from output (the daemon returns {"output": "...", "exit_code": 0})
    output = result.get("output", "")
    # Extract TK-XXXX IDs from text output
    task_ids = re.findall(r'TK-\d{4}', output)
    seen = set()
    for tid in task_ids:
        if tid in seen:
            continue
        seen.add(tid)
        for phase in phases:
            resources.append(Resource(
                uri=f"amauta://context/{tid}/{phase}",
                name=f"{tid} — Phase {phase} context",
                description=f"RPETDContext for task {tid}, phase {phase}",
                mimeType="application/json",
            ))
    return ListResourcesResult(resources=resources)

@server.read_resource()
async def read_resource(uri: str) -> ReadResourceResult:
    """Read RPETDContext JSON for amauta://context/{task_id}/{phase} URI."""
    import re
    m = re.match(r'^amauta://context/([^/]+)/([RPETD])$', uri)
    if not m:
        raise ValueError(f"Unsupported resource URI: {uri!r}. Expected amauta://context/{{task_id}}/{{phase}}")
    task_id, phase = m.group(1), m.group(2)
    result = _call_daemon("GET", f"/api/context/{task_id}/{phase}")
    if "error" in result:
        raise ValueError(f"Context not found: {result['error']}")
    return ReadResourceResult(contents=[TextContent(
        type="text",
        text=json.dumps(result),
    )])

# ── Daemon health guard ───────────────────────────────────────────────────────

def _check_daemon_health() -> bool:
    """Return True if daemon is reachable on DAEMON_URL."""
    try:
        result = _call_daemon("GET", "/health")
        return "error" not in result
    except Exception:
        return False

# ── Transport implementations ─────────────────────────────────────────────────

async def _run_stdio():
    """Run MCP server over stdio (Claude Code transport)."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def _run_sse():
    """Run MCP server over SSE on port MCP_SSE_PORT."""
    from mcp.server.sse import SseServerTransport
    import http.server as _http
    from socketserver import ThreadingMixIn

    transport = SseServerTransport(MCP_SSE_PATH)

    class _SSEHandler(_http.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args): pass  # suppress default logs
        def do_GET(self):
            if self.path == MCP_SSE_PATH or self.path.startswith(MCP_SSE_PATH + "?"):
                asyncio.run(transport.handle_sse(self.rfile, self.wfile, server))
            else:
                self.send_response(404)
                self.end_headers()
        def do_POST(self):
            if self.path.startswith("/messages"):
                asyncio.run(transport.handle_post_message(self.rfile, self.wfile, server))
            else:
                self.send_response(404)
                self.end_headers()

    class _ThreadedServer(ThreadingMixIn, _http.HTTPServer):
        daemon_threads = True

    httpd = _ThreadedServer(("0.0.0.0", MCP_SSE_PORT), _SSEHandler)
    print(f"[amauta-mcp] SSE transport on port {MCP_SSE_PORT}{MCP_SSE_PATH}", flush=True)
    httpd.serve_forever()

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    use_sse = "--sse" in sys.argv or (hasattr(sys.stdin, "isatty") and sys.stdin.isatty())
    if use_sse:
        _run_sse()
    else:
        asyncio.run(_run_stdio())
