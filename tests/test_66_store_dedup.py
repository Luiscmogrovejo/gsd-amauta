"""
Phase 66 / MEMR-06 + MEMR-07: no-embedding write-time dedup (trigram/Jaccard,
never-block), TK-1704 empty-tags guard mirrored into memory_store(),
skip_dedup seam (both store methods + the daemon route), rerank
blend-not-replace semantics, and the hnsw.iterative_scan GUC correction.

Import/PG-gating style follows tests/test_66_hybrid_memory.py (the sibling
lock file this plan depends on).
"""
import contextlib
import inspect
import importlib.util
import json
import os
import sys
import threading
import uuid
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _pg_conn_or_none():
    """
    Open a psycopg2 connection to GSD_POSTGRES_URL (default DSN matches
    test_65_hybrid_generic.py / test_66_hybrid_memory.py). Returns None on
    any exception so PG-gated tests can skip cleanly when the live database
    is unavailable.
    """
    try:
        import psycopg2
        dsn = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")
        return psycopg2.connect(dsn)
    except Exception:
        return None


_PG_AVAILABLE = _pg_conn_or_none() is not None

TEST_PROJECT = "__test66d__"


def _cleanup_test_project():
    """Delete every gsd_memory row under TEST_PROJECT and verify the count
    is actually zero afterward (research pitfall: verified cleanup, not
    merely attempted)."""
    conn = _pg_conn_or_none()
    if conn is None:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM gsd_memory WHERE project_id = %s", (TEST_PROJECT,))
        conn.commit()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE project_id = %s", (TEST_PROJECT,))
            remaining = cur.fetchone()[0]
        assert remaining == 0, f"{TEST_PROJECT} cleanup failed to verify: {remaining} rows remain"
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _test66d_project_hygiene():
    """Clean TEST_PROJECT before AND after every test in this module so PG-
    gated tests never see stale rows from a prior failed run, and never
    leak rows into subsequent test runs."""
    if _PG_AVAILABLE:
        _cleanup_test_project()
    yield
    if _PG_AVAILABLE:
        _cleanup_test_project()


# ═══════════════════════════════════════════════════════
# PG-gated: real write-time dedup against the live database
# ═══════════════════════════════════════════════════════

@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_empty_tags_no_raise():
    """TK-1704 mirror: memory_store(tags=None) must not raise. Pre-fix this
    called normalize_tags([]) directly, which intentionally rejects empty
    input and raised ValueError."""
    from services.pg_store import PGStore

    store = PGStore()
    mem_id = store.memory_store(
        f"__test66d__ empty-tags smoke {uuid.uuid4().hex}",
        tags=None,
        project_id=TEST_PROJECT,
    )
    assert mem_id is not None
    assert not isinstance(mem_id, dict)


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_trigram_dedup_skips():
    """No-API-key write path (generate_embedding -> None, so
    memory_store_with_embedding falls back to memory_store) must dedup a
    near-identical write via the new trigram rung."""
    from services.pg_store import PGStore

    orig_generate_embedding = PGStore.generate_embedding
    PGStore.generate_embedding = staticmethod(lambda *a, **kw: None)
    try:
        store = PGStore()
        text = f"__test66d__ trigram dedup near-identical marker {uuid.uuid4().hex}"
        first = store.memory_store_with_embedding(text, project_id=TEST_PROJECT)
        assert not isinstance(first, dict), f"first store unexpectedly deduped: {first}"

        second = store.memory_store_with_embedding(text, project_id=TEST_PROJECT)
        assert isinstance(second, dict) and second.get("dedup_skipped") is True
        assert second.get("existing_id") == first
        assert "similarity" in second
    finally:
        PGStore.generate_embedding = orig_generate_embedding


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_skip_dedup_bypasses():
    """skip_dedup=True must bypass the trigram/Jaccard dedup entirely, even
    against text identical to an existing row."""
    from services.pg_store import PGStore

    orig_generate_embedding = PGStore.generate_embedding
    PGStore.generate_embedding = staticmethod(lambda *a, **kw: None)
    try:
        store = PGStore()
        text = f"__test66d__ skip_dedup bypass marker {uuid.uuid4().hex}"
        first = store.memory_store_with_embedding(text, project_id=TEST_PROJECT)
        assert not isinstance(first, dict)

        second = store.memory_store_with_embedding(text, project_id=TEST_PROJECT, skip_dedup=True)
        assert not isinstance(second, dict), f"skip_dedup did not bypass dedup: {second}"
        assert second != first
    finally:
        PGStore.generate_embedding = orig_generate_embedding


# ═══════════════════════════════════════════════════════
# Never-block guarantee (no live PG required — stubbed connection)
# ═══════════════════════════════════════════════════════

class _RaisingDedupCursor:
    """Stub cursor that raises on both dedup-rung SELECTs (trigram's
    `similarity(` query and Jaccard's candidate-fetch query) but succeeds
    silently on everything else (the plain INSERT), recording every
    executed statement so the test can assert the INSERT still ran."""

    def __init__(self):
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if "similarity(" in sql:
            raise RuntimeError("stub trigram rung failure")
        if "ORDER BY created_at DESC" in sql and "FROM gsd_memory" in sql:
            raise RuntimeError("stub jaccard rung failure")
        # Anything else (the plain INSERT) succeeds.

    def fetchone(self):
        return ("mem-neverblock-stub",)

    def fetchall(self):
        return []


class _RaisingDedupConn:
    def __init__(self):
        self.cur = _RaisingDedupCursor()

    def cursor(self, cursor_factory=None):
        return self.cur

    def commit(self):
        pass

    def rollback(self):
        pass


def test_dedup_never_blocks():
    """Both dedup rungs failing must never block the write -- the INSERT
    must still execute."""
    from services.pg_store import PGStore

    store = object.__new__(PGStore)
    fake_conn = _RaisingDedupConn()

    @contextlib.contextmanager
    def _fake_get_conn():
        yield fake_conn

    store._get_conn = _fake_get_conn

    result = store.memory_store("never block me", tags=None, project_id="__test66d_stub__")
    assert result == "mem-neverblock-stub"

    insert_statements = [sql for sql, _ in fake_conn.cur.executed if "INSERT INTO gsd_memory" in sql]
    assert insert_statements, (
        f"dedup rung failures must not prevent the INSERT from executing: "
        f"{fake_conn.cur.executed}"
    )


# ═══════════════════════════════════════════════════════
# Rerank blend semantics (MEMR-07) — no live PG required
# ═══════════════════════════════════════════════════════

def test_rerank_blend_not_replace():
    """A row whose composite score dominates must stay ranked above a row
    the reranker slightly prefers -- blend, not replace."""
    from services.pg_store import PGStore
    from unittest.mock import patch

    store = object.__new__(PGStore)
    store.dsn = "postgresql://stub/stub"

    row_a = {"id": "A", "text": "row a", "score": 10.0, "semantic_similarity": 0.9}
    row_b = {"id": "B", "text": "row b", "score": 4.0, "semantic_similarity": 0.5}

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            pass

        def fetchall(self):
            return [dict(row_a), dict(row_b)]

    class _FakeConn:
        def cursor(self, cursor_factory=None):
            return _FakeCursor()

    @contextlib.contextmanager
    def _fake_get_conn():
        yield _FakeConn()

    store._get_conn = _fake_get_conn

    with patch.object(store, "generate_embedding", return_value=[0.1, 0.2, 0.3, 0.4]):
        with patch.object(PGStore, "_score_semantic_results", return_value=[dict(row_a), dict(row_b)]):
            with patch.object(PGStore, "rerank", staticmethod(lambda q, docs, top_k=10: [
                {"index": 1, "relevance_score": 0.9},  # reranker prefers B
                {"index": 0, "relevance_score": 0.7},  # A less preferred
            ])):
                results, method = store.memory_semantic_search("q", limit=2)

    assert method == "vector+rerank"
    assert results[0]["id"] == "A", (
        f"composite-dominant row A must stay first despite the reranker "
        f"preferring B: {[(r['id'], r['score']) for r in results]}"
    )
    assert "score_composite" in results[0] and "score_composite" in results[1]
    assert results[0]["score_composite"] == 10.0
    assert results[1]["score_composite"] == 4.0


def test_guc_is_hnsw():
    """MEM-M3: the connection GUC must target the index type that actually
    exists (HNSW), not ivfflat."""
    from services.pg_store import PGStore

    src = inspect.getsource(PGStore._get_conn)
    assert "hnsw.iterative_scan" in src
    assert "ivfflat.iterative_scan" not in src


# ═══════════════════════════════════════════════════════
# Daemon-route-level HTTP test (LOAD-BEARING fix verification)
# ═══════════════════════════════════════════════════════

@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_daemon_route_dedup_shape():
    """POST /api/memory/store twice with near-identical text and
    "embed": false (forcing the plain else branch -- the exact path the
    LOAD-BEARING daemon fix targets) must return
    {"stored": false, "dedup_skipped": true, "existing_id": ...} on the
    second call, and must NEVER serialize the dedup dict as
    {"id": {...}, "stored": true}.
    """
    repo_root = os.path.join(os.path.dirname(__file__), "..")
    services_dir = os.path.abspath(os.path.join(repo_root, "services"))
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)

    # amauta-daemon.py is hyphenated -- not importable by name.
    spec = importlib.util.spec_from_file_location(
        "amauta_daemon_66_04_test", os.path.join(services_dir, "amauta-daemon.py")
    )
    amauta_daemon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(amauta_daemon)

    from pg_store import PGStore

    # Module-level import in amauta-daemon.py only sets _HAS_PG_MODULE --
    # _pg_store itself is only populated by main()/start_daemon(), which we
    # deliberately do NOT run here. Wire it directly so _get_store() returns
    # a real PGStore instance.
    amauta_daemon._pg_store = PGStore()
    amauta_daemon._sqlite_store = None
    # Force-open regardless of ambient env (test isolation, not a real auth bypass).
    amauta_daemon.DAEMON_AUTH_TOKEN = ""
    amauta_daemon._oidc = None

    server = amauta_daemon.ThreadedHTTPServer(("127.0.0.1", 0), amauta_daemon.AmautaHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    text = f"__test66d__ daemon route dedup shape check {uuid.uuid4().hex}"
    first_id = None
    try:
        def _post(body):
            payload = json.dumps(body).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/memory/store",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return resp.status, json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read().decode())

        status1, data1 = _post({"text": text, "embed": False, "project_id": TEST_PROJECT})
        assert status1 == 200, data1
        assert data1.get("stored") is True
        assert not isinstance(data1.get("id"), dict)
        first_id = data1.get("id")

        status2, data2 = _post({"text": text, "embed": False, "project_id": TEST_PROJECT})
        assert status2 == 200, data2
        # LOAD-BEARING assertion: must be the dedup shape, never a leaked dict-as-id.
        assert data2.get("stored") is False, (
            f"dedup hit must report stored:false, got: {data2}"
        )
        assert data2.get("dedup_skipped") is True, (
            f"dedup hit must report dedup_skipped:true, got: {data2}"
        )
        assert not isinstance(data2.get("id"), dict), (
            f"dedup dict must never leak as the 'id' field: {data2}"
        )
        assert data2.get("existing_id") == first_id
    finally:
        server.shutdown()
        server.server_close()
        # Verified cleanup: DATA-06 forces project_id="__test__" under pytest
        # (PYTEST_CURRENT_TEST is set), NOT the project_id we sent in the
        # request body -- so clean up by id, not by TEST_PROJECT filter.
        conn = _pg_conn_or_none()
        if conn is not None and first_id is not None:
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM gsd_memory WHERE id = %s", (first_id,))
                conn.commit()
                with conn.cursor() as cur:
                    cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE id = %s", (first_id,))
                    remaining = cur.fetchone()[0]
                assert remaining == 0, f"daemon-route test cleanup failed: id {first_id} still present"
            finally:
                conn.close()
