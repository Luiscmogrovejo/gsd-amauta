"""INFRA-02 + INFRA-03: pgvector upgrade and ParadeDB pg_search verification tests.

Phase 26 plan 02 — paradedb/paradedb:latest-pg16 image switch + migration 011.

Deviations from plan documented inline:
- Image tag is latest-pg16 (not pg16) — ParadeDB tagging convention
- Migration 011 uses DO block version assertion (not ALTER EXTENSION vector UPDATE)
  because paradedb:latest-pg16 ships pgvector 0.8.1 but DB has 0.8.2 (cannot downgrade)
- BM25 CREATE INDEX uses USING bm25 WITH (key_field='id') — paradedb.create_bm25() proc
  does not exist in pg_search v0.22.6
- BM25 query syntax requires column prefix: 'content:term' (not bare term)
"""
import pathlib
import pytest


def _read_migration():
    return pathlib.Path('migrations/011-paradedb-setup.sql').read_text()


def test_infra02_migration_has_version_assertion():
    """Migration 011 contains pgvector version assertion (>= 0.8.0)."""
    sql = _read_migration()
    # DO block replaces ALTER EXTENSION vector UPDATE (which would fail on downgrade)
    assert '0.8.0' in sql, 'Migration must assert pgvector >= 0.8.0'
    assert 'INFRA-02' in sql


def test_infra02_migration_enables_iterative_scan():
    """Migration 011 sets ivfflat.iterative_scan = relaxed_order."""
    sql = _read_migration()
    assert 'ivfflat.iterative_scan' in sql
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
    """pg_store.py _get_conn sets ivfflat.iterative_scan = relaxed_order."""
    pg_store = pathlib.Path('services/pg_store.py').read_text()
    assert 'ivfflat.iterative_scan' in pg_store
    assert 'relaxed_order' in pg_store


def test_infra02_docker_compose_uses_paradedb_image():
    """docker-compose.yml uses paradedb/paradedb:latest-pg16 image."""
    compose = pathlib.Path('docker/docker-compose.yml').read_text()
    # Deviation: tag is latest-pg16 (not pg16) — ParadeDB tagging convention
    assert 'paradedb/paradedb:latest-pg16' in compose
    assert 'pgvector/pgvector:pg16' not in compose


def test_infra03_docker_compose_has_pg_search_preload():
    """docker-compose.yml has pg_search in shared_preload_libraries command."""
    compose = pathlib.Path('docker/docker-compose.yml').read_text()
    assert 'shared_preload_libraries=pg_search' in compose


def test_infra02_extension_fixture_exists():
    """tests/fixtures/26-pg-extensions.txt exists with version info."""
    fixture = pathlib.Path('tests/fixtures/26-pg-extensions.txt')
    if not fixture.exists():
        pytest.skip('Extension fixture not created — run 26-02-03 task first')
    content = fixture.read_text()
    assert 'extversion' in content
    assert 'PASS' in content


@pytest.mark.integration
def test_infra02_pgvector_version_gte_080():
    """LIVE: pgvector version in running PG is >= 0.8.0."""
    try:
        import psycopg2
        import os
        dsn = os.environ.get('GSD_POSTGRES_URL', 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta')
        conn = psycopg2.connect(dsn, connect_timeout=3)
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
def test_infra03_pg_search_installed():
    """LIVE: pg_search extension is installed in running PG."""
    try:
        import psycopg2
        import os
        dsn = os.environ.get('GSD_POSTGRES_URL', 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta')
        conn = psycopg2.connect(dsn, connect_timeout=3)
        cur = conn.cursor()
        cur.execute("SELECT extversion FROM pg_extension WHERE extname='pg_search'")
        row = cur.fetchone()
        conn.close()
        assert row is not None, 'pg_search extension not installed'
        assert row[0] is not None, 'pg_search version must be non-null'
    except psycopg2.OperationalError:
        pytest.skip('PG not reachable — live integration test skipped')


@pytest.mark.integration
def test_infra03_bm25_query_returns_results():
    """LIVE: BM25 query on bm25_test_table returns >= 1 result.

    Deviation: BM25 query syntax requires column prefix 'content:hello' (not bare 'hello').
    """
    try:
        import psycopg2
        import os
        dsn = os.environ.get('GSD_POSTGRES_URL', 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta')
        conn = psycopg2.connect(dsn, connect_timeout=3)
        cur = conn.cursor()
        # pg_search v0.22.6 requires column-prefixed query: 'content:term'
        cur.execute("SELECT count(*) FROM bm25_test_table WHERE bm25_test_table @@@ 'content:hello'")
        row = cur.fetchone()
        conn.close()
        assert row[0] >= 1, f'BM25 query returned {row[0]} results, expected >= 1'
    except psycopg2.OperationalError:
        pytest.skip('PG not reachable — live integration test skipped')
    except Exception as exc:
        pytest.fail(f'BM25 query failed: {exc}')
