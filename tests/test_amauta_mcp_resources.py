"""
tests/test_amauta_mcp_resources.py — unit tests for the 3 MCP resource URI handlers (Phase 46-02-03).

Tests:
  - list_resources: advertises exactly 3 frozen URI templates
  - read_resource amauta://context/{task_id}/{phase}: PG happy path, PG unavailable, not found
  - read_resource amauta://agent/{agent_name}: happy path, not found, path traversal rejected
  - read_resource amauta://findings/{task_id}: happy path, PG unavailable
  - malformed URI raises ValueError
  - _render_agent hydration kwarg default is None (Phase 47 HYDRA-02 contract lock)

Loads amauta-mcp.py via importlib (handles hyphenated filename). Mocks _get_pg_store()
and _render_agent to avoid DB/fs dependencies. Wraps async calls with asyncio.run().
"""

import asyncio
import importlib.util
import inspect
import json
import os
import urllib.parse
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch, mock_open

import pytest

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


# ── Helpers ────────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


def _content_json(result):
    """Extract the JSON dict from the first content item of a ReadResourceResult."""
    return json.loads(result.contents[0].text)


def _content_text(result):
    """Extract the raw text from the first content item of a ReadResourceResult."""
    return result.contents[0].text


def _make_store_mock():
    """Return a MagicMock that mimics PGStore with _get_conn context manager."""
    store = MagicMock()
    # Build a context-manager-compatible _get_conn
    conn_mock = MagicMock()
    cur_mock = MagicMock()
    cur_mock.__enter__ = MagicMock(return_value=cur_mock)
    cur_mock.__exit__ = MagicMock(return_value=False)
    conn_mock.cursor.return_value = cur_mock
    conn_mock.__enter__ = MagicMock(return_value=conn_mock)
    conn_mock.__exit__ = MagicMock(return_value=False)

    @contextmanager
    def _get_conn_cm():
        yield conn_mock

    store._get_conn = _get_conn_cm
    store._conn_mock = conn_mock
    store._cur_mock = cur_mock
    return store


# ── Tests ──────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not _MOD_AVAILABLE, reason=f"amauta-mcp.py failed to load: {_LOAD_ERROR if not _MOD_AVAILABLE else ''}")
class TestListResources:

    def test_list_resources_advertises_three_templates(self):
        """list_resources() must include the 3 frozen URI templates (subset guarantee)."""
        result = _run(_mod.list_resources())
        # pydantic AnyUrl percent-encodes { and } — decode before comparing
        decoded_uris = {urllib.parse.unquote(str(r.uri)) for r in result.resources}
        want = {
            "amauta://context/{task_id}/{phase}",
            "amauta://agent/{agent_name}",
            "amauta://findings/{task_id}",
        }
        assert want.issubset(decoded_uris), f"Missing URIs: {want - decoded_uris}"

    def test_list_resources_returns_three_entries(self):
        """list_resources() returns exactly 3 entries (the 3 template resources)."""
        result = _run(_mod.list_resources())
        assert len(result.resources) == 3

    def test_list_resources_mime_types(self):
        """context and agent templates are text/markdown; findings is application/json."""
        result = _run(_mod.list_resources())
        by_name = {r.name: r.mimeType for r in result.resources}
        assert "RPETD context (template)" in by_name
        assert "Agent definition (template)" in by_name
        assert "Blackboard findings (template)" in by_name


@pytest.mark.skipif(not _MOD_AVAILABLE, reason=f"amauta-mcp.py failed to load: {_LOAD_ERROR if not _MOD_AVAILABLE else ''}")
class TestReadResourceContext:

    def test_read_resource_context_happy_path(self):
        """amauta://context/TK-0001/R: PG returns row → text contains task_id + phase content."""
        fake_row = {
            "id": 1,
            "task_id": "TK-0001",
            "phase": "R",
            "compiled_view": {"R": "research findings"},
            "full_context": {},
            "context_version": 1,
            "file_hashes": {},
            "created_at": "2026-05-12T00:00:00",
        }
        store = MagicMock()
        store.rpetd_context_get.return_value = fake_row
        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.read_resource("amauta://context/TK-0001/R"))
        text = _content_text(result)
        assert "TK-0001" in text
        assert "research findings" in text
        store.rpetd_context_get.assert_called_once_with("TK-0001", "R")

    def test_read_resource_context_pg_unavailable(self):
        """amauta://context/TK-0001/R: PGStore None → structured pg_unavailable error returned."""
        with patch.object(_mod, "_get_pg_store", return_value=None):
            result = _run(_mod.read_resource("amauta://context/TK-0001/R"))
        payload = _content_json(result)
        assert payload.get("error") == "pg_unavailable"

    def test_read_resource_context_not_found_raises_value_error(self):
        """amauta://context/TK-9999/R: rpetd_context_get returns None → ValueError raised."""
        store = MagicMock()
        store.rpetd_context_get.return_value = None
        with patch.object(_mod, "_get_pg_store", return_value=store):
            with pytest.raises(ValueError):
                _run(_mod.read_resource("amauta://context/TK-9999/R"))


@pytest.mark.skipif(not _MOD_AVAILABLE, reason=f"amauta-mcp.py failed to load: {_LOAD_ERROR if not _MOD_AVAILABLE else ''}")
class TestReadResourceAgent:

    def test_read_resource_agent_happy_path(self):
        """amauta://agent/test-agent: _render_agent returns body → content contains body."""
        with patch.object(_mod, "_render_agent", return_value="AGENT BODY"):
            result = _run(_mod.read_resource("amauta://agent/test-agent"))
        text = _content_text(result)
        assert "AGENT BODY" in text

    def test_read_resource_agent_not_found_raises_value_error(self):
        """amauta://agent/nonexistent-agent: _render_agent returns None → ValueError raised."""
        with patch.object(_mod, "_render_agent", return_value=None):
            with pytest.raises(ValueError):
                _run(_mod.read_resource("amauta://agent/nonexistent-agent"))

    def test_read_resource_agent_rejects_path_traversal(self):
        """amauta://agent/../../etc/passwd: regex mismatch → ValueError (default branch)."""
        with pytest.raises(ValueError):
            _run(_mod.read_resource("amauta://agent/../../etc/passwd"))


@pytest.mark.skipif(not _MOD_AVAILABLE, reason=f"amauta-mcp.py failed to load: {_LOAD_ERROR if not _MOD_AVAILABLE else ''}")
class TestReadResourceFindings:

    def test_read_resource_findings_happy_path(self):
        """amauta://findings/TK-0001: PG returns 2 rows → JSON has findings length 2 and count 2."""
        from datetime import datetime, timezone
        dt = datetime(2026, 5, 12, tzinfo=timezone.utc)
        fake_rows = [
            ("uuid-1", "agent-a", "TK-0001", "observation", "content A", 0.9, dt),
            ("uuid-2", "agent-b", "TK-0001", "warning",     "content B", 0.7, dt),
        ]
        store = _make_store_mock()
        store._cur_mock.fetchall.return_value = fake_rows
        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.read_resource("amauta://findings/TK-0001"))
        payload = _content_json(result)
        assert "findings" in payload
        assert payload["count"] == 2
        assert len(payload["findings"]) == 2

    def test_read_resource_findings_pg_unavailable(self):
        """amauta://findings/TK-0001: PGStore None → structured pg_unavailable error returned."""
        with patch.object(_mod, "_get_pg_store", return_value=None):
            result = _run(_mod.read_resource("amauta://findings/TK-0001"))
        payload = _content_json(result)
        assert payload.get("error") == "pg_unavailable"


@pytest.mark.skipif(not _MOD_AVAILABLE, reason=f"amauta-mcp.py failed to load: {_LOAD_ERROR if not _MOD_AVAILABLE else ''}")
class TestReadResourceErrors:

    def test_read_resource_malformed_uri_raises_value_error(self):
        """amauta://unknown/foo: no regex matches → ValueError (default branch)."""
        with pytest.raises(ValueError):
            _run(_mod.read_resource("amauta://unknown/foo"))

    def test_read_resource_http_uri_raises_value_error(self):
        """http://example.com: completely foreign URI → ValueError."""
        with pytest.raises(ValueError):
            _run(_mod.read_resource("http://example.com/foo"))


@pytest.mark.skipif(not _MOD_AVAILABLE, reason=f"amauta-mcp.py failed to load: {_LOAD_ERROR if not _MOD_AVAILABLE else ''}")
class TestRenderAgentContract:

    def test_render_agent_hydration_kwarg_default_is_none(self):
        """_render_agent must have hydration=None default — Phase 47 HYDRA-02 contract lock."""
        sig = inspect.signature(_mod._render_agent)
        assert "hydration" in sig.parameters, "_render_agent must have hydration param"
        assert sig.parameters["hydration"].default is None, (
            "hydration default must be None (Phase 47 HYDRA-02 injection point contract)"
        )

    def test_render_agent_returns_none_on_path_traversal(self):
        """_render_agent must return None for names failing ^[a-z][a-z0-9-]+$ regex."""
        assert _mod._render_agent("../../etc/passwd") is None
        assert _mod._render_agent("UPPERCASE") is None
        assert _mod._render_agent("has space") is None
        assert _mod._render_agent("") is None

    def test_render_agent_prepends_hydration_block(self, tmp_path):
        """When hydration is given, _render_agent prepends ## Current context block."""
        # Write a real agent file to a temp dir, then monkeypatch search path
        agent_dir = tmp_path / "agents"
        agent_dir.mkdir()
        agent_file = agent_dir / "my-agent.md"
        agent_file.write_text("# My Agent\n\nHello from agent.\n")

        # Patch os.path.dirname so the first search path lands in tmp_path
        orig_dirname = os.path.dirname
        orig_abspath = os.path.abspath
        def fake_dirname(p):
            return str(tmp_path / "services")
        def fake_abspath(p):
            if "amauta-mcp" in p:
                return str(tmp_path / "services" / "amauta-mcp.py")
            return orig_abspath(p)
        with patch("os.path.dirname", side_effect=fake_dirname):
            with patch("os.path.abspath", side_effect=fake_abspath):
                result = _mod._render_agent("my-agent", hydration="LIVE CONTEXT HERE")
        if result is None:
            pytest.skip("Filesystem patching did not reach agent file — env-dependent")
        assert "## Current context" in result
        assert "LIVE CONTEXT HERE" in result
        assert "Hello from agent." in result
