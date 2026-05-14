"""
tests/test_amauta_mcp_wrapper_tools.py — pytest integration tests for the two new
MCP wrapper tools: amauta/bearings (POLISH-03) and amauta/agent-hydrate (POLISH-04).

Loads amauta-mcp.py via importlib (handles hyphenated filename, Phase 46 pattern).
Uses unittest.mock.patch to isolate subprocess calls.
Mirrors Phase 46 test pattern from tests/test_amauta_mcp_tools.py.
"""

import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import unittest
from unittest.mock import MagicMock, patch

# ── Load the hyphenated module ─────────────────────────────────────────────────

_SERVICES_DIR = os.path.join(os.path.dirname(__file__), "..", "services")
_MODULE_PATH = os.path.join(_SERVICES_DIR, "amauta-mcp.py")


def _load_mod():
    spec = importlib.util.spec_from_file_location("amauta_mcp", _MODULE_PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


try:
    _mod = _load_mod()
    _MOD_AVAILABLE = True
except Exception as _e:
    _MOD_AVAILABLE = False
    _LOAD_ERROR = str(_e)

_NODE_AVAILABLE = shutil.which("node") is not None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


def _result_json(result):
    """Extract the JSON dict from a CallToolResult."""
    return json.loads(result.content[0].text)


def _make_proc(returncode=0, stdout="", stderr=""):
    """Build a mock CompletedProcess for use with patch('subprocess.run')."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.stdout = stdout
    proc.stderr = stderr
    return proc


# ── Test 1: amauta/bearings registered ────────────────────────────────────────

class TestBearingsToolRegistered(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_bearings_tool_registered(self):
        """list_tools() TOOLS list contains a Tool with name 'amauta/bearings'."""
        result = _run(_mod.list_tools())
        names = [t.name for t in result.tools]
        self.assertIn(
            "amauta/bearings",
            names,
            f"amauta/bearings not found in tool names: {names}",
        )


# ── Test 2: amauta/agent-hydrate registered ───────────────────────────────────

class TestAgentHydrateToolRegistered(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_agent_hydrate_tool_registered(self):
        """list_tools() TOOLS list contains a Tool with name 'amauta/agent-hydrate'."""
        result = _run(_mod.list_tools())
        names = [t.name for t in result.tools]
        self.assertIn(
            "amauta/agent-hydrate",
            names,
            f"amauta/agent-hydrate not found in tool names: {names}",
        )


# ── Test 3: bearings handler returns parsed JSON ───────────────────────────────

class TestBearingsHandlerReturnsParsedJson(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_bearings_handler_returns_parsed_json(self):
        """amauta/bearings handler with terse=False returns parsed dict preserving schema_version."""
        fake_payload = json.dumps({"schema_version": "1.0", "state": "ok", "recommendations": []})
        mock_proc = _make_proc(returncode=0, stdout=fake_payload)

        with patch("subprocess.run", return_value=mock_proc):
            result = _run(_mod.call_tool("amauta/bearings", {"terse": False}))

        data = _result_json(result)
        self.assertNotIn("error", data, f"Unexpected error in bearings response: {data}")
        self.assertEqual(
            data.get("schema_version"),
            "1.0",
            f"Expected schema_version='1.0', got: {data}",
        )


# ── Test 4: agent-hydrate requires agent_name ─────────────────────────────────

class TestAgentHydrateRequiresAgentName(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_agent_hydrate_handler_requires_agent_name(self):
        """amauta/agent-hydrate with empty args returns invalid_input containing 'agent_name is required'."""
        result = _run(_mod.call_tool("amauta/agent-hydrate", {}))
        data = _result_json(result)
        self.assertEqual(
            data.get("error"),
            "invalid_input",
            f"Expected invalid_input error, got: {data}",
        )
        self.assertIn(
            "agent_name is required",
            data.get("detail", ""),
            f"Expected 'agent_name is required' in detail, got: {data}",
        )


# ── Test 5: agent-hydrate passes task_id ──────────────────────────────────────

class TestAgentHydratePassesTaskId(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_agent_hydrate_handler_passes_task_id(self):
        """amauta/agent-hydrate passes --task-id TK-1 in subprocess cmd args."""
        fake_payload = json.dumps({"schema_version": "1.0", "agent": "gsd-planner"})
        mock_proc = _make_proc(returncode=0, stdout=fake_payload)

        captured_cmd = []

        def capture_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            return mock_proc

        with patch("subprocess.run", side_effect=capture_run):
            result = _run(_mod.call_tool(
                "amauta/agent-hydrate",
                {"agent_name": "gsd-planner", "task_id": "TK-1"},
            ))

        data = _result_json(result)
        self.assertNotIn("error", data, f"Unexpected error: {data}")
        self.assertIn("--task-id", captured_cmd, f"--task-id not in cmd: {captured_cmd}")
        # task_id value should follow --task-id
        idx = captured_cmd.index("--task-id")
        self.assertEqual(
            captured_cmd[idx + 1],
            "TK-1",
            f"Expected TK-1 after --task-id, got: {captured_cmd[idx + 1]}",
        )


# ── Test 6: subprocess pg_unavailable error mapping ───────────────────────────

class TestSubprocessWrapperHandlesPgUnavailable(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_subprocess_wrapper_handles_pg_unavailable(self):
        """_subprocess_wrap_gsd_tools with exit code 1 + 'pg_unavailable' in stderr → error='pg_unavailable'."""
        mock_proc = _make_proc(returncode=1, stdout="", stderr="pg_unavailable: database not reachable")

        with patch("subprocess.run", return_value=mock_proc):
            result = _mod._subprocess_wrap_gsd_tools("bearings", [])

        self.assertEqual(
            result.get("error"),
            "pg_unavailable",
            f"Expected pg_unavailable error, got: {result}",
        )
        self.assertIn("detail", result, "Expected detail key in error response")


# ── Test 7: subprocess timeout ────────────────────────────────────────────────

class TestSubprocessWrapperHandlesTimeout(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_subprocess_wrapper_handles_timeout(self):
        """_subprocess_wrap_gsd_tools with TimeoutExpired → error='internal_error' with 'timed out' in detail."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["node"], timeout=30)):
            result = _mod._subprocess_wrap_gsd_tools("bearings", [], timeout=30)

        self.assertEqual(
            result.get("error"),
            "internal_error",
            f"Expected internal_error on timeout, got: {result}",
        )
        self.assertIn(
            "timed out",
            result.get("detail", ""),
            f"Expected 'timed out' in detail, got: {result}",
        )


# ── Test 8: Phase 46 six tools regression lock ───────────────────────────────

class TestPhase46SixToolsStillRegistered(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_phase_46_six_tools_still_registered(self):
        """TOOLS list contains all 6 original Phase 46 tool names (regression lock)."""
        result = _run(_mod.list_tools())
        names = {t.name for t in result.tools}
        phase46_tools = {
            "amauta/search-code",
            "amauta/memory-store",
            "amauta/memory-search",
            "amauta/memory-distill",
            "amauta/research",
            "amauta/complexity-score",
        }
        missing = phase46_tools - names
        self.assertEqual(
            missing,
            set(),
            f"Phase 46 tool names missing from tool list: {missing}. Current names: {names}",
        )


if __name__ == "__main__":
    unittest.main()
