"""
Phase 27 RLM-01/RLM-02/RLM-03: Ingestion pipeline tests.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_rlm03_describe_chunk_pipe_delimited():
    """describe_chunk returns pipe-delimited string with symbol_name."""
    from services.caveman_descriptions import describe_chunk
    chunk = {
        'symbol_name': 'compute_score',
        'symbol_type': 'function',
        'content': 'def compute_score(chunk, terms, doc_freq) -> float:\n    return 0.0',
        'dependencies': ['math.log', 'chunk_token_list'],
        'file_path': 'services/rlm-service.py',
    }
    result = describe_chunk(chunk)
    assert '|' in result, f'Must be pipe-delimited: {result!r}'
    assert 'compute_score' in result, f'symbol_name required: {result!r}'
    assert 'function' in result, f'symbol_type required: {result!r}'
    assert len(result) <= 500, f'Must be <= 500 chars: {len(result)}'


def test_rlm03_describe_chunk_with_params():
    """describe_chunk extracts parameter names from Python function signature."""
    from services.caveman_descriptions import describe_chunk
    chunk = {
        'symbol_name': 'my_func',
        'symbol_type': 'function',
        'content': 'def my_func(self, x, y, z=1):\n    return x',
        'dependencies': [],
        'file_path': 'test.py',
    }
    result = describe_chunk(chunk)
    # self should be excluded; x, y, z should appear
    assert 'params:' in result, f'params field required: {result!r}'
    assert 'self' not in result.split('params:')[1].split('|')[0], 'self must be excluded from params'


def test_rlm03_describe_chunk_no_params_omits_field():
    """describe_chunk omits params field when no parameters are present."""
    from services.caveman_descriptions import describe_chunk
    chunk = {
        'symbol_name': 'no_args',
        'symbol_type': 'function',
        'content': 'def no_args():\n    pass',
        'dependencies': [],
        'file_path': 'test.py',
    }
    result = describe_chunk(chunk)
    assert 'no_args' in result
    assert 'type:function' in result
    # params field should be absent since no parameters
    assert 'params:' not in result, f'params field should be absent for no-arg function: {result!r}'


def test_rlm03_embedding_module_imports():
    """rlm_embeddings module imports without error."""
    from services.rlm_embeddings import generate_code_embedding, embed_for_query, clear_cache
    assert callable(generate_code_embedding)
    assert callable(embed_for_query)


def test_rlm03_embedding_empty_text_returns_none():
    """generate_code_embedding returns None for empty text."""
    from services.rlm_embeddings import generate_code_embedding
    assert generate_code_embedding('') is None
    assert generate_code_embedding('   ') is None


def test_rlm03_embedding_returns_none_without_api_key(monkeypatch):
    """generate_code_embedding returns None if no VOYAGE_API_KEY and no Ollama."""
    monkeypatch.delenv('VOYAGE_API_KEY', raising=False)
    monkeypatch.setenv('OLLAMA_BASE_URL', 'http://127.0.0.1:19999')  # Non-existent
    from services.rlm_embeddings import generate_code_embedding, clear_cache
    clear_cache()
    result = generate_code_embedding('def foo(): pass')
    assert result is None, f'Expected None without API key, got: {type(result)}'


def test_rlm02_ingestion_module_imports():
    """rlm_ingestion module imports without error."""
    from services.rlm_ingestion import ingest_file, ingest_directory, is_stale, file_sha256
    assert callable(ingest_file)
    assert callable(ingest_directory)
    assert callable(is_stale)
    assert callable(file_sha256)


def test_rlm02_file_sha256_produces_64char_hex():
    """file_sha256 returns a 64-char hex string for an existing file."""
    from services.rlm_ingestion import file_sha256
    result = file_sha256('services/rlm-service.py')
    assert len(result) == 64, f'Expected 64-char hex, got {len(result)}: {result!r}'
    assert all(c in '0123456789abcdef' for c in result)


def test_rlm02_file_sha256_empty_for_missing():
    """file_sha256 returns empty string for non-existent file."""
    from services.rlm_ingestion import file_sha256
    result = file_sha256('/nonexistent/path/that/does/not/exist.py')
    assert result == '', f'Expected empty string for missing file, got: {result!r}'


def test_rlm02_ingest_file_missing_returns_error():
    """ingest_file returns error status for a non-existent file."""
    from services.rlm_ingestion import ingest_file
    result = ingest_file('/nonexistent/file.py', None)
    assert result['status'] == 'error'
    assert result['error'] == 'file_not_found'


def test_rlm02_describe_chunk_touches_file_stem():
    """describe_chunk includes file stem in touches field."""
    from services.caveman_descriptions import describe_chunk
    chunk = {
        'symbol_name': 'my_fn',
        'symbol_type': 'function',
        'content': 'def my_fn(): pass',
        'dependencies': [],
        'file_path': 'services/rlm-service.py',
    }
    result = describe_chunk(chunk)
    assert 'touches:rlm-service' in result, f'touches field must contain file stem: {result!r}'
