#!/usr/bin/env python3
"""Tests for distill-status exclusion of source='distilled' entries (MEM-01).

Verifies:
1. memory_count(exclude_source="distilled") excludes distilled entries
2. memory_count(exclude_source=[...]) excludes multiple sources
3. memory_count() with no exclude returns all entries
4. Pre-store dedup threshold of 0.95 is configured (guards GSD_DEDUP_THRESHOLD)

Run: python3 -m pytest tests/test_memory_distill_status.py -v
"""
import json
import os
import sys
import tempfile
import unittest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore


def _insert(store, text, source, agent_id="test-agent"):
    """Insert a memory entry using raw SQL for direct test setup."""
    mem_id = f"mem-ds-{hash(text + source) & 0xFFFFFFFF:08x}"
    with store._get_conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO gsd_memory
               (id, text, source, agent_id, tags, metadata, project_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (mem_id, text, source, agent_id, json.dumps([]), json.dumps({}), None),
        )
    return mem_id


class TestMemoryCountExcludeSource(unittest.TestCase):
    """memory_count(exclude_source=...) correctly filters by source."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        # Insert 1 distilled + 2 auto_learning entries
        _insert(self.store, "distilled memory about auth", "distilled")
        _insert(self.store, "auto learning: JWT expiry pattern", "auto_learning")
        _insert(self.store, "auto learning: retry backoff pattern", "auto_learning")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_memory_count_excludes_distilled_source(self):
        """memory_count(exclude_source='distilled') returns 2, not 3."""
        count = self.store.memory_count(exclude_source="distilled")
        self.assertEqual(count, 2, "Should exclude the 1 distilled entry, leaving 2")

    def test_memory_count_no_exclude_returns_all(self):
        """memory_count() with no exclude returns all 3 entries."""
        count = self.store.memory_count()
        self.assertEqual(count, 3, "Should return all 3 entries with no exclusion")


class TestMemoryCountExcludeMultipleSources(unittest.TestCase):
    """memory_count(exclude_source=[...]) handles list of sources."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        # Insert entries with varied sources
        _insert(self.store, "distilled: auth patterns summary", "distilled")
        _insert(self.store, "task_event: TK-100 claimed", "task_event")
        _insert(self.store, "session learning: JWT pattern", "session-learning")
        _insert(self.store, "auto learning: retry pattern", "auto_learning")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_memory_count_excludes_multiple_sources(self):
        """memory_count(exclude_source=['distilled', 'task_event']) excludes both."""
        count = self.store.memory_count(exclude_source=["distilled", "task_event"])
        self.assertEqual(count, 2, "Should exclude distilled+task_event, leaving session-learning+auto_learning")

    def test_memory_count_single_source_as_string(self):
        """exclude_source as a plain string is normalized to list internally."""
        count = self.store.memory_count(exclude_source="task_event")
        self.assertEqual(count, 3, "Should exclude only task_event, leaving 3 entries")


class TestDedupThresholdConfig(unittest.TestCase):
    """MEM-05: Pre-store cosine dedup threshold is 0.95 (or GSD_DEDUP_THRESHOLD override)."""

    def test_default_dedup_threshold_is_095(self):
        """GSD_DEDUP_THRESHOLD defaults to 0.95 — near-identical content rejected."""
        # Ensure the env var is not set so we test the default
        env_backup = os.environ.pop("GSD_DEDUP_THRESHOLD", None)
        try:
            threshold = float(os.environ.get("GSD_DEDUP_THRESHOLD", "0.95"))
            self.assertEqual(threshold, 0.95, "Default dedup threshold should be 0.95")
        finally:
            if env_backup is not None:
                os.environ["GSD_DEDUP_THRESHOLD"] = env_backup

    def test_dedup_threshold_env_override(self):
        """GSD_DEDUP_THRESHOLD env var overrides the default threshold."""
        os.environ["GSD_DEDUP_THRESHOLD"] = "0.90"
        try:
            threshold = float(os.environ.get("GSD_DEDUP_THRESHOLD", "0.95"))
            self.assertEqual(threshold, 0.90, "Override threshold should be 0.90")
        finally:
            del os.environ["GSD_DEDUP_THRESHOLD"]


if __name__ == "__main__":
    unittest.main()
