#!/usr/bin/env python3
"""Tests for E/T-phase memory enrichment and SKB Jaccard deduplication.

Verifies:
1. _jaccard_similarity() computes correct word-overlap ratios
2. _skb_promote() skips near-duplicate entries (Jaccard > 0.7)
3. _skb_promote() allows genuinely distinct entries (Jaccard < 0.7)
4. E-phase enrichment queries for past execution patterns
5. T-phase enrichment uses domain-based search (not task-ID)

Run: python3 -m pytest tests/test_enrichment_memory.py -v
"""
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import amauta


class TestJaccardSimilarity(unittest.TestCase):
    """Tests for _jaccard_similarity() helper."""

    def test_identical_texts(self):
        """Identical texts should return 1.0."""
        self.assertAlmostEqual(
            amauta._jaccard_similarity("hello world foo bar", "hello world foo bar"),
            1.0, places=2
        )

    def test_completely_different(self):
        """Completely different texts should return 0.0."""
        self.assertAlmostEqual(
            amauta._jaccard_similarity("alpha beta gamma", "delta epsilon zeta"),
            0.0, places=2
        )

    def test_partial_overlap(self):
        """Partial overlap should return intermediate value."""
        sim = amauta._jaccard_similarity(
            "VALIDATED PATTERN: Auth SSO integration",
            "LESSON: Auth SSO integration setup"
        )
        # High overlap: "Auth", "SSO", "integration" shared; "VALIDATED", "PATTERN" vs "LESSON", "setup" differ
        self.assertGreater(sim, 0.4)

    def test_skb_near_duplicate_detection(self):
        """Near-duplicate SKB entries (same task, different prefix) should score > 0.7."""
        text_a = "VALIDATED PATTERN: Deploy Authentik SSO. Task: TK-001 Agent: executor-backend. Criteria: OIDC configured"
        text_b = "LESSON: Deploy Authentik SSO. Task: TK-001 Agent: executor-backend. Criteria: OIDC configured"
        sim = amauta._jaccard_similarity(text_a, text_b)
        self.assertGreater(sim, 0.7, f"Near-duplicate should score > 0.7, got {sim}")

    def test_empty_text(self):
        """Empty text should return 0.0."""
        self.assertEqual(amauta._jaccard_similarity("", "hello world foo"), 0.0)
        self.assertEqual(amauta._jaccard_similarity("hello world foo", ""), 0.0)

    def test_short_words_ignored(self):
        """Words < 3 chars should be excluded."""
        # "a", "I", "of" should all be excluded
        sim = amauta._jaccard_similarity("a I of hello world", "a I of hello world")
        # Only "hello" and "world" count
        self.assertAlmostEqual(sim, 1.0, places=2)


class TestSkbPromoteJaccard(unittest.TestCase):
    """Tests for SKB dedup with Jaccard similarity."""

    def test_skips_near_duplicate(self):
        """Should skip insertion when Jaccard > 0.7 with existing entry."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)

        # Existing entry with similar content (enough overlap for Jaccard > 0.7)
        mock_cursor.fetchall.return_value = [
            ("VALIDATED PATTERN: Auth SSO integration Authentik OIDC",
             "Task: TK-001 Auth SSO Authentik OIDC deploy criteria met agent executor backend")
        ]

        with patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_pg_conn", return_value=mock_conn):
            amauta._skb_promote(
                title="LESSON: Auth SSO integration Authentik OIDC",
                content="Task: TK-001 Auth SSO Authentik OIDC deploy criteria met agent executor",
                category="workflow",
            )

        # Should NOT have called INSERT (only SELECT for dedup check)
        insert_calls = [c for c in mock_cursor.execute.call_args_list
                       if "INSERT" in str(c)]
        self.assertEqual(len(insert_calls), 0, "Should not INSERT near-duplicate")

    def test_allows_distinct_entry(self):
        """Should INSERT when Jaccard < 0.7 (genuinely new content)."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)

        # Existing entry with completely different content
        mock_cursor.fetchall.return_value = [
            ("Database migration pattern", "PostgreSQL schema versioning and rollback")
        ]

        with patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_pg_conn", return_value=mock_conn):
            amauta._skb_promote(
                title="LESSON: Auth SSO integration",
                content="OIDC provider configuration and reverse proxy setup",
                category="workflow",
            )

        # Should have called INSERT
        insert_calls = [c for c in mock_cursor.execute.call_args_list
                       if "INSERT" in str(c)]
        self.assertEqual(len(insert_calls), 1, "Should INSERT distinct entry")


class TestEPhasePatternQuery(unittest.TestCase):
    """Tests for E-phase execution pattern memory query."""

    def test_e_phase_includes_pattern_query_via_semantic(self):
        """E-phase enrichment should query _mem_semantic_search for past execution patterns."""
        item = {
            "id": "TK-TEST",
            "title": "Deploy Authentik SSO integration",
            "description": "Set up SSO for homelab services",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_mem_semantic_search", return_value=[
                 {"text": "Past failure: auth timeout", "score": 3,
                  "source": "auto_learning", "tags": []}
             ]) as mock_semantic, \
             patch.object(amauta, "_mem_pg_search", return_value=[
                 {"text": "Past failure: auth timeout", "score": 3,
                  "source": "auto_learning", "tags": []}
             ]):
            result = amauta._rpetd_phase_enrich("E", item, "executing deployment...")

        # _mem_semantic_search should have been called for execution patterns
        call_queries = [str(c) for c in mock_semantic.call_args_list]
        pattern_calls = [q for q in call_queries if "implementation" in q or "approach" in q or "pattern" in q]
        self.assertGreater(len(pattern_calls), 0,
                          f"E-phase should query _mem_semantic_search for patterns, calls were: {call_queries}")

    def test_e_phase_pattern_query_uses_semantic_not_pg(self):
        """E-phase pattern query should call _mem_semantic_search, not _mem_pg_search."""
        item = {
            "id": "TK-TEST",
            "title": "Configure Redis caching layer",
            "description": "Add Redis for session storage",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_mem_semantic_search", return_value=[]) as mock_semantic, \
             patch.object(amauta, "_mem_pg_search", return_value=[]) as mock_pg:
            amauta._rpetd_phase_enrich("E", item, "executing...")

        # _mem_semantic_search should be called for pattern query (primary path)
        semantic_pattern_calls = [str(c) for c in mock_semantic.call_args_list
                                  if "implementation" in str(c) or "approach" in str(c) or "pattern" in str(c)]
        self.assertGreater(len(semantic_pattern_calls), 0,
                          "E-phase pattern query must use _mem_semantic_search as primary path")


class TestTPhasedomainSearch(unittest.TestCase):
    """Tests for T-phase domain-based test strategy search."""

    def test_t_phase_uses_title_not_task_id(self):
        """T-phase should search by domain title via _mem_semantic_search, not task ID."""
        item = {
            "id": "TK-TEST-999",
            "title": "Deploy Authentik SSO integration",
            "description": "Set up SSO",
            "success_criteria": ["OIDC works"],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_mem_pg_search", return_value=[]), \
             patch.object(amauta, "_mem_semantic_search", return_value=[]) as mock_semantic:
            amauta._rpetd_phase_enrich("T", item, "test output: 5 passed")

        # _mem_semantic_search must have been called for T-phase test strategy search
        self.assertTrue(mock_semantic.called,
                       "T-phase should call _mem_semantic_search for domain-based search")

        # Verify the query contains domain title keywords (not task ID)
        t_calls = [str(c) for c in mock_semantic.call_args_list]
        strategy_calls = [q for q in t_calls
                          if "testing" in q.lower() or "strategy" in q.lower() or "validation" in q.lower()]
        self.assertGreater(len(strategy_calls), 0,
                          f"T-phase should query _mem_semantic_search with test strategy keywords, calls: {t_calls}")

        # Ensure the query does NOT use task ID as primary search term
        for call in mock_semantic.call_args_list:
            query_arg = str(call[0][0]) if call[0] else ""
            self.assertNotIn("TK-TEST-999", query_arg,
                            "T-phase should search by domain title, not task ID")


if __name__ == "__main__":
    unittest.main()
