"""Two engines on one disposable cluster — Phase 89 plan 89-06 (decision D3).

``pg_search`` is optional as of plan 89-06, so the Postgres suite has to be
provable on BOTH engines. No CI cell has a PostgreSQL without ParadeDB today
(plan 89-07 brings the macOS and Windows databases up), so this module makes
the second engine out of the cluster that IS there.

MEASURED, 2026-11-13, CI run 43346801628: THE IMAGE PRE-INSTALLS THE EXTENSION
──────────────────────────────────────────────────────────────────────────────
``paradedb/paradedb:latest-pg16`` carries ``pg_search`` (and ``vector``) in
**template1**, so a plain ``CREATE DATABASE`` INHERITS them — which is also why
no migration in this repository ever creates ``vector`` and 011's pgvector
assertion still passes. Setting ``gsd.lexical_engine`` alone was therefore not
enough: 011 correctly skipped its own ``CREATE EXTENSION`` and its BM25 index,
and 012 then found the INHERITED extension in ``pg_extension`` and built
``idx_rlm_chunks_bm25`` anyway. :func:`scratch_database` now does both halves —
``DROP EXTENSION IF EXISTS pg_search CASCADE`` on the new database and the
setting so 011 does not put it back — and VERIFIES both before yielding, so a
stand-in that stops standing in fails loudly instead of quietly testing the
engine it was meant to exclude.

WHAT THE STAND-IN PROVES, AND WHAT IT DOES NOT
──────────────────────────────────────────────
:func:`scratch_database` with ``force_plain=True`` produces a database on the
ParadeDB cluster in which ``pg_search`` is NOT installed and migration 011 will
not install it. So ``pg_extension`` carries no ``pg_search`` row and every
consumer — the
migrations' own guards, ``migrate_runner``'s sentinels,
``infra_detect.lexical_engine``, ``rlm_search._has_pg_search``, ``doctor`` and
``/health`` — takes exactly the branch it would take on a plain PostgreSQL,
because all of them key off that one catalogue row.

It is a faithful stand-in for **the extension-presence question only**. It does
NOT prove:

* that ``pg_available_extensions`` lacks the control file (the first condition
  of 011's guard; only a cluster without the ParadeDB binaries shows that, and
  the first one arrives with plan 89-07). This is also why
  ``check_pg_capabilities``' ``pg_search_absent`` degradation cannot be
  produced here: that function asks ``pg_available_extensions``, i.e. "can this
  SERVER run our schema", and on a ParadeDB server the honest answer is yes.
  The accept/reject split is proven instead with an extension name that is
  genuinely absent from the cluster, moved between the two lists;
* anything about ParadeDB's RANKING, which is a property of the engine, not of
  the catalogue. The two engines score differently on purpose — that is the
  divergence this plan documents rather than hides.

Every helper here needs ``GSD_TEST_POSTGRES_URL``; the caller skips without it
through ``tests/conftest.py``'s ``postgres_dsn`` fixture.
"""
import contextlib
import sys
import uuid
import warnings
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from services import migrate_runner, pg_dsn  # noqa: E402

#: The value migration 011 and services/infra_detect.py both recognise.
FORCE_PLAIN = "postgres_fts"

#: Migration 033's two substitute indexes, by name, so a test never spells them
#: itself. Plan 89-07's assertions can import this tuple.
FTS_SUBSTITUTE_INDEXES = ("idx_rlm_chunks_fts", "idx_gsd_memory_fts_fallback")

#: The BM25 indexes 011, 012 and 025 create only where pg_search is installed.
BM25_INDEXES = ("bm25_test_idx", "idx_rlm_chunks_bm25", "idx_gsd_memory_bm25")


class Measured(UserWarning):
    """Carries a measured value into the CI log.

    The same device plan 89-02 built (``tests/test_89_02_decimal_phase.py:70``):
    ``pytest -q`` hides a PASSING test's stdout but always prints the warnings
    summary, and plan 89-06's acceptance asks for applied counts, two
    ``pg_indexes`` sets, a probe count and two field lists as **measured**
    values rather than claims. A warning puts them in the log of the only cell
    that has a disposable database.
    """


def measure(key, value):
    """Emit one measured value into the warnings summary. Returns it unchanged."""
    warnings.warn("[89-06 MEASURED] %s = %s" % (key, value), Measured, stacklevel=2)
    return value


def _admin_dsn(dsn):
    return pg_dsn.dsn_with_database(dsn, "postgres")


def _autocommit(dsn):
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    conn = psycopg2.connect(dsn, connect_timeout=10)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    return conn


def _make_plain(db_dsn):
    """Drop the inherited ``pg_search`` and prove the database is now plain.

    Two conditions, both verified, because either one alone is not enough:
    the extension must be gone from ``pg_extension`` (``template1`` put it
    there), and ``gsd.lexical_engine`` must be visible to a NEW session (or
    migration 011 installs it again on the first apply).
    """
    conn = _autocommit(db_dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("DROP EXTENSION IF EXISTS pg_search CASCADE")
    finally:
        conn.close()

    conn = _autocommit(db_dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'")
            still_there = cur.fetchone() is not None
            cur.execute("SELECT coalesce(current_setting(%s, true), '')",
                        ("gsd.lexical_engine",))
            setting = cur.fetchone()[0]
    finally:
        conn.close()
    if still_there:
        raise RuntimeError(
            "pg_engines: pg_search is still installed after DROP EXTENSION, so "
            "this database is NOT a plain-engine stand-in")
    if setting != FORCE_PLAIN:
        raise RuntimeError(
            "pg_engines: gsd.lexical_engine reads %r, not %r, so migration 011 "
            "would reinstall pg_search on the first apply" % (setting, FORCE_PLAIN))


@contextlib.contextmanager
def scratch_database(dsn, force_plain=False):
    """A fresh, empty database on the test server; dropped afterwards.

    The same mechanism as ``tests/test_docker_pg_migration.py``'s
    ``scratch_dsn`` fixture, plus the one ALTER DATABASE that makes the second
    engine possible.

    Args:
        dsn: the disposable cluster's DSN (``GSD_TEST_POSTGRES_URL``).
        force_plain: make the new database genuinely ``pg_search``-less — drop
            the extension it inherited from ``template1`` AND set
            ``gsd.lexical_engine = 'postgres_fts'`` so migration 011 does not
            put it back. Verified before yielding.

    Yields:
        str: a DSN for the new database.

    Raises:
        RuntimeError: when ``force_plain`` could not be established. A silent
            half-success here would mean every "plain engine" assertion in this
            plan silently tested ParadeDB instead.
    """
    name = "gsd_89_06_" + uuid.uuid4().hex[:12]
    admin = _admin_dsn(dsn)
    conn = _autocommit(admin)
    try:
        with conn.cursor() as cur:
            cur.execute('CREATE DATABASE "%s"' % name)
            if force_plain:
                # ALTER DATABASE ... SET applies from the NEXT connection on,
                # which is every connection this helper's caller will make.
                cur.execute(
                    'ALTER DATABASE "%s" SET gsd.lexical_engine = %%s' % name,
                    (FORCE_PLAIN,),
                )
    finally:
        conn.close()
    db_dsn = pg_dsn.dsn_with_database(dsn, name)
    if force_plain:
        _make_plain(db_dsn)
    try:
        yield db_dsn
    finally:
        conn = _autocommit(admin)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid()", (name,)
                )
                cur.execute('DROP DATABASE IF EXISTS "%s"' % name)
        finally:
            conn.close()


@contextlib.contextmanager
def migrated_database(dsn, force_plain=False):
    """:func:`scratch_database` with every migration applied.

    Yields:
        tuple: ``(db_dsn, report)`` — ``report`` is ``apply_migrations``' own
        dict (it returns a report, not an int), whose ``applied`` list and
        ``total`` are what the "same number on both engines" assertion reads.
    """
    with scratch_database(dsn, force_plain=force_plain) as db_dsn:
        report = migrate_runner.apply_migrations(dsn=db_dsn, log=lambda *_: None)
        yield db_dsn, report


def index_names(db_dsn, schema="public"):
    """Every index name in the database, as a sorted list."""
    import psycopg2

    conn = psycopg2.connect(db_dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT indexname FROM pg_indexes WHERE schemaname = %s "
                "ORDER BY indexname", (schema,)
            )
            return [r[0] for r in cur.fetchall()]
    finally:
        conn.close()


def index_defs(db_dsn, schema="public"):
    """``{indexname: indexdef}`` — the comparison a "byte-unchanged" claim needs.

    Names alone would miss a redefinition under the same name; the definition
    text is what ``pg_indexes`` can show of the index itself.
    """
    import psycopg2

    conn = psycopg2.connect(db_dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = %s ORDER BY indexname", (schema,)
            )
            return {r[0]: r[1] for r in cur.fetchall()}
    finally:
        conn.close()


def has_pg_search(db_dsn):
    """Whether ``pg_search`` is installed in this database (the ground truth)."""
    import psycopg2

    conn = psycopg2.connect(db_dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'")
            return cur.fetchone() is not None
    finally:
        conn.close()


# ── The two engines as fixtures ─────────────────────────────────────────────
# Defined here, not in a test module, so BOTH of plan 89-06's test files share
# ONE database per engine for the whole session: building two fully migrated
# databases costs real seconds, and four would cost them twice. A test module
# takes them with `from pg_engines import paradedb, plain, both  # noqa: F401`.

def _engine_entry(dsn, report, engine):
    return {"dsn": dsn, "report": report, "engine": engine,
            "applied": len(report["applied"]), "total": report["total"]}


#: The ONE reason a ParadeDB-engine test gives when the server cannot install
#: `pg_search` at all. Plan 89-07: before this plan every cell with a database
#: was the Linux ParadeDB container, so `paradedb` could not fail; now the macOS
#: and Windows cells have a PLAIN PostgreSQL, where `pg_available_extensions`
#: carries no `pg_search` row (measured: run 43354540890,
#: `pg_search_in_pg_available_extensions=0`) and this fixture would otherwise
#: blow up inside migration 011 instead of saying why.
PARADEDB_SKIP_REASON = (
    "no pg_search on this server, so a ParadeDB-engine database cannot be built "
    "here: this test asserts ParadeDB BM25 behaviour, not engine-agnostic "
    "behaviour (ParadeDB has no Windows build at all; real ParadeDB on the macOS "
    "cell is a separate, additive step)"
)


def server_can_install_pg_search(dsn):
    """Whether the SERVER carries a `pg_search` control file at all.

    Distinct from :func:`has_pg_search`, which asks whether the extension is
    installed in one database. A plain PostgreSQL answers False here and no
    `CREATE EXTENSION` can change that.

    Args:
        dsn: any DSN on the server.

    Returns:
        bool
    """
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search'")
            return cur.fetchone() is not None
    finally:
        conn.close()


@pytest.fixture(scope="session")
def paradedb(postgres_dsn):
    """A fully migrated database WITH pg_search, or ONE named skip."""
    if not server_can_install_pg_search(postgres_dsn):
        pytest.skip(PARADEDB_SKIP_REASON)
    with migrated_database(postgres_dsn) as (dsn, report):
        yield _engine_entry(dsn, report, "pg_search_bm25")


@pytest.fixture(scope="session")
def plain(postgres_dsn):
    """A fully migrated database WITHOUT pg_search (see this module's header)."""
    with migrated_database(postgres_dsn, force_plain=True) as (dsn, report):
        yield _engine_entry(dsn, report, "postgres_fts")


@pytest.fixture
def both(paradedb, plain):
    """Both engines, keyed by engine name, for a test that must assert on each."""
    return {"pg_search_bm25": paradedb, "postgres_fts": plain}


class CountingCursor:
    """A cursor wrapper that records every statement it executes."""

    def __init__(self, cursor, log):
        self._cursor = cursor
        self._log = log

    def execute(self, sql, params=None):
        self._log.append(sql if isinstance(sql, str) else str(sql))
        return (self._cursor.execute(sql, params) if params is not None
                else self._cursor.execute(sql))

    def __getattr__(self, name):
        return getattr(self._cursor, name)

    def __enter__(self):
        self._cursor.__enter__()
        return self

    def __exit__(self, *exc):
        return self._cursor.__exit__(*exc)


class CountingConnection:
    """A connection whose cursors record their statements.

    Used to MEASURE that the lexical probe runs once per connection rather
    than once per search — a claim about caching that only a count can settle.
    """

    def __init__(self, conn):
        self._conn = conn
        self.statements = []

    def cursor(self, *args, **kwargs):
        return CountingCursor(self._conn.cursor(*args, **kwargs), self.statements)

    def matching(self, needle):
        return [s for s in self.statements if needle in s]

    def __getattr__(self, name):
        return getattr(self._conn, name)
