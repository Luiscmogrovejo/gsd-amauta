"""
TK-1741: hybrid vector leg dimension-mismatch + txn-rollback fix.

Prior bug: hybrid_search_generic's vector leg cast BOTH the query literal and
rlm_chunks.embedding_code to ::vector(256), but embedding_code is genuinely
vector(1024) end to end (migration 013, live-verified populated rows all
report vector_dims()=1024). pgvector's vector(N) cast enforces an EXACT
dimension match rather than truncating/slicing, so the cast raised on every
call ("expected 256 dimensions, not 1024"), silently degrading every hybrid
search to BM25-only, and the except branch never rolled back the aborted
transaction before issuing the BM25-only fallback query on the same
connection.

Second bug (TK-1736 re-route, same file/task): fixing the cast activates the
RRF-fusion CTE for the first time ever, exposing a previously-dormant type
bug -- PostgreSQL's bare `1.0` literal defaults to `numeric`, not
`double precision`, so `rrf_score` arrives via psycopg2 as
`decimal.Decimal` once the fused CTE actually returns rows. hybrid_search()'s
position_decay step then does `Decimal * float`, raising TypeError on every
real hybrid call -- swallowed by outer callers (e.g. amauta-mcp.py's
try/except), silently degrading to legacy/memory fallback. The same
None-rrf_score BM25-only-degradation path had an equivalent crash in its own
sort/decay code, contradicting hybrid_search()'s own documented graceful-
degradation contract.

Tests here:
  - test_vector_leg_rollback_on_failure: unit-level, fake connection, proves
    pg_conn.rollback() is invoked before the BM25-only fallback fires when
    the vector-leg execute() raises.
  - test_rollback_is_best_effort_on_stub_without_rollback: a pg_conn stub
    with no .rollback() method must not crash hybrid_search_generic.
  - test_vector_leg_executes_and_ranks_live: PG-gated, proves the vector leg
    now runs to completion (no exception, no silent BM25-only fallback) and
    that a lexically-unmatched-but-embedding-close row is surfaced purely via
    the vector leg (rank_bm25 falls back to the candidate_k+1 placeholder,
    rank_vector is a real rank).
  - test_rrf_score_is_python_float_not_decimal_live: PG-gated, proves
    hybrid_search_generic's rrf_score is a plain Python float (not
    decimal.Decimal) once the fused CTE actually returns rows.
  - test_hybrid_search_end_to_end_rrf_score_is_float_live: PG-gated + skipped
    without a configured embedding provider, proves the full public
    hybrid_search() wrapper round-trips rrf_score as a Python float with no
    exception (the literal end-to-end acceptance oracle for the TK-1736
    re-route).

Import/fixture style follows tests/test_65_hybrid_generic.py.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _pg_conn_or_none():
    """Open a psycopg2 connection to GSD_POSTGRES_URL; None if unreachable."""
    try:
        import psycopg2
        dsn = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")
        return psycopg2.connect(dsn)
    except Exception:
        return None


_PG_AVAILABLE = _pg_conn_or_none() is not None


def _vec_literal(active_dim: int, total: int = 1024) -> str:
    """Build a pgvector literal string: 1.0 at active_dim, 0.0 elsewhere.

    Two distinct basis vectors (e.g. active_dim=0 vs active_dim=1) are
    orthogonal -- cosine distance 0 to themselves, 1 to each other -- which
    makes vector-leg ranking assertions deterministic without depending on
    any real embedding model.
    """
    values = ["0.0"] * total
    values[active_dim] = "1.0"
    return "[" + ",".join(values) + "]"


class _RaiseOnceCursor:
    """Stub cursor: raises on its first execute() (simulating the vector
    leg's SQL failing), succeeds on every subsequent execute() (simulating
    the BM25-only fallback query)."""

    def __init__(self, shared_state):
        self._state = shared_state

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._state["execute_calls"] += 1
        if self._state["execute_calls"] == 1:
            raise Exception("simulated vector leg failure")
        # Fallback call (_generic_bm25_only) succeeds.
        self._state["fallback_sql"] = sql

    @property
    def description(self):
        return [("id",)]

    def fetchall(self):
        return []


class _RaiseOnceConn:
    """Stub pg_conn pairing _RaiseOnceCursor with a rollback() call tracker."""

    def __init__(self):
        self._state = {"execute_calls": 0, "fallback_sql": None}
        self.rollback_calls = 0

    def cursor(self):
        return _RaiseOnceCursor(self._state)

    def rollback(self):
        self.rollback_calls += 1

    @property
    def execute_calls(self):
        return self._state["execute_calls"]

    @property
    def fallback_sql(self):
        return self._state["fallback_sql"]


def test_vector_leg_rollback_on_failure():
    """TK-1741: when the vector-leg execute() raises, hybrid_search_generic
    must call pg_conn.rollback() BEFORE issuing the BM25-only fallback query
    on the same connection -- otherwise the fallback would itself fail with
    'current transaction is aborted' on a real psycopg2 connection."""
    from services.rlm_search import hybrid_search_generic

    conn = _RaiseOnceConn()
    select_columns = ['id', 'file_path', 'symbol_name', 'symbol_type',
                       'start_line', 'end_line', 'content', 'description',
                       'dependencies', 'dependents']

    result = hybrid_search_generic(
        'frobnicate', conn,
        table='rlm_chunks', id_column='id', select_columns=select_columns,
        vector_column='embedding_code',
        query_embedding=[0.1] * 1024,
        bm25_query='content:frobnicate OR description:frobnicate^2.0',
        top_k=5,
    )

    assert result == [], "fallback stub cursor returns no rows"
    assert conn.execute_calls == 2, (
        f"expected exactly 2 execute() calls (failed vector leg + BM25-only "
        f"fallback), got {conn.execute_calls}"
    )
    assert conn.rollback_calls >= 1, (
        "hybrid_search_generic must call pg_conn.rollback() after the "
        "vector-leg exception and before the BM25-only fallback query"
    )
    assert conn.fallback_sql is not None, "fallback query must have executed"
    assert '<=>' not in conn.fallback_sql, "fallback query must not reference the vector operator"


def test_rollback_is_best_effort_on_stub_without_rollback():
    """A pg_conn without a .rollback() method (e.g. a minimal test stub)
    must not crash hybrid_search_generic -- the rollback call is
    best-effort, wrapped in its own try/except."""
    from services.rlm_search import hybrid_search_generic

    class _NoRollbackCursor:
        calls = {"n": 0}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            _NoRollbackCursor.calls["n"] += 1
            if _NoRollbackCursor.calls["n"] == 1:
                raise Exception("simulated vector leg failure")

        @property
        def description(self):
            return [("id",)]

        def fetchall(self):
            return []

    class _NoRollbackConn:
        def cursor(self):
            return _NoRollbackCursor()
        # deliberately no .rollback() method

    select_columns = ['id', 'file_path', 'symbol_name', 'symbol_type',
                       'start_line', 'end_line', 'content', 'description',
                       'dependencies', 'dependents']

    # Must not raise AttributeError from the missing .rollback().
    result = hybrid_search_generic(
        'frobnicate', _NoRollbackConn(),
        table='rlm_chunks', id_column='id', select_columns=select_columns,
        vector_column='embedding_code',
        query_embedding=[0.1] * 1024,
        bm25_query='content:frobnicate OR description:frobnicate^2.0',
        top_k=5,
    )
    assert result == []


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_vector_leg_executes_and_ranks_live():
    """
    Live PG proof (research pitfall 13: cleanup must be VERIFIED, not
    attempted).

    Insert two synthetic rlm_chunks rows under a unique file_path prefix,
    neither of which contains the bm25_query token anywhere in content or
    description (so the BM25 leg cannot rank either of them). Row 'near'
    gets an embedding_code identical to the crafted query_embedding (basis
    vector e0); row 'far' gets an orthogonal embedding (basis vector e1).

    Calling hybrid_search_generic directly (bypassing hybrid_search's live
    embedding-model dependency) with query_embedding=e0 must:
      - execute without raising (proves the ::vector(256)/vector(1024)
        mismatch is fixed -- pre-fix, this call always fell back silently
        to BM25-only and returned zero rows here, since bm25_query matches
        neither fixture row);
      - return the 'near' row with a real rank_vector (not the
        candidate_k+1 placeholder) and rank_bm25 == candidate_k + 1 (proof
        it was NOT found by the BM25 leg -- it was surfaced purely via the
        vector leg).
    """
    from services.rlm_search import hybrid_search_generic

    conn = _pg_conn_or_none()
    assert conn is not None, "PG must be reachable — skipif should have gated this test"

    prefix = '__test1741_vecleg__/'
    candidate_k = 20

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO rlm_chunks
                    (file_path, symbol_name, symbol_type, start_line, end_line,
                     content, description, sha256, embedding_code)
                VALUES
                    (%s, %s, 'function', 1, 5, %s, %s, 'tk1741A', %s::vector),
                    (%s, %s, 'function', 1, 5, %s, %s, 'tk1741B', %s::vector)
                """,
                [
                    f"{prefix}near.py", "row_near_tk1741",
                    "def row_near_tk1741(): return 'unrelated content'",
                    "unrelated description, no shared token",
                    _vec_literal(0),
                    f"{prefix}far.py", "row_far_tk1741",
                    "def row_far_tk1741(): return 'also unrelated'",
                    "another unrelated description",
                    _vec_literal(1),
                ],
            )
        conn.commit()

        select_columns = ['id', 'file_path', 'symbol_name', 'symbol_type',
                           'start_line', 'end_line', 'content', 'description',
                           'dependencies', 'dependents']

        # bm25_query deliberately matches neither row's content/description —
        # any row surfaced here must come from the vector leg alone.
        results = hybrid_search_generic(
            'zzznomatch_tk1741', conn,
            table='rlm_chunks', id_column='id', select_columns=select_columns,
            vector_column='embedding_code',
            query_embedding=[1.0] + [0.0] * 1023,  # matches row_near's e0 exactly
            bm25_query='content:zzznomatch_tk1741',
            filter_sql="AND c.file_path LIKE %s", filter_params=(f"{prefix}%",),
            top_k=5, candidate_k=candidate_k,
        )

        by_symbol = {r['symbol_name']: r for r in results}
        assert 'row_near_tk1741' in by_symbol, (
            f"vector-leg-only row missing from fused results (leg may still "
            f"be silently failing/falling back): {list(by_symbol.keys())}"
        )
        near = by_symbol['row_near_tk1741']
        assert near['rank_vector'] is not None and near['rank_vector'] < candidate_k + 1, (
            f"row_near_tk1741 must carry a real rank_vector from the vector leg, got {near['rank_vector']!r}"
        )
        assert near['rank_bm25'] == candidate_k + 1, (
            f"row_near_tk1741 must NOT be found by the BM25 leg (rank_bm25 should be the "
            f"{candidate_k + 1} placeholder), got {near['rank_bm25']!r} — bm25_query may be "
            f"matching unexpectedly"
        )
        assert near['rrf_score'] is not None and near['rrf_score'] > 0, (
            "fused row must carry a positive rrf_score"
        )
        assert isinstance(near['rrf_score'], float), (
            f"rrf_score must be a plain Python float (TK-1736 re-route: PostgreSQL's "
            f"bare 1.0 literal is numeric, not double precision, unless explicitly cast) "
            f"-- got {type(near['rrf_score'])!r}"
        )
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"__test1741_vecleg__/ cleanup failed to verify: {remaining} rows remain"
        conn.close()


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_rrf_score_is_python_float_not_decimal_live():
    """
    TK-1736 re-route: fixing the vector-leg cast activates the RRF fusion
    CTE for the first time -- PostgreSQL's bare `1.0` literal defaults to
    `numeric`, which psycopg2 returns as decimal.Decimal, not float. This
    directly breaks hybrid_search()'s position_decay step
    (`Decimal * float` raises TypeError), which was previously never
    exercised because the vector leg always fell back to BM25-only before
    the fused CTE could ever return a row.

    Proof, independent of any embedding provider: insert a single fixture
    row and query hybrid_search_generic with a crafted query_embedding
    matching its stored vector exactly, forcing the CTE to fuse a real row
    and produce a real (non-placeholder) rrf_score.
    """
    from services.rlm_search import hybrid_search_generic

    conn = _pg_conn_or_none()
    assert conn is not None, "PG must be reachable — skipif should have gated this test"

    prefix = '__test1736_decimal__/'

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO rlm_chunks
                    (file_path, symbol_name, symbol_type, start_line, end_line,
                     content, description, sha256, embedding_code)
                VALUES (%s, %s, 'function', 1, 5, %s, %s, 'tk1736A', %s::vector)
                """,
                [
                    f"{prefix}a.py", "row_a_tk1736",
                    "def row_a_tk1736(): return 'unrelated content'",
                    "unrelated description, no shared token",
                    _vec_literal(2),
                ],
            )
        conn.commit()

        select_columns = ['id', 'file_path', 'symbol_name', 'symbol_type',
                           'start_line', 'end_line', 'content', 'description',
                           'dependencies', 'dependents']

        results = hybrid_search_generic(
            'zzznomatch_tk1736', conn,
            table='rlm_chunks', id_column='id', select_columns=select_columns,
            vector_column='embedding_code',
            query_embedding=[0.0, 0.0, 1.0] + [0.0] * 1021,  # matches basis vector e2 exactly
            bm25_query='content:zzznomatch_tk1736',
            filter_sql="AND c.file_path LIKE %s", filter_params=(f"{prefix}%",),
            top_k=5,
        )

        by_symbol = {r['symbol_name']: r for r in results}
        assert 'row_a_tk1736' in by_symbol, f"fixture row missing from results: {list(by_symbol.keys())}"
        row = by_symbol['row_a_tk1736']
        assert row['rrf_score'] is not None
        assert isinstance(row['rrf_score'], float), (
            f"rrf_score must be a plain Python float, not decimal.Decimal -- got {type(row['rrf_score'])!r}"
        )
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"__test1736_decimal__/ cleanup failed to verify: {remaining} rows remain"
        conn.close()


def _embedding_provider_available() -> bool:
    """Best-effort check for a configured embedding provider, mirroring
    rlm_embeddings.py's priority order (Voyage API key, then local Ollama).
    Used only to skip the true end-to-end hybrid_search() test when neither
    is reachable -- the deterministic tests above already cover the fix
    without any external dependency."""
    if os.environ.get("VOYAGE_API_KEY"):
        return True
    try:
        import urllib.request
        url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434") + "/api/tags"
        with urllib.request.urlopen(url, timeout=2):
            return True
    except Exception:
        return False


_EMBEDDING_PROVIDER_AVAILABLE = _embedding_provider_available()


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
@pytest.mark.skipif(not _EMBEDDING_PROVIDER_AVAILABLE, reason="no embedding provider configured (VOYAGE_API_KEY/Ollama)")
def test_hybrid_search_end_to_end_rrf_score_is_float_live():
    """
    TK-1736 acceptance oracle: the full public hybrid_search() wrapper
    (query -> real embedding -> hybrid_search_generic -> position_decay)
    must round-trip without exception and return rrf_score as a plain
    Python float, using a real embedding provider end to end.
    """
    from services.rlm_search import hybrid_search

    conn = _pg_conn_or_none()
    assert conn is not None, "PG must be reachable — skipif should have gated this test"

    prefix = '__test1736_e2e__/'

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO rlm_chunks
                    (file_path, symbol_name, symbol_type, start_line, end_line, content, description, sha256)
                VALUES (%s, %s, 'function', 1, 5, %s, %s, 'tk1736E2E')
                """,
                [
                    f"{prefix}a.py", "row_e2e_tk1736zzy",
                    "def row_e2e_tk1736zzy(): return 'zzytk1736e2etoken content'",
                    "description mentioning zzytk1736e2etoken as well",
                ],
            )
        conn.commit()

        results = hybrid_search('zzytk1736e2etoken', conn, top_k=5, file_filter=prefix)

        assert results, f"expected at least one result for the seeded fixture row, got: {results}"
        for row in results:
            assert row.get('rrf_score') is None or isinstance(row['rrf_score'], float), (
                f"hybrid_search() must never return a non-float rrf_score -- got "
                f"{type(row.get('rrf_score'))!r} for {row.get('symbol_name')!r}"
            )
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s", [f"{prefix}%"])
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"__test1736_e2e__/ cleanup failed to verify: {remaining} rows remain"
        conn.close()
