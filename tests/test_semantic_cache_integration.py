#!/usr/bin/env python3
"""Integration tests for SemanticCacheManager and ROUTE-02 compaction wiring.

Phase 24 / SEMANTIC-01, SEMANTIC-02, SEMANTIC-03, ROUTE-02.

Tests end-to-end cache hit/miss cycles using the real SemanticCacheManager
with MockPGStore, and verifies that _make_compaction_llm_call() resolves the
correct model from config.json.

Run: python3 -m pytest tests/test_semantic_cache_integration.py -v
"""

import importlib.util
import json
import math
import os
import sys
import tempfile
import pytest

# Ensure project root on path
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from services.semantic_cache import SemanticCacheManager


# ── Shared Mock Infrastructure ────────────────────────────────────────────────

def _cosine(a, b):
    """Compute cosine similarity between two equal-length lists."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# Distinct embedding vectors for integration test queries (dim=4).
# Chosen so that "similar" pairs have cosine >= 0.90 and "unrelated" < 0.50.
_EMBEDDINGS = {
    # Semantically similar pair — cosine > 0.99
    "Python JSON parsing":              [0.9, 0.4, 0.1, 0.0],
    "how to parse JSON in Python":      [0.88, 0.42, 0.12, 0.02],
    # Completely unrelated — cosine ~ 0.01
    "Kubernetes pod networking":         [0.0, 0.0, 0.1, 0.99],
    # Distinct entries for stats test — no cross-similarity
    "query_alpha":                       [1.0, 0.0, 0.0, 0.0],
    "query_beta":                        [0.0, 1.0, 0.0, 0.0],
    "query_gamma":                       [0.0, 0.0, 1.0, 0.0],
    # Separate entry for invalidation test (different dim dominance)
    "file_invalidation_query":           [0.7, 0.7, 0.1, 0.0],
    "unrelated_invalidation_query":      [0.0, 0.1, 0.0, 1.0],
}


def _get_embedding(text):
    """Return deterministic embedding from lookup table, or hash-based fallback."""
    if text in _EMBEDDINGS:
        return _EMBEDDINGS[text]
    h = hash(text) % 1000
    return [h / 1000.0, (1000 - h) / 1000.0, 0.1, 0.1]


class MockPGStore:
    """In-memory PGStore implementing all semantic_cache_* methods for integration tests."""

    def __init__(self):
        self._entries = []
        self._next_id = 1

    def semantic_cache_lookup(self, query_text, threshold=0.90):
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
        count = 0
        for entry in self._entries:
            if (entry["valid"]
                    and file_path in entry["source_file_hashes"]
                    and entry["source_file_hashes"][file_path] != new_hash):
                entry["valid"] = False
                count += 1
        return count

    def semantic_cache_stats(self):
        total = len(self._entries)
        valid = sum(1 for e in self._entries if e["valid"])
        return {"entries": total, "valid_entries": valid}


# ── ROUTE-02 Daemon Import Helper ────────────────────────────────────────────

def _load_make_compaction_llm_call():
    """Load _make_compaction_llm_call from services/amauta-daemon.py via importlib.

    The file has a hyphen in its name so normal import fails; use spec loading.
    Returns the function, or raises ImportError on failure.
    """
    daemon_path = os.path.join(_PROJECT_ROOT, 'services', 'amauta-daemon.py')
    spec = importlib.util.spec_from_file_location('amauta_daemon', daemon_path)
    module = importlib.util.module_from_spec(spec)
    # Inject module into sys.modules so internal imports resolve
    sys.modules['amauta_daemon'] = module
    spec.loader.exec_module(module)
    return getattr(module, '_make_compaction_llm_call')


# ── SEMANTIC-01: End-to-end cache hit/miss cycle ─────────────────────────────

class TestFullCacheCycle:
    """SEMANTIC-01: End-to-end store then lookup integration."""

    def test_full_cache_cycle_store_then_lookup(self):
        """SEMANTIC-01: Store response, then lookup same query returns correct text."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.90)

        query = "Python JSON parsing"
        response_text = "Use json.loads() for strings, json.load() for file objects."

        entry_id = manager.store(query, response_text, 50, {}, store)
        assert entry_id is not None

        result = manager.lookup(query, store)

        assert result is not None, "Expected cache hit on same query"
        assert result["response"] == response_text
        assert result["similarity"] >= 0.90
        stats = manager.stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 0

    def test_cache_miss_on_unrelated_query(self):
        """SEMANTIC-01: Unrelated query after store returns None (cosine well below threshold)."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.90)

        # Store a Python JSON entry
        manager.store("Python JSON parsing", "Use json.loads()", 10, {}, store)

        # Lookup something completely unrelated
        result = manager.lookup("Kubernetes pod networking", store)

        # Verify fixture: cosine between these two must be < 0.50
        sim = _cosine(
            _get_embedding("Python JSON parsing"),
            _get_embedding("Kubernetes pod networking"),
        )
        assert sim < 0.50, f"Fixture cosine={sim:.4f} unexpectedly high — adjust embeddings"

        assert result is None, "Expected cache miss for unrelated query"
        assert manager.stats()["misses"] == 1


# ── SEMANTIC-02: File-change invalidation integration ─────────────────────────

class TestFileChangeInvalidation:
    """SEMANTIC-02: File change triggers cache invalidation."""

    def test_file_change_invalidates_then_miss(self):
        """SEMANTIC-02: Store with source_file_hashes, invalidate with new hash, lookup misses."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.90)

        file_path = "/tmp/test.py"
        initial_hash = "hash1"
        new_hash = "hash2"

        manager.store(
            "file_invalidation_query",
            "Cached response for file query",
            80,
            {file_path: initial_hash},
            store,
        )

        # Verify it's a hit before invalidation
        result_before = manager.lookup("file_invalidation_query", store)
        assert result_before is not None, "Expected hit before invalidation"

        # Invalidate due to file hash change
        invalidated_count = manager.invalidate_for_file(file_path, new_hash, store)
        assert invalidated_count == 1

        # Now lookup should miss
        result_after = manager.lookup("file_invalidation_query", store)
        assert result_after is None, "Expected miss after invalidation"

    def test_stats_reflect_invalidation(self):
        """SEMANTIC-02: After invalidation, stats shows reduced valid entry count."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.90)

        # Store two entries with distinct file hashes
        manager.store(
            "file_invalidation_query",
            "Response A",
            50,
            {"/tmp/file_a.py": "hash_a_v1"},
            store,
        )
        manager.store(
            "unrelated_invalidation_query",
            "Response B",
            50,
            {"/tmp/file_b.py": "hash_b_v1"},
            store,
        )

        db_stats_before = store.semantic_cache_stats()
        assert db_stats_before["valid_entries"] == 2

        # Invalidate only file_a
        manager.invalidate_for_file("/tmp/file_a.py", "hash_a_v2", store)

        db_stats_after = store.semantic_cache_stats()
        assert db_stats_after["valid_entries"] == 1, (
            f"Expected 1 valid entry after invalidation, got {db_stats_after['valid_entries']}"
        )


# ── SEMANTIC-03: Stats counters after mixed operations ────────────────────────

class TestStatsMixedOperations:
    """SEMANTIC-03: Stats counters accurate after mixed hit/miss operations."""

    def test_stats_after_mixed_operations(self):
        """SEMANTIC-03: 5 hits + 3 misses → hit_rate == 0.625 exactly."""
        store = MockPGStore()
        manager = SemanticCacheManager(threshold=0.0)  # threshold=0 → all stored entries hit

        # Populate one entry
        manager.store("query_alpha", "Response Alpha", 100, {}, store)

        # 5 hits
        for _ in range(5):
            result = manager.lookup("query_alpha", store)
            assert result is not None

        # 3 misses — use separate empty store so no entries are found
        empty_store = MockPGStore()
        for _ in range(3):
            result = manager.lookup("query_alpha", empty_store)
            assert result is None

        stats = manager.stats()
        assert stats["hits"] == 5
        assert stats["misses"] == 3
        assert stats["hit_rate"] == 0.625, (
            f"Expected hit_rate=0.625, got {stats['hit_rate']}"
        )


# ── ROUTE-02: Compaction model routing tests ──────────────────────────────────

class TestRoute02CompactionLlmCall:
    """ROUTE-02: _make_compaction_llm_call reads model from config.json."""

    def test_make_compaction_llm_call_reads_config(self):
        """ROUTE-02: With config containing compaction='haiku', llm_call._compaction_model == 'haiku'."""
        _make_compaction_llm_call = _load_make_compaction_llm_call()

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create .planning/config.json inside a temporary dir structure
            planning_dir = os.path.join(tmpdir, '.planning')
            os.makedirs(planning_dir)
            config = {
                "model_routing": {
                    "R": "sonnet",
                    "P": "sonnet",
                    "E": "sonnet",
                    "T": "haiku",
                    "D": "haiku",
                    "compaction": "haiku",
                }
            }
            config_path = os.path.join(planning_dir, 'config.json')
            with open(config_path, 'w') as f:
                json.dump(config, f)

            # Monkey-patch the config path resolution inside the function
            # by temporarily setting a patched env — we use a direct call trick:
            # _make_compaction_llm_call reads config relative to __file__,
            # so we patch via monkeypatch the path. Instead, call it with a
            # patched __file__ via importlib reload with temp dir.
            # Simplest: call directly and verify by loading config manually.
            import unittest.mock as mock
            daemon_path = os.path.join(_PROJECT_ROOT, 'services', 'amauta-daemon.py')

            # Re-load the module so we can monkeypatch os.path.dirname
            spec = importlib.util.spec_from_file_location('amauta_daemon_t1', daemon_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)

            fn = mod._make_compaction_llm_call

            # Patch the config loading path: replace open so it reads our temp config
            real_open = open

            def patched_open(path, mode='r', *args, **kwargs):
                if 'config.json' in path and '.planning' in path:
                    return real_open(config_path, mode, *args, **kwargs)
                return real_open(path, mode, *args, **kwargs)

            with mock.patch('builtins.open', side_effect=patched_open):
                llm_call = fn()

            assert llm_call is not None, "Expected llm_call function, got None"
            assert hasattr(llm_call, '_compaction_model'), "llm_call must have _compaction_model attribute"
            assert llm_call._compaction_model == 'haiku', (
                f"Expected _compaction_model='haiku', got '{llm_call._compaction_model}'"
            )

    def test_compaction_uses_configured_model_not_phase_model(self):
        """ROUTE-02: compaction model is 'haiku', not the phase model 'sonnet'."""
        import unittest.mock as mock

        daemon_path = os.path.join(_PROJECT_ROOT, 'services', 'amauta-daemon.py')
        spec = importlib.util.spec_from_file_location('amauta_daemon_t2', daemon_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        fn = mod._make_compaction_llm_call

        config = {"model_routing": {"R": "sonnet", "E": "sonnet", "compaction": "haiku"}}
        real_open = open

        def patched_open(path, mode='r', *args, **kwargs):
            if 'config.json' in path and '.planning' in path:
                import io
                return io.StringIO(json.dumps(config))
            return real_open(path, mode, *args, **kwargs)

        with mock.patch('builtins.open', side_effect=patched_open):
            llm_call = fn()

        assert llm_call is not None
        # The resolved model must be 'haiku' (not 'sonnet' which is the phase default)
        assert llm_call._compaction_model == 'haiku', (
            f"Expected 'haiku' (not 'sonnet'), got '{llm_call._compaction_model}'"
        )
        assert llm_call._compaction_model != 'sonnet', (
            "compaction_model must not default to phase model 'sonnet'"
        )

    def test_compaction_fallback_on_missing_config(self):
        """ROUTE-02: _make_compaction_llm_call returns None when config file not found."""
        import unittest.mock as mock

        daemon_path = os.path.join(_PROJECT_ROOT, 'services', 'amauta-daemon.py')
        spec = importlib.util.spec_from_file_location('amauta_daemon_t3', daemon_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        fn = mod._make_compaction_llm_call

        # Patch open to raise FileNotFoundError for config.json
        real_open = open

        def patched_open(path, mode='r', *args, **kwargs):
            if 'config.json' in path and '.planning' in path:
                raise FileNotFoundError(f"No config at {path}")
            return real_open(path, mode, *args, **kwargs)

        with mock.patch('builtins.open', side_effect=patched_open):
            llm_call = fn()

        assert llm_call is None, (
            "Expected None when config.json is missing (graceful fallback)"
        )
