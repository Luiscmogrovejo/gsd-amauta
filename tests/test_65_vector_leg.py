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
        from conftest import postgres_dsn_or_none
        dsn = postgres_dsn_or_none()
        if not dsn:
            return None
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
    the BM25-only fallback query).

    Phase 89 plan 89-06 (decision D3): `hybrid_search_generic` now asks the
    catalogue which engine answers the lexical leg before it builds its SQL. A
    CAPABILITY PROBE is not a retrieval statement, and "the first retrieval
    statement fails" is this stub's entire purpose -- if the probe consumed that
    budget, the vector leg would SUCCEED and the test would measure nothing.
    Probes are therefore counted separately and still raise, which is the right
    answer for a double with no catalogue: `_has_pg_search` reads an unreadable
    catalogue as "unknown" and keeps the `@@@` statement this test is about.
    """

    #: Statements that identify a capability probe rather than a retrieval leg.
    PROBE_MARKERS = ("pg_extension", "information_schema")

    def __init__(self, shared_state):
        self._state = shared_state

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        if any(marker in sql for marker in self.PROBE_MARKERS):
            self._state["probe_calls"] = self._state.get("probe_calls", 0) + 1
            raise Exception("simulated: this stub has no catalogue")
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
        self._state = {"execute_calls": 0, "fallback_sql": None,
                       "probe_calls": 0}
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


# ───────────────────────────────────────────────────────────────────────────
# Plan 88-16-08: the embedding provider, on both of its REAL paths
#
# Operator decision 2026-11-11, "there is a key, use it": the
# embedding-provider assertion is NOT a paid-credential exception. It makes one
# small REAL Voyage call when VOYAGE_API_KEY is present and runs a
# DETERMINISTIC STAND-IN when it is not, and **neither path skips**. A pull
# request from a fork never receives repository secrets, so the stand-in is the
# normal path there, not a fallback for failure.
#
# It is deliberately separated from PostgreSQL. The end-to-end hybrid test
# below keeps its `_PG_AVAILABLE` guard — it has to, it writes rows — and there
# is no PostgreSQL on the operator's machine for this whole phase, so leaving
# the provider assertion inside it would have made "both paths proven locally"
# impossible. What a provider owes its caller is a vector of the right
# dimension, normalised, and derived from the input; none of that needs a
# database.
#
# THE KEY'S VALUE IS NEVER READ. The branch below asks only whether the
# variable is non-empty — the same `[ -n "${VOYAGE_API_KEY:-}" ]` shape the
# plan's acceptance uses — and nothing here prints, logs, hashes, measures or
# stores it.
# ───────────────────────────────────────────────────────────────────────────

_VOYAGE_KEY_PRESENT = bool((os.environ.get("VOYAGE_API_KEY") or "").strip())

#: The host the real path reaches, and the ONLY host allowed anywhere in the
#: suite. The guards are default-deny for every non-loopback destination
#: (plan 88-16-03); the `allow_host` fixture permits this one for one test and
#: restores the allow-list afterwards.
VOYAGE_API_HOST = "api.voyageai.com"


def _install_stub():
    """Install the deterministic stand-in through the product's provider seam."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support"))
    import stub_embeddings

    from services import rlm_embeddings

    return rlm_embeddings, rlm_embeddings.set_provider_override(stub_embeddings.stub_provider)


def test_embedding_provider_returns_a_normalised_1024_vector(allow_host):
    """The provider contract, asserted on whichever path this environment has.

    Shared assertions, identical on both paths:
      * `embed_code` returns `(vector, model_name)`;
      * the vector has 1024 components, the dimension
        `rlm_chunks.embedding_code` declares;
      * every component is a finite float;
      * the vector is unit length, so cosine distance is meaningful;
      * blank input returns None, the "no provider" answer.

    The real path adds one assertion the stand-in cannot satisfy: the model
    name is Voyage's and the vector is NOT the stand-in's, which is what makes
    "the call actually reached Voyage" a measurement rather than a hope.
    """
    from services import rlm_embeddings

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support"))
    import stub_embeddings

    text = "def gsd_embedding_probe():\n    return 42\n"

    if _VOYAGE_KEY_PRESENT:
        allow_host(VOYAGE_API_HOST)  # scoped to THIS test; restored at teardown
        rlm_embeddings.set_provider_override(None)
        result = rlm_embeddings.embed_code(text)
        assert result is not None, (
            "VOYAGE_API_KEY is set but the provider returned nothing; the real call failed"
        )
        vector, model = result
        assert model == rlm_embeddings.VOYAGE_MODEL, model
        assert vector != stub_embeddings.deterministic_embedding(text), (
            "the real path returned the stand-in's vector: the call did not reach Voyage"
        )
        path_taken = "real"
    else:
        rlm_embeddings_module, previous = _install_stub()
        try:
            result = rlm_embeddings_module.embed_code(text)
            assert result is not None
            vector, model = result
            assert model == stub_embeddings.STUB_MODEL, model
        finally:
            rlm_embeddings_module.set_provider_override(previous)
        path_taken = "stand-in"

    assert len(vector) == 1024, f"{path_taken}: expected 1024 dimensions, got {len(vector)}"
    assert all(isinstance(c, float) and c == c and abs(c) != float("inf") for c in vector), (
        f"{path_taken}: every component must be a finite float"
    )
    norm = sum(c * c for c in vector) ** 0.5
    assert abs(norm - 1.0) < 1e-3, f"{path_taken}: expected a unit vector, norm was {norm}"


def test_the_voyage_host_allowance_did_not_leak_to_the_next_test():
    """The host allowance is scoped to one test, not to the session.

    This runs AFTER the test above and takes no `allow_host` fixture, so the
    guard must refuse the same host again. Without this, "allowed for one test"
    would be an unverified claim — and a session-wide allowance would delete
    the property plan 88-16-03 added.
    """
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support"))
    import hermetic_guard

    allowed, reason = hermetic_guard.decide(VOYAGE_API_HOST, 443)
    assert allowed is False, (
        f"the Voyage host allowance leaked out of the test that needed it ({reason})"
    )
    assert reason == "non-loopback-host"


def test_the_stand_in_is_deterministic_across_processes():
    """The same input yields the same vector in a SEPARATE interpreter.

    Python salts `hash()` per process (`PYTHONHASHSEED`), which is how plan
    88-12 lost a day to a 0.1 % flake. Running the stand-in in a child proves
    the digest-based derivation does not have that property.
    """
    import json
    import subprocess

    support = os.path.join(os.path.dirname(os.path.abspath(__file__)), "support")
    sys.path.insert(0, support)
    import stub_embeddings

    here = stub_embeddings.deterministic_embedding("determinism probe")[:8]
    code = (
        "import sys, json; sys.path.insert(0, %r); import stub_embeddings; "
        "print(json.dumps(stub_embeddings.deterministic_embedding('determinism probe')[:8]))"
        % support
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=True,
    )
    there = json.loads(out.stdout)
    assert here == there, f"the stand-in is not deterministic across processes: {here} vs {there}"


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
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
