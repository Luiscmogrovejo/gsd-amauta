"""
Phase 27 RLM-04/RLM-05/RLM-06: Search pipeline unit tests.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_rlm04_rlm_search_imports():
    from services.rlm_search import hybrid_search, bm25_only_search, _sanitize_query
    assert callable(hybrid_search)
    assert callable(bm25_only_search)
    assert callable(_sanitize_query)


def test_rlm04_sanitize_query_strips_special_chars():
    from services.rlm_search import _sanitize_query
    assert _sanitize_query('foo!bar@baz') == 'foo bar baz'
    assert _sanitize_query('') == ''
    assert _sanitize_query('   ') == ''
    assert len(_sanitize_query('x' * 600)) <= 500


def test_rlm04_sanitize_query_preserves_normal_terms():
    from services.rlm_search import _sanitize_query
    result = _sanitize_query('hybrid search BM25 score')
    assert 'hybrid' in result
    assert 'search' in result
    assert 'BM25' in result


def test_rlm04_rrf_k_constant():
    """RRF_K must be 60 per CONTEXT.md requirement."""
    from services.rlm_search import RRF_K
    assert RRF_K == 60, f'Expected RRF_K=60, got {RRF_K}'


def test_rlm05_reranker_imports():
    from services.rlm_reranker import rerank, _get_cache_client
    assert callable(rerank)
    assert callable(_get_cache_client)


def test_rlm05_rerank_empty_chunks():
    from services.rlm_reranker import rerank
    result = rerank('test query', [])
    assert result == [], f'Expected [], got {result}'


def test_rlm05_rerank_returns_top_k_without_api(monkeypatch):
    """rerank falls back gracefully when no API key or local model."""
    monkeypatch.delenv('JINA_API_KEY', raising=False)
    from services.rlm_reranker import rerank
    chunks = [{'id': i, 'content': f'def foo_{i}(): pass', 'rrf_score': 1.0 / i} for i in range(1, 8)]
    result = rerank('foo function', chunks, top_k=5)
    assert len(result) <= 5, f'Expected <= 5, got {len(result)}'


def test_rlm05_cache_constants():
    """Cache TTL and key prefix must match spec."""
    from services.rlm_reranker import CACHE_TTL, CACHE_KEY_PREFIX
    assert CACHE_TTL == 600, f'Expected CACHE_TTL=600, got {CACHE_TTL}'
    assert CACHE_KEY_PREFIX == 'rlm:rerank:', f'Expected rlm:rerank:, got {CACHE_KEY_PREFIX}'


def test_rlm06_graph_imports():
    from services.rlm_graph import (
        build_graph_from_pg, store_graph_in_valkey, get_neighbors,
        expand_chunks_with_graph, get_hub_files, rebuild_graph
    )
    assert callable(expand_chunks_with_graph)
    assert callable(get_hub_files)
    assert callable(rebuild_graph)


def test_rlm06_expand_chunks_with_graph_no_cache():
    """expand_chunks_with_graph works when cache_client is None."""
    from services.rlm_graph import expand_chunks_with_graph
    chunks = [{'id': 1, 'symbol_name': 'compute_score', 'content': 'def compute_score(): pass'}]
    result = expand_chunks_with_graph(chunks, None)
    assert len(result) == 1
    assert 'graph_callers' in result[0], 'graph_callers must be present even without cache'
    assert 'graph_callees' in result[0], 'graph_callees must be present even without cache'
    assert result[0]['graph_callers'] == []
    assert result[0]['graph_callees'] == []


def test_rlm06_get_hub_files_no_cache():
    """get_hub_files returns [] when cache_client is None."""
    from services.rlm_graph import get_hub_files
    result = get_hub_files(None)
    assert result == [], f'Expected [], got {result}'


def test_rlm06_get_neighbors_no_cache():
    """get_neighbors returns empty dict when cache_client is None."""
    from services.rlm_graph import get_neighbors
    result = get_neighbors('some_symbol', None)
    assert result == {}, f'Expected {{}}, got {result}'


def test_rlm06_graph_key_prefix():
    """GRAPH_KEY_PREFIX must be rlm:graph: per spec."""
    from services.rlm_graph import GRAPH_KEY_PREFIX
    assert GRAPH_KEY_PREFIX == 'rlm:graph:', f'Expected rlm:graph:, got {GRAPH_KEY_PREFIX}'


def test_rlm02_rlm_service_deprecated_markers():
    """rlm-service.py must have >= 2 DEPRECATED Phase 27 markers."""
    import pathlib
    src = pathlib.Path('services/rlm-service.py').read_text()
    count = src.count('DEPRECATED Phase 27')
    assert count >= 2, f'Expected >= 2 DEPRECATED Phase 27 markers, got {count}'


def test_rlm02_rlm_service_wires_pipeline():
    """rlm-service.py must wire hybrid_search, rerank, expand_chunks_with_graph."""
    import pathlib
    src = pathlib.Path('services/rlm-service.py').read_text()
    assert 'hybrid_search' in src, 'hybrid_search must be wired in /search'
    assert 'expand_chunks_with_graph' in src, 'graph expansion must be wired in /search'
    assert 'pg_chunks_count' in src, 'health endpoint must include pg_chunks_count'
