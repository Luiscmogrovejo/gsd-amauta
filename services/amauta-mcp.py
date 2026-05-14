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
    Tool, Resource, TextContent, TextResourceContents,
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


def _subprocess_wrap_gsd_tools(action: str, args: list, timeout: int = 30) -> dict:
    """Shell out to `node get-shit-done/bin/gsd-tools.cjs <action> <args...> --json`.
    Returns parsed JSON on success; structured error dict on failure.
    Used by amauta/bearings (POLISH-03) and amauta/agent-hydrate (POLISH-04) wrapper tools."""
    import subprocess
    import json as _json
    import os.path
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                          'get-shit-done', 'bin', 'gsd-tools.cjs')
    cmd = ['node', script, action] + args + ['--json']
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": "internal_error", "detail": f"gsd-tools {action} timed out after {timeout}s"}
    if proc.returncode != 0:
        # Map Phase 45/47 exit codes to MCP error vocabulary
        code = "pg_unavailable" if "pg_unavailable" in (proc.stderr or "") else \
               "valkey_unavailable" if "valkey_unavailable" in (proc.stderr or "") else \
               "invalid_input" if proc.returncode == 1 else "internal_error"
        return {"error": code, "detail": (proc.stderr or proc.stdout).strip()[:500]}
    try:
        return _json.loads(proc.stdout)
    except _json.JSONDecodeError as e:
        return {"error": "internal_error", "detail": f"non-JSON stdout from gsd-tools {action}: {e}"}


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


# ── Agent definition filesystem helper ───────────────────────────────────────

def _render_agent(name: str, hydration=None):
    """Phase 47 HYDRA-02 injection point — hydration kwarg reserved for `## Current context` prepend; Phase 46 always passes None.

    Reads agent definition markdown from the filesystem. Search order:
      1. <repo>/agents/<name>.md
      2. ~/.claude/agents/<name>.md

    Args:
        name: Agent name (must match ^[a-z][a-z0-9-]+$). Returns None on mismatch.
        hydration: Optional string prepended as a fenced context block before the
            agent body. Phase 46 always passes None; Phase 47 HYDRA-02 passes the
            live context block.

    Returns:
        str or None: Agent markdown content (with optional hydration block prepended),
            or None if name is invalid or no file is found.
    """
    import re as _re
    if not _re.match(r'^[a-z][a-z0-9-]+$', name):
        return None
    search_paths = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents", f"{name}.md"),
        os.path.expanduser(f"~/.claude/agents/{name}.md"),
    ]
    for candidate in search_paths:
        try:
            with open(candidate, "r", encoding="utf-8") as fh:
                body = fh.read()
            if hydration is not None and isinstance(hydration, str) and hydration:
                return f"## Current context\n\n{hydration}\n\n---\n\n{body}"
            return body
        except OSError:
            continue
    return None


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
        Tool(
            name="amauta/complexity-score",
            description="Compute a deterministic 0-100 complexity score for a task plan using the Phase 42 SCALE-01 scorer. Returns score + 7-feature breakdown.",
            inputSchema={
                "type": "object",
                "properties": {
                    "plan_path":    {"type": "string", "description": "Path to PLAN.md file (optional)"},
                    "task_meta":    {"type": "object", "description": "Task metadata: files_expected, estimated_loc, description, title"},
                    "project_root": {"type": "string", "default": ".", "description": "Project root for relative path resolution"},
                },
                "required": ["task_meta"],
            },
        ),
        Tool(
            name="amauta/bearings",
            description="Deterministic project bearings (state, recent activity, plan progress, pattern stats, recommendation). Wraps `gsd-tools bearings --json`.",
            inputSchema={
                "type": "object",
                "properties": {
                    "terse": {"type": "boolean", "default": False, "description": "Compress output to 400 tokens"},
                    "token_budget": {"type": "integer", "default": 600, "description": "Max token budget for output"},
                },
            },
        ),
        Tool(
            name="amauta/agent-hydrate",
            description="Agent-specific hydration block: memory + blackboard + valkey + security. Wraps `gsd-tools agent-hydrate --json`.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_name": {"type": "string", "description": "Agent name (e.g. gsd-planner)"},
                    "task_id": {"type": "string", "description": "Optional task ID for task-scoped findings"},
                },
                "required": ["agent_name"],
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
        store = _get_pg_store()
        if store is None:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}))])
        try:
            total = store.memory_count(project_id=None)
            result = {
                "status": "ok",
                "needs_distill": total >= 500,
                "total": total,
                "threshold": 500,
                "message": "Run 'gsd-memory distill' CLI to trigger distillation.",
            }
            return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": str(e)}))])

    elif name == "amauta/research":
        query = arguments.get("query", "")
        if not isinstance(query, str) or not query.strip():
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "invalid_input", "detail": "query is required"}))])

        # 1. Valkey semantic cache check (key = "amauta:research:" + sha256)
        cache_key = "amauta:research:" + hashlib.sha256(query.strip().lower().encode()).hexdigest()
        valkey = _get_mcp_valkey()
        if valkey.available():
            cached = valkey.get(cache_key)
            if cached is not None:
                try:
                    payload = json.loads(cached)
                    payload["from_cache"] = True
                    return CallToolResult(content=[TextContent(type="text", text=json.dumps(payload))])
                except Exception:
                    pass  # Corrupted cache entry — fall through to fresh fetch
        # Valkey unavailable → skip cache gracefully (no error)

        store = _get_pg_store()
        if store is None:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}))])

        try:
            # 2. Memory search (direct PGStore)
            raw_mem = store.memory_semantic_search(query=query, limit=10)
            memory_results, _ = raw_mem if isinstance(raw_mem, tuple) else (raw_mem, "unknown")
            if not isinstance(memory_results, list):
                memory_results = []

            # 3. SKB search (direct PGStore)
            try:
                skb_results = store.skb_search(query=query, limit=10)
                if not isinstance(skb_results, list):
                    skb_results = []
            except Exception:
                skb_results = []

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

            # 5. Best-effort Valkey SETEX (ttl=3600); swallow failures
            if valkey.available():
                valkey.setex(cache_key, 3600, json.dumps(result))

            return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": str(e)}))])

    elif name == "amauta/complexity-score":
        try:
            from services.complexity_scorer import extract_features, score_features
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": f"complexity_scorer import failed: {e}"}))])
        task_meta = arguments.get("task_meta")
        if not isinstance(task_meta, dict):
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "invalid_input", "detail": "task_meta dict required"}))])
        plan_path = arguments.get("plan_path")
        project_root = arguments.get("project_root", ".")
        try:
            features = extract_features(plan_path, task_meta, project_root)
            score = score_features(features)
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"score": score, "features": features}))])
        except Exception as e:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "internal_error", "detail": str(e)}))])

    elif name == "amauta/bearings":
        extra = []
        if arguments.get("terse"):
            extra.append("--terse")
        if "token_budget" in arguments:
            extra.extend(["--token-budget", str(arguments["token_budget"])])
        result = _subprocess_wrap_gsd_tools("bearings", extra)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    elif name == "amauta/agent-hydrate":
        agent_name = arguments.get("agent_name")
        if not agent_name:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "invalid_input", "detail": "agent_name is required"}))])
        extra = [agent_name]
        if arguments.get("task_id"):
            extra.extend(["--task-id", arguments["task_id"]])
        result = _subprocess_wrap_gsd_tools("agent-hydrate", extra)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    return CallToolResult(content=[TextContent(type="text", text=json.dumps({"error": f"unknown tool: {name}"}))])

@server.list_resources()
async def list_resources() -> ListResourcesResult:
    """Advertise the three frozen resource URI templates (MCP-03 verbatim).

    Returns template entries as discoverability hints — Phase 46 exposes the
    URI patterns, not a concrete enumeration of live task IDs.
    """
    return ListResourcesResult(resources=[
        Resource(
            uri="amauta://context/{task_id}/{phase}",
            name="RPETD context (template)",
            description="amauta://context/<task_id>/<R|P|E|T|D> — returns compiled RPETD context as text/markdown",
            mimeType="text/markdown",
        ),
        Resource(
            uri="amauta://agent/{agent_name}",
            name="Agent definition (template)",
            description="amauta://agent/<agent_name> — returns the agent .md content (filesystem-backed)",
            mimeType="text/markdown",
        ),
        Resource(
            uri="amauta://findings/{task_id}",
            name="Blackboard findings (template)",
            description="amauta://findings/<task_id> — returns agent_findings rows as JSON",
            mimeType="application/json",
        ),
    ])


def _format_rpetd_md(row: dict) -> str:
    """Format an rpetd_context row as markdown for the context resource."""
    task_id = row.get("task_id", "")
    phase = row.get("phase", "")
    compiled_view = row.get("compiled_view")
    created_at = row.get("created_at", "")
    if isinstance(compiled_view, str):
        try:
            compiled_view = json.loads(compiled_view)
        except Exception:
            pass
    if isinstance(compiled_view, dict):
        body_parts = []
        for section, content in compiled_view.items():
            body_parts.append(f"## {section}\n\n{content}")
        body = "\n\n".join(body_parts) if body_parts else str(compiled_view)
    else:
        body = str(compiled_view) if compiled_view else ""
    return f"# RPETD Context: {task_id} / Phase {phase}\n\n_Created: {created_at}_\n\n{body}"


@server.read_resource()
async def read_resource(uri: str) -> ReadResourceResult:
    """Route resource URI to one of three handlers: context, agent, or findings.

    URI patterns:
        amauta://context/{task_id}/{phase}  — PG query via rpetd_context_get()
        amauta://agent/{agent_name}          — filesystem read via _render_agent()
        amauta://findings/{task_id}          — PG SELECT from agent_findings table
    """
    import re
    # Branch 1: RPETD context
    m = re.match(r'^amauta://context/(TK-\d{4,})/([RPETD])$', str(uri))
    if m:
        task_id, phase = m.group(1), m.group(2)
        store = _get_pg_store()
        if store is None:
            return ReadResourceResult(contents=[TextResourceContents(
                uri=uri,
                mimeType="application/json",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}),
            )])
        row = store.rpetd_context_get(task_id, phase)
        if row is None:
            raise ValueError(f"Context not found: {uri}")
        return ReadResourceResult(contents=[TextResourceContents(
            uri=uri,
            mimeType="text/markdown",
            text=_format_rpetd_md(row),
        )])

    # Branch 2: Agent definition
    m = re.match(r'^amauta://agent/([a-z][a-z0-9-]+)$', str(uri))
    if m:
        name = m.group(1)
        body = _render_agent(name, hydration=None)
        if body is None:
            raise ValueError(f"Agent not found: {uri}")
        return ReadResourceResult(contents=[TextResourceContents(
            uri=uri,
            mimeType="text/markdown",
            text=body,
        )])

    # Branch 3: Blackboard findings
    m = re.match(r'^amauta://findings/(TK-\d{4,})$', str(uri))
    if m:
        task_id = m.group(1)
        store = _get_pg_store()
        if store is None:
            return ReadResourceResult(contents=[TextResourceContents(
                uri=uri,
                mimeType="application/json",
                text=json.dumps({"error": "pg_unavailable", "detail": "PGStore unavailable"}),
            )])
        try:
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, agent_name, task_id, finding_type, content, confidence, created_at "
                        "FROM agent_findings WHERE task_id = %s ORDER BY created_at DESC",
                        (task_id,),
                    )
                    raw_rows = cur.fetchall()
            findings = [
                {
                    "id": str(r[0]),
                    "agent_name": r[1],
                    "task_id": r[2],
                    "finding_type": r[3],
                    "content": r[4],
                    "confidence": r[5],
                    "created_at": r[6].isoformat() if r[6] else None,
                }
                for r in raw_rows
            ]
            return ReadResourceResult(contents=[TextResourceContents(
                uri=uri,
                mimeType="application/json",
                text=json.dumps({"findings": findings, "count": len(findings)}),
            )])
        except Exception as e:
            return ReadResourceResult(contents=[TextResourceContents(
                uri=uri,
                mimeType="application/json",
                text=json.dumps({"error": "pg_unavailable", "detail": str(e)}),
            )])

    # Default: unrecognized URI
    raise ValueError(
        f"Unsupported resource URI: {uri!r}. Expected one of "
        "amauta://context/{task_id}/{phase}, "
        "amauta://agent/{agent_name}, "
        "amauta://findings/{task_id}"
    )

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
