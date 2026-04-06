#!/usr/bin/env python3
"""Tests for memory retention cleanup (MEM-02: tiered archival).

Verifies:
1. task_event entries >30 days are archived
2. task_event entries <=30 days are NOT archived
3. rpetd_phase entries >90 days are archived
4. rpetd_phase entries <=90 days are NOT archived
5. auto_learning entries are NEVER archived regardless of age
6. lesson-learned entries are NEVER archived regardless of age
7. Archived entries exist in gsd_memory_archive table
8. Cleanup is idempotent (second run archives 0)
9. Return dict has correct counts

Run: python3 -m pytest tests/test_memory_retention.py -v
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore, RETENTION_DAYS


def _insert_with_date(store, text, source, created_at_str, entry_id=None,
                      agent_id="test-agent", tags=None):
    """Insert a memory entry with a specific created_at timestamp."""
    if entry_id is None:
        entry_id = f"mem-ret-{hash(text + source + created_at_str) & 0xFFFFFFFF:08x}"
    with store._get_conn() as conn:
        conn.execute(
            """INSERT INTO gsd_memory (id, text, source, agent_id, tags, metadata, project_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (entry_id, text, source, agent_id,
             json.dumps(tags or []), json.dumps({}),
             None, created_at_str),
        )
    return entry_id


class TestRetentionTaskEvent(unittest.TestCase):
    """task_event entries: archived after 30 days, kept if <= 30 days."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        # 35 days old -- should be archived
        self.old_id = _insert_with_date(
            self.store, "old task event claimed TK-999",
            "task_event", (now - timedelta(days=35)).isoformat(),
            entry_id="mem-ret-old-te")
        # 25 days old -- should NOT be archived
        self.recent_id = _insert_with_date(
            self.store, "recent task event claimed TK-100",
            "task_event", (now - timedelta(days=25)).isoformat(),
            entry_id="mem-ret-recent-te")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_old_task_event_archived(self):
        """task_event >30 days old is moved to archive."""
        result = self.store.memory_retention_cleanup()
        self.assertEqual(result["task_event_archived"], 1)
        # Verify entry gone from active table
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.old_id,)
            ).fetchone()
            self.assertIsNone(row, "Old task_event should be removed from gsd_memory")

    def test_recent_task_event_not_archived(self):
        """task_event <=30 days old is NOT archived."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.recent_id,)
            ).fetchone()
            self.assertIsNotNone(row, "Recent task_event should remain in gsd_memory")


class TestRetentionRpetdPhase(unittest.TestCase):
    """rpetd_phase entries: archived after 90 days, kept if <= 90 days."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        # 95 days old -- should be archived
        self.old_id = _insert_with_date(
            self.store, "R: old rpetd research phase",
            "rpetd_phase", (now - timedelta(days=95)).isoformat(),
            entry_id="mem-ret-old-rp")
        # 85 days old -- should NOT be archived
        self.recent_id = _insert_with_date(
            self.store, "P: recent rpetd plan phase",
            "rpetd_phase", (now - timedelta(days=85)).isoformat(),
            entry_id="mem-ret-recent-rp")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_old_rpetd_phase_archived(self):
        """rpetd_phase >90 days old is moved to archive."""
        result = self.store.memory_retention_cleanup()
        self.assertEqual(result["rpetd_phase_archived"], 1)
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.old_id,)
            ).fetchone()
            self.assertIsNone(row, "Old rpetd_phase should be removed from gsd_memory")

    def test_recent_rpetd_phase_not_archived(self):
        """rpetd_phase <=90 days old is NOT archived."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.recent_id,)
            ).fetchone()
            self.assertIsNotNone(row, "Recent rpetd_phase should remain in gsd_memory")


class TestRetentionProtectedSources(unittest.TestCase):
    """High-value sources are NEVER archived regardless of age."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        ancient = (now - timedelta(days=365)).isoformat()
        self.al_id = _insert_with_date(
            self.store, "auto learning about patterns",
            "auto_learning", ancient, entry_id="mem-ret-al")
        self.ll_id = _insert_with_date(
            self.store, "lesson learned about testing",
            "lesson-learned", ancient, entry_id="mem-ret-ll")
        self.bp_id = _insert_with_date(
            self.store, "best practice for error handling",
            "best-practice", ancient, entry_id="mem-ret-bp")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_auto_learning_never_archived(self):
        """auto_learning entries are NEVER archived regardless of age."""
        result = self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.al_id,)
            ).fetchone()
            self.assertIsNotNone(row, "auto_learning must NEVER be archived")

    def test_lesson_learned_never_archived(self):
        """lesson-learned entries are NEVER archived regardless of age."""
        result = self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.ll_id,)
            ).fetchone()
            self.assertIsNotNone(row, "lesson-learned must NEVER be archived")

    def test_best_practice_never_archived(self):
        """best-practice entries are NEVER archived regardless of age."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.bp_id,)
            ).fetchone()
            self.assertIsNotNone(row, "best-practice must NEVER be archived")


class TestRetentionArchiveTable(unittest.TestCase):
    """Archived entries exist in gsd_memory_archive with correct data."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        self.old_ts = (now - timedelta(days=35)).isoformat()
        self.old_id = _insert_with_date(
            self.store, "archived task event data",
            "task_event", self.old_ts, entry_id="mem-ret-archive-check")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_archived_entries_in_archive_table(self):
        """Archived entries appear in gsd_memory_archive table."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id, text, source, archived_at FROM gsd_memory_archive WHERE id = ?",
                (self.old_id,)
            ).fetchone()
            self.assertIsNotNone(row, "Archived entry should exist in gsd_memory_archive")
            self.assertEqual(row[0], self.old_id)
            self.assertEqual(row[1], "archived task event data")
            self.assertEqual(row[2], "task_event")
            self.assertIsNotNone(row[3], "archived_at should be set")

    def test_archive_preserves_original_timestamps(self):
        """Archive preserves original created_at from the source entry."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT created_at FROM gsd_memory_archive WHERE id = ?",
                (self.old_id,)
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertIn(self.old_ts[:10], row[0], "Original created_at should be preserved")


class TestRetentionIdempotency(unittest.TestCase):
    """Cleanup is idempotent -- second run archives 0."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        _insert_with_date(
            self.store, "old task event for idempotency test",
            "task_event", (now - timedelta(days=35)).isoformat(),
            entry_id="mem-ret-idemp")
        _insert_with_date(
            self.store, "old rpetd for idempotency test",
            "rpetd_phase", (now - timedelta(days=95)).isoformat(),
            entry_id="mem-ret-idemp-rp")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_idempotent_second_run_archives_zero(self):
        """Second cleanup run archives 0 entries."""
        first = self.store.memory_retention_cleanup()
        self.assertEqual(first["total"], 2, "First run should archive 2 entries")
        second = self.store.memory_retention_cleanup()
        self.assertEqual(second["total"], 0, "Second run should archive 0 entries")


class TestRetentionReturnDict(unittest.TestCase):
    """Return dict has correct structure and counts."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        _insert_with_date(
            self.store, "old task event for counts",
            "task_event", (now - timedelta(days=35)).isoformat(),
            entry_id="mem-ret-count-te")
        _insert_with_date(
            self.store, "old rpetd for counts",
            "rpetd_phase", (now - timedelta(days=95)).isoformat(),
            entry_id="mem-ret-count-rp")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_return_dict_has_correct_counts(self):
        """Return dict has task_event_archived, rpetd_phase_archived, total."""
        result = self.store.memory_retention_cleanup()
        self.assertIn("task_event_archived", result)
        self.assertIn("rpetd_phase_archived", result)
        self.assertIn("total", result)
        self.assertEqual(result["task_event_archived"], 1)
        self.assertEqual(result["rpetd_phase_archived"], 1)
        self.assertEqual(result["total"], 2)

    def test_empty_db_returns_zero_counts(self):
        """Cleanup on empty DB returns all-zero counts."""
        empty_fd, empty_path = tempfile.mkstemp(suffix=".db")
        empty_store = SQLiteStore(db_path=empty_path)
        try:
            result = empty_store.memory_retention_cleanup()
            self.assertEqual(result["total"], 0)
            self.assertEqual(result["task_event_archived"], 0)
            self.assertEqual(result["rpetd_phase_archived"], 0)
        finally:
            empty_store.close()
            os.close(empty_fd)
            os.unlink(empty_path)


class TestRetentionWebSearchResult(unittest.TestCase):
    """web_search_result entries: archived after 180 days, kept if <= 180 days."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        # 181 days old -- should be archived
        self.old_id = _insert_with_date(
            self.store, "old web search result about pytest patterns",
            "web_search_result", (now - timedelta(days=181)).isoformat(),
            entry_id="mem-ret-old-wsr")
        # 10 days old -- should NOT be archived
        self.recent_id = _insert_with_date(
            self.store, "recent web search result about docker",
            "web_search_result", (now - timedelta(days=10)).isoformat(),
            entry_id="mem-ret-recent-wsr")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_retention_archives_web_search_result_after_180_days(self):
        """web_search_result >180 days old is moved to archive."""
        result = self.store.memory_retention_cleanup()
        self.assertEqual(result["web_search_result_archived"], 1)
        # Verify old entry removed from active table
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.old_id,)
            ).fetchone()
            self.assertIsNone(row, "Old web_search_result should be removed from gsd_memory")
        # Verify old entry is in archive table
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory_archive WHERE id = ?", (self.old_id,)
            ).fetchone()
            self.assertIsNotNone(row, "Old web_search_result should be in gsd_memory_archive")

    def test_recent_web_search_result_not_archived(self):
        """web_search_result <=180 days old is NOT archived."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.recent_id,)
            ).fetchone()
            self.assertIsNotNone(row, "Recent web_search_result should remain in gsd_memory")


class TestRetentionDistilledPermanent(unittest.TestCase):
    """distilled entries are NEVER archived regardless of age (permanent by design)."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        # 365 days old -- should NEVER be archived
        self.distilled_id = _insert_with_date(
            self.store, "distilled knowledge about system design",
            "distilled", (now - timedelta(days=365)).isoformat(),
            entry_id="mem-ret-distilled")

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_retention_preserves_distilled_entries_forever(self):
        """distilled entries are NEVER archived regardless of age."""
        self.store.memory_retention_cleanup()
        with self.store._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (self.distilled_id,)
            ).fetchone()
            self.assertIsNotNone(row, "distilled entries must NEVER be archived")


if __name__ == "__main__":
    unittest.main()
