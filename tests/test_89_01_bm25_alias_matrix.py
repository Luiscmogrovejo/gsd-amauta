#!/usr/bin/env python3
"""Plan 89-01: the alias/embedding matrix for the BM25 leg of the hybrid engine.

``hybrid_search_generic`` splices ONE ``filter_sql`` fragment into two
statements: the aliased per-leg CTEs of the hybrid SQL (``FROM {table} c``) and
the degradation branch ``_generic_bm25_only``, which used to query the bare
unaliased table name. ``hybrid_search`` builds its file filter against the alias
(``AND (c.file_path = %s OR c.file_path LIKE %s)``), so whenever a caller passed
a file filter AND no query embedding the degradation branch referenced a table
alias that did not exist in its own statement. PostgreSQL answered
``missing FROM-clause entry for table "c"`` (sqlstate 42P01), the branch's
``except`` logged ``generic_bm25_only_failed`` and returned ``[]``, and every
consumer read that as "no matches".

Nothing covered that combination. The four cells here are
(alias-qualified / unqualified ``filter_sql``) x (with / without
``query_embedding``), and **cell 2 is the one that was broken**.
``services/pg_store.py``'s ``_memory_filter_sql`` documents the unqualified form
as deliberate (``:333-338``), so cells 3 and 4 pin that it keeps working once the
degradation branch is aliased.

The last two tests are the error contract (plan 89-01 task 03): a SQL
**programming** error is a typed ``EngineProgrammingError`` and re-raises under
``GSD_TEST_MODE``, while an **operational** error still degrades to an empty
result, because that degradation is what the product relies on when the database
is merely unwell.

Everything here seeds ``rlm_chunks`` with direct SQL — no ingestion, no
embedding provider on the write path — so the only variable is the SQL. Rows live
under a ``__test8901_alias__`` prefix and cleanup is VERIFIED with a
``COUNT(*) = 0`` assertion rather than merely attempted.

Run: python3 -m pytest tests/test_89_01_bm25_alias_matrix.py -q -rs -p no:cacheprovider
"""
import logging
import os
import sys

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support")
)

import stub_embeddings  # noqa: E402  (tests/support, just added to sys.path)
from conftest import PG_SKIP_REASON, postgres_dsn_or_none  # noqa: E402

#: The disposable database, or None. There is deliberately no default: a literal
#: 127.0.0.1:5433 here would dial the operator's live PostgreSQL through libpq,
#: which the in-process socket guard cannot see.
_PG_DSN = postgres_dsn_or_none()

pytestmark = pytest.mark.skipif(_PG_DSN is None, reason=PG_SKIP_REASON)

#: Every fixture row lives under this prefix, and nothing else may.
PREFIX = "__test8901_alias__"

#: A token that exists nowhere else in the corpus, so a BM25 match on it is
#: unambiguous evidence that the lexical leg ran and found THIS row.
TOKEN = "zzq8901aliastoken"

#: rlm_chunks columns hybrid_search() asks for, in its own order.
SELECT_COLUMNS = [
    "id", "file_path", "symbol_name", "symbol_type", "start_line", "end_line",
    "content", "description", "dependencies", "dependents",
]

#: The two shapes of the same condition. The first is what `hybrid_search`
#: emits; the second is what `pg_store._memory_filter_sql` emits, deliberately.
ALIAS_QUALIFIED_FILTER = "AND (c.file_path = %s OR c.file_path LIKE %s)"
UNQUALIFIED_FILTER = "AND (file_path = %s OR file_path LIKE %s)"


def _bm25_query():
    """The field-qualified match string hybrid_search would build for TOKEN."""
    from services.rlm_search import _boosted_rlm_query, _sanitize_query

    return _boosted_rlm_query(_sanitize_query(TOKEN))


def _query_embedding():
    """A deterministic 1024-dim query vector — no key, no network, no drift."""
    return stub_embeddings.deterministic_embedding(TOKEN, input_type="query")


def _filter_params(prefix):
    """The (exact, beneath) pair both filter shapes bind."""
    return (prefix, prefix + os.sep + "%")


@pytest.fixture()
def pg_conn():
    """A psycopg2 connection to the disposable database, closed on teardown."""
    import psycopg2

    conn = psycopg2.connect(_PG_DSN, connect_timeout=10)
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture()
def seeded(pg_conn):
    """Seed two rlm_chunks rows under PREFIX and verify their removal.

    One row carries TOKEN and a deterministic ``embedding_code`` so the vector
    leg has something to rank; a SIBLING-directory row carries neither, so a
    filter that leaked into sibling directories would surface as an extra result
    rather than silently.

    Yields:
        str: the path prefix the filter fragments bind to.
    """
    vec = "[" + ",".join(
        "%.6f" % v for v in stub_embeddings.deterministic_embedding(TOKEN)
    ) + "]"
    with pg_conn.cursor() as cur:
        # Defensive: a previous run killed between INSERT and teardown would
        # otherwise collide with idx_rlm_chunks_upsert_key and report a unique
        # violation instead of whatever this test is actually about.
        cur.execute(
            "DELETE FROM rlm_chunks WHERE file_path LIKE %s", ["%s%%" % PREFIX]
        )
        cur.execute(
            """
            INSERT INTO rlm_chunks
                (file_path, symbol_name, symbol_type, start_line, end_line,
                 content, description, sha256, embedding_code)
            VALUES
                (%s, %s, 'function', 1, 9, %s, %s, 'test8901aliasA', %s::vector),
                (%s, %s, 'function', 1, 9, %s, %s, 'test8901aliasB', NULL)
            """,
            [
                "%s%sworker.py" % (PREFIX, os.sep), "alias_cell_worker",
                "def alias_cell_worker(): return %r" % TOKEN,
                "alias_cell_worker emits %s" % TOKEN,
                vec,
                "%s-sibling%sother.py" % (PREFIX, os.sep), "alias_cell_sibling",
                "def alias_cell_sibling(): return 'unrelated'",
                "alias_cell_sibling is unrelated",
            ],
        )
    pg_conn.commit()
    try:
        yield PREFIX
    finally:
        with pg_conn.cursor() as cur:
            cur.execute(
                "DELETE FROM rlm_chunks WHERE file_path LIKE %s", ["%s%%" % PREFIX]
            )
        pg_conn.commit()
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM rlm_chunks WHERE file_path LIKE %s",
                ["%s%%" % PREFIX],
            )
            remaining = cur.fetchone()[0]
        assert remaining == 0, (
            "%s cleanup failed to verify: %d rows remain" % (PREFIX, remaining)
        )


def _run_cell(pg_conn, prefix, filter_sql, query_embedding, caplog):
    """Run one matrix cell and return (rows, the leg's own warning lines).

    The warnings matter: both swallowing branches log before returning ``[]``,
    so a cell that comes back empty can say WHY in its own failure message
    instead of leaving the reader to guess.
    """
    from services import rlm_search

    with caplog.at_level(logging.WARNING, logger="amauta.rlm_search"):
        rows = rlm_search.hybrid_search_generic(
            TOKEN, pg_conn,
            table="rlm_chunks", id_column="id", select_columns=SELECT_COLUMNS,
            vector_column="embedding_code", query_embedding=query_embedding,
            bm25_query=_bm25_query(),
            filter_sql=filter_sql, filter_params=_filter_params(prefix),
            top_k=5,
        )
    return rows, [r.getMessage() for r in caplog.records]


def _assert_seeded_row_found(rows, swallowed, cell):
    """Both halves of every cell's expectation: rows, and the right row."""
    assert rows, (
        "%s returned no rows against a real PostgreSQL. The leg's own log "
        "said: %r" % (cell, swallowed)
    )
    names = [r["symbol_name"] for r in rows]
    assert "alias_cell_worker" in names, (
        "%s: the seeded TOKEN row is missing from the results: %r" % (cell, names)
    )
    assert "alias_cell_sibling" not in names, (
        "%s: the filter leaked into the SIBLING directory: %r" % (cell, names)
    )


def test_cell1_alias_qualified_filter_with_embedding_returns_rows(
    pg_conn, seeded, caplog
):
    """Cell 1: alias-qualified filter + a query embedding — the hybrid path.

    This cell always worked: the hybrid SQL aliases its tables, so the
    alias-qualified fragment resolves. It is here so the matrix can tell "the
    fix worked" apart from "the fixture is broken".
    """
    rows, swallowed = _run_cell(
        pg_conn, seeded, ALIAS_QUALIFIED_FILTER, _query_embedding(), caplog
    )
    _assert_seeded_row_found(rows, swallowed, "cell 1 (aliased, with embedding)")
    assert any(r["rrf_score"] is not None for r in rows), (
        "cell 1 must take the FUSED path, so at least one row carries an "
        "rrf_score: %r" % ([r["rrf_score"] for r in rows],)
    )


def test_cell2_alias_qualified_filter_without_embedding_returns_rows(
    pg_conn, seeded, caplog
):
    """Cell 2, **the broken one**: alias-qualified filter, no query embedding.

    This is the reproduction plan 89-01 task 01 produced and task 02 fixed.
    Before the alias fix it failed, and the assertion message carried the BM25
    leg's own swallowed log line — the literal psycopg2 text including sqlstate
    42P01 and the table name ``c``.

    It is also the only cell the main CI pytest step could ever take for
    ``/query``: that step deliberately carries no embedding key, so
    ``generate_code_embedding`` returns None on every call, and ``/query``
    always passes a file filter.
    """
    rows, swallowed = _run_cell(
        pg_conn, seeded, ALIAS_QUALIFIED_FILTER, None, caplog
    )
    _assert_seeded_row_found(rows, swallowed, "cell 2 (aliased, no embedding)")
    assert all(r["rrf_score"] is None for r in rows), (
        "cell 2 is the BM25-only degradation path, whose contract is a NULL "
        "rrf_score: %r" % ([r["rrf_score"] for r in rows],)
    )


def test_cell3_unqualified_filter_with_embedding_returns_rows(
    pg_conn, seeded, caplog
):
    """Cell 3: the ``pg_store`` unqualified form + a query embedding.

    An unqualified column resolves against a single aliased table, which is why
    aliasing the degradation branch did not have to change
    ``_memory_filter_sql``. This cell is the proof.
    """
    rows, swallowed = _run_cell(
        pg_conn, seeded, UNQUALIFIED_FILTER, _query_embedding(), caplog
    )
    _assert_seeded_row_found(
        rows, swallowed, "cell 3 (unqualified, with embedding)"
    )


def test_cell4_unqualified_filter_without_embedding_returns_rows(
    pg_conn, seeded, caplog
):
    """Cell 4: the ``pg_store`` unqualified form, no query embedding.

    The combination ``memory_search`` takes on every cell that has no embedding
    key — i.e. the main CI pytest step. It worked before the fix and must keep
    working after it.
    """
    rows, swallowed = _run_cell(pg_conn, seeded, UNQUALIFIED_FILTER, None, caplog)
    _assert_seeded_row_found(
        rows, swallowed, "cell 4 (unqualified, no embedding)"
    )

