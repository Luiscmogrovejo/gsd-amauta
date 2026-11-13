"""INFRA-02 + INFRA-03: pgvector upgrade and ParadeDB pg_search verification tests.

Phase 26 plan 02 — paradedb/paradedb:latest-pg16 image switch + migration 011.

Deviations from plan documented inline:
- Image tag is latest-pg16 (not pg16) — ParadeDB tagging convention
- Migration 011 uses DO block version assertion (not ALTER EXTENSION vector UPDATE)
  because paradedb:latest-pg16 ships pgvector 0.8.1 but DB has 0.8.2 (cannot downgrade)
- BM25 CREATE INDEX uses USING bm25 WITH (key_field='id') — paradedb.create_bm25() proc
  does not exist in pg_search v0.22.6
- BM25 query syntax requires column prefix: 'content:term' (not bare term)

Phase 89 / decision D3 (plan 89-06): pg_search is OPTIONAL. The seven tests
that read migration TEXT are unchanged — 011 still carries every literal they
assert, inside the guard. Of the three that need a database, two were about the
EXTENSION and are now about THE ENGINE PRESENT: they assert the correct answer
on a ParadeDB database and the correct answer on a plain PostgreSQL, so they
pass on every cell and need no skip entry. The pgvector one is unchanged:
pgvector is still required.
"""
import os
import pathlib
import re
import sys

import pytest

#: Plan 89-12 (decision D4): the lexical engine each CI cell is DOCUMENTED to
#: run, keyed by ``sys.platform``. The Linux cell gets ParadeDB from the pinned
#: container image, the macOS cell from the pinned, SHA-256-verified
#: ``pg_search`` installer package, and the Windows cell runs plain PostgreSQL
#: because ParadeDB publishes no Windows build at all. ``docs/CI-POSTGRES-CELLS.md``
#: carries the same table for people, and a test below holds the two together.
#:
#: This is what turns "the engine present" into "the engine this cell is MEANT
#: to have": without it, a macOS cell whose package silently failed to load
#: would fall back to full-text search, every engine-conditional test would
#: take its other branch, and the run would be green on the wrong engine.
CI_CELL_LEXICAL_ENGINE = {
    'linux': 'pg_search_bm25',
    'darwin': 'pg_search_bm25',
    'win32': 'postgres_fts',
}

#: The runner label of each platform's cell, as the workflow matrix spells it.
CI_CELL_RUNNER = {
    'linux': 'ubuntu-latest',
    'darwin': 'macos-latest',
    'win32': 'windows-latest',
}

_CELLS_DOC = pathlib.Path(__file__).resolve().parent.parent / 'docs' / 'CI-POSTGRES-CELLS.md'


def _on_a_ci_cell():
    """Whether this run is a CI cell — the skip gate's own rule for ``CI``."""
    value = os.environ.get('CI', '').strip().lower()
    return value not in ('', 'false', '0')


# 88-08-04: the three LIVE integration tests below used to fall back to the default DSN
# on 127.0.0.1:5433, i.e. the operator's live Postgres whenever its container was up
# (psycopg2 is a C extension, so the in-process socket guard cannot see it). They now
# take the ``postgres_dsn`` fixture (tests/conftest.py), which skips with
# "no disposable Postgres" unless GSD_TEST_POSTGRES_URL points at a disposable server.


def _read_migration():
    return pathlib.Path('migrations/011-paradedb-setup.sql').read_text(encoding="utf-8")


def test_infra02_migration_has_version_assertion():
    """Migration 011 contains pgvector version assertion (>= 0.8.0)."""
    sql = _read_migration()
    # DO block replaces ALTER EXTENSION vector UPDATE (which would fail on downgrade)
    assert '0.8.0' in sql, 'Migration must assert pgvector >= 0.8.0'
    assert 'INFRA-02' in sql


def test_infra02_migration_enables_iterative_scan():
    """Migration 011 sets hnsw.iterative_scan = relaxed_order."""
    sql = _read_migration()
    # The GUC was ivfflat.iterative_scan until the index moved to HNSW; the setting
    # changed in 1d51227 (66-04-02) in both migration 011 and services/pg_store.py.
    assert 'hnsw.iterative_scan' in sql
    assert 'relaxed_order' in sql


def test_infra03_migration_installs_pg_search():
    """Migration 011 creates pg_search extension."""
    sql = _read_migration()
    assert 'CREATE EXTENSION IF NOT EXISTS pg_search' in sql


def test_infra03_migration_creates_bm25_test_table():
    """Migration 011 creates bm25_test_table for smoke testing."""
    sql = _read_migration()
    assert 'bm25_test_table' in sql


def test_infra03_migration_creates_bm25_index():
    """Migration 011 creates BM25 index using pg_search v0.22.6 CREATE INDEX syntax."""
    sql = _read_migration()
    # pg_search v0.22.6 uses CREATE INDEX USING bm25 (not paradedb.create_bm25())
    assert 'USING bm25' in sql
    assert "key_field = 'id'" in sql


def test_infra02_migration_down_exists():
    """DOWN migration for 011 exists."""
    down = pathlib.Path('migrations/011-paradedb-setup-DOWN.sql')
    assert down.exists(), 'DOWN migration must exist'


def test_infra02_pg_store_enables_iterative_scan():
    """pg_store.py _get_conn sets hnsw.iterative_scan = relaxed_order."""
    pg_store = pathlib.Path('services/pg_store.py').read_text(encoding="utf-8")
    # ivfflat.iterative_scan -> hnsw.iterative_scan in 1d51227 (66-04-02).
    assert 'hnsw.iterative_scan' in pg_store
    assert 'relaxed_order' in pg_store


def test_infra02_docker_compose_uses_paradedb_image():
    """docker-compose.yml uses paradedb/paradedb:latest-pg16 image."""
    compose = pathlib.Path('docker/docker-compose.yml').read_text(encoding="utf-8")
    # Deviation: tag is latest-pg16 (not pg16) — ParadeDB tagging convention
    assert 'paradedb/paradedb:latest-pg16' in compose
    assert 'pgvector/pgvector:pg16' not in compose


def test_infra03_docker_compose_has_pg_search_preload():
    """docker-compose.yml has pg_search in shared_preload_libraries command."""
    compose = pathlib.Path('docker/docker-compose.yml').read_text(encoding="utf-8")
    assert 'shared_preload_libraries=pg_search' in compose


def test_infra02_extension_fixture_exists():
    """tests/fixtures/26-pg-extensions.txt exists with version info."""
    fixture = pathlib.Path('tests/fixtures/26-pg-extensions.txt')
    if not fixture.exists():
        pytest.skip('Extension fixture not created — run 26-02-03 task first')
    content = fixture.read_text(encoding="utf-8")
    assert 'extversion' in content
    assert 'PASS' in content


@pytest.mark.integration
def test_infra02_pgvector_version_gte_080(postgres_dsn):
    """LIVE: pgvector version in running PG is >= 0.8.0."""
    try:
        import psycopg2
        conn = psycopg2.connect(postgres_dsn, connect_timeout=3)
        cur = conn.cursor()
        cur.execute("SELECT extversion FROM pg_extension WHERE extname='vector'")
        row = cur.fetchone()
        conn.close()
        assert row is not None, 'pgvector extension not found'
        version = row[0]
        parts = version.split('.')
        major, minor = int(parts[0]), int(parts[1])
        assert (major, minor) >= (0, 8), f'pgvector version {version} < 0.8.0'
    except psycopg2.OperationalError:
        pytest.skip('PG not reachable — live integration test skipped')


@pytest.mark.integration
def test_infra03_pg_search_installed(postgres_dsn):
    """LIVE: the database says which lexical engine it has, and is consistent.

    Phase 89 / decision D3 (plan 89-06) made pg_search OPTIONAL, so "the
    extension is installed" is no longer the right assertion everywhere — it is
    the right assertion on a ParadeDB database and the WRONG one on a plain
    PostgreSQL, which is what the macOS and Windows cells get from plan 89-07.
    This test now asserts the correct thing FOR THE ENGINE PRESENT, which is why
    it needs no skip entry on any cell:

      * pg_search installed  -> it has a version, the resolver says
        `pg_search_bm25`, and the BM25 smoke index exists;
      * pg_search absent     -> the resolver says `postgres_fts`, the capability
        report agrees, and migration 033's substitute index exists.

    Neither branch asserts a SCORE: the two engines are not claimed to rank
    alike (services/rlm_search.py, RETR-08).
    """
    import sys as _sys

    _REPO = pathlib.Path(__file__).resolve().parent.parent
    if str(_REPO) not in _sys.path:
        _sys.path.insert(0, str(_REPO))
    from services import infra_detect

    try:
        import psycopg2
        conn = psycopg2.connect(postgres_dsn, connect_timeout=3)
    except psycopg2.OperationalError:
        pytest.skip('PG not reachable — live integration test skipped')
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT extversion FROM pg_extension WHERE extname='pg_search'")
            row = cur.fetchone()
            cur.execute("SELECT indexname FROM pg_indexes WHERE schemaname='public'")
            indexes = {r[0] for r in cur.fetchall()}
        infra_detect.reset_lexical_engine_cache()
        engine = infra_detect.lexical_engine(conn)
    finally:
        conn.close()

    if row is not None:
        assert row[0] is not None, 'pg_search version must be non-null'
        assert engine['lexical_engine'] == infra_detect.LEXICAL_PG_SEARCH, engine
        assert 'bm25_test_idx' in indexes, \
            'pg_search is installed but migration 011 created no BM25 index'
    else:
        assert engine['lexical_engine'] == infra_detect.LEXICAL_POSTGRES_FTS, engine
        ok, report = infra_detect.check_pg_capabilities(postgres_dsn)
        assert ok, report['reason']
        assert report['lexical_engine'] == infra_detect.LEXICAL_POSTGRES_FTS
        assert 'idx_rlm_chunks_fts' in indexes, \
            'pg_search is absent and migration 033 created no substitute'
        assert 'idx_gsd_memory_fts_fallback' in indexes, \
            'pg_search is absent and migration 033 created no memory substitute'

    # Plan 89-12: the two index sets, BOTH directions, by name. A database is on
    # exactly one lexical engine: every index of its own set exists and none of
    # the other's does. (A leftover substitute beside a BM25 index would mean
    # migration 033 ran its plain branch on a ParadeDB database.)
    import pg_engines  # tests/support is on sys.path -- see tests/conftest.py
    bm25 = set(pg_engines.BM25_INDEXES)
    substitutes = set(pg_engines.FTS_SUBSTITUTE_INDEXES)
    if row is not None:
        assert bm25 <= indexes, sorted(bm25 - indexes)
        assert not (substitutes & indexes), sorted(substitutes & indexes)
    else:
        assert substitutes <= indexes, sorted(substitutes - indexes)
        assert not (bm25 & indexes), sorted(bm25 & indexes)

    # Plan 89-12: and on a CI cell the engine is not "whichever one is there",
    # it is the one that cell is documented to run. Everything above passes on
    # EITHER engine by design, so without this line a macOS cell whose pinned
    # package failed to load would be green on the fallback and nobody would
    # know. A developer machine is not a cell and may run either.
    if _on_a_ci_cell():
        assert sys.platform in CI_CELL_LEXICAL_ENGINE, sys.platform
        assert engine['lexical_engine'] == CI_CELL_LEXICAL_ENGINE[sys.platform], (
            'the %s cell is documented (docs/CI-POSTGRES-CELLS.md) to run %s and '
            'this database runs %s: %s' % (
                CI_CELL_RUNNER[sys.platform], CI_CELL_LEXICAL_ENGINE[sys.platform],
                engine['lexical_engine'], engine.get('reason')))

    # Plan 89-07: the same answer must reach the two places an operator looks,
    # ON THE CELL'S OWN DATABASE. Plan 89-06's doctor and /health tests take
    # both engines in one test, so they are ParadeDB-gated and never execute on
    # a server with no pg_search available -- which left the plain-PostgreSQL
    # report unasserted exactly where it is the only report there is (the
    # macOS and Windows cells). This asserts it for the engine PRESENT, so it
    # runs, unskipped, on all nine cells.
    from services import _89_06_reporting as reporting
    from services import migrate_runner, report_hooks

    expected = (infra_detect.LEXICAL_PG_SEARCH if row is not None
                else infra_detect.LEXICAL_POSTGRES_FTS)
    env = {'GSD_POSTGRES_URL': postgres_dsn}
    reporting.reset_cache()
    try:
        rows = reporting.doctor_rows(env)
        section = report_hooks.extra_health_rows(env)
    finally:
        reporting.reset_cache()
    assert rows and len(rows) == 1, rows
    status, category, detail, data = rows[0]
    assert category == reporting.DOCTOR_CATEGORY
    assert data['lexical_engine'] == expected, rows
    assert status == (report_hooks.STATUS_OK if row is not None
                      else report_hooks.STATUS_WARN), rows
    fragment = section[reporting.HEALTH_KEY]
    assert fragment['lexical_engine'] == expected, fragment
    assert fragment['degraded'] is (row is None), fragment
    assert fragment['reason'] == detail, (fragment, detail)
    if row is None:
        assert detail == infra_detect.LEXICAL_FALLBACK_SENTENCE, detail

    # ... and the schema that database carries is the WHOLE schema: every
    # migration on disk is recorded as applied, none pending, none drifted.
    state = migrate_runner.status(dsn=postgres_dsn)
    assert state['tracking_table'] is True, state
    assert state['pending'] == [], state['pending']
    assert state['drifted'] == [], state['drifted']
    assert len(state['applied']) == state['total'] > 0, state


def test_the_documented_engine_of_every_cell_is_the_asserted_one():
    """docs/CI-POSTGRES-CELLS.md and ``CI_CELL_LEXICAL_ENGINE`` say the same thing.

    Plan 89-12. The table people read and the map the live test above enforces
    are two statements of one fact, and a statement that is only written down
    drifts. This needs no database, so it runs on every cell and locally: each
    of the nine cells has a row, and each row names the engine the live
    assertion requires of that platform.
    """
    text = _CELLS_DOC.read_text(encoding='utf-8')
    rows = [line for line in text.splitlines()
            if line.startswith('|') and re.search(r'`(test|pytest) \(', line)]
    assert len(rows) == 9, 'the table must have one row per required cell: %r' % rows
    engines = set(CI_CELL_LEXICAL_ENGINE.values())
    seen = {}
    for line in rows:
        runners = [r for r in CI_CELL_RUNNER.values() if r in line]
        assert len(runners) == 1, line
        named = [e for e in engines if '`%s`' % e in line]
        assert len(named) == 1, 'a row names exactly one engine: %s' % line
        platform = next(p for p, r in CI_CELL_RUNNER.items() if r == runners[0])
        assert named[0] == CI_CELL_LEXICAL_ENGINE[platform], line
        seen[platform] = seen.get(platform, 0) + 1
    assert seen == {'linux': 3, 'darwin': 3, 'win32': 3}, seen
    # The Windows limit is stated as a capability, in the words the plan fixed.
    assert 'no Windows target' in text


@pytest.mark.integration
def test_infra03_bm25_query_returns_results(postgres_dsn):
    """LIVE: the lexical leg of the engine present finds the smoke row.

    Phase 89 / decision D3 (plan 89-06): on a plain PostgreSQL there is no
    `@@@` operator to call at all, so this asserts the same FACT — "a lexical
    query for 'hello' finds the row that contains it" — through whichever
    engine the database has. Membership, never a score.
    """
    try:
        import psycopg2
        conn = psycopg2.connect(postgres_dsn, connect_timeout=3)
    except psycopg2.OperationalError:
        pytest.skip('PG not reachable — live integration test skipped')
    has_pg_search = None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname='pg_search'")
            has_pg_search = cur.fetchone() is not None
            if has_pg_search:
                # pg_search v0.22.6 requires column-prefixed query: 'content:term'
                cur.execute(
                    "SELECT count(*) FROM bm25_test_table "
                    "WHERE bm25_test_table @@@ 'content:hello'")
            else:
                # bm25_test_idx was skipped by 011's guard and gets no 033
                # substitute (three rows: see 033's header), so this is a
                # deliberate sequential to_tsvector scan.
                cur.execute(
                    "SELECT count(*) FROM bm25_test_table "
                    "WHERE to_tsvector('english', content) "
                    "@@ plainto_tsquery('english', 'hello')")
            row = cur.fetchone()
    except Exception as exc:
        conn.close()
        pytest.fail(f'lexical query failed (pg_search={has_pg_search}): {exc}')
    else:
        conn.close()
    assert row[0] >= 1, f'lexical query returned {row[0]} results, expected >= 1'
