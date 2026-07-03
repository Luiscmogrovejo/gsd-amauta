"""
Plan 65-04 -- RETR-07: ranking-consistency sweep tests.

Re-exec half (RLM-M5): legacy_chunker() must load rlm-service.py exactly
once per process instead of re-exec'ing importlib on every non-code file.

Cache-key half (RLM-M6): reranker cache keys must derive from chunk content
identity, not a shared `id`-or-position fallback, so id-less chunks never
collide on a single cache entry.

Run: pytest tests/test_65_consistency_sweep.py -v
"""
import importlib.util as _importlib_util
import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services import ast_chunker  # noqa: E402
from services import rlm_reranker  # noqa: E402


def _reset_module_cache():
    """Reset ast_chunker's process-global rlm-service module cache."""
    ast_chunker._RLM_SERVICE_MOD = None


def _make_chunk(file_path, start_line, content, chunk_id=None):
    c = {"file_path": file_path, "start_line": start_line, "content": content}
    if chunk_id is not None:
        c["id"] = chunk_id
    return c


class _DictCache:
    """Minimal Valkey-shaped stub: get/set backed by a dict, accepts ex=."""

    def __init__(self):
        self.store = {}

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ex=None):
        self.store[key] = value


# ---------------------------------------------------------------------------
# Re-exec half (RLM-M5)
# ---------------------------------------------------------------------------

def test_legacy_chunker_execs_module_once(tmp_path, monkeypatch):
    """Two consecutive legacy_chunker calls execute rlm-service.py exactly once."""
    _reset_module_cache()
    real_spec_from_file_location = _importlib_util.spec_from_file_location
    call_count = {"n": 0}

    def counting_wrapper(*args, **kwargs):
        call_count["n"] += 1
        return real_spec_from_file_location(*args, **kwargs)

    monkeypatch.setattr(_importlib_util, "spec_from_file_location", counting_wrapper)

    md_file = tmp_path / "sample.md"
    md_file.write_text("# Title\n\nSome markdown content for chunking.\n")

    result1 = ast_chunker.legacy_chunker(str(md_file))
    result2 = ast_chunker.legacy_chunker(str(md_file))

    assert result1 == result2, "Two calls on the same unmodified file should return equal chunks"
    assert call_count["n"] == 1, f"Expected exactly 1 module exec, got {call_count['n']}"

    _reset_module_cache()


def test_cached_module_identity():
    """_get_rlm_service_module() returns the SAME object across calls."""
    _reset_module_cache()
    mod1 = ast_chunker._get_rlm_service_module()
    mod2 = ast_chunker._get_rlm_service_module()
    assert mod1 is mod2, "Second call must return the identical cached module object"
    _reset_module_cache()


def test_load_failure_cached_not_retried(monkeypatch):
    """A failed module load is cached; the raising loader is invoked exactly once."""
    _reset_module_cache()
    call_count = {"n": 0}

    def raising_loader(*args, **kwargs):
        call_count["n"] += 1
        raise RuntimeError("simulated load failure")

    monkeypatch.setattr(_importlib_util, "spec_from_file_location", raising_loader)

    result1 = ast_chunker.legacy_chunker("/nonexistent/path/whatever.md")
    result2 = ast_chunker.legacy_chunker("/nonexistent/path/whatever.md")

    assert result1 == []
    assert result2 == []
    assert call_count["n"] == 1, f"Expected exactly 1 load attempt, got {call_count['n']}"

    _reset_module_cache()


# ---------------------------------------------------------------------------
# Cache-key half (RLM-M6)
# ---------------------------------------------------------------------------

def test_idless_chunks_get_distinct_keys():
    """Two different id-less chunks get distinct keys; identical chunks agree."""
    chunk_a = _make_chunk("a.md", 1, "alpha content here")
    chunk_b = _make_chunk("b.md", 5, "beta content here")

    key_a = rlm_reranker._stable_chunk_key(chunk_a)
    key_b = rlm_reranker._stable_chunk_key(chunk_b)
    assert key_a != key_b, "Different id-less chunks must not collide on the same key"

    chunk_a_copy = dict(chunk_a)
    assert rlm_reranker._stable_chunk_key(chunk_a_copy) == key_a, "Key derivation must be deterministic"


def test_id_bearing_chunks_keep_plain_id_keys():
    """A chunk with a real id keys as str(id) -- backward-compatible with existing Valkey entries."""
    chunk = {"id": 42, "content": "whatever"}
    assert rlm_reranker._stable_chunk_key(chunk) == "42"


def test_no_cross_contamination_via_cache(monkeypatch):
    """Cached scores for id-less chunks round-trip to the CORRECT chunk, never collide."""
    cache = _DictCache()
    monkeypatch.setattr(rlm_reranker, "_get_cache_client", lambda: cache)

    chunk_alpha = _make_chunk("alpha.md", 1, "alpha marker text")
    chunk_beta = _make_chunk("beta.md", 1, "beta marker text")
    chunks = [chunk_alpha, chunk_beta]

    def marker_score(query, score_chunks, texts):
        scores = {}
        for c, t in zip(score_chunks, texts):
            key = rlm_reranker._stable_chunk_key(c)
            scores[key] = 0.9 if "alpha" in t else 0.1
        return scores

    monkeypatch.setattr(rlm_reranker, "_score_chunks", marker_score)

    rlm_reranker.rerank("q", chunks, top_k=2)

    rerank_keys = [k for k in cache.store if k.startswith(rlm_reranker.CACHE_KEY_PREFIX)]
    assert len(rerank_keys) == 2, f"Expected 2 distinct cache keys for 2 distinct chunks, got {rerank_keys}"

    def raising_score(*args, **kwargs):
        raise RuntimeError("scorer should not be called on the cache-only round trip")

    monkeypatch.setattr(rlm_reranker, "_score_chunks", raising_score)

    result2 = rlm_reranker.rerank("q", chunks, top_k=2)
    scores_by_file = {c["file_path"]: c["reranker_score"] for c in result2}

    assert scores_by_file["alpha.md"] == pytest.approx(0.9), "alpha chunk must keep its own cached score"
    assert scores_by_file["beta.md"] == pytest.approx(0.1), "beta chunk must keep its own cached score"


def test_positional_scheme_gone():
    """No residual id-or-position fallback keying remains anywhere in the module."""
    src = inspect.getsource(rlm_reranker)
    assert 'get("id", i)' not in src
    assert 'get("id", idx)' not in src
    assert 'get("id", 0)' not in src
