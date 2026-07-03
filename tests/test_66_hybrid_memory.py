"""
Phase 66 / MEMR-03 + MEMR-04: memory_search hybrid-router locks, degradation
ladder, rescue-window proof, and memory_semantic_search over-fetch lock.

Import/PG-gating style follows tests/test_65_hybrid_generic.py (the consumer
contract this plan's router depends on).
"""
import contextlib
import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _pg_conn_or_none():
    """
    Open a psycopg2 connection to GSD_POSTGRES_URL (default DSN matches
    test_65_hybrid_generic.py / rlm-service.py:217). Returns None on any
    exception so PG-gated tests can skip cleanly when the live database is
    unavailable.
    """
    try:
        import psycopg2
        dsn = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")
        return psycopg2.connect(dsn)
    except Exception:
        return None


class _FakeCursor:
    """Stub cursor recording executed SQL without touching a real DB."""

    def __init__(self):
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return []

    def rollback(self):
        pass


class _FakeConn:
    """Stub pg_conn exposing only .cursor()/.commit()/.rollback(), used to
    prove memory_search's rung-1 BM25-only degradation path issues SQL and
    never raises, without a real database connection."""

    def __init__(self):
        self.cur = _FakeCursor()

    def cursor(self, cursor_factory=None):
        return self.cur

    def commit(self):
        pass

    def rollback(self):
        pass


def _make_store_with_fake_conn():
    """Construct a PGStore instance bypassing __init__ (no real
    psycopg2 pool needed) with _get_conn monkeypatched to yield a fake
    connection whose cursor records executed SQL."""
    from services.pg_store import PGStore

    store = object.__new__(PGStore)
    fake_conn = _FakeConn()

    @contextlib.contextmanager
    def _fake_get_conn():
        yield fake_conn

    store._get_conn = _fake_get_conn
    return store, fake_conn


def test_memory_search_calls_generic():
    """MEMR-03: memory_search must route through hybrid_search_generic and
    must no longer contain the relevance-blind created_at-ordered fallback."""
    from services.pg_store import PGStore

    src = inspect.getsource(PGStore.memory_search)
    assert 'hybrid_search_generic' in src
    assert 'created_at DESC' not in src


def test_no_rederived_rrf():
    """MEMR-03 must_have: no new '1.0 / (' RRF literal is re-derived in
    pg_store.py -- the RRF formula lives ONLY in rlm_search.py."""
    import services.pg_store as m

    assert inspect.getsource(m).count('1.0 / (') == 0


def test_degradation_no_embedding():
    """Rung 1 with no query embedding available routes through
    hybrid_search_generic's native BM25-only mode (no vector operator
    issued) and never raises, even against a stub connection that returns
    zero rows at every rung."""
    from services.pg_store import PGStore

    orig_generate_embedding = PGStore.generate_embedding
    PGStore.generate_embedding = staticmethod(lambda *a, **kw: None)
    try:
        store, fake_conn = _make_store_with_fake_conn()
        results = store.memory_search("zx66degradation query", limit=3)
    finally:
        PGStore.generate_embedding = orig_generate_embedding

    assert results == []  # every rung's stub cursor returns fetchall() == []
    assert fake_conn.cur.executed, (
        "hybrid_search_generic's BM25-only degradation branch must still "
        "issue SQL through the stub connection"
    )
    first_sql = fake_conn.cur.executed[0][0]
    assert '<=>' not in first_sql, (
        "rung 1 with no query embedding must not reference the vector operator"
    )


def test_jaccard_helper():
    """MEMR-03 rung 3 Python fallback (reused by wave 4's write-dedup)."""
    from services.pg_store import _jaccard

    assert _jaccard('a b c', 'a b d') == 0.5
    assert _jaccard('', '') == 0.0
    assert _jaccard('same', 'same') == 1.0


def test_semantic_overfetch_source():
    """MEMR-04 second site: memory_semantic_search over-fetches limit*4."""
    from services.pg_store import PGStore

    src = inspect.getsource(PGStore.memory_semantic_search)
    assert 'limit * 4' in src


_PG_AVAILABLE = _pg_conn_or_none() is not None


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_rescue_window():
    """
    Rescue-window proof (MEMR-03/04, research pitfall 3 companion, live PG
    required): 8 recent, never-cited 'agent' rows and 1 older, heavily-cited
    'lesson-learned' row all share the unique token zx66rescue. The
    lesson-learned row's source bonus (+4) and citation boost
    (min(log1p(12), 3.0) ~= 2.565) must rescue it into the top-3 of
    memory_search('zx66rescue', limit=3) despite its age and despite being
    outnumbered 8:1 by fresher rows -- proving the composite score (not raw
    relevance/recency) drives the final ranking. Cleanup is VERIFIED (a
    COUNT(*) == 0 check), not merely attempted (research pitfall 13).
    """
    from services.pg_store import PGStore

    conn = _pg_conn_or_none()
    assert conn is not None, "PG must be reachable — skipif should have gated this test"

    try:
        with conn.cursor() as cur:
            for i in range(8):
                cur.execute(
                    """
                    INSERT INTO gsd_memory (text, source, project_id, applied_count)
                    VALUES (%s, 'agent', '__test66h__', 0)
                    """,
                    (f"row {i} contains zx66rescue as filler low-signal text",),
                )
            cur.execute(
                """
                INSERT INTO gsd_memory (text, source, project_id, applied_count, created_at)
                VALUES (%s, 'lesson-learned', '__test66h__', 12, NOW() - INTERVAL '200 days')
                """,
                ("the rescued lesson-learned row also contains zx66rescue",),
            )
        conn.commit()

        store = PGStore()
        results = store.memory_search('zx66rescue', project_id='__test66h__', limit=3)
        sources = [r.get('source') for r in results]
        assert 'lesson-learned' in sources, (
            f"lesson-learned row (bonus+citations) must be rescued into the "
            f"top-3: {sources}"
        )
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM gsd_memory WHERE project_id = '__test66h__'")
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE project_id = '__test66h__'")
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"__test66h__ cleanup failed to verify: {remaining} rows remain"
        conn.close()
