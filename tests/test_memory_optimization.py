#!/usr/bin/env python3
"""Tests for memory optimization: source filtering (MEM-01) and recency decay (MEM-03).

Verifies:
1. Default search excludes task_event and rpetd_phase sources
2. exclude_sources=None includes all sources
3. exclude_sources=('task_event',) excludes only task_event
4. Recency decay reduces score for old entries
5. Recency decay is zero for entries created today
6. Recency penalty caps at MAX_RECENCY_PENALTY
7. GSD_RECENCY_DECAY_PER_30D=0 disables decay
8. Source filtering and recency decay compose correctly

Run: python3 -m pytest tests/test_memory_optimization.py -v
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore, DEFAULT_EXCLUDE_SOURCES, MAX_RECENCY_PENALTY


def _insert_with_date(store, text, source, created_at_str, agent_id="test-agent", tags=None):
    """Insert a memory entry with a specific created_at timestamp."""
    mem_id = f"mem-test-{hash(text + source + created_at_str) & 0xFFFFFFFF:08x}"
    with store._get_conn() as conn:
        conn.execute(
            """INSERT INTO gsd_memory (id, text, source, agent_id, tags, metadata, project_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (mem_id, text, source, agent_id,
             json.dumps(tags or []), json.dumps({}),
             None, created_at_str),
        )
    return mem_id


class TestSourceFiltering(unittest.TestCase):
    """MEM-01: Default search excludes task_event and rpetd_phase."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc).isoformat()
        _insert_with_date(self.store, "recent learning about auth patterns", "auto_learning", now)
        _insert_with_date(self.store, "claimed TK-001 auth task event", "task_event", now)
        _insert_with_date(self.store, "R: auth patterns found in codebase", "rpetd_phase", now)
        _insert_with_date(self.store, "auth must use JWT for all endpoints", "lesson-learned", now)
        _insert_with_date(self.store, "best practice: auth middleware pattern", "best-practice", now)

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_default_search_excludes_noise_sources(self):
        """Default memory_search excludes task_event and rpetd_phase."""
        results = self.store.memory_search("auth")
        sources = [r["source"] for r in results]
        self.assertNotIn("task_event", sources)
        self.assertNotIn("rpetd_phase", sources)
        self.assertGreater(len(results), 0, "Should return non-noise results")

    def test_exclude_sources_none_includes_all(self):
        """exclude_sources=None includes ALL sources including noise."""
        results = self.store.memory_search("auth", exclude_sources=None)
        sources = set(r["source"] for r in results)
        self.assertIn("task_event", sources)
        self.assertIn("rpetd_phase", sources)
        self.assertIn("auto_learning", sources)
        self.assertEqual(len(results), 5, "Should return all 5 entries")

    def test_exclude_only_task_event(self):
        """exclude_sources=('task_event',) excludes only task_event."""
        results = self.store.memory_search("auth", exclude_sources=("task_event",))
        sources = [r["source"] for r in results]
        self.assertNotIn("task_event", sources)
        self.assertIn("rpetd_phase", sources, "rpetd_phase should NOT be excluded")
        self.assertEqual(len(results), 4)

    def test_default_exclude_sources_constant(self):
        """DEFAULT_EXCLUDE_SOURCES contains the expected values."""
        self.assertIn("task_event", DEFAULT_EXCLUDE_SOURCES)
        self.assertIn("rpetd_phase", DEFAULT_EXCLUDE_SOURCES)
        self.assertEqual(len(DEFAULT_EXCLUDE_SOURCES), 2)

    def test_semantic_search_also_filters(self):
        """memory_semantic_search (FTS fallback) also respects exclude_sources."""
        results, method = self.store.memory_semantic_search("auth")
        self.assertEqual(method, "text_fallback")
        sources = [r["source"] for r in results]
        self.assertNotIn("task_event", sources)
        self.assertNotIn("rpetd_phase", sources)

    def test_semantic_search_include_noise(self):
        """memory_semantic_search with exclude_sources=None includes noise."""
        results, method = self.store.memory_semantic_search("auth", exclude_sources=None)
        sources = set(r["source"] for r in results)
        self.assertIn("task_event", sources)
        self.assertIn("rpetd_phase", sources)


class TestRecencyDecay(unittest.TestCase):
    """MEM-03: Recency decay reduces scores for old entries."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        self.now_str = now.isoformat()
        self.days60_str = (now - timedelta(days=60)).isoformat()
        self.days200_str = (now - timedelta(days=200)).isoformat()

        _insert_with_date(self.store, "recent auth learning today", "auto_learning", self.now_str)
        _insert_with_date(self.store, "old auth learning sixty days", "auto_learning", self.days60_str)
        _insert_with_date(self.store, "ancient auth learning two hundred", "auto_learning", self.days200_str)

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_recent_entry_scores_higher_than_old(self):
        """Today's entry scores higher than 60-day-old entry (same source)."""
        results = self.store.memory_search("auth learning", exclude_sources=None)
        # Find the recent and old entries
        recent = next((r for r in results if "today" in r["text"]), None)
        old = next((r for r in results if "sixty" in r["text"]), None)
        self.assertIsNotNone(recent, "Should find the recent entry")
        self.assertIsNotNone(old, "Should find the 60-day old entry")
        self.assertGreater(recent["score"], old["score"],
                           f"Recent ({recent['score']}) should score higher than old ({old['score']})")

    def test_today_entry_has_no_decay(self):
        """Entry created today has zero recency penalty."""
        results = self.store.memory_search("recent auth learning today", exclude_sources=None)
        today_entry = next((r for r in results if "today" in r["text"]), None)
        self.assertIsNotNone(today_entry)
        # With source_bonus=3 for auto_learning and zero decay, score should be >= 3
        self.assertGreaterEqual(today_entry["score"], 3.0)

    def test_recency_penalty_capped_at_max(self):
        """200-day-old entry's decay is capped at MAX_RECENCY_PENALTY (3.0)."""
        results = self.store.memory_search("auth learning", exclude_sources=None)
        ancient = next((r for r in results if "two hundred" in r["text"]), None)
        old60 = next((r for r in results if "sixty" in r["text"]), None)
        self.assertIsNotNone(ancient)
        self.assertIsNotNone(old60)
        # 200 days uncapped would be 0.5 * (200/30) = 3.33, but cap is 3.0
        # So ancient should have exactly MAX_RECENCY_PENALTY = 3.0 decay
        # Difference between 60-day and 200-day should be limited by the cap
        # 60-day penalty = 0.5 * (60/30) = 1.0
        # 200-day penalty = 3.0 (capped)
        # Difference = 2.0 (not 2.33 as it would be uncapped)
        score_diff = old60["score"] - ancient["score"]
        self.assertAlmostEqual(score_diff, 2.0, places=1,
                               msg=f"Score diff should be ~2.0 (1.0 vs 3.0 decay), got {score_diff}")

    def test_decay_disabled_with_env_var_zero(self):
        """GSD_RECENCY_DECAY_PER_30D=0 disables decay entirely."""
        # Need to reimport to pick up the env var change
        import importlib
        import sqlite_store as ss
        with patch.dict(os.environ, {"GSD_RECENCY_DECAY_PER_30D": "0"}):
            # Monkey-patch the module-level constant
            original = ss.RECENCY_DECAY_PER_30D
            ss.RECENCY_DECAY_PER_30D = 0.0
            try:
                results = self.store.memory_search("auth learning", exclude_sources=None)
                scores = [r["score"] for r in results if "auto_learning" == r.get("source")]
                # All same-source entries should have the same score (no decay)
                self.assertTrue(
                    all(s == scores[0] for s in scores),
                    f"With decay disabled, all same-source scores should be equal: {scores}",
                )
            finally:
                ss.RECENCY_DECAY_PER_30D = original


class TestFilterAndDecayComposition(unittest.TestCase):
    """Source filtering and recency decay compose correctly."""

    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        now = datetime.now(timezone.utc)
        _insert_with_date(self.store, "recent auth auto learning", "auto_learning",
                          now.isoformat())
        _insert_with_date(self.store, "old auth auto learning aged", "auto_learning",
                          (now - timedelta(days=90)).isoformat())
        _insert_with_date(self.store, "recent auth task event claimed", "task_event",
                          now.isoformat())
        _insert_with_date(self.store, "recent auth rpetd phase log", "rpetd_phase",
                          now.isoformat())
        _insert_with_date(self.store, "ancient auth lesson learned important", "lesson-learned",
                          (now - timedelta(days=180)).isoformat())

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def test_default_search_filters_and_decays(self):
        """Default search excludes noise AND applies recency decay."""
        results = self.store.memory_search("auth")
        sources = set(r["source"] for r in results)
        # Noise sources excluded
        self.assertNotIn("task_event", sources)
        self.assertNotIn("rpetd_phase", sources)
        # Should have auto_learning and lesson-learned
        self.assertIn("auto_learning", sources)
        self.assertIn("lesson-learned", sources)
        # Recent auto_learning should score higher than old auto_learning
        recent_al = next((r for r in results if "recent" in r["text"] and r["source"] == "auto_learning"), None)
        old_al = next((r for r in results if "aged" in r["text"]), None)
        self.assertIsNotNone(recent_al)
        self.assertIsNotNone(old_al)
        self.assertGreater(recent_al["score"], old_al["score"])

    def test_lesson_learned_survives_max_decay(self):
        """lesson-learned with +4 bonus survives even MAX_RECENCY_PENALTY=3.0 decay."""
        results = self.store.memory_search("auth", exclude_sources=None)
        lesson = next((r for r in results if r["source"] == "lesson-learned"), None)
        self.assertIsNotNone(lesson)
        # lesson-learned gets +4 bonus. 180 days = min(0.5 * 6, 3.0) = 3.0 decay
        # So score should be >= 4 - 3.0 = 1.0 (plus any text_rank component)
        self.assertGreater(lesson["score"], 0,
                           f"lesson-learned should still have positive score: {lesson['score']}")


if __name__ == "__main__":
    unittest.main()
