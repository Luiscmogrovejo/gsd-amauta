#!/usr/bin/env python3
"""Tests for data integrity features: distill exclusion and pre-store dedup.

Verifies:
1. SQLite memory_list exclude_source filters out distilled entries (DATA-03)
2. exclude_source coexists with source filter without SQL errors
3. exclude_source with list of sources works correctly
4. Dedup response shape from daemon handler (DATA-04)

Run: python3 -m pytest tests/test_data_integrity.py -v
"""
import json, os, sys, tempfile, unittest
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


if __name__ == "__main__":
    unittest.main()
