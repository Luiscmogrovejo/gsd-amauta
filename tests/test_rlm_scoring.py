#!/usr/bin/env python3
"""Tests for RLM BM25 scoring and camelCase/snake_case tokenization.

Verifies that:
1. _tokenize splits camelCase and snake_case identifiers
2. BM25 scoring uses length normalization (short focused chunks rank higher)
3. Label boost (2x) is preserved
4. Position penalty is preserved
5. score_chunks returns properly sorted results

Run: python3 -m pytest tests/test_rlm_scoring.py -v
"""
import importlib.util
import math
import os
import sys
import unittest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

_rlm_path = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py"
)
_spec = importlib.util.spec_from_file_location("rlm_service", _rlm_path)
_rlm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rlm)

_tokenize = _rlm._tokenize
_split_identifiers = _rlm._split_identifiers
score_chunks = _rlm.score_chunks
_compute_score = _rlm._compute_score


class TestSplitIdentifiers(unittest.TestCase):
    """Tests for camelCase and snake_case splitting."""

    def test_camel_case_basic(self):
        result = _split_identifiers("getUserProfile")
        self.assertIn("get", result.lower())
        self.assertIn("User", result)
        self.assertIn("Profile", result)

    def test_snake_case_basic(self):
        result = _split_identifiers("get_user_profile")
        self.assertIn("get", result.lower())
        self.assertIn("user", result.lower())
        self.assertIn("profile", result.lower())

    def test_upper_acronym(self):
        result = _split_identifiers("HTMLParser")
        self.assertIn("HTML", result)
        self.assertIn("Parser", result)

    def test_plain_text_unchanged(self):
        result = _split_identifiers("hello world")
        self.assertEqual(result, "hello world")


class TestTokenize(unittest.TestCase):
    """Tests for the updated _tokenize with identifier splitting."""

    def test_camel_case_tokens(self):
        tokens = _tokenize("getUserProfile")
        self.assertIn("get", tokens)
        self.assertIn("user", tokens)
        self.assertIn("profile", tokens)

    def test_snake_case_tokens(self):
        tokens = _tokenize("get_user_profile")
        self.assertIn("get", tokens)
        self.assertIn("user", tokens)
        self.assertIn("profile", tokens)

    def test_mixed_identifiers(self):
        tokens = _tokenize("parseJSON_response from getApiData")
        self.assertIn("parse", tokens)
        self.assertIn("json", tokens)
        self.assertIn("response", tokens)
        self.assertIn("get", tokens)
        self.assertIn("api", tokens)
        self.assertIn("data", tokens)

    def test_min_length_filter(self):
        """Tokens shorter than 3 chars should be excluded."""
        tokens = _tokenize("a ab abc abcd")
        self.assertNotIn("a", tokens)
        self.assertNotIn("ab", tokens)
        self.assertIn("abc", tokens)
        self.assertIn("abcd", tokens)


class TestBM25Scoring(unittest.TestCase):
    """Tests for BM25 scoring formula."""

    def _make_chunk(self, text, label="", start_line=1, end_line=10):
        return {
            "text": text,
            "label": label,
            "start_line": start_line,
            "end_line": end_line,
            "filepath": "test.py",
        }

    def test_length_normalization(self):
        """Short focused chunks should rank higher than long unfocused ones."""
        short = self._make_chunk("user profile database query", label="getUser")
        long_text = ("filler word " * 100) + "user profile"
        long = self._make_chunk(long_text, label="bigFunction", start_line=1, end_line=200)

        results = score_chunks([short, long], "user profile", top_k=2)
        self.assertEqual(results[0]["label"], "getUser",
                         "Short focused chunk should rank first with BM25 length normalization")

    def test_label_boost_preserved(self):
        """Chunks with query terms in label should rank higher."""
        with_label = self._make_chunk("handle user auth flow extra code padding", label="userAuth")
        without_label = self._make_chunk("handle user auth flow extra code padding", label="miscFunction")
        # Add a third filler chunk to give BM25 IDF discrimination
        filler = self._make_chunk("totally unrelated filler text with no matching terms", label="filler")

        results = score_chunks([without_label, with_label, filler], "user auth", top_k=3)
        # The chunk with matching label should rank first
        self.assertEqual(results[0]["label"], "userAuth")
        # Its score should be strictly higher than the one without label match
        self.assertGreater(results[0]["relevance_score"], results[1]["relevance_score"])

    def test_position_penalty_preserved(self):
        """Chunks at top of file should score slightly higher than identical chunks at bottom."""
        top = self._make_chunk("database connection pool", label="dbPool", start_line=5, end_line=20)
        bottom = self._make_chunk("database connection pool", label="dbPool", start_line=450, end_line=465)

        # Need enough chunks to have meaningful max_end_line
        filler = self._make_chunk("something else entirely", label="other", start_line=200, end_line=500)
        results = score_chunks([bottom, top, filler], "database connection", top_k=3)
        # Top chunk should appear before bottom chunk
        top_idx = next(i for i, r in enumerate(results) if r["start_line"] == 5)
        bottom_idx = next(i for i, r in enumerate(results) if r["start_line"] == 450)
        self.assertLess(top_idx, bottom_idx)

    def test_empty_query_returns_first_n(self):
        """Empty query should return first top_k chunks unchanged."""
        chunks = [self._make_chunk(f"chunk {i}") for i in range(5)]
        results = score_chunks(chunks, "", top_k=3)
        self.assertEqual(len(results), 3)

    def test_no_chunks_returns_empty(self):
        results = score_chunks([], "test query", top_k=5)
        self.assertEqual(len(results), 0)

    def test_bm25_saturation(self):
        """BM25 should show diminishing returns for repeated terms (saturation)."""
        # A chunk with "auth" 1 time vs 100 times -- the gap should NOT be linear
        once = self._make_chunk("auth handler for login", label="auth")
        many = self._make_chunk("auth " * 100, label="repeater")

        results = score_chunks([once, many], "auth", top_k=2)
        # Both should score, but the 100x chunk should NOT score 100x higher
        ratio = results[0]["relevance_score"] / max(0.001, results[1]["relevance_score"])
        self.assertLess(ratio, 10, "BM25 saturation should prevent linear scaling with TF")

    def test_relevance_score_field_present(self):
        """Each result should have a relevance_score field."""
        chunk = self._make_chunk("test function implementation", label="testFunc")
        results = score_chunks([chunk], "test function", top_k=1)
        self.assertIn("relevance_score", results[0])
        self.assertGreater(results[0]["relevance_score"], 0)


if __name__ == "__main__":
    unittest.main()
