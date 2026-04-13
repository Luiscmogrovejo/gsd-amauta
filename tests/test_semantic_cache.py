#!/usr/bin/env python3
"""Tests for SemanticCacheManager — Phase 24 / SEMANTIC-01, SEMANTIC-02, SEMANTIC-03.

Tests lookup/store/invalidate behavior with a MockPGStore that implements
all semantic_cache_* methods in-memory using a lookup table of pre-defined
cosine similarity scores.

Run: python3 -m pytest tests/test_semantic_cache.py -v
"""

import math
import threading
import pytest

from services.semantic_cache import SemanticCacheManager, COSINE_THRESHOLD


# ── Mock Infrastructure ───────────────────────────────────────────────────────

def _cosine(a, b):
    """Compute cosine similarity between two equal-length lists."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# Pre-defined embedding vectors (dim=4 for simplicity).
# "Similar" queries share a dominant dimension; "unrelated" queries do not.
_EMBEDDINGS = {
    # Near-identical queries (cosine ~ 1.0)
    "how to parse JSON in Python": [0.9, 0.4, 0.1, 0.0],
    "Python JSON parsing":          [0.88, 0.42, 0.12, 0.02],
    # Clearly unrelated query (cosine ~ 0.18 with above)
    "what is the speed of light":   [0.0, 0.0, 0.1, 0.99],
    # Threshold edge cases
    "query_above_threshold":        [1.0, 0.0, 0.0, 0.0],
    "query_below_threshold":        [0.0, 1.0, 0.0, 0.0],
}

_THRESHOLD_TEST = 0.90  # same as default COSINE_THRESHOLD


def _get_embedding(text):
    """Return a deterministic embedding from the lookup table, or a generic one."""
    if text in _EMBEDDINGS:
        return _EMBEDDINGS[text]
    # Generic embedding based on hash — deterministic but arbitrary
    h = hash(text) % 1000
    return [h / 1000.0, (1000 - h) / 1000.0, 0.1, 0.1]


class MockPGStore:
    """In-memory PGStore that implements semantic_cache_* methods for testing.

    Uses pre-defined embedding vectors with real cosine similarity math.
    """

    def __init__(self):
        self._entries = []  # list of dicts
        self._next_id = 1

    def semantic_cache_lookup(self, query_text, threshold=0.90):
        """Return the most similar valid entry above threshold, or None."""
        q_vec = _get_embedding(query_text)
        best = None
        best_sim = -1.0
        for entry in self._entries:
            if not entry["valid"]:
                continue
            sim = _cosine(q_vec, entry["_embedding"])
            if sim >= threshold and sim > best_sim:
                best_sim = sim
                best = entry
        if best:
            return {
                "id": best["id"],
                "query_text": best["query_text"],
                "response": best["response"],
                "response_tokens": best["response_tokens"],
                "similarity": round(best_sim, 4),
                "source_file_hashes": best["source_file_hashes"] or {},
            }
        return None

    def semantic_cache_store(self, query_text, response, response_tokens=0,
                             source_file_hashes=None, provider="perplexity"):
        """Store entry, return new ID."""
        entry_id = self._next_id
        self._next_id += 1
        self._entries.append({
            "id": entry_id,
            "query_text": query_text,
            "_embedding": _get_embedding(query_text),
            "response": response,
            "response_tokens": response_tokens,
            "source_file_hashes": source_file_hashes or {},
            "valid": True,
            "provider": provider,
        })
        return entry_id

    def semantic_cache_invalidate(self, file_path, new_hash):
        """Invalidate entries where source_file_hashes[file_path] != new_hash."""
        count = 0
        for entry in self._entries:
            if (entry["valid"]
                    and file_path in entry["source_file_hashes"]
                    and entry["source_file_hashes"][file_path] != new_hash):
                entry["valid"] = False
                count += 1
        return count

    def semantic_cache_stats(self):
        """Return entry counts."""
        total = len(self._entries)
        valid = sum(1 for e in self._entries if e["valid"])
        return {"entries": total, "valid_entries": valid}


# ── SEMANTIC-01: Cache lookup and hit/miss behavior ───────────────────────────

class TestSemanticCacheLookup:
    """SEMANTIC-01: Cache intercepts queries at cosine >= 0.90."""

    def test_cache_miss_returns_none(self):
        """Lookup on empty cache returns None and increments miss counter."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        result = manager.lookup("any query", store)

        assert result is None
        assert manager.stats()["misses"] == 1
        assert manager.stats()["hits"] == 0

    def test_cache_hit_returns_response(self):
        """Store a response, then lookup with same query returns it."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        manager.store("how to parse JSON in Python", "Use json.loads()", 10, {}, store)
        result = manager.lookup("how to parse JSON in Python", store)

        assert result is not None
        assert result["response"] == "Use json.loads()"
        assert manager.stats()["hits"] == 1

    def test_paraphrased_query_cache_hit(self):
        """Store 'how to parse JSON in Python', lookup 'Python JSON parsing' returns it.

        Both queries map to embeddings with cosine >= 0.90.
        """
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        manager.store(
            "how to parse JSON in Python",
            "Use json.loads() or json.load()",
            50,
            {},
            store,
        )
        result = manager.lookup("Python JSON parsing", store)

        q_orig = _get_embedding("how to parse JSON in Python")
        q_para = _get_embedding("Python JSON parsing")
        actual_sim = _cosine(q_orig, q_para)

        # Verify our fixture is actually above threshold before asserting
        assert actual_sim >= _THRESHOLD_TEST, (
            f"Fixture embeddings have cosine={actual_sim:.4f} < {_THRESHOLD_TEST}; "
            "adjust fixture vectors"
        )
        assert result is not None, "Expected cache hit for paraphrased query"
        assert result["response"] == "Use json.loads() or json.load()"

    def test_below_threshold_returns_miss(self):
        """Store a response, lookup with unrelated query (cosine ~ 0.18) returns None."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        manager.store(
            "how to parse JSON in Python",
            "Use json.loads()",
            10,
            {},
            store,
        )
        result = manager.lookup("what is the speed of light", store)

        q_orig = _get_embedding("how to parse JSON in Python")
        q_other = _get_embedding("what is the speed of light")
        actual_sim = _cosine(q_orig, q_other)

        assert actual_sim < _THRESHOLD_TEST, (
            f"Fixture embeddings have cosine={actual_sim:.4f} >= {_THRESHOLD_TEST}; "
            "adjust fixture vectors"
        )
        assert result is None
        assert manager.stats()["misses"] == 1


# ── SEMANTIC-02: File-change invalidation ─────────────────────────────────────

class TestSemanticCacheInvalidation:
    """SEMANTIC-02: Cache entries are invalidated when source file hashes change."""

    def test_invalidate_on_file_change(self):
        """Store entry with source_file_hashes, invalidate with new hash, entry no longer returned."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        file_hashes = {"/project/src/foo.py": "abc123"}
        manager.store("my query", "cached response", 100, file_hashes, store)

        # Verify it's findable before invalidation
        assert manager.lookup("my query", store) is not None

        # Invalidate: file hash changed
        count = manager.invalidate_for_file("/project/src/foo.py", "def456", store)
        assert count == 1

        # Should now miss
        assert manager.lookup("my query", store) is None

    def test_invalidate_only_affects_changed_files(self):
        """Invalidate one file hash; only entries referencing that file are affected."""
        # Use exact-match lookup (threshold=0.999) so we target specific entries.
        # To ensure each query only matches its own entry, we inspect the store directly.
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        hashes_a = {"/project/a.py": "hash_a_v1"}
        hashes_b = {"/project/b.py": "hash_b_v1"}

        manager.store("how to parse JSON in Python", "response A", 10, hashes_a, store)
        manager.store("what is the speed of light", "response B", 10, hashes_b, store)

        # Before invalidation — both entries valid
        assert store.semantic_cache_stats()["valid_entries"] == 2

        # Invalidate only file A (used by "how to parse JSON in Python" entry)
        count = manager.invalidate_for_file("/project/a.py", "hash_a_v2", store)
        assert count == 1

        # File A's entry is now invalid; file B's still valid
        stats = store.semantic_cache_stats()
        assert stats["valid_entries"] == 1

        # The remaining valid entry belongs to the file-B query
        for entry in store._entries:
            if entry["valid"]:
                assert entry["source_file_hashes"] == hashes_b

    def test_valid_file_hash_not_invalidated(self):
        """If the file hash has NOT changed, the cache entry remains valid."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        current_hash = "unchanged_hash_42"
        file_hashes = {"/project/stable.py": current_hash}
        manager.store("stable query", "stable response", 20, file_hashes, store)

        # Invalidate with the SAME hash (no change)
        count = manager.invalidate_for_file("/project/stable.py", current_hash, store)
        assert count == 0

        # Entry still valid
        assert manager.lookup("stable query", store) is not None


# ── SEMANTIC-03: Stats counters ───────────────────────────────────────────────

class TestSemanticCacheStats:
    """SEMANTIC-03: /cache/stats returns correct hit/miss/hit_rate/tokens counters."""

    def test_stats_hit_rate_calculation(self):
        """5 hits and 3 misses → hit_rate = 0.625."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.0)  # threshold=0 makes every stored entry a hit

        manager.store("query", "response", 100, {}, store)

        for _ in range(5):
            manager.lookup("query", store)

        # 3 misses with a fresh empty store
        empty_store = MockPGStore()
        for _ in range(3):
            manager.lookup("miss query", empty_store)

        stats = manager.stats()
        assert stats["hits"] == 5
        assert stats["misses"] == 3
        assert stats["hit_rate"] == 0.625

    def test_stats_includes_all_fields(self):
        """stats() must return all required fields with correct types."""
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        stats = manager.stats()

        required_fields = {"hits", "misses", "hit_rate", "entries", "total_tokens_saved", "estimated_cost_saved"}
        assert required_fields.issubset(stats.keys()), (
            f"Missing fields: {required_fields - set(stats.keys())}"
        )
        assert isinstance(stats["hits"], int)
        assert isinstance(stats["misses"], int)
        assert isinstance(stats["hit_rate"], float)
        assert isinstance(stats["entries"], int)
        assert isinstance(stats["total_tokens_saved"], int)
        assert isinstance(stats["estimated_cost_saved"], float)

    def test_stats_tokens_saved_accumulates(self):
        """total_tokens_saved sums response_tokens from all hits."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.0)  # threshold=0 → all entries hit

        manager.store("q1", "r1", 200, {}, store)
        manager.store("q2", "r2", 300, {}, store)

        manager.lookup("q1", store)
        manager.lookup("q2", store)

        stats = manager.stats()
        assert stats["total_tokens_saved"] == 500

    def test_stats_estimated_cost_saved(self):
        """estimated_cost_saved = hits * 0.018."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.0)

        manager.store("query", "resp", 50, {}, store)
        for _ in range(4):
            manager.lookup("query", store)

        stats = manager.stats()
        expected = round(4 * 0.018, 6)
        assert stats["estimated_cost_saved"] == expected

    def test_stats_zero_requests_hit_rate(self):
        """hit_rate is 0.0 when no lookups have been made."""
        manager = SemanticCacheManager()
        stats = manager.stats()
        assert stats["hit_rate"] == 0.0
        assert stats["hits"] == 0
        assert stats["misses"] == 0

    def test_stats_thread_safe(self):
        """Concurrent lookups do not corrupt hit/miss counters."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.0)

        manager.store("concurrent query", "response", 10, {}, store)

        results = []

        def do_lookups():
            for _ in range(50):
                r = manager.lookup("concurrent query", store)
                results.append(r is not None)

        threads = [threading.Thread(target=do_lookups) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        stats = manager.stats()
        assert stats["hits"] == 200  # 4 threads * 50 lookups
        assert stats["misses"] == 0

    def test_no_store_counts_as_miss(self):
        """Lookup with no store (None) counts as a miss and returns None."""
        manager = SemanticCacheManager(threshold=_THRESHOLD_TEST)

        result = manager.lookup("any query", None)

        assert result is None
        assert manager.stats()["misses"] == 1
