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

    def test_substring_tf_not_overcounted(self):
        """RLM-01: 'get' should NOT match inside 'getting', 'forget', 'budget'."""
        chunk_with_substrings = self._make_chunk(
            "getting user data, forget about budget issues",
            label="processData"
        )
        chunk_with_exact = self._make_chunk(
            "get the user profile from database",
            label="fetchUser"
        )
        results = score_chunks([chunk_with_substrings, chunk_with_exact], "get", top_k=2)
        # The chunk with exact "get" should rank higher than one with only substrings
        exact_score = next(r["relevance_score"] for r in results if r["label"] == "fetchUser")
        substring_score = next(r["relevance_score"] for r in results if r["label"] == "processData")
        self.assertGreater(exact_score, substring_score,
                           "'get' exact match should score higher than 'getting'/'forget'/'budget' substrings")

    def test_word_boundary_tf_correct(self):
        """RLM-01: 'get' in 'get(x)' should count as TF=1 with word boundary matching."""
        chunk = self._make_chunk(
            "def get(x): return get_value(x) if get else None",
            label="getter"
        )
        # With word-boundary matching: "get" appears as a standalone word twice
        # ("get(x)" -> "get" after tokenization, and "get" before "else")
        # The old text.count("get") would find "get" inside "get_value" too
        results = score_chunks([chunk], "get", top_k=1)
        self.assertGreater(results[0]["relevance_score"], 0,
                           "Word-boundary 'get' should still match")

    def test_multi_term_query_ranks_better_coverage(self):
        """RLM-02: chunk matching all query terms should rank above one matching only one term."""
        full_match = self._make_chunk(
            "user authentication profile database handler",
            label="fullHandler"
        )
        partial_match = self._make_chunk(
            "user user user user user repeated many times",
            label="partialHandler"
        )
        filler = self._make_chunk("unrelated code about widgets", label="filler")
        results = score_chunks([partial_match, full_match, filler],
                               "user authentication profile database", top_k=3)
        # Full coverage should beat repeated single-term match
        self.assertEqual(results[0]["label"], "fullHandler",
                         "Chunk matching all query terms should rank first (no query-length normalization)")

    def test_position_decay_reduced(self):
        """RLM-03: position decay should be 5% (not 10%) -- bottom-of-file penalty is halved."""
        rlm_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py")
        spec = importlib.util.spec_from_file_location("rlm_check", rlm_path)
        rlm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rlm)
        self.assertAlmostEqual(rlm.POSITION_DECAY, 0.05, places=2,
                               msg="POSITION_DECAY should default to 0.05 (5%)")

    def test_bm25_b_parameter_code_optimized(self):
        """RLM-04: BM25 b parameter should be 0.6 (code-optimized, not 0.75 prose default)."""
        rlm_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py")
        spec = importlib.util.spec_from_file_location("rlm_check_b", rlm_path)
        rlm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rlm)
        self.assertAlmostEqual(rlm.BM25_B, 0.6, places=2,
                               msg="BM25_B should be 0.6 for code-optimized length normalization")

    def test_default_chunk_size_4000(self):
        """RLM-05: default max chunk size should be 4000 chars (not 8000)."""
        import importlib
        rlm_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py")
        spec = importlib.util.spec_from_file_location("rlm_check_chunk", rlm_path)
        rlm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rlm)
        self.assertEqual(rlm.MAX_CHUNK_CHARS, 4000,
                         "MAX_CHUNK_CHARS should default to 4000 for focused retrieval")

    def test_label_boost_does_not_dominate(self):
        """RLM-06: label match should boost but NOT dominate over content-rich chunks."""
        # Chunk with matching label but minimal content
        label_only = self._make_chunk(
            "stub function with no real content here",
            label="userAuth"
        )
        # Chunk with rich content but non-matching label
        content_rich = self._make_chunk(
            "user authentication handler validates credentials checks password "
            "verifies auth tokens refreshes sessions manages user login flow "
            "auth middleware processes user requests handles auth errors",
            label="middleware"
        )
        filler = self._make_chunk("unrelated widget factory code", label="widgets")
        results = score_chunks([label_only, content_rich, filler], "user auth", top_k=3)
        # Content-rich chunk should rank at least as well as label-only chunk
        content_idx = next(i for i, r in enumerate(results) if r["label"] == "middleware")
        self.assertLessEqual(content_idx, 1,
                             "Content-rich chunk should be in top 2 despite lacking label match")


class TestChunkCache(unittest.TestCase):
    """Tests for ChunkCache hit/miss counters (RLM-08)."""

    def test_cache_hit_miss_counters(self):
        """Hit and miss counters should increment correctly."""
        cache = _rlm.ChunkCache(max_size=10)
        # Miss: key not in cache
        result = cache.get("/test/file.py", 1000.0)
        self.assertIsNone(result)
        self.assertEqual(cache.miss_count, 1)
        self.assertEqual(cache.hit_count, 0)

        # Put then hit
        cache.put("/test/file.py", 1000.0, [{"text": "chunk1"}])
        result = cache.get("/test/file.py", 1000.0)
        self.assertIsNotNone(result)
        self.assertEqual(cache.hit_count, 1)
        self.assertEqual(cache.miss_count, 1)

        # Hit rate
        self.assertAlmostEqual(cache.hit_rate, 0.5, places=2)

    def test_cache_clear_resets_counters(self):
        """Clearing cache should reset hit/miss counters."""
        cache = _rlm.ChunkCache(max_size=10)
        cache.put("/test/file.py", 1000.0, [{"text": "chunk1"}])
        cache.get("/test/file.py", 1000.0)  # hit
        cache.get("/test/missing.py", 2000.0)  # miss
        self.assertGreater(cache.hit_count, 0)
        self.assertGreater(cache.miss_count, 0)

        cache.clear()
        self.assertEqual(cache.hit_count, 0)
        self.assertEqual(cache.miss_count, 0)
        self.assertAlmostEqual(cache.hit_rate, 0.0, places=2)

    def test_clear_file_removes_specific_entries(self):
        """RLM-09: clear_file should remove only entries for the specified filepath."""
        cache = _rlm.ChunkCache(max_size=10)
        cache.put("/test/a.py", 1000.0, [{"text": "chunk_a"}])
        cache.put("/test/b.py", 2000.0, [{"text": "chunk_b"}])

        # Clear only a.py
        cache.clear_file("/test/a.py")

        self.assertIsNone(cache.get("/test/a.py", 1000.0))
        self.assertIsNotNone(cache.get("/test/b.py", 2000.0))
        self.assertEqual(cache.size, 1)


if __name__ == "__main__":
    unittest.main()
