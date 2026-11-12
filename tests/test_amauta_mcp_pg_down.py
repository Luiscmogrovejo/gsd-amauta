"""
tests/test_amauta_mcp_pg_down.py — PG-down resilience end-to-end test (Phase 46-02-06).

Verifies CONTEXT.md §Area 7 PG-down guarantee:
  - Server starts and lists tools even when PG is unreachable.
  - Tool calls return {"error": "pg_unavailable", ...} structured errors.
  - Resource reads return {"error": "pg_unavailable", ...} structured errors.
  - Server process does NOT exit due to tool/resource failures.
  - amauta/complexity-score still works (pure function — no PG dependency).

Skips gracefully when mcp Python package is not installed.
"""

import json
import os
import subprocess
import sys
import time

import pytest

# ── Skip gate: mcp package required ───────────────────────────────────────────

_MCP_AVAILABLE = False
try:
    import mcp  # noqa: F401
    _MCP_AVAILABLE = True
except ImportError:
    pass

pytestmark = pytest.mark.skipif(
    not _MCP_AVAILABLE,
    reason="mcp Python package not installed — PG-down integration test skipped",
)

# ── Constants ──────────────────────────────────────────────────────────────────

_SERVICES_DIR = os.path.join(os.path.dirname(__file__), "..", "services")
_SERVER_PATH = os.path.join(_SERVICES_DIR, "amauta-mcp.py")

# Frozen tool names (MCP-02 verbatim)
FROZEN_TOOL_NAMES = {
    "amauta/search-code",
    "amauta/memory-store",
    "amauta/memory-search",
    "amauta/memory-distill",
    "amauta/research",
    "amauta/complexity-score",
}


# ── JSON-RPC helpers (duplicated from test_amauta_mcp_stdio.py for isolation) ──

# Phase 88 plan 88-16-02: `select.select` accepts sockets only on Windows, so the
# previous reader raised OSError on a pipe, returned None, and every test skipped
# itself with "No ... response within timeout". The shared helper uses a reader
# thread and a queue, which is portable.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support"))
from jsonrpc_stdio import read_jsonrpc as _read_jsonrpc  # noqa: E402
from jsonrpc_stdio import send_jsonrpc as _send_jsonrpc  # noqa: E402
from jsonrpc_stdio import stderr_tail as _stderr_tail  # noqa: E402

#: JSON-RPC read budget. A loaded Windows runner needs far more than the 5-10 s
#: these calls used to allow: plan 88-16-02 turned "no response in time" from a
#: silent skip into a failure, and the first enforcing run showed
#: `amauta/complexity-score` exceeding 10 s there while every other call passed.
#: Generous is correct for a budget whose only job is to stop a hang: a server
#: that answers in 2 s is unaffected, and a server that never answers still
#: fails, just later.
_RPC_TIMEOUT = float(os.environ.get("GSD_MCP_RPC_TIMEOUT", "60"))


# ── Subprocess fixture ─────────────────────────────────────────────────────────

#: Temp SQLite databases created by _spawn_server_pg_down, removed at exit.
_TMP_SQLITE_DIRS = []


def _spawn_server_pg_down():
    """Spawn the MCP stdio server with PG deliberately unreachable.

    GSD_POSTGRES_URL=postgresql://invalid:1/none — bogus DSN that cannot resolve.

    GSD_SQLITE_PATH points at a throwaway file: the memory tools now fall back
    to the SQLite store when PG is down, and this test must not read or write
    the developer's real ~/.amauta/data/gsd_amauta.db.

    Returns Popen or None on startup failure.
    """
    import shutil
    import tempfile

    env = os.environ.copy()
    env["GSD_POSTGRES_URL"] = "postgresql://invalid:1/none"
    _tmp = tempfile.mkdtemp(prefix="mcp-pgdown-")
    _TMP_SQLITE_DIRS.append(_tmp)
    env["GSD_DATA_DIR"] = _tmp
    env["GSD_SQLITE_PATH"] = os.path.join(_tmp, "gsd_amauta.db")

    try:
        proc = subprocess.Popen(
            [sys.executable, _SERVER_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except Exception:
        return None

    # Give the server a moment to start
    time.sleep(0.3)
    if proc.poll() is not None:
        return None  # crashed on startup

    return proc


def _teardown(proc):
    """Terminate and reap the subprocess, then remove its temp SQLite dir."""
    import shutil

    if proc is not None:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    while _TMP_SQLITE_DIRS:
        shutil.rmtree(_TMP_SQLITE_DIRS.pop(), ignore_errors=True)


# ── Tests ──────────────────────────────────────────────────────────────────────

class TestPGDownResilience:
    """End-to-end PG-down resilience tests.

    Each test gets its own server subprocess (setup_method / teardown_method)
    to guarantee process isolation and satisfy the proc.poll() is None canary
    after independent activity in each test.
    """

    def setup_method(self):
        self.proc = _spawn_server_pg_down()
        if self.proc is None:
            pytest.fail(
                "MCP stdio server failed to start with the PG-down environment. "
                "This used to skip, which hid a dead server behind a green cell."
            )
        self._req_id = 0

    def teardown_method(self):
        _teardown(self.proc)
        self.proc = None

    def _next_id(self):
        self._req_id += 1
        return self._req_id

    def _do_initialize(self):
        """Send initialize + initialized notification. Returns response or None."""
        rid = self._next_id()
        _send_jsonrpc(self.proc, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-pg-down", "version": "0.0.1"},
        }, request_id=rid)
        resp = _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)
        # Send initialized notification (no response expected)
        _send_jsonrpc(self.proc, "notifications/initialized", {}, request_id=None)
        return resp

    def test_pg_down_server_starts_and_lists_tools(self):
        """Server starts with PG down and tools/list returns all 6 frozen names."""
        init_resp = self._do_initialize()
        if init_resp is None:
            pytest.fail("no initialize response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))

        # tools/list must succeed even with PG unreachable
        rid = self._next_id()
        _send_jsonrpc(self.proc, "tools/list", {}, request_id=rid)
        resp = _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no tools/list response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))

        result = resp.get("result", {})
        tools = result.get("tools", [])
        tool_names = {t.get("name") for t in tools}
        missing = FROZEN_TOOL_NAMES - tool_names
        assert not missing, (
            f"Server crashed or tool surface degraded under PG-down: missing {missing}"
        )

    def test_pg_down_memory_search_falls_back_to_sqlite(self):
        """amauta/memory-search with PG down now answers from the SQLite store.

        Previously it returned pg_unavailable even though SQLiteStore
        implements memory_semantic_search — the whole memory surface of the
        MCP server went dark whenever PostgreSQL was not running. The answer
        must be a real (possibly empty) result set tagged backend=sqlite, not
        an error.
        """
        self._do_initialize()

        rid = self._next_id()
        _send_jsonrpc(self.proc, "tools/call", {
            "name": "amauta/memory-search",
            "arguments": {"query": "anything"},
        }, request_id=rid)
        resp = _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no tools/call response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))
        content = resp.get("result", {}).get("content", [])
        assert content, f"No content in tools/call response: {resp}"
        text_block = next((c for c in content if c.get("type") == "text"), None)
        assert text_block is not None, f"No text content block in response: {content}"
        payload = json.loads(text_block["text"])
        assert payload.get("error") is None, (
            f"memory-search must not error on the SQLite fallback, got: {payload}"
        )
        assert isinstance(payload.get("results"), list), (
            f"Expected a results list from the SQLite fallback, got: {payload}"
        )
        assert payload.get("backend") == "sqlite", (
            f"Expected backend=sqlite marker, got: {payload}"
        )

    def test_pg_down_pg_only_tool_returns_pg_unavailable(self):
        """amauta/memory-distill (PG-only) still returns error='pg_unavailable'."""
        self._do_initialize()

        rid = self._next_id()
        _send_jsonrpc(self.proc, "tools/call", {
            "name": "amauta/memory-distill",
            "arguments": {},
        }, request_id=rid)
        resp = _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no tools/call response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))

        # The result may be in resp["result"]["content"] (CallToolResult shape)
        result = resp.get("result", {})
        content = result.get("content", [])
        assert content, f"No content in tools/call response: {resp}"

        # Parse the text payload — must have error='pg_unavailable'
        text_block = next((c for c in content if c.get("type") == "text"), None)
        assert text_block is not None, f"No text content block in response: {content}"

        payload = json.loads(text_block["text"])
        assert payload.get("error") == "pg_unavailable", (
            f"Expected error='pg_unavailable', got: {payload}"
        )

    def test_pg_down_resource_read_returns_pg_unavailable(self):
        """resources/read for amauta://findings/TK-0001 with PG down returns pg_unavailable in content."""
        self._do_initialize()

        rid = self._next_id()
        _send_jsonrpc(self.proc, "resources/read", {
            "uri": "amauta://findings/TK-0001",
        }, request_id=rid)
        resp = _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no resources/read response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))

        # Per CONTEXT Area 5: structured error is returned as resource content,
        # NOT as a JSON-RPC error code. The SDK returns it inside the content.
        # Check both paths: resp["result"]["contents"][...]["text"] or resp["error"]
        if "error" in resp and resp["error"]:
            # SDK mapped it to a JSON-RPC error — still acceptable; server stayed up
            pass
        else:
            result = resp.get("result", {})
            contents = result.get("contents", [])
            if contents:
                text = contents[0].get("text", "")
                try:
                    payload = json.loads(text)
                    assert payload.get("error") == "pg_unavailable", (
                        f"Expected error='pg_unavailable' in content, got: {payload}"
                    )
                except (json.JSONDecodeError, KeyError):
                    # If text is not JSON, still acceptable as long as server stayed up
                    pass

        # The critical invariant: process did NOT exit
        assert self.proc.poll() is None, (
            "Server process exited after resources/read with PG down — MUST stay running"
        )

    def test_pg_down_process_does_not_exit(self):
        """Server process is still running after tool + resource calls with PG down.

        This is the 'server NEVER exits because a tool failed' invariant from CONTEXT §Area 4.
        """
        self._do_initialize()

        # Activity 1: tool call (memory-search → pg_unavailable)
        rid = self._next_id()
        _send_jsonrpc(self.proc, "tools/call", {
            "name": "amauta/memory-search",
            "arguments": {"query": "test"},
        }, request_id=rid)
        _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)

        # Activity 2: another tool call (memory-distill → pg_unavailable)
        rid = self._next_id()
        _send_jsonrpc(self.proc, "tools/call", {
            "name": "amauta/memory-distill",
            "arguments": {},
        }, request_id=rid)
        _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)

        # Wait 2 seconds — then assert still alive
        time.sleep(2)
        assert self.proc.poll() is None, (
            "Server process exited after PG-down tool calls — must remain running"
        )

    def test_pg_down_complexity_score_still_works(self):
        """amauta/complexity-score works with PG down (pure function; no PG dependency).

        This is the final proof that daemon coupling is gone — even with PG unreachable
        the complexity scorer runs standalone via services/complexity_scorer.py.
        """
        self._do_initialize()

        rid = self._next_id()
        _send_jsonrpc(self.proc, "tools/call", {
            "name": "amauta/complexity-score",
            "arguments": {
                "task_meta": {
                    "title": "test task",
                    "description": "a short test task for Phase 46",
                    "files_expected": [],
                    "estimated_loc": 50,
                },
            },
        }, request_id=rid)
        resp = _read_jsonrpc(self.proc, request_id=rid, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no complexity-score response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))

        result = resp.get("result", {})
        content = result.get("content", [])
        assert content, f"No content in complexity-score response: {resp}"

        text_block = next((c for c in content if c.get("type") == "text"), None)
        assert text_block is not None, f"No text content block in complexity-score response"

        payload = json.loads(text_block["text"])

        # Must NOT be a pg_unavailable error — this tool is PG-free
        assert payload.get("error") != "pg_unavailable", (
            "amauta/complexity-score returned pg_unavailable — tool should NOT need PG"
        )

        # On success: must have 'score' field (integer 0..100)
        if "error" not in payload:
            assert "score" in payload, f"Expected 'score' in complexity-score result: {payload}"
            score = payload["score"]
            assert isinstance(score, (int, float)), f"score must be numeric, got {type(score)}: {score}"
            assert 0 <= score <= 100, f"score must be in [0, 100], got {score}"
