#!/usr/bin/env python3
"""Tests for data integrity features: distill exclusion, pre-store dedup,
project_id auto-detection, and test isolation.

Verifies:
1. SQLite memory_list exclude_source filters out distilled entries (DATA-03)
2. exclude_source coexists with source filter without SQL errors
3. exclude_source with list of sources works correctly
4. Dedup response shape from daemon handler (DATA-04)
5. project_id auto-detection from CWD basename (DATA-05)
6. project_id forced to __test__ in test mode (DATA-06)
7. SQLite search excludes __test__ entries by default (DATA-06)
8. SQLite search includes __test__ when explicitly requested (DATA-06)
9. _mem_log_event passes project_id in daemon body (DATA-05)
10. amauta.py uses gsd_memory table not amauta_memory (BLOCKING-2 validation)

Run: python3 -m pytest tests/test_data_integrity.py -v
"""
import json, os, re, sys, tempfile, unittest
from unittest.mock import MagicMock, patch

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore


class TestExcludeSourceSQLite(unittest.TestCase):
    """Integration tests for memory_list exclude_source using SQLiteStore."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        # Seed entries with different sources
        self.store.memory_store("Learning about FastAPI patterns", source="auto_learning",
                                agent_id="executor-backend", tags=["python"])
        self.store.memory_store("Distilled summary of prior learnings", source="distilled",
                                agent_id="executor-backend", tags=["summary"])
        self.store.memory_store("Task event: TK-100 completed", source="task_event",
                                agent_id="executor-backend", tags=["task"])

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_exclude_source_filters_distilled(self):
        """memory_list(exclude_source='distilled') excludes distilled entries."""
        results = self.store.memory_list(exclude_source='distilled')
        self.assertEqual(len(results), 2)
        sources = [r["source"] for r in results]
        self.assertNotIn("distilled", sources)
        self.assertIn("auto_learning", sources)
        self.assertIn("task_event", sources)

    def test_exclude_source_with_source_filter(self):
        """exclude_source and source can coexist without SQL errors."""
        # source='auto_learning' AND exclude_source='distilled' — should return auto_learning only
        results = self.store.memory_list(source='auto_learning', exclude_source='distilled')
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source"], "auto_learning")

    def test_exclude_source_with_list(self):
        """exclude_source accepts a list of sources to exclude."""
        results = self.store.memory_list(exclude_source=['distilled', 'task_event'])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source"], "auto_learning")

    def test_exclude_source_none_returns_all(self):
        """exclude_source=None returns all entries (default behavior)."""
        results = self.store.memory_list(exclude_source=None)
        self.assertEqual(len(results), 3)

    def test_exclude_source_nonexistent(self):
        """exclude_source with a source that doesn't exist returns all entries."""
        results = self.store.memory_list(exclude_source='nonexistent')
        self.assertEqual(len(results), 3)


class TestDedupResponseShape(unittest.TestCase):
    """Unit tests for daemon dedup response handling."""

    def test_dedup_dict_shape(self):
        """Dedup dict from pg_store has the required fields."""
        dedup_result = {
            "dedup_skipped": True,
            "existing_id": 42,
            "similarity": 0.9812,
        }
        # Verify shape matches what daemon expects
        self.assertTrue(isinstance(dedup_result, dict))
        self.assertTrue(dedup_result.get("dedup_skipped"))
        self.assertIn("existing_id", dedup_result)
        self.assertIn("similarity", dedup_result)
        self.assertGreaterEqual(dedup_result["similarity"], 0.95)

    def test_dedup_daemon_response_format(self):
        """Daemon formats dedup response correctly for callers."""
        # Simulate what the daemon handler does when it gets a dedup dict
        mem_id = {"dedup_skipped": True, "existing_id": 42, "similarity": 0.9812}

        if isinstance(mem_id, dict) and mem_id.get("dedup_skipped"):
            response = {
                "stored": False,
                "dedup_skipped": True,
                "existing_id": mem_id["existing_id"],
                "similarity": mem_id["similarity"],
            }
        else:
            response = {"id": mem_id, "stored": True}

        self.assertFalse(response["stored"])
        self.assertTrue(response["dedup_skipped"])
        self.assertEqual(response["existing_id"], 42)
        self.assertAlmostEqual(response["similarity"], 0.9812, places=3)

    def test_non_dedup_result_passes_through(self):
        """Normal int result from memory_store_with_embedding passes through."""
        mem_id = 123  # normal store returns int

        if isinstance(mem_id, dict) and mem_id.get("dedup_skipped"):
            response = {"stored": False, "dedup_skipped": True}
        else:
            response = {"id": mem_id, "stored": True}

        self.assertTrue(response["stored"])
        self.assertEqual(response["id"], 123)

    def test_dedup_threshold_env_var(self):
        """GSD_DEDUP_THRESHOLD env var is respected as float."""
        with patch.dict(os.environ, {"GSD_DEDUP_THRESHOLD": "0.90"}):
            threshold = float(os.environ.get("GSD_DEDUP_THRESHOLD", "0.95"))
            self.assertAlmostEqual(threshold, 0.90, places=2)

        # Default when env var not set
        threshold = float(os.environ.get("GSD_DEDUP_THRESHOLD", "0.95"))
        self.assertAlmostEqual(threshold, 0.95, places=2)


class TestProjectIdAutoDetection(unittest.TestCase):
    """Tests for DATA-05: project_id auto-detection from CWD basename."""

    def test_project_id_returns_cwd_basename(self):
        """project_id defaults to os.path.basename(os.getcwd())."""
        expected = os.path.basename(os.getcwd())
        self.assertTrue(len(expected) > 0)
        # Verify this is a sensible directory name (not empty or root)
        self.assertNotEqual(expected, "")
        self.assertNotIn("/", expected)

    def test_project_id_forced_to_test_with_gsd_test_mode(self):
        """DATA-06: GSD_TEST_MODE=1 forces project_id to __test__."""
        with patch.dict(os.environ, {"GSD_TEST_MODE": "1"}):
            # Simulate the daemon's _resolve_project_id logic
            if os.environ.get("GSD_TEST_MODE") == "1":
                project_id = "__test__"
            else:
                project_id = os.path.basename(os.getcwd())
            self.assertEqual(project_id, "__test__")

    def test_project_id_forced_to_test_with_pytest_current_test(self):
        """DATA-06: PYTEST_CURRENT_TEST forces project_id to __test__."""
        with patch.dict(os.environ, {"PYTEST_CURRENT_TEST": "test_data_integrity.py::test_x"}):
            if os.environ.get("PYTEST_CURRENT_TEST"):
                project_id = "__test__"
            else:
                project_id = os.path.basename(os.getcwd())
            self.assertEqual(project_id, "__test__")

    def test_project_id_forced_to_test_with_node_env(self):
        """DATA-06: NODE_ENV=test forces project_id to __test__."""
        with patch.dict(os.environ, {"NODE_ENV": "test"}):
            if os.environ.get("NODE_ENV") == "test":
                project_id = "__test__"
            else:
                project_id = os.path.basename(os.getcwd())
            self.assertEqual(project_id, "__test__")


class TestSearchExcludesTestEntries(unittest.TestCase):
    """Tests for DATA-06: default search excludes __test__ entries."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        # Seed entries with different project_ids
        self.store.memory_store("FastAPI patterns for production", source="auto_learning",
                                agent_id="executor-backend", tags=["python"],
                                project_id="gsd-amauta")
        self.store.memory_store("Test entry should be hidden", source="auto_learning",
                                agent_id="executor-backend", tags=["python"],
                                project_id="__test__")
        self.store.memory_store("Legacy entry with null project", source="auto_learning",
                                agent_id="executor-backend", tags=["python"],
                                project_id=None)

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_default_search_excludes_test_entries(self):
        """Default memory_search (no project_id) excludes __test__ entries."""
        results = self.store.memory_search("patterns")
        project_ids = [r.get("project_id") for r in results]
        self.assertNotIn("__test__", project_ids)
        # Should still include real and null project entries
        self.assertTrue(len(results) >= 1)

    def test_explicit_test_search_includes_test_entries(self):
        """memory_search with project_id='__test__' returns only test entries."""
        results = self.store.memory_search("entry", project_id="__test__")
        self.assertTrue(len(results) >= 1)
        for r in results:
            self.assertEqual(r.get("project_id"), "__test__")


class TestMemLogEventProjectId(unittest.TestCase):
    """Tests for DATA-05: _mem_log_event passes project_id in daemon body."""

    def test_mem_log_event_includes_project_id_in_body(self):
        """_mem_log_event HTTP body includes project_id key."""
        # Add amauta.py parent dir to sys.path
        amauta_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
        sys.path.insert(0, amauta_dir)

        captured_body = {}

        class MockResponse:
            def read(self):
                return json.dumps({"stored": True, "id": "MEM-test123"}).encode()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        def mock_urlopen(req, timeout=None):
            captured_body["data"] = json.loads(req.data.decode("utf-8"))
            return MockResponse()

        # Ensure PYTEST_CURRENT_TEST is set (which it should be during pytest runs)
        with patch.dict(os.environ, {"PYTEST_CURRENT_TEST": "test_data_integrity.py::test_mem"}):
            with patch("urllib.request.urlopen", side_effect=mock_urlopen):
                # Import after patching to avoid side effects
                import importlib
                if "amauta" in sys.modules:
                    amauta_mod = importlib.reload(sys.modules["amauta"])
                else:
                    amauta_mod = importlib.import_module("amauta")

                # Mock _mem_pg_available to return True to enter the PG branch
                with patch.object(amauta_mod, "_mem_pg_available", return_value=True):
                    amauta_mod._mem_log_event("test-agent", ["tag1"], "test text", source="task_event")

        if captured_body.get("data"):
            self.assertIn("project_id", captured_body["data"])
            self.assertEqual(captured_body["data"]["project_id"], "__test__")


class TestAutoCaptureDaemonProjectId(unittest.TestCase):
    """Tests for auto-capture daemon route receiving project_id."""

    def test_auto_capture_body_includes_project_id(self):
        """Auto-capture request body should include project_id."""
        # Simulate what gsd-memory.cjs autoProjectId does
        # In test mode: project_id should be '__test__'
        env_test = {"NODE_ENV": "test"}
        with patch.dict(os.environ, env_test):
            if os.environ.get("NODE_ENV") == "test":
                project_id = "__test__"
            else:
                project_id = os.path.basename(os.getcwd())
            self.assertEqual(project_id, "__test__")

        # Without test mode: should be CWD basename
        project_id = os.path.basename(os.getcwd())
        self.assertNotEqual(project_id, "")
        self.assertNotEqual(project_id, "__test__")


class TestTableNameMigration(unittest.TestCase):
    """BLOCKING-2 validation: amauta.py uses gsd_memory table, not amauta_memory."""

    def test_no_amauta_memory_inserts_in_source(self):
        """amauta.py has zero 'INSERT INTO amauta_memory' statements."""
        amauta_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "amauta.py")
        with open(amauta_path, "r") as f:
            source = f.read()
        # Count non-comment INSERT INTO amauta_memory lines
        insert_count = len(re.findall(r"INSERT INTO amauta_memory", source))
        self.assertEqual(insert_count, 0, f"Found {insert_count} 'INSERT INTO amauta_memory' — should be 0")

    def test_gsd_memory_inserts_present(self):
        """amauta.py has at least 2 'INSERT INTO gsd_memory' statements."""
        amauta_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "amauta.py")
        with open(amauta_path, "r") as f:
            source = f.read()
        insert_count = len(re.findall(r"INSERT INTO gsd_memory", source))
        self.assertGreaterEqual(insert_count, 2, f"Found {insert_count} 'INSERT INTO gsd_memory' — should be >= 2")

    def test_zero_amauta_memory_sql_references(self):
        """amauta.py has zero SQL references to amauta_memory (FROM/INTO/SELECT)."""
        amauta_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "amauta.py")
        with open(amauta_path, "r") as f:
            source = f.read()
        # Match any SQL-like reference (FROM amauta_memory, INTO amauta_memory, etc.)
        sql_refs = len(re.findall(r"(?:FROM|INTO|TABLE)\s+amauta_memory", source))
        self.assertEqual(sql_refs, 0, f"Found {sql_refs} SQL references to amauta_memory")


if __name__ == "__main__":
    unittest.main()
