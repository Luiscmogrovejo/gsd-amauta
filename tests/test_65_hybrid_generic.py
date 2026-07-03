"""
Phase 65 / RETR-06: hybrid_search_generic() genericity lock + description-boost
tests, plus a PG-gated live ranking proof for the caveman description weight.

Import style follows tests/test_27_search_pipeline.py.
"""
import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _pg_conn_or_none():
    """
    Open a psycopg2 connection to GSD_POSTGRES_URL (default DSN matches
    rlm-service.py:217). Returns None on any exception so PG-gated tests can
    skip cleanly when the live database is unavailable.
    """
    try:
        import psycopg2
        dsn = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")
        return psycopg2.connect(dsn)
    except Exception:
        return None


class _FakeCursor:
    """Stub cursor that records the executed SQL without touching a real DB."""

    def __init__(self):
        self.executed_sql = None
        self.executed_params = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed_sql = sql
        self.executed_params = params

    @property
    def description(self):
        return [("id",)]

    def fetchall(self):
        return []


class _FakeConn:
    """Stub pg_conn exposing only .cursor() -> _FakeCursor, used to capture SQL."""

    def __init__(self):
        self.cur = _FakeCursor()

    def cursor(self):
        return self.cur


def test_generic_source_is_table_agnostic():
    """Phase 66 reuse contract: hybrid_search_generic must carry zero
    rlm_chunks-specific literals — table/column names arrive as parameters only."""
    from services.rlm_search import hybrid_search_generic
    src = inspect.getsource(hybrid_search_generic)
    for forbidden in ("rlm_chunks", "description", "embedding_code", "file_path"):
        assert forbidden not in src, f"hybrid_search_generic source must not contain {forbidden!r}"


def test_ident_validation_rejects_injection():
    from services.rlm_search import _check_ident, hybrid_search_generic

    with pytest.raises(ValueError):
        _check_ident("rlm_chunks; DROP")

    _check_ident("id")  # sanity: a safe identifier does NOT raise
    with pytest.raises(ValueError):
        _check_ident("x); --")

    # Same injection attempt via the public entry point: must raise before any
    # SQL is issued against the (fake) connection.
    fake_conn = _FakeConn()
    with pytest.raises(ValueError):
        hybrid_search_generic(
            'foo', fake_conn,
            table='rlm_chunks; DROP', id_column='id',
            select_columns=['id', 'x); --'],
            bm25_query='content:foo',
        )
    assert fake_conn.cur.executed_sql is None, "no SQL should be issued when identifiers fail validation"


def test_boosted_query_mentions_description_weight():
    from services.rlm_search import _boosted_rlm_query

    result = _boosted_rlm_query("frobnicate widget")
    for term in ("frobnicate", "widget"):
        assert f"description:{term}^" in result, f"missing description boost for {term!r}: {result}"
        assert f"content:{term}" in result, f"missing content term for {term!r}: {result}"


def test_sanitize_still_strips_special_chars():
    """Regression: _sanitize_query behavior unchanged for the pg_search special char class."""
    from services.rlm_search import _sanitize_query

    assert _sanitize_query('foo!bar@baz') == 'foo bar baz'
    assert _sanitize_query('') == ''
    assert _sanitize_query('   ') == ''
    assert len(_sanitize_query('x' * 600)) <= 500


def test_hybrid_search_signature_frozen():
    """65-01/65-03 wave contract: hybrid_search's public signature is frozen."""
    from services.rlm_search import hybrid_search

    params = list(inspect.signature(hybrid_search).parameters.keys())
    assert params == ['query', 'pg_conn', 'top_k', 'file_filter'], (
        f"hybrid_search signature drifted: {params}"
    )


def test_generic_bm25_only_degradation():
    """hybrid_search_generic with query_embedding=None issues SQL without a
    vector operator and does not raise, using a stub connection."""
    from services.rlm_search import hybrid_search_generic

    fake_conn = _FakeConn()
    select_columns = ['id', 'file_path', 'symbol_name', 'symbol_type',
                       'start_line', 'end_line', 'content', 'description',
                       'dependencies', 'dependents']

    result = hybrid_search_generic(
        'frobnicate', fake_conn,
        table='rlm_chunks', id_column='id', select_columns=select_columns,
        vector_column='embedding_code', query_embedding=None,
        bm25_query='content:frobnicate OR description:frobnicate^2.0',
        top_k=5,
    )

    assert result == []
    assert fake_conn.cur.executed_sql is not None, "degradation branch must still issue SQL"
    assert '<=>' not in fake_conn.cur.executed_sql, "bm25-only degradation must not reference the vector operator"


_PG_AVAILABLE = _pg_conn_or_none() is not None


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_bm25_description_outranks_content_live():
    """
    Live PG proof (research pitfall 13: cleanup must be VERIFIED, not attempted).

    Insert two synthetic rlm_chunks rows under a unique file_path prefix:
    row A carries the unique token 'zx65boosttoken' only in `description`,
    row B carries it only in `content`. bm25_only_search must rank row A
    above row B once the description boost is applied.
    """
    from services.rlm_search import bm25_only_search

    conn = _pg_conn_or_none()
    assert conn is not None, "PG must be reachable — skipif should have gated this test"

    prefix = '__test65_boost__/'
    token = 'zx65boosttoken'

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO rlm_chunks
                    (file_path, symbol_name, symbol_type, start_line, end_line,
                     content, description, sha256)
                VALUES
                    (%s, %s, 'function', 1, 5, %s, %s, 'zxA'),
                    (%s, %s, 'function', 1, 5, %s, %s, 'zxB')
                """,
                [
                    f"{prefix}a.py", "rowA_zx65", "def rowA_zx65(): return 1",
                    f"this description has {token} inside it",
                    f"{prefix}b.py", "rowB_zx65",
                    f"def rowB_zx65(): {token} = 1; return {token}",
                    "plain description no token",
                ],
            )
        conn.commit()

        results = bm25_only_search(token, conn, top_k=5, file_filter=prefix)
        symbol_names = [r['symbol_name'] for r in results]

        assert 'rowA_zx65' in symbol_names, f"description-token row missing from results: {symbol_names}"
        assert 'rowB_zx65' in symbol_names, f"content-token row missing from results: {symbol_names}"
        assert symbol_names.index('rowA_zx65') < symbol_names.index('rowB_zx65'), (
            f"description-boosted row (rowA_zx65) must outrank content-only row (rowB_zx65): {symbol_names}"
        )
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"__test65_boost__/ cleanup failed to verify: {remaining} rows remain"
        conn.close()
