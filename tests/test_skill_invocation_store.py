#!/usr/bin/env python3
"""Tests for skill_invocation_store.py — Phase 43 SKILL-02.

Tests import safety, PG-down graceful fallback, update_outcome validation,
and reciprocal rank fusion pure-function behavior.

All tests run without PG or daemon. PG-dependent paths are exercised via
monkeypatching to verify graceful-fail behavior.

Run: python3 tests/test_skill_invocation_store.py
     pytest tests/test_skill_invocation_store.py -v
"""

import importlib.util
import os
import sys
import unittest

# ── Load skill_invocation_store via importlib + sys.path ─────────────────────

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SVC_DIR = os.path.join(_ROOT, "services")
if _SVC_DIR not in sys.path:
    sys.path.insert(0, _SVC_DIR)

import skill_invocation_store as _store

# ── Test class ────────────────────────────────────────────────────────────────


class TestSkillInvocationStoreImport(unittest.TestCase):
    """Test that the module and its public API are present and importable."""

    def test_module_imports(self):
        """Module imports cleanly and exposes all 4 public symbols."""
        self.assertTrue(hasattr(_store, "record_invocation"))
        self.assertTrue(hasattr(_store, "retrieve_similar"))
        self.assertTrue(hasattr(_store, "update_outcome"))
        self.assertTrue(hasattr(_store, "_reciprocal_rank_fusion"))
        self.assertTrue(callable(_store.record_invocation))
        self.assertTrue(callable(_store.retrieve_similar))
        self.assertTrue(callable(_store.update_outcome))
        self.assertTrue(callable(_store._reciprocal_rank_fusion))

    def test_module_imports_without_pg(self):
        """_HAS_PG can be patched to False and functions remain callable."""
        orig = _store._HAS_PG
        try:
            _store._HAS_PG = False
            self.assertTrue(callable(_store.record_invocation))
            self.assertTrue(callable(_store.retrieve_similar))
            self.assertTrue(callable(_store.update_outcome))
        finally:
            _store._HAS_PG = orig

    def test_has_pg_attribute_exists(self):
        """Module exports _HAS_PG boolean attribute."""
        self.assertTrue(hasattr(_store, "_HAS_PG"))
        self.assertIsInstance(_store._HAS_PG, bool)


class TestDefaultConstants(unittest.TestCase):
    """Verify Area 3 lock constants match spec values."""

    def test_default_constants(self):
        """_DEFAULT_K=3, _DEFAULT_COSINE_FLOOR=0.6, _DEFAULT_RECENCY_DAYS=90, _RRF_K=60."""
        self.assertEqual(_store._DEFAULT_K, 3)
        self.assertAlmostEqual(_store._DEFAULT_COSINE_FLOOR, 0.6)
        self.assertEqual(_store._DEFAULT_RECENCY_DAYS, 90)
        self.assertEqual(_store._RRF_K, 60)


class TestRecordInvocationPGDown(unittest.TestCase):
    """Test graceful fallback when PG is unavailable."""

    def setUp(self):
        self._orig_has_pg = _store._HAS_PG

    def tearDown(self):
        _store._HAS_PG = self._orig_has_pg

    def test_record_invocation_returns_none_when_pg_down(self):
        """record_invocation returns None (not raises) when _HAS_PG=False."""
        _store._HAS_PG = False
        result = _store.record_invocation("plan-phase", "test prompt", {})
        self.assertIsNone(result)

    def test_retrieve_similar_returns_empty_when_pg_down(self):
        """retrieve_similar returns [] (not raises) when _HAS_PG=False."""
        _store._HAS_PG = False
        result = _store.retrieve_similar("plan-phase", "test prompt")
        self.assertEqual(result, [])
        self.assertIsInstance(result, list)


class TestUpdateOutcome(unittest.TestCase):
    """Test update_outcome input validation and PG-down fallback."""

    def setUp(self):
        self._orig_has_pg = _store._HAS_PG

    def tearDown(self):
        _store._HAS_PG = self._orig_has_pg

    def test_update_outcome_rejects_invalid_class(self):
        """update_outcome raises ValueError for invalid outcome_class."""
        with self.assertRaises(ValueError):
            _store.update_outcome("fake-uuid-1234-5678-9012-abcdef012345", "bogus")

    def test_update_outcome_rejects_empty_string(self):
        """update_outcome raises ValueError for empty string."""
        with self.assertRaises(ValueError):
            _store.update_outcome("fake-uuid", "")

    def test_update_outcome_accepts_three_enums(self):
        """update_outcome does NOT raise ValueError for valid outcome values with PG down."""
        _store._HAS_PG = False
        for outcome in ("success", "fail", "escalation"):
            # Should not raise ValueError — returns False when PG is down
            try:
                result = _store.update_outcome("fake-uuid-for-enum-test", outcome)
                self.assertFalse(result, f"Expected False (PG down) for outcome={outcome}")
            except ValueError:
                self.fail(f"ValueError raised for valid outcome '{outcome}'")


class TestReciprocaldRankFusion(unittest.TestCase):
    """Test the _reciprocal_rank_fusion pure function."""

    def test_rrf_picks_overlap_first(self):
        """b appears in both lists → highest RRF score → should be first."""
        # a: 1/(60+1) ≈ 0.01639 (only in list A at rank 1)
        # b: 1/(60+2) + 1/(60+1) ≈ 0.01613 + 0.01639 = 0.03252 (both lists)
        # c: 1/(60+2) ≈ 0.01613 (only in list B at rank 1)
        result = _store._reciprocal_rank_fusion(
            [{"id": "a"}, {"id": "b"}],
            [{"id": "b"}, {"id": "c"}],
        )
        self.assertIsInstance(result, list)
        self.assertGreater(len(result), 0)
        self.assertEqual(result[0]["id"], "b", f"b should be first. Got: {[r['id'] for r in result]}")

    def test_rrf_handles_empty_lists(self):
        """_reciprocal_rank_fusion([], []) returns empty list."""
        result = _store._reciprocal_rank_fusion([], [])
        self.assertEqual(result, [])

    def test_rrf_handles_one_empty_list(self):
        """_reciprocal_rank_fusion([{id:a},{id:b}], []) preserves original order."""
        result = _store._reciprocal_rank_fusion(
            [{"id": "a"}, {"id": "b"}],
            [],
        )
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["id"], "a")
        self.assertEqual(result[1]["id"], "b")

    def test_rrf_handles_other_empty_list(self):
        """_reciprocal_rank_fusion([], [{id:a},{id:b}]) preserves original order."""
        result = _store._reciprocal_rank_fusion(
            [],
            [{"id": "x"}, {"id": "y"}],
        )
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["id"], "x")
        self.assertEqual(result[1]["id"], "y")

    def test_rrf_preserves_source_metadata(self):
        """Fused output carries through similarity and bm25_score fields."""
        list_a = [{"id": "doc1", "similarity": 0.9}]
        list_b = [{"id": "doc2", "bm25_score": 2.3}]
        result = _store._reciprocal_rank_fusion(list_a, list_b)
        by_id = {r["id"]: r for r in result}
        self.assertIn("doc1", by_id)
        self.assertIn("doc2", by_id)
        # doc1 should carry vector_similarity
        self.assertIn("vector_similarity", by_id["doc1"])
        self.assertAlmostEqual(float(by_id["doc1"]["vector_similarity"]), 0.9)
        # doc2 should carry bm25_score
        self.assertIn("bm25_score", by_id["doc2"])
        self.assertAlmostEqual(float(by_id["doc2"]["bm25_score"]), 2.3)

    def test_rrf_score_ordering_correctness(self):
        """b at rank 1 + rank 2 should have higher score than a at rank 2 only."""
        result = _store._reciprocal_rank_fusion(
            [{"id": "a"}, {"id": "b"}],
            [{"id": "b"}, {"id": "c"}],
        )
        by_id = {r["id"]: r["rrf_score"] for r in result}
        self.assertGreater(by_id["b"], by_id["a"])
        self.assertGreater(by_id["a"], by_id["c"])


class TestBuildInvocationText(unittest.TestCase):
    """Test the _build_invocation_text helper (determinism)."""

    def test_build_invocation_text_deterministic(self):
        """Two calls with identical args produce identical output."""
        text1 = _store._build_invocation_text("plan-phase", "test prompt", {"k": 1}, "success")
        text2 = _store._build_invocation_text("plan-phase", "test prompt", {"k": 1}, "success")
        self.assertEqual(text1, text2)

    def test_build_invocation_text_pending_default(self):
        """None outcome_class resolves to 'pending' in the text."""
        text = _store._build_invocation_text("plan-phase", "prompt", {}, None)
        self.assertIn("pending", text)

    def test_build_invocation_text_contains_skill_name(self):
        """skill_name appears in the invocation text."""
        text = _store._build_invocation_text("execute-phase", "do work", {}, None)
        self.assertIn("execute-phase", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
