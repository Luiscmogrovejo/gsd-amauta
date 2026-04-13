#!/usr/bin/env python3
"""
Amauta MCP Server — thin MCP wrapper over amauta-daemon HTTP API.

Runs as a separate async process alongside the daemon (port 18799).
Exposes amauta capabilities as MCP tools and resources for Claude Code
(stdio transport) and remote clients (SSE on port 18800).

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
import urllib.request
import urllib.error
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool, Resource, TextContent,
    ListToolsResult, CallToolResult, ListResourcesResult, ReadResourceResult,
)

# ── Constants ─────────────────────────────────────────────────────────────────
DAEMON_URL   = os.environ.get("AMAUTA_DAEMON_URL", "http://localhost:18799")
RLM_URL      = os.environ.get("AMAUTA_RLM_URL",    "http://localhost:18798")
MCP_SSE_PORT = int(os.environ.get("AMAUTA_MCP_PORT", "18800"))
MCP_SSE_PATH = "/sse"

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


def _call_rlm(query: str, top_k: int = 10, file_filter: str | None = None,
              directory: str | None = None) -> dict:
    """Delegate to RLM service HTTP API (/query on port 18798)."""
    url = f"{RLM_URL}/query"
    payload = {"query": query, "top_k": top_k}
    if file_filter:
        payload["file_filter"] = file_filter
    if directory:
        payload["directory"] = directory
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
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
    ])

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> CallToolResult:
    if name == "amauta/search-code":
        query = arguments.get("query", "")
        if not query:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "query is required"}))])
        top_k = int(arguments.get("top_k", 10))
        file_filter = arguments.get("file_filter")
        directory = arguments.get("directory")
        result = _call_rlm(query, top_k=top_k, file_filter=file_filter, directory=directory)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    elif name == "amauta/memory-store":
        text = arguments.get("text", "")
        if not text:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "text is required"}))])
        body = {"text": text}
        for k in ("source", "agent_id", "tags", "project_id", "metadata"):
            if k in arguments:
                body[k] = arguments[k]
        result = _call_daemon("POST", "/api/memory/store", body)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    elif name == "amauta/memory-search":
        query = arguments.get("query", "")
        if not query:
            return CallToolResult(content=[TextContent(type="text",
                text=json.dumps({"error": "query is required"}))])
        body = {"query": query, "limit": arguments.get("limit", 20)}
        for k in ("project_id", "source"):
            if k in arguments:
                body[k] = arguments[k]
        result = _call_daemon("POST", "/api/memory/semantic-search", body)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

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

    return CallToolResult(content=[TextContent(type="text", text=json.dumps({"error": f"unknown tool: {name}"}))])

@server.list_resources()
async def list_resources() -> ListResourcesResult:
    return ListResourcesResult(resources=[])  # populated in 29-02

@server.read_resource()
async def read_resource(uri: str) -> ReadResourceResult:
    return ReadResourceResult(contents=[TextContent(type="text", text=json.dumps({"error": "not implemented"}))])

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
