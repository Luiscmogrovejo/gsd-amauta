"""
tests/test_amauta_mcp_tools.py — per-tool unit tests for all 6 MCP tools (Phase 46 Task 46-01-09).

Loads amauta-mcp.py via importlib (handles hyphenated filename). Mocks _get_pg_store()
and _get_mcp_valkey() to avoid DB dependency. Wraps async calls with asyncio.run().
"""

import asyncio
import importlib.util
import json
import os
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


# ── Helpers ────────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


def _result_json(result):
    """Extract the JSON dict from a CallToolResult."""
    return json.loads(result.content[0].text)


def _mock_store(
    memory_store_return=None,
    memory_search_return=None,
    memory_count_return=0,
    skb_search_return=None,
):
    """Build a MagicMock store with frozen method signatures."""
    store = MagicMock()
    store.memory_store_with_embedding.return_value = memory_store_return or {"id": "mem-1", "stored": True}
    store.memory_semantic_search.return_value = (memory_search_return or [], "vector")
    store.memory_count.return_value = memory_count_return
    store.skb_search.return_value = skb_search_return or []
    return store


def _mock_valkey(available=False, get_return=None, setex_return=True):
    """Build a MagicMock MCPValkey with controlled behavior."""
    v = MagicMock()
    v.available.return_value = available
    v.get.return_value = get_return
    v.setex.return_value = setex_return
    return v


# ── Test cases ─────────────────────────────────────────────────────────────────

class TestListTools(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_list_tools_exposes_six_frozen_names(self):
        """list_tools() must return exactly the 6 frozen tool names (MCP-02)."""
        result = _run(_mod.list_tools())
        names = {t.name for t in result.tools}
        expected = {
            "amauta/search-code",
            "amauta/memory-store",
            "amauta/memory-search",
            "amauta/memory-distill",
            "amauta/research",
            "amauta/complexity-score",
        }
        self.assertEqual(names, expected, f"Tool set mismatch. Got: {names}")


class TestMemoryStoreTool(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_memory_store_invalid_input(self):
        """amauta/memory-store with empty arguments returns invalid_input error."""
        with patch.object(_mod, "_get_pg_store", return_value=_mock_store()):
            result = _run(_mod.call_tool("amauta/memory-store", {}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "invalid_input", f"Expected invalid_input, got: {data}")

    def test_memory_store_happy_path(self):
        """amauta/memory-store with valid text calls memory_store_with_embedding once."""
        store = _mock_store(memory_store_return={"id": "mem-1", "stored": True})
        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/memory-store", {"text": "hello world"}))
        data = _result_json(result)
        store.memory_store_with_embedding.assert_called_once()
        self.assertEqual(str(data.get("id")), "mem-1", f"Expected id=mem-1, got: {data}")

    def test_memory_store_pg_unavailable(self):
        """amauta/memory-store returns pg_unavailable when store is None."""
        with patch.object(_mod, "_get_pg_store", return_value=None):
            result = _run(_mod.call_tool("amauta/memory-store", {"text": "hello"}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "pg_unavailable")


class TestMemorySearchTool(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_memory_search_pg_unavailable(self):
        """amauta/memory-search returns pg_unavailable when _get_pg_store() is None."""
        with patch.object(_mod, "_get_pg_store", return_value=None):
            result = _run(_mod.call_tool("amauta/memory-search", {"query": "x"}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "pg_unavailable")

    def test_memory_search_invalid_input(self):
        """amauta/memory-search with empty query returns invalid_input."""
        with patch.object(_mod, "_get_pg_store", return_value=_mock_store()):
            result = _run(_mod.call_tool("amauta/memory-search", {"query": ""}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "invalid_input")

    def test_memory_search_happy_path(self):
        """amauta/memory-search returns results list on success."""
        store = _mock_store(memory_search_return=[{"text": "a result", "id": "m1"}])
        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/memory-search", {"query": "test query"}))
        data = _result_json(result)
        self.assertIn("results", data, f"Expected results key, got: {data}")
        self.assertEqual(len(data["results"]), 1)


class TestSearchCodeTool(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_search_code_post_filter_directory(self):
        """amauta/search-code directory filter retains only matching paths."""
        fake_rows = [
            {"path": "services/pg_store.py", "text": "PGStore class"},
            {"path": "tests/test_pg.py", "text": "test file"},
            {"path": "services/amauta-mcp.py", "text": "MCP server"},
        ]
        store = _mock_store(memory_search_return=fake_rows)
        # Make _get_conn a context manager returning a fake conn
        fake_conn = MagicMock()
        fake_cur = MagicMock()
        fake_cur.fetchone.return_value = None  # code_embeddings table absent
        fake_conn.__enter__ = MagicMock(return_value=fake_conn)
        fake_conn.__exit__ = MagicMock(return_value=False)
        fake_conn.cursor.return_value.__enter__ = MagicMock(return_value=fake_cur)
        fake_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value = fake_conn

        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/search-code", {
                "query": "test",
                "directory": "services/",
            }))
        data = _result_json(result)
        results = data.get("results", [])
        for r in results:
            path = r.get("path", "")
            self.assertTrue(
                path.startswith("services/"),
                f"Result path {path!r} does not start with 'services/'",
            )
        # At least one result expected from the two services/ rows
        self.assertGreater(len(results), 0, "Expected at least 1 result after directory filter")

    def test_search_code_pg_unavailable(self):
        """amauta/search-code returns pg_unavailable when store is None."""
        with patch.object(_mod, "_get_pg_store", return_value=None):
            result = _run(_mod.call_tool("amauta/search-code", {"query": "find something"}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "pg_unavailable")


class TestMemoryDistillTool(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_memory_distill_threshold_500(self):
        """amauta/memory-distill with count=600 → needs_distill=True, threshold=500."""
        store = _mock_store(memory_count_return=600)
        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/memory-distill", {}))
        data = _result_json(result)
        self.assertTrue(data.get("needs_distill"), "needs_distill must be True when total >= 500")
        self.assertEqual(data.get("threshold"), 500, "threshold must be literal 500")
        self.assertEqual(data.get("total"), 600)

    def test_memory_distill_below_threshold(self):
        """amauta/memory-distill with count=100 → needs_distill=False."""
        store = _mock_store(memory_count_return=100)
        with patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/memory-distill", {}))
        data = _result_json(result)
        self.assertFalse(data.get("needs_distill"), "needs_distill must be False when total < 500")


class TestResearchTool(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_research_valkey_cache_hit(self):
        """amauta/research returns from_cache=True on cache hit without calling memory_semantic_search."""
        cached_payload = json.dumps({
            "memory_results": [],
            "skb_results": [],
            "web_results": [],
        })
        valkey = _mock_valkey(available=True, get_return=cached_payload.encode())
        store = _mock_store()
        with patch.object(_mod, "_get_mcp_valkey", return_value=valkey), \
             patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/research", {"query": "test query"}))
        data = _result_json(result)
        self.assertTrue(data.get("from_cache"), "from_cache must be True on cache hit")
        store.memory_semantic_search.assert_not_called()

    def test_research_valkey_unavailable_skips_cache(self):
        """amauta/research with Valkey unavailable still returns from_cache=False without raising."""
        valkey = _mock_valkey(available=False)
        store = _mock_store()
        with patch.object(_mod, "_get_mcp_valkey", return_value=valkey), \
             patch.object(_mod, "_get_pg_store", return_value=store):
            result = _run(_mod.call_tool("amauta/research", {"query": "test query"}))
        data = _result_json(result)
        self.assertFalse(data.get("from_cache"), "from_cache must be False when Valkey unavailable")
        # No error — should still succeed
        self.assertNotIn("error", data, f"Unexpected error: {data}")

    def test_research_invalid_input(self):
        """amauta/research with empty query returns invalid_input."""
        with patch.object(_mod, "_get_pg_store", return_value=_mock_store()), \
             patch.object(_mod, "_get_mcp_valkey", return_value=_mock_valkey()):
            result = _run(_mod.call_tool("amauta/research", {"query": ""}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "invalid_input")


class TestComplexityScoreTool(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_complexity_score_invalid_input_when_task_meta_missing(self):
        """amauta/complexity-score with empty args returns invalid_input."""
        result = _run(_mod.call_tool("amauta/complexity-score", {}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "invalid_input", f"Expected invalid_input, got: {data}")

    def test_complexity_score_invalid_input_when_task_meta_not_dict(self):
        """amauta/complexity-score with task_meta=string returns invalid_input."""
        result = _run(_mod.call_tool("amauta/complexity-score", {"task_meta": "not a dict"}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "invalid_input")

    def test_complexity_score_happy_path(self):
        """amauta/complexity-score with valid task_meta returns score 0-100 + 7 features."""
        task_meta = {
            "title": "Test task",
            "description": "A test task description",
            "files_expected": ["services/amauta-mcp.py", "tests/test_mcp.py"],
            "estimated_loc": 50,
        }
        result = _run(_mod.call_tool("amauta/complexity-score", {"task_meta": task_meta}))
        data = _result_json(result)
        self.assertNotIn("error", data, f"Unexpected error: {data}")
        self.assertIn("score", data, "Expected score in result")
        score = data["score"]
        self.assertIsInstance(score, int, f"score must be int, got {type(score)}")
        self.assertGreaterEqual(score, 0, "score must be >= 0")
        self.assertLessEqual(score, 100, "score must be <= 100")
        self.assertIn("features", data, "Expected features in result")
        features = data["features"]
        required_keys = {
            "files_expected", "estimated_loc", "test_impact",
            "dependency_depth", "has_migration", "has_api_change",
            "security_sensitivity",
        }
        missing = required_keys - set(features.keys())
        self.assertEqual(missing, set(), f"Missing feature keys: {missing}")


if __name__ == "__main__":
    unittest.main()
