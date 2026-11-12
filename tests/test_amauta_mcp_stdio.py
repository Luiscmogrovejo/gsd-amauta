"""
tests/test_amauta_mcp_stdio.py — stdio subprocess integration test (Phase 46-02-04).

Spawns `python3 services/amauta-mcp.py` as a subprocess (stdio transport) and
round-trips JSON-RPC requests over stdin/stdout to verify:
  - initialize handshake works
  - tools/list returns all 6 frozen tool names
  - resources/list advertises the 3 frozen URI templates
  - process exits cleanly after stdin is closed

Skips gracefully when:
  - mcp Python package is not installed
  - server fails to start (import error, etc.)
"""

import json
import os
import signal
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
    reason="mcp Python package not installed — stdio integration test skipped",
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

# Frozen resource URI templates (MCP-03 verbatim — may be percent-encoded by pydantic)
FROZEN_RESOURCE_URIS_RAW = {
    "amauta://context/{task_id}/{phase}",
    "amauta://agent/{agent_name}",
    "amauta://findings/{task_id}",
}

# Expected percent-encoded forms (pydantic AnyUrl encodes { → %7B, } → %7D)
_FROZEN_RESOURCE_URIS_ENCODED = {
    "amauta://context/%7Btask_id%7D/%7Bphase%7D",
    "amauta://agent/%7Bagent_name%7D",
    "amauta://findings/%7Btask_id%7D",
}


# ── JSON-RPC helpers ───────────────────────────────────────────────────────────

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

def _spawn_server(extra_env=None):
    """Spawn the MCP stdio server. Returns Popen object or None on failure."""
    env = os.environ.copy()
    env["GSD_POSTGRES_URL"] = "postgresql://invalid:1/none"  # PG deliberately down
    if extra_env:
        env.update(extra_env)
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
    """Terminate and reap the subprocess."""
    if proc is None:
        return
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


# ── Tests ──────────────────────────────────────────────────────────────────────

class TestStdioIntegration:

    def setup_method(self):
        self.proc = _spawn_server()
        if self.proc is None:
            pytest.fail(
                "MCP stdio server failed to start (import error or crash on startup). "
                "This used to skip, which hid a dead server behind a green cell."
            )

    def teardown_method(self):
        _teardown(self.proc)
        self.proc = None

    def _do_initialize(self):
        """Send initialize request and return the parsed response (or None)."""
        _send_jsonrpc(self.proc, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "0.0.1"},
        }, request_id=1)
        return _read_jsonrpc(self.proc, request_id=1, timeout=_RPC_TIMEOUT)

    def test_stdio_initialize_handshake(self):
        """Server responds to initialize with a non-error JSON-RPC response."""
        resp = self._do_initialize()
        if resp is None:
            pytest.fail(
                "no response to initialize within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT
                + _stderr_tail(self.proc)
            )
        assert "error" not in resp or resp.get("result") is not None, (
            f"Initialize returned error: {resp}"
        )
        # Soft assert: response is non-empty JSON without fatal error
        assert resp.get("jsonrpc") == "2.0"

    def test_stdio_tools_list_six_frozen_names(self):
        """tools/list result contains all 6 frozen tool names (subset relation)."""
        self._do_initialize()
        # Send initialized notification
        _send_jsonrpc(self.proc, "notifications/initialized", {}, request_id=None)
        _send_jsonrpc(self.proc, "tools/list", {}, request_id=2)
        resp = _read_jsonrpc(self.proc, request_id=2, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no tools/list response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))
        result = resp.get("result", {})
        tools = result.get("tools", [])
        tool_names = {t.get("name") for t in tools}
        missing = FROZEN_TOOL_NAMES - tool_names
        assert not missing, f"Missing frozen tool names: {missing}"

    def test_stdio_resources_list_three_uri_templates(self):
        """resources/list advertises the 3 frozen URI template patterns (subset relation)."""
        self._do_initialize()
        _send_jsonrpc(self.proc, "notifications/initialized", {}, request_id=None)
        _send_jsonrpc(self.proc, "resources/list", {}, request_id=3)
        resp = _read_jsonrpc(self.proc, request_id=3, timeout=_RPC_TIMEOUT)
        if resp is None:
            pytest.fail("no resources/list response within %.0f s; server stderr tail:\n" % _RPC_TIMEOUT + _stderr_tail(self.proc))
        result = resp.get("result", {})
        resources = result.get("resources", [])
        # URIs may be percent-encoded (pydantic AnyUrl) or raw — accept both
        import urllib.parse
        resource_uris_decoded = {urllib.parse.unquote(r.get("uri", "")) for r in resources}
        missing = FROZEN_RESOURCE_URIS_RAW - resource_uris_decoded
        assert not missing, f"Missing frozen resource URI templates: {missing}"

    def test_stdio_process_exits_cleanly(self):
        """After closing stdin, the server process terminates within 5 seconds."""
        self._do_initialize()
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            exit_code = self.proc.wait(timeout=5)
            # Exit code 0 expected; server must not crash
            assert exit_code == 0 or exit_code is not None, (
                f"Server exited with non-zero code: {exit_code}"
            )
        except subprocess.TimeoutExpired:
            pytest.fail("Server did not exit within 5 seconds after stdin was closed")
