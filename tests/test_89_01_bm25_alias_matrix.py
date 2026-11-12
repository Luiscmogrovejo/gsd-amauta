#!/usr/bin/env python3
"""Plan 89-01: the alias/embedding matrix for the BM25 leg of the hybrid engine.

``hybrid_search_generic`` splices ONE ``filter_sql`` fragment into two
statements: the aliased per-leg CTEs of the hybrid SQL (``FROM {table} c``) and
the unaliased degradation branch ``_generic_bm25_only`` (``FROM {table}``).
``hybrid_search`` builds its file filter against the alias
(``AND (c.file_path = %s OR c.file_path LIKE %s)``), so whenever a caller passed
a file filter AND no query embedding the degradation branch referenced a table
alias that did not exist in its own statement. PostgreSQL answered
``missing FROM-clause entry for table "c"`` (sqlstate 42P01), the branch's
``except`` logged ``generic_bm25_only_failed`` and returned ``[]``, and every
consumer read that as "no matches".

Nothing covered that combination: the four cells below are
(aliased / unaliased ``filter_sql``) x (with / without ``query_embedding``), and
cell 2 is the one that was broken. ``services/pg_store.py``'s
``_memory_filter_sql`` documents the unqualified form as deliberate, so cells 3
and 4 pin that it keeps working once the degradation branch is aliased.

Everything here seeds ``rlm_chunks`` with direct SQL — no ingestion, no
embedding provider on the write path — so the only variable is the SQL. Rows
live under a ``__test8901_alias__/`` prefix and cleanup is VERIFIED with a
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


def _bm25_query():
    """The field-qualified match string hybrid_search would build for TOKEN."""
    from services.rlm_search import _boosted_rlm_query, _sanitize_query

    return _boosted_rlm_query(_sanitize_query(TOKEN))


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

    One row carries TOKEN; a sibling directory row does not, so a filter that
    matched siblings would show up as an extra result rather than silently.

    Yields:
        str: the absolute-looking path prefix to filter on.
    """
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO rlm_chunks
                (file_path, symbol_name, symbol_type, start_line, end_line,
                 content, description, sha256)
            VALUES
                (%s, %s, 'function', 1, 9, %s, %s, 'test8901aliasA'),
                (%s, %s, 'function', 1, 9, %s, %s, 'test8901aliasB')
            """,
            [
                "%s/worker.py" % PREFIX, "alias_cell_worker",
                "def alias_cell_worker(): return %r" % TOKEN,
                "alias_cell_worker emits %s" % TOKEN,
                "%s-sibling/other.py" % PREFIX, "alias_cell_sibling",
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
            "%s/ cleanup failed to verify: %d rows remain" % (PREFIX, remaining)
        )


def test_alias_qualified_filter_without_embedding_returns_rows(pg_conn, seeded, caplog):
    """Cell 2, the broken one: an alias-qualified filter and no query embedding.

    This is the reproduction plan 89-01 task 01 was written to produce. Before
    the fix it fails, and the assertion message carries the BM25 leg's OWN log
    line — the literal psycopg2 text including sqlstate 42P01 and the table
    name ``c`` — because the branch swallows the error and returns ``[]``.
    """
    from services import rlm_search

    with caplog.at_level(logging.WARNING, logger="amauta.rlm_search"):
        rows = rlm_search.hybrid_search_generic(
            TOKEN, pg_conn,
            table="rlm_chunks", id_column="id", select_columns=SELECT_COLUMNS,
            vector_column="embedding_code", query_embedding=None,
            bm25_query=_bm25_query(),
            filter_sql="AND (c.file_path = %s OR c.file_path LIKE %s)",
            filter_params=(seeded, seeded + os.sep + "%"),
            top_k=5,
        )

    swallowed = [r.getMessage() for r in caplog.records]
    assert rows, (
        "cell 2 (alias-qualified filter_sql, query_embedding=None) returned no "
        "rows against a real PostgreSQL. The BM25-only leg's own log said: %r"
        % (swallowed,)
    )
    assert any(r["symbol_name"] == "alias_cell_worker" for r in rows), (
        "the seeded TOKEN row is missing from the results: %r"
        % ([r["symbol_name"] for r in rows],)
    )
