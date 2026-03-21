#!/usr/bin/env python3
"""Parity tests for SQLiteStore result shapes.

Verifies that SQLiteStore returns the same result shapes as PGStore
(without needing PG). Tests focus on key presence, types, and value ranges.

Run: python3 tests/test_memory_parity.py
"""
import json, os, sys, tempfile, unittest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore, normalize_tags, TAG_SYNONYMS

# Expected keys matching PGStore output
EXPECTED_SEARCH_KEYS = {"id", "text", "source", "agent_id", "tags", "metadata",
                        "project_id", "created_at", "updated_at", "score", "text_rank"}
EXPECTED_LIST_KEYS = {"id", "text", "source", "agent_id", "tags", "project_id", "created_at"}


class TestSQLiteParity(unittest.TestCase):
    def setUp(self):
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = SQLiteStore(db_path=self.db_path)
        # Seed some test data
        self.store.memory_store("Python FastAPI setup with PostgreSQL", source="lesson-learned",
                                agent_id="executor-backend", tags=["python", "fastapi", "postgresql"])
        self.store.memory_store("React component testing patterns", source="best-practice",
                                agent_id="executor-frontend", tags=["react", "jest"])
        self.store.memory_store("Kubernetes deployment configuration", source="auto_learning",
                                agent_id="executor-infra", tags=["kubernetes", "docker"])

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    # ── Search result shape tests ────────────────────────

    def test_search_result_keys(self):
        """Search results must contain all expected keys (PG parity)."""
        results = self.store.memory_search("Python")
        self.assertGreater(len(results), 0, "Should find at least one result")
        for r in results:
            self.assertTrue(EXPECTED_SEARCH_KEYS.issubset(set(r.keys())),
                            f"Missing keys: {EXPECTED_SEARCH_KEYS - set(r.keys())}")

    def test_search_result_types(self):
        """Search result values must have correct types (PG parity)."""
        results = self.store.memory_search("Python")
        r = results[0]
        self.assertIsInstance(r["id"], str)
        self.assertIsInstance(r["text"], str)
        self.assertIsInstance(r["source"], str)
        self.assertIsInstance(r["tags"], list)
        self.assertIsInstance(r["metadata"], dict)
        self.assertIsInstance(r["score"], float)
        self.assertIsInstance(r["text_rank"], float)
        self.assertIsInstance(r["created_at"], str)

    def test_search_no_rowid(self):
        """Search results must NOT contain rowid (PG parity)."""
        results = self.store.memory_search("Python")
        for r in results:
            self.assertNotIn("rowid", r, "rowid should not be in output (PG does not return it)")

    def test_search_score_range(self):
        """Score must be a positive float (source_bonus + text_rank component)."""
        results = self.store.memory_search("Python")
        for r in results:
            self.assertGreaterEqual(r["score"], 0.0)
            self.assertLessEqual(r["text_rank"], 1.0)  # Normalized to 0-1

    # ── List result shape tests ──────────────────────────

    def test_list_result_keys(self):
        """List results must contain expected keys (PG parity)."""
        results = self.store.memory_list()
        self.assertGreater(len(results), 0)
        for r in results:
            self.assertTrue(EXPECTED_LIST_KEYS.issubset(set(r.keys())),
                            f"Missing keys: {EXPECTED_LIST_KEYS - set(r.keys())}")

    def test_list_result_types(self):
        """List result values must have correct types."""
        results = self.store.memory_list()
        r = results[0]
        self.assertIsInstance(r["id"], str)
        self.assertIsInstance(r["text"], str)
        self.assertIsInstance(r["tags"], list)
        self.assertIsInstance(r["created_at"], str)

    # ── Count tests ──────────────────────────────────────

    def test_count_returns_int(self):
        """memory_count must return int (PG parity)."""
        count = self.store.memory_count()
        self.assertIsInstance(count, int)
        self.assertEqual(count, 3)

    # ── Cross-project search tests ───────────────────────

    def test_cross_project_result_keys(self):
        """Cross-project search results must match PG shape."""
        results = self.store.memory_cross_project_search("Python")
        self.assertGreater(len(results), 0)
        for r in results:
            self.assertTrue(EXPECTED_SEARCH_KEYS.issubset(set(r.keys())),
                            f"Missing keys: {EXPECTED_SEARCH_KEYS - set(r.keys())}")
            self.assertNotIn("rowid", r)

    # ── Tag normalization tests ──────────────────────────

    def test_normalize_tags_synonyms(self):
        """normalize_tags converts known synonyms to canonical forms."""
        result = normalize_tags(["postgres", "k8s", "js", "py"])
        self.assertEqual(result, ["postgresql", "kubernetes", "javascript", "python"])

    def test_normalize_tags_dedup(self):
        """normalize_tags deduplicates after normalization."""
        result = normalize_tags(["postgres", "pg", "postgresql"])
        self.assertEqual(result, ["postgresql"])

    def test_normalize_tags_passthrough(self):
        """normalize_tags passes through unknown tags unchanged (lowercased)."""
        result = normalize_tags(["React", "CustomTag"])
        self.assertEqual(result, ["react", "customtag"])

    def test_normalize_tags_empty(self):
        """normalize_tags handles empty/None gracefully."""
        self.assertIsNone(normalize_tags(None))
        self.assertEqual(normalize_tags([]), [])

    def test_store_normalizes_tags(self):
        """memory_store should normalize tags before storage."""
        mem_id = self.store.memory_store("test with postgres tag", tags=["postgres", "k8s"])
        results = self.store.memory_search("postgres tag")
        found = [r for r in results if r["id"] == mem_id]
        self.assertEqual(len(found), 1)
        self.assertIn("postgresql", found[0]["tags"])
        self.assertIn("kubernetes", found[0]["tags"])

    # ── count_by_source tests ────────────────────────────

    def test_count_by_source(self):
        """memory_count_by_source returns dict of {source: int}."""
        counts = self.store.memory_count_by_source()
        self.assertIsInstance(counts, dict)
        self.assertEqual(counts.get("lesson-learned"), 1)
        self.assertEqual(counts.get("best-practice"), 1)
        self.assertEqual(counts.get("auto_learning"), 1)

    # ── tag_stats tests ──────────────────────────────────

    def test_tag_stats(self):
        """memory_tag_stats returns dict with tags and unique_tags."""
        stats = self.store.memory_tag_stats()
        self.assertIsInstance(stats, dict)
        self.assertIn("tags", stats)
        self.assertIn("unique_tags", stats)
        self.assertIsInstance(stats["tags"], dict)
        self.assertIsInstance(stats["unique_tags"], int)
        # We stored 3 entries with tags: python, fastapi, postgresql, react, jest, kubernetes, docker
        self.assertGreaterEqual(stats["unique_tags"], 5)
        # Each tag should have count 1
        for tag, cnt in stats["tags"].items():
            self.assertIsInstance(cnt, int)
            self.assertGreater(cnt, 0)

    def test_tag_stats_empty_db(self):
        """memory_tag_stats on empty DB returns zero counts."""
        fd2, path2 = tempfile.mkstemp(suffix=".db")
        store2 = SQLiteStore(db_path=path2)
        stats = store2.memory_tag_stats()
        self.assertEqual(stats["unique_tags"], 0)
        self.assertEqual(stats["tags"], {})
        store2.close()
        os.close(fd2)
        os.unlink(path2)


if __name__ == "__main__":
    unittest.main()
