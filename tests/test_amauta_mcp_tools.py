"""
tests/test_amauta_mcp_tools.py — per-tool unit tests for all 6 MCP tools (Phase 46 Task 46-01-09).

Loads amauta-mcp.py via importlib (handles hyphenated filename). Mocks _get_pg_store()
and _get_mcp_valkey() to avoid DB dependency. Wraps async calls with asyncio.run().

Phase 65 RETR-03: search-code tests reworked to assert hybrid_search delegation
(query-forwarding, provenance, fallback chain) and a subprocess import proof
that _HYBRID_SEARCH_AVAILABLE resolves True even with cwd outside the repo
(Phase 60 silent-import-failure class).
"""

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
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
        """amauta/search-code forwards `directory` to hybrid_search as file_filter
        and maps rlm_chunks rows to path/text/symbol_name/score keys."""
        fake_rows = [
            {"file_path": "services/pg_store.py", "content": "PGStore class",
             "symbol_name": "PGStore", "rrf_score": 0.9},
            {"file_path": "services/amauta-mcp.py", "content": "MCP server",
             "symbol_name": "call_tool", "rrf_score": 0.5},
        ]
        recorder = {}

        def _fake_hybrid_search(query, conn, top_k=5, file_filter=None):
            recorder["file_filter"] = file_filter
            return fake_rows

        store = _mock_store()
        fake_conn = MagicMock()
        fake_conn.__enter__ = MagicMock(return_value=fake_conn)
        fake_conn.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value = fake_conn

        with patch.object(_mod, "_get_pg_store", return_value=store), \
             patch.object(_mod, "hybrid_search", side_effect=_fake_hybrid_search), \
             patch.object(_mod, "_HYBRID_SEARCH_AVAILABLE", True):
            result = _run(_mod.call_tool("amauta/search-code", {
                "query": "test",
                "directory": "services/",
            }))
        data = _result_json(result)
        self.assertEqual(recorder.get("file_filter"), "services/",
                          "directory argument must reach hybrid_search as file_filter")
        results = data.get("results", [])
        self.assertEqual(len(results), 2, f"Expected 2 mapped rows, got: {results}")
        for r in results:
            self.assertIn("path", r)
            self.assertIn("text", r)
            self.assertIn("symbol_name", r)
            self.assertIn("score", r)
        self.assertEqual(results[0]["path"], "services/pg_store.py")
        self.assertEqual(results[0]["text"], "PGStore class")
        self.assertEqual(results[0]["symbol_name"], "PGStore")
        self.assertEqual(results[0]["score"], 0.9)

    def test_search_code_pg_unavailable(self):
        """amauta/search-code returns pg_unavailable when store is None."""
        with patch.object(_mod, "_get_pg_store", return_value=None):
            result = _run(_mod.call_tool("amauta/search-code", {"query": "find something"}))
        data = _result_json(result)
        self.assertEqual(data.get("error"), "pg_unavailable")

    def test_search_code_query_forwarded_and_ranked(self):
        """Two different queries reach hybrid_search verbatim and produce distinct
        results — proving search-code ranks by ITS query, not a static LIMIT probe."""
        recorded_queries = []

        def _fake_hybrid_search(query, conn, top_k=5, file_filter=None):
            recorded_queries.append(query)
            if query == "frobnicate widget":
                return [{"file_path": "services/widget.py", "content": "frobnicate",
                          "symbol_name": "frobnicate", "rrf_score": 0.8}]
            return [{"file_path": "services/config.py", "content": "load config",
                      "symbol_name": "load_config", "rrf_score": 0.7}]

        store = _mock_store()
        fake_conn = MagicMock()
        fake_conn.__enter__ = MagicMock(return_value=fake_conn)
        fake_conn.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value = fake_conn

        with patch.object(_mod, "_get_pg_store", return_value=store), \
             patch.object(_mod, "hybrid_search", side_effect=_fake_hybrid_search), \
             patch.object(_mod, "_HYBRID_SEARCH_AVAILABLE", True):
            result1 = _run(_mod.call_tool("amauta/search-code", {"query": "frobnicate widget"}))
            result2 = _run(_mod.call_tool("amauta/search-code", {"query": "load config"}))

        data1 = _result_json(result1)
        data2 = _result_json(result2)

        self.assertEqual(recorded_queries, ["frobnicate widget", "load config"],
                          "hybrid_search must receive the exact query string per call")
        self.assertEqual(data1.get("engine"), "hybrid_rlm_chunks")
        self.assertEqual(data2.get("engine"), "hybrid_rlm_chunks")
        self.assertNotEqual(data1.get("results"), data2.get("results"),
                             "Two different queries must produce two different result sets")
        self.assertEqual(data1["results"][0]["path"], "services/widget.py")
        self.assertEqual(data2["results"][0]["path"], "services/config.py")

    def test_search_code_hybrid_raises_falls_back_to_memory(self):
        """When hybrid_search raises, search-code falls back to memory_semantic_search
        and reports engine=memory_fallback (never an unhandled exception)."""
        def _raising_hybrid_search(query, conn, top_k=5, file_filter=None):
            raise RuntimeError("hybrid boom")

        known_rows = [{"path": "memory/note-1", "text": "some memory row"}]
        store = _mock_store(memory_search_return=known_rows)
        fake_conn = MagicMock()
        fake_conn.__enter__ = MagicMock(return_value=fake_conn)
        fake_conn.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value = fake_conn

        with patch.object(_mod, "_get_pg_store", return_value=store), \
             patch.object(_mod, "hybrid_search", side_effect=_raising_hybrid_search), \
             patch.object(_mod, "_HYBRID_SEARCH_AVAILABLE", True):
            result = _run(_mod.call_tool("amauta/search-code", {"query": "anything"}))
        data = _result_json(result)
        self.assertEqual(data.get("engine"), "memory_fallback")
        self.assertEqual(data.get("results"), known_rows)

    def test_search_code_hybrid_empty_is_a_valid_answer(self):
        """An empty hybrid_search result ([]) is a VALID terminal answer — it must
        NOT silently fall through to memory_semantic_search."""
        store = _mock_store(memory_search_return=[{"path": "should/not/appear", "text": "x"}])
        fake_conn = MagicMock()
        fake_conn.__enter__ = MagicMock(return_value=fake_conn)
        fake_conn.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value = fake_conn

        with patch.object(_mod, "_get_pg_store", return_value=store), \
             patch.object(_mod, "hybrid_search", return_value=[]), \
             patch.object(_mod, "_HYBRID_SEARCH_AVAILABLE", True):
            result = _run(_mod.call_tool("amauta/search-code", {"query": "no matches expected"}))
        data = _result_json(result)
        self.assertEqual(data.get("results"), [])
        self.assertEqual(data.get("engine"), "hybrid_rlm_chunks")
        store.memory_semantic_search.assert_not_called()

    def test_no_unfiltered_select_regression(self):
        """Structural lock on RETR-03: the dead code_embeddings probe must never
        return, and hybrid_search delegation must remain present."""
        with open(_MODULE_PATH) as f:
            source = f.read()
        self.assertNotIn("code_embeddings", source,
                          "code_embeddings must not reappear in amauta-mcp.py")
        self.assertIn("hybrid_search", source,
                       "hybrid_search delegation must be present in amauta-mcp.py")

    def test_hybrid_import_resolves_outside_repo_cwd(self):
        """Subprocess proof of the Phase 60 silent-import-failure class: loading
        amauta-mcp.py by absolute path with cwd OUTSIDE the repo must still
        resolve _HYBRID_SEARCH_AVAILABLE to True (the sys.path fix works
        regardless of the process's working directory)."""
        try:
            import mcp  # noqa: F401
        except ImportError as e:
            self.skipTest(f"mcp package unimportable in this venv: {e}")

        script = (
            "import importlib.util\n"
            f"spec = importlib.util.spec_from_file_location('amauta_mcp_subproc', {_MODULE_PATH!r})\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(mod)\n"
            "print(mod._HYBRID_SEARCH_AVAILABLE)\n"
        )
        proc = subprocess.run(
            [sys.executable, "-c", script],
            cwd=os.path.expanduser("~"),
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(
            proc.stdout.strip(), "True",
            f"Expected _HYBRID_SEARCH_AVAILABLE=True from subprocess with cwd outside repo. "
            f"stdout={proc.stdout!r} stderr={proc.stderr!r}",
        )


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
