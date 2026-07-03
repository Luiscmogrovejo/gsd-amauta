#!/usr/bin/env python3
"""Phase 66-02 (MEMR-02/05) — bounded citation boost + merged_sources carry
+ echo-chamber canary unit tests.

Direct-import PGStore via PGStore.__new__() for scorer units — no PG
connection needed. Matches the pattern already used by the plan's own
acceptance-criteria snippets.
"""
import sys
import os
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.pg_store import PGStore, SOURCE_SCORES  # noqa: E402


def _new_store():
    return PGStore.__new__(PGStore)


class TestBoostBounded(unittest.TestCase):
    def test_boost_bounded(self):
        """applied_count 0 -> +0.0; 1000 -> +3.0 cap (never unbounded)."""
        store = _new_store()
        rows = [
            {"source": "agent", "applied_count": 1000, "text_rank": 0.0, "created_at": None},
            {"source": "agent", "applied_count": 0, "text_rank": 0.0, "created_at": None},
        ]
        scored = store._score_memories(rows)
        self.assertAlmostEqual(scored[0]["score"], 3.0, delta=0.01)
        self.assertEqual(scored[1]["score"], 0.0)

    def test_boost_absent_applied_count_treated_as_zero(self):
        """A row with no applied_count key at all must not crash and must
        score identically to applied_count=0 (byte-identical to pre-boost)."""
        store = _new_store()
        rows = [{"source": "agent", "text_rank": 0.0, "created_at": None}]
        scored = store._score_memories(rows)
        self.assertEqual(scored[0]["score"], 0.0)


class TestBoostInBothScorers(unittest.TestCase):
    def test_boost_in_both_scorers(self):
        """Same synthetic row through _score_memories and
        _score_semantic_results gains the identical citation_boost."""
        store = _new_store()
        text_row = {"source": "agent", "applied_count": 20, "text_rank": 0.0, "created_at": None}
        sem_row = {"source": "agent", "applied_count": 20, "semantic_similarity": 0.0, "created_at": None}

        text_scored = store._score_memories([text_row])[0]
        sem_scored = store._score_semantic_results([sem_row])[0]

        # Both base terms (text_rank*10, similarity*10) are 0, source_bonus is 0
        # for 'agent' — so the entire score IS the citation_boost, and it must
        # be identical across scorers.
        self.assertAlmostEqual(text_scored["score"], sem_scored["score"], delta=0.001)
        self.assertGreater(text_scored["score"], 0.0)


class TestMergedSourcesCarry(unittest.TestCase):
    def test_merged_sources_carry(self):
        """A distilled row (+2) with metadata.merged_sources=['lesson-learned']
        (+4) scores with the carried bonus (4), not its own bonus (2)."""
        store = _new_store()
        row = {
            "source": "distilled",
            "applied_count": 0,
            "text_rank": 0.0,
            "created_at": None,
            "metadata": {"merged_sources": ["lesson-learned"]},
        }
        scored = store._score_memories([row])[0]
        self.assertEqual(scored["score"], float(SOURCE_SCORES["lesson-learned"]))

    def test_carry_never_lowers_bonus(self):
        """A lesson-learned row (+4) with metadata.merged_sources=['agent']
        (+0) keeps its own higher bonus (4) — carry only raises, never lowers."""
        store = _new_store()
        row = {
            "source": "lesson-learned",
            "applied_count": 0,
            "text_rank": 0.0,
            "created_at": None,
            "metadata": {"merged_sources": ["agent"]},
        }
        scored = store._score_memories([row])[0]
        self.assertEqual(scored["score"], float(SOURCE_SCORES["lesson-learned"]))

    def test_carry_capped_at_source_scores_max(self):
        """Carry never exceeds the SOURCE_SCORES ceiling (4) even if a bogus
        merged_sources entry somehow scored higher."""
        store = _new_store()
        row = {
            "source": "distilled",
            "applied_count": 0,
            "text_rank": 0.0,
            "created_at": None,
            "metadata": {"merged_sources": ["lesson-learned", "best-practice"]},
        }
        scored = store._score_memories([row])[0]
        self.assertEqual(scored["score"], 4.0)


class TestMetadataStringGuard(unittest.TestCase):
    def test_metadata_string_guard(self):
        """metadata arriving as a JSON string (rather than a dict) must not
        crash the scorer — parsed if possible, ignored gracefully otherwise."""
        store = _new_store()
        row = {
            "source": "distilled",
            "applied_count": 0,
            "text_rank": 0.0,
            "created_at": None,
            "metadata": '{"merged_sources": ["agent"]}',
        }
        scored = store._score_memories([row])[0]
        # merged=['agent'] carries max(0, SOURCE_SCORES['agent']=0) -> stays at
        # distilled's own bonus (2), no crash.
        self.assertEqual(scored["score"], 2.0)

    def test_metadata_garbage_string_does_not_crash(self):
        store = _new_store()
        row = {
            "source": "distilled",
            "applied_count": 0,
            "text_rank": 0.0,
            "created_at": None,
            "metadata": "not valid json {{{",
        }
        scored = store._score_memories([row])[0]
        self.assertEqual(scored["score"], 2.0)

    def test_semantic_scorer_metadata_string_guard(self):
        store = _new_store()
        row = {
            "source": "distilled",
            "applied_count": 0,
            "semantic_similarity": 0.0,
            "created_at": None,
            "metadata": '{"merged_sources": ["lesson-learned"]}',
        }
        scored = store._score_semantic_results([row])[0]
        self.assertEqual(scored["score"], 4.0)


class TestConcentration(unittest.TestCase):
    def test_concentration_computed_correctly(self):
        """monkeypatch memory_search to return fixed top-1 ids -> max_top1_share
        and distinct_top1 computed correctly; zero-result queries excluded."""
        store = _new_store()
        seq = [[{"id": "a"}], [{"id": "a"}], [{"id": "b"}], [], [{"id": "a"}]]
        it = iter(seq)
        with patch.object(store, "memory_search", side_effect=lambda q, limit=5: next(it)):
            result = store.memory_top1_concentration(
                ["q1", "q2", "q3", "q4", "q5"], limit=5
            )
        self.assertEqual(result["total_queries"], 5)
        self.assertEqual(result["answered"], 4)
        self.assertEqual(result["distinct_top1"], 2)
        self.assertAlmostEqual(result["max_top1_share"], 0.75, delta=0.0001)
        self.assertEqual(result["top1_ids"], {"a": 3, "b": 1})

    def test_concentration_empty_corpus_returns_zeros(self):
        """Empty query list must return all-zero dict, never a division error."""
        store = _new_store()
        result = store.memory_top1_concentration([])
        self.assertEqual(result["total_queries"], 0)
        self.assertEqual(result["answered"], 0)
        self.assertEqual(result["distinct_top1"], 0)
        self.assertEqual(result["max_top1_share"], 0.0)
        self.assertEqual(result["top1_ids"], {})

    def test_concentration_all_zero_results_returns_zeros(self):
        """Every query returns zero results -> answered=0, no crash."""
        store = _new_store()
        with patch.object(store, "memory_search", return_value=[]):
            result = store.memory_top1_concentration(["q1", "q2"], limit=5)
        self.assertEqual(result["total_queries"], 2)
        self.assertEqual(result["answered"], 0)
        self.assertEqual(result["max_top1_share"], 0.0)


if __name__ == "__main__":
    unittest.main()
