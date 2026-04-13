"""
Phase 27 RLM-01: AST chunker correctness tests.
Verifies zero partial function definitions across sample files.

Run: pytest tests/test_27_ast_chunker.py -v
"""
import os
import sys
import re
import pytest

# Ensure project root is on path so 'services.ast_chunker' resolves
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _import_chunker():
    from services.ast_chunker import chunk_file_ast, is_code_file, legacy_chunker
    return chunk_file_ast, is_code_file, legacy_chunker


# ---------------------------------------------------------------------------
# Import and callable checks
# ---------------------------------------------------------------------------

def test_rlm01_ast_chunker_imports():
    """ast_chunker module imports without error."""
    chunk_file_ast, is_code_file, legacy_chunker = _import_chunker()
    assert callable(chunk_file_ast)
    assert callable(is_code_file)
    assert callable(legacy_chunker)


# ---------------------------------------------------------------------------
# is_code_file tests
# ---------------------------------------------------------------------------

def test_rlm01_is_code_file_py():
    """is_code_file returns True for Python files."""
    _, is_code_file, _ = _import_chunker()
    assert is_code_file('foo.py') is True
    assert is_code_file('foo.js') is True
    assert is_code_file('foo.cjs') is True
    assert is_code_file('foo.ts') is True


def test_rlm01_is_code_file_tsx_jsx():
    """is_code_file returns True for TSX/JSX files."""
    _, is_code_file, _ = _import_chunker()
    assert is_code_file('foo.tsx') is True
    assert is_code_file('foo.jsx') is True
    assert is_code_file('foo.mjs') is True


def test_rlm01_is_code_file_non_code():
    """is_code_file returns False for non-code files (legacy_chunker path)."""
    _, is_code_file, _ = _import_chunker()
    assert is_code_file('foo.md') is False
    assert is_code_file('foo.sql') is False
    assert is_code_file('foo.yaml') is False
    assert is_code_file('foo.json') is False
    assert is_code_file('foo.sh') is False
    assert is_code_file('foo.txt') is False


# ---------------------------------------------------------------------------
# chunk_file_ast: rlm-service.py (production target)
# ---------------------------------------------------------------------------

def test_rlm01_chunk_file_ast_rlm_service():
    """chunk_file_ast produces chunks for rlm-service.py with no partial functions."""
    chunk_file_ast, _, _ = _import_chunker()
    filepath = os.path.abspath('services/rlm-service.py')
    if not os.path.exists(filepath):
        pytest.skip('rlm-service.py not found')
    chunks = chunk_file_ast(filepath)
    assert len(chunks) > 0, 'Expected at least 1 chunk from rlm-service.py'
    for chunk in chunks:
        assert 'symbol_name' in chunk, f'Missing symbol_name in chunk {chunk}'
        assert 'symbol_type' in chunk, f'Missing symbol_type in chunk {chunk}'
        assert 'start_line' in chunk, f'Missing start_line in chunk {chunk}'
        assert 'end_line' in chunk, f'Missing end_line in chunk {chunk}'
        assert chunk['end_line'] >= chunk['start_line'], \
            f'end_line must be >= start_line: {chunk["symbol_name"]}'
        assert chunk['content'], f'content must be non-empty: {chunk["symbol_name"]}'
        # Compatibility fields
        assert chunk['text'] == chunk['content'], 'text must equal content'
        assert chunk['label'] == chunk['symbol_name'], 'label must equal symbol_name'
        assert chunk['filepath'] == chunk['file_path'], 'filepath must equal file_path'


def test_rlm01_chunk_count_within_range_of_symbol_count():
    """
    Chunk count should roughly match symbol count.
    tree-sitter counts methods inside classes separately from regex top-level-only count.
    We compare against all defs (including methods) for a fair comparison.
    """
    chunk_file_ast, _, _ = _import_chunker()
    filepath = os.path.abspath('services/rlm-service.py')
    if not os.path.exists(filepath):
        pytest.skip('rlm-service.py not found')
    with open(filepath, 'r') as f:
        content = f.read()
    # Count ALL defs including methods (indented) — accurate comparison for AST
    symbol_count = len(re.findall(r'^\s*(def |class |async def )', content, re.MULTILINE))
    chunks = chunk_file_ast(filepath)
    chunk_count = len(chunks)
    # Allow ±30% relative to total symbol count (tree-sitter may merge decorators)
    ratio = abs(chunk_count - symbol_count) / max(1, symbol_count)
    assert ratio <= 0.30, (
        f'Chunk count {chunk_count} differs from all-defs symbol count {symbol_count} '
        f'by {ratio:.1%} (limit: 30%)'
    )


def test_rlm01_no_partial_functions():
    """
    No chunk ends with an unclosed function signature (def/function keyword at end of text).
    Each chunk extracted by tree-sitter is a complete AST node -- the body is always present.
    """
    chunk_file_ast, _, _ = _import_chunker()
    filepath = os.path.abspath('services/rlm-service.py')
    if not os.path.exists(filepath):
        pytest.skip('rlm-service.py not found')
    chunks = chunk_file_ast(filepath)
    for chunk in chunks:
        text = chunk['content']
        last_line = text.rstrip().split('\n')[-1].strip()
        # A partial function chunk would end on 'def foo():' with no body
        # This is impossible with tree-sitter (AST node includes body), but verify anyway
        is_bare_def_ending = (
            last_line.endswith(':') and
            re.match(r'^(async\s+)?def\s+\w+', last_line)
        )
        assert not is_bare_def_ending, (
            f"Partial function in chunk {chunk['symbol_name']} ending at "
            f"line {chunk['end_line']}: last_line={last_line!r}"
        )


# ---------------------------------------------------------------------------
# chunk_file_ast: pg_store.py (metadata schema verification)
# ---------------------------------------------------------------------------

def test_rlm01_chunk_metadata_schema():
    """Every chunk has all required metadata keys with correct types."""
    chunk_file_ast, _, _ = _import_chunker()
    filepath = os.path.abspath('services/pg_store.py')
    if not os.path.exists(filepath):
        pytest.skip('pg_store.py not found')
    chunks = chunk_file_ast(filepath)
    required_keys = {
        'file_path', 'symbol_name', 'symbol_type', 'start_line', 'end_line',
        'content', 'dependencies', 'dependents',
        'text', 'label', 'filepath', 'char_count'
    }
    assert len(chunks) > 0, 'Expected at least one chunk from pg_store.py'
    for chunk in chunks:
        missing = required_keys - set(chunk.keys())
        assert not missing, f'Chunk {chunk.get("symbol_name")} missing keys: {missing}'
        assert isinstance(chunk['dependencies'], list), 'dependencies must be list'
        assert isinstance(chunk['dependents'], list), 'dependents must be list'
        assert isinstance(chunk['start_line'], int), 'start_line must be int'
        assert isinstance(chunk['end_line'], int), 'end_line must be int'
        assert isinstance(chunk['char_count'], int), 'char_count must be int'
        assert chunk['char_count'] == len(chunk['content']), 'char_count must equal len(content)'
        assert chunk['symbol_type'] in ('function', 'class', 'method', 'module', 'legacy'), \
            f'Unexpected symbol_type: {chunk["symbol_type"]}'


# ---------------------------------------------------------------------------
# chunk_file_ast: non-code file returns empty list
# ---------------------------------------------------------------------------

def test_rlm01_non_code_file_returns_empty():
    """chunk_file_ast returns empty list for non-code files (.sql, .md, etc.)."""
    chunk_file_ast, _, _ = _import_chunker()
    # .sql file -- should return empty, caller uses legacy_chunker
    sql_file = os.path.abspath('migrations/012-rlm-chunks.sql')
    if os.path.exists(sql_file):
        chunks = chunk_file_ast(sql_file)
        assert chunks == [], f'Expected empty list for .sql file, got {len(chunks)} chunks'


# ---------------------------------------------------------------------------
# requirements.txt checks
# ---------------------------------------------------------------------------

def test_rlm01_requirements_txt_has_wave3_deps():
    """requirements.txt includes networkx, voyageai, sentence-transformers."""
    req_path = os.path.abspath('requirements.txt')
    assert os.path.exists(req_path), 'requirements.txt must exist'
    with open(req_path, 'r') as f:
        content = f.read()
    assert 'networkx' in content, 'networkx required for dependency graph (Wave 3)'
    assert 'voyageai' in content, 'voyageai required for Voyage Code 3 embeddings (Wave 2)'
    assert 'sentence-transformers' in content, \
        'sentence-transformers required for reranker fallback (Wave 2)'


# ---------------------------------------------------------------------------
# Migration file existence checks
# ---------------------------------------------------------------------------

def test_rlm01_migration_012_exists():
    """Migration 012 files exist with correct names."""
    assert os.path.exists('migrations/012-rlm-chunks.sql'), \
        'migrations/012-rlm-chunks.sql must exist'
    assert os.path.exists('migrations/012-rlm-chunks-DOWN.sql'), \
        'migrations/012-rlm-chunks-DOWN.sql must exist'


def test_rlm01_migration_013_exists():
    """Migration 013 files exist with correct names."""
    assert os.path.exists('migrations/013-code-embeddings.sql'), \
        'migrations/013-code-embeddings.sql must exist'
    assert os.path.exists('migrations/013-code-embeddings-DOWN.sql'), \
        'migrations/013-code-embeddings-DOWN.sql must exist'
