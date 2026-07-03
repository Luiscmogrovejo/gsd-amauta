"""
Phase 66 / MEMR-08 (LAST plan of the phase): bi-temporal valid_at/invalid_at
columns + the write-time mem0-style ADD/UPDATE/DELETE/NOOP classifier.

Import/PG-gating style follows tests/test_66_store_dedup.py (the sibling
lock file this plan's wiring extends). All PG-gated rows in this file live
under project_id "__test66b__" (see TEST_PROJECT below), cleaned before AND
after every test by the autouse hygiene fixture. Classifier decisions are
injected by monkeypatching services.pg_store's imported `classify_memory_op`
name with a controllable stub (injection, not the live LLM) -- the only
test that exercises the real Anthropic HTTP call is the key-gated live-LLM
smoke test at the bottom of this file.

Live discovery (documented for future maintainers): the plan's own example
contradiction pair -- "the daemon runs on port 18799" / "the daemon now
runs on port 19000" -- has a live pg_trgm similarity() of ~0.63, ABOVE the
default GSD_TEXT_DEDUP_THRESHOLD (0.6, the pre-existing MEMR-06 rung). The
module-wide `_high_dedup_threshold` fixture below raises that threshold so
every test in this file reaches the classifier instead of short-circuiting
on the older near-duplicate dedup rung -- both mechanisms are independently
correct and coexist by design; this fixture isolates the classifier for
these tests without touching the default in production.
"""
import contextlib
import importlib.util
import json
import os
import sys
import threading
import urllib.error
import urllib.request
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _pg_conn_or_none():
    """
    Open a psycopg2 connection to GSD_POSTGRES_URL (default DSN matches
    test_65_hybrid_generic.py / test_66_hybrid_memory.py / test_66_store_dedup.py).
    Returns None on any exception so PG-gated tests can skip cleanly when
    the live database is unavailable.
    """
    try:
        import psycopg2
        dsn = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")
        return psycopg2.connect(dsn)
    except Exception:
        return None


_PG_AVAILABLE = _pg_conn_or_none() is not None

TEST_PROJECT = "__test66b__"


def _cleanup_test_project():
    """Delete every gsd_memory row under TEST_PROJECT ("__test66b__") and
    verify the count is actually zero afterward (research pitfall: verified
    cleanup, not merely attempted)."""
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
def _test66b_project_hygiene():
    """Clean TEST_PROJECT before AND after every test in this module so
    PG-gated tests never see stale rows from a prior failed run, and never
    leak rows into subsequent test runs."""
    if _PG_AVAILABLE:
        _cleanup_test_project()
    yield
    if _PG_AVAILABLE:
        _cleanup_test_project()


@pytest.fixture(autouse=True)
def _high_dedup_threshold(monkeypatch):
    """Raise GSD_TEXT_DEDUP_THRESHOLD for every test in this module -- see
    the module docstring for why (the synthetic contradiction/negation/
    restatement pairs below share enough tokens to clear the default 0.6
    MEMR-06 near-duplicate threshold, which would short-circuit before ever
    reaching the classifier this file exists to test)."""
    monkeypatch.setenv("GSD_TEXT_DEDUP_THRESHOLD", "0.99")


# ═══════════════════════════════════════════════════════
# Stub connection/cursor for classifier-wiring tests that do NOT require
# live PostgreSQL (mirrors test_66_store_dedup.py's _RaisingDedupConn
# pattern, generalized to serve trigram-candidate SELECTs, the plain
# INSERT, and UPDATE...invalid_at statements).
# ═══════════════════════════════════════════════════════

class _StubCursor:
    """Records every executed statement. Returns `candidate_rows` for any
    SELECT containing `similarity(text` (the widened trigram candidate
    query), a fixed insert id for the INSERT, and an empty result for
    anything else (e.g. the UPDATE ... invalid_at statements, which the
    caller does not fetch from)."""

    def __init__(self, candidate_rows=None, insert_id="mem-stub-id"):
        self.candidate_rows = candidate_rows or []
        self.insert_id = insert_id
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        last_sql = self.executed[-1][0] if self.executed else ""
        if "INSERT INTO gsd_memory" in last_sql:
            return (self.insert_id,)
        return None

    def fetchall(self):
        last_sql = self.executed[-1][0] if self.executed else ""
        if "similarity(text" in last_sql:
            return list(self.candidate_rows)
        return []


class _StubConn:
    def __init__(self, candidate_rows=None, insert_id="mem-stub-id"):
        self.cur = _StubCursor(candidate_rows=candidate_rows, insert_id=insert_id)

    def cursor(self, cursor_factory=None):
        return self.cur

    def commit(self):
        pass

    def rollback(self):
        pass


def _stub_store(candidate_rows, bitemporal=True, insert_id="mem-stub-id"):
    """Build a PGStore instance wired to a _StubConn -- no live PG required."""
    from services.pg_store import PGStore

    store = object.__new__(PGStore)
    store._bitemporal_cache = bitemporal
    fake_conn = _StubConn(candidate_rows=candidate_rows, insert_id=insert_id)

    @contextlib.contextmanager
    def _fake_get_conn():
        yield fake_conn
    store._get_conn = _fake_get_conn
    return store, fake_conn


# ═══════════════════════════════════════════════════════
# PG-gated: the actual MEMR-08 acceptance behavior against live PostgreSQL
# ═══════════════════════════════════════════════════════

@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_contradiction_closes_window(monkeypatch):
    """THE MEMR-08 acceptance test: storing fact B with an injected UPDATE
    decision targeting fact A closes A's validity window (invalid_at IS NOT
    NULL), B lands currently-valid (invalid_at IS NULL), and memory_search
    returns B but NEVER A."""
    from services.pg_store import PGStore
    import services.pg_store as pg_store_mod

    monkeypatch.setattr(PGStore, "generate_embedding", staticmethod(lambda *a, **kw: None))

    store = PGStore()
    a_text = "the daemon runs on port 18799"
    a_id = store.memory_store(a_text, project_id=TEST_PROJECT)
    assert not isinstance(a_id, dict), f"fact A store unexpectedly deduped/classified: {a_id}"

    b_text = "the daemon now runs on port 19000"

    def _stub(new_text, candidates, llm_call=None):
        assert any(c["id"] == a_id for c in candidates), (
            f"fact A must be among the classifier's candidates: {candidates}"
        )
        return {"op": "UPDATE", "target_id": a_id, "reason": "synthetic-contradiction"}

    monkeypatch.setattr(pg_store_mod, "classify_memory_op", _stub)

    b_result = store.memory_store(b_text, project_id=TEST_PROJECT)
    assert isinstance(b_result, dict) and b_result.get("superseded_id") == a_id, (
        f"UPDATE decision must return {{'id':..., 'superseded_id': {a_id!r}}}, got {b_result}"
    )
    b_id = b_result["id"]

    conn = _pg_conn_or_none()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT invalid_at FROM gsd_memory WHERE id = %s", (a_id,))
            assert cur.fetchone()[0] is not None, "fact A's validity window must be closed"
            cur.execute("SELECT invalid_at FROM gsd_memory WHERE id = %s", (b_id,))
            assert cur.fetchone()[0] is None, "fact B must be currently valid"
    finally:
        conn.close()

    results = store.memory_search("daemon port", project_id=TEST_PROJECT)
    ids = [r["id"] for r in results]
    assert b_id in ids, f"memory_search must return currently-valid fact B: {ids}"
    assert a_id not in ids, f"memory_search must NEVER return invalidated fact A: {ids}"


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_delete_closes_without_insert(monkeypatch):
    """A stub DELETE decision must close the target's window WITHOUT
    inserting a new row, and return {"deleted_target": id}."""
    from services.pg_store import PGStore
    import services.pg_store as pg_store_mod

    monkeypatch.setattr(PGStore, "generate_embedding", staticmethod(lambda *a, **kw: None))
    store = PGStore()

    target_text = "gsd-amauta requires node 18 LTS to run"
    target_id = store.memory_store(target_text, project_id=TEST_PROJECT)
    assert not isinstance(target_id, dict)

    def _stub(new_text, candidates, llm_call=None):
        return {"op": "DELETE", "target_id": target_id, "reason": "synthetic-negation"}

    monkeypatch.setattr(pg_store_mod, "classify_memory_op", _stub)

    negation_text = "gsd-amauta does NOT require node 18 LTS to run anymore"
    result = store.memory_store(negation_text, project_id=TEST_PROJECT)
    assert isinstance(result, dict) and result.get("deleted_target") == target_id

    conn = _pg_conn_or_none()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT invalid_at FROM gsd_memory WHERE id = %s", (target_id,))
            assert cur.fetchone()[0] is not None, "DELETE must close the target's validity window"
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE project_id = %s", (TEST_PROJECT,))
            assert cur.fetchone()[0] == 1, "DELETE must NOT insert a new row"
    finally:
        conn.close()


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_noop_skips_insert(monkeypatch):
    """A stub NOOP decision must skip the insert entirely and return
    {"noop": True, "existing_id": ...}; row count stays unchanged."""
    from services.pg_store import PGStore
    import services.pg_store as pg_store_mod

    monkeypatch.setattr(PGStore, "generate_embedding", staticmethod(lambda *a, **kw: None))
    store = PGStore()

    base_text = "the retry backoff schedule is 2000ms then 8000ms"
    base_id = store.memory_store(base_text, project_id=TEST_PROJECT)
    assert not isinstance(base_id, dict)

    def _stub(new_text, candidates, llm_call=None):
        return {"op": "NOOP", "target_id": base_id, "reason": "restatement"}

    monkeypatch.setattr(pg_store_mod, "classify_memory_op", _stub)

    restatement = "the retry backoff schedule is 2000ms and then 8000ms again"
    result = store.memory_store(restatement, project_id=TEST_PROJECT)
    assert result == {"noop": True, "existing_id": base_id}, result

    conn = _pg_conn_or_none()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE project_id = %s", (TEST_PROJECT,))
            assert cur.fetchone()[0] == 1, "NOOP must not insert a second row"
    finally:
        conn.close()


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_classifier_failure_is_add(monkeypatch):
    """A classifier that raises must never block the write -- the row
    lands anyway (fail-open, real INSERT, real PG)."""
    from services.pg_store import PGStore
    import services.pg_store as pg_store_mod

    monkeypatch.setattr(PGStore, "generate_embedding", staticmethod(lambda *a, **kw: None))
    store = PGStore()

    base_text = "the cache TTL default is 300 seconds"
    base_id = store.memory_store(base_text, project_id=TEST_PROJECT)
    assert not isinstance(base_id, dict)

    def _raising_stub(new_text, candidates, llm_call=None):
        raise RuntimeError("synthetic classifier failure")

    monkeypatch.setattr(pg_store_mod, "classify_memory_op", _raising_stub)

    followup = "the cache TTL default should stay 300 seconds going forward"
    result = store.memory_store(followup, project_id=TEST_PROJECT)
    assert not isinstance(result, dict), (
        f"classifier failure must fall through to a plain ADD, got {result}"
    )

    conn = _pg_conn_or_none()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE project_id = %s", (TEST_PROJECT,))
            assert cur.fetchone()[0] == 2, "row must be inserted despite the classifier raising"
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════
# Never-block / kill-switch / un-migrated-guard / skip_dedup -- no live PG
# required (stub connection, following test_66_store_dedup.py's
# _RaisingDedupConn precedent)
# ═══════════════════════════════════════════════════════

def test_killswitch_env(monkeypatch):
    """GSD_MEMORY_CLASSIFIER=off must short-circuit the REAL
    classify_memory_op (NOT monkeypatched here) before it ever calls
    _default_llm_call -- verified via a call-counting patch on
    services.memory_classifier._default_llm_call. pg_store's plain ADD
    path then proceeds via a stubbed connection; no live PG, no network
    call, required."""
    import services.memory_classifier as classifier_mod

    monkeypatch.setenv("GSD_MEMORY_CLASSIFIER", "off")

    call_count = {"n": 0}

    def _counting_llm_call(prompt):
        call_count["n"] += 1
        return '{"op": "DELETE", "target_id": 1}'

    monkeypatch.setattr(classifier_mod, "_default_llm_call", _counting_llm_call)

    store, fake_conn = _stub_store(
        candidate_rows=[{"id": 1, "text": "existing candidate", "sim": 0.9}],
    )

    result = store.memory_store("new statement text", tags=None, project_id=TEST_PROJECT)

    assert call_count["n"] == 0, (
        "kill switch must short-circuit classify_memory_op before "
        "_default_llm_call is ever invoked"
    )
    assert not isinstance(result, dict), f"kill switch must degrade to a plain ADD, got {result}"
    insert_statements = [sql for sql, _ in fake_conn.cur.executed if "INSERT INTO gsd_memory" in sql]
    assert insert_statements, "plain ADD must still execute the INSERT"


def test_unmigrated_guard():
    """_has_bitemporal() forced False must produce a filter_sql fragment
    with no `invalid_at` clause, AND the store path (stub connection, no
    live PG) must not raise -- an un-migrated database degrades
    gracefully."""
    import services.pg_store as pg_store_mod

    filter_sql, _ = pg_store_mod._memory_filter_sql(project_id=TEST_PROJECT, valid_only=False)
    assert "invalid_at" not in filter_sql

    store, fake_conn = _stub_store(
        candidate_rows=[{"id": 1, "text": "candidate", "sim": 0.5}],
        bitemporal=False,
    )

    result = store.memory_store("unmigrated guard smoke text", tags=None, project_id=TEST_PROJECT)
    assert not isinstance(result, dict) or "error" not in result

    executed_sql = [sql for sql, _ in fake_conn.cur.executed]
    trigram_sql = next(sql for sql in executed_sql if "similarity(text" in sql)
    assert "invalid_at" not in trigram_sql, (
        "un-migrated guard must omit the invalid_at fragment from the "
        "trigram candidate query"
    )


def test_skip_dedup_skips_classifier(monkeypatch):
    """skip_dedup=True (distill's merge-store) must skip classification
    entirely -- the classifier stub must never be invoked, matching
    MEMR-06's existing skip_dedup semantics."""
    import services.pg_store as pg_store_mod

    call_count = {"n": 0}

    def _counting_stub(new_text, candidates, llm_call=None):
        call_count["n"] += 1
        return {"op": "DELETE", "target_id": 1}

    monkeypatch.setattr(pg_store_mod, "classify_memory_op", _counting_stub)

    store, fake_conn = _stub_store(
        candidate_rows=[{"id": 1, "text": "candidate", "sim": 0.9}],
    )

    result = store.memory_store(
        "distill merge text", tags=None, project_id=TEST_PROJECT, skip_dedup=True,
    )
    assert call_count["n"] == 0, (
        "skip_dedup=True must skip classification entirely (distill-merge safety)"
    )
    assert not isinstance(result, dict)
    insert_statements = [sql for sql, _ in fake_conn.cur.executed if "INSERT INTO gsd_memory" in sql]
    assert insert_statements, "skip_dedup write must still execute the INSERT"


# ═══════════════════════════════════════════════════════
# Live-LLM smoke (key-gated, tolerant assertion -- no CI dependency on a
# live Anthropic key; skipped entirely when ANTHROPIC_API_KEY is unset)
# ═══════════════════════════════════════════════════════

@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set -- live LLM classifier smoke skipped",
)
def test_live_llm_classifier_smoke():
    """An obvious restatement pair, classified by the REAL Anthropic HTTP
    call (no llm_call injection): tolerant assertion only -- op must be one
    of the 4-enum and classify_memory_op must not raise. LLM output is
    inherently non-deterministic, so this does NOT assert a specific op."""
    from services.memory_classifier import classify_memory_op

    candidates = [{"id": 1, "text": "the team meeting is scheduled for 3pm on Tuesday"}]
    result = classify_memory_op(
        "the team meeting is scheduled for 3pm Tuesday, same as before", candidates,
    )
    assert result["op"] in ("ADD", "UPDATE", "DELETE", "NOOP"), result


# ═══════════════════════════════════════════════════════
# Daemon-route-level HTTP tests (TK-1773 — Phase 66-05 follow-up): MEMR-08's
# write-time classifier returns THREE dict sentinel shapes
# (noop/deleted_target/{"id":...,"superseded_id":...}) that the daemon's
# dedup-dict check (LOAD-BEARING fix, commit d029ff7) does not recognize --
# they fell through to the plain-id branch and leaked as
# {"id": <dict>, "stored": true}. Mirrors
# tests/test_66_store_dedup.py::test_daemon_route_dedup_shape's HTTP-level
# pattern for the dedup_skipped shape.
# ═══════════════════════════════════════════════════════

def _start_daemon_server():
    """Load amauta-daemon.py as a standalone module (hyphenated filename,
    not importable by name) wired to a real PGStore, and start it on an
    ephemeral port. Returns (amauta_daemon module, server, thread, port)."""
    repo_root = os.path.join(os.path.dirname(__file__), "..")
    services_dir = os.path.abspath(os.path.join(repo_root, "services"))
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)

    spec = importlib.util.spec_from_file_location(
        "amauta_daemon_66_05_test", os.path.join(services_dir, "amauta-daemon.py")
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
    return amauta_daemon, server, thread, port


def _post_json(port, body):
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


def _cleanup_by_ids(*ids):
    """Verified-by-id cleanup -- DATA-06 forces project_id="__test__" under
    pytest (PYTEST_CURRENT_TEST is set), NOT the project_id sent in the
    request body, so TEST_PROJECT-scoped DELETEs would miss these rows."""
    conn = _pg_conn_or_none()
    if conn is None:
        return
    try:
        with conn.cursor() as cur:
            for _id in ids:
                if _id is not None:
                    cur.execute("DELETE FROM gsd_memory WHERE id = %s", (_id,))
        conn.commit()
    finally:
        conn.close()


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_daemon_route_noop_shape(monkeypatch):
    """POST /api/memory/store with a classifier stub returning NOOP must
    surface {"stored": false, "noop": true, "existing_id": ...} at the top
    level -- NEVER {"id": {"noop": true, ...}, "stored": true}."""
    import pg_store as pg_store_mod  # bare import -- matches the daemon's own `from pg_store import PGStore`

    amauta_daemon, server, thread, port = _start_daemon_server()
    base_id = None
    try:
        base_text = f"__test66b__ TK-1773 noop base {uuid.uuid4().hex}"
        status0, data0 = _post_json(port, {"text": base_text, "embed": False, "project_id": TEST_PROJECT})
        assert status0 == 200 and data0.get("stored") is True, data0
        base_id = data0.get("id")

        def _stub(new_text, candidates, llm_call=None):
            return {"op": "NOOP", "target_id": base_id, "reason": "synthetic-restatement"}

        monkeypatch.setattr(pg_store_mod, "classify_memory_op", _stub)

        status1, data1 = _post_json(
            port, {"text": f"{base_text} restated", "embed": False, "project_id": TEST_PROJECT}
        )
        assert status1 == 200, data1
        assert data1.get("stored") is False, f"NOOP must report stored:false, got: {data1}"
        assert data1.get("noop") is True, f"NOOP shape must surface noop:true, got: {data1}"
        assert data1.get("existing_id") == base_id
        assert not isinstance(data1.get("id"), dict), f"NOOP dict must never leak as the 'id' field: {data1}"
    finally:
        server.shutdown()
        server.server_close()
        _cleanup_by_ids(base_id)


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_daemon_route_deleted_target_shape(monkeypatch):
    """POST /api/memory/store with a classifier stub returning DELETE must
    surface {"stored": false, "deleted_target": ...} at the top level --
    NEVER {"id": {"deleted_target": ...}, "stored": true}."""
    import pg_store as pg_store_mod

    amauta_daemon, server, thread, port = _start_daemon_server()
    base_id = None
    try:
        base_text = f"__test66b__ TK-1773 delete base {uuid.uuid4().hex}"
        status0, data0 = _post_json(port, {"text": base_text, "embed": False, "project_id": TEST_PROJECT})
        assert status0 == 200 and data0.get("stored") is True, data0
        base_id = data0.get("id")

        def _stub(new_text, candidates, llm_call=None):
            return {"op": "DELETE", "target_id": base_id, "reason": "synthetic-negation"}

        monkeypatch.setattr(pg_store_mod, "classify_memory_op", _stub)

        status1, data1 = _post_json(
            port, {"text": f"{base_text} negated", "embed": False, "project_id": TEST_PROJECT}
        )
        assert status1 == 200, data1
        assert data1.get("stored") is False, f"DELETE must report stored:false, got: {data1}"
        assert data1.get("deleted_target") == base_id, f"DELETE shape must surface deleted_target, got: {data1}"
        assert not isinstance(data1.get("id"), dict), f"DELETE dict must never leak as the 'id' field: {data1}"
    finally:
        server.shutdown()
        server.server_close()
        _cleanup_by_ids(base_id)


@pytest.mark.skipif(not _PG_AVAILABLE, reason="live PostgreSQL unavailable (GSD_POSTGRES_URL)")
def test_daemon_route_superseded_id_shape(monkeypatch):
    """POST /api/memory/store with a classifier stub returning UPDATE must
    surface {"id": <new id>, "stored": true, "superseded_id": ...} -- a
    successful store (a new row WAS inserted), NEVER
    {"id": {"id": ..., "superseded_id": ...}, "stored": true}."""
    import pg_store as pg_store_mod

    amauta_daemon, server, thread, port = _start_daemon_server()
    base_id = None
    new_id = None
    try:
        base_text = f"__test66b__ TK-1773 update base {uuid.uuid4().hex}"
        status0, data0 = _post_json(port, {"text": base_text, "embed": False, "project_id": TEST_PROJECT})
        assert status0 == 200 and data0.get("stored") is True, data0
        base_id = data0.get("id")

        def _stub(new_text, candidates, llm_call=None):
            return {"op": "UPDATE", "target_id": base_id, "reason": "synthetic-contradiction"}

        monkeypatch.setattr(pg_store_mod, "classify_memory_op", _stub)

        status1, data1 = _post_json(
            port, {"text": f"{base_text} updated", "embed": False, "project_id": TEST_PROJECT}
        )
        assert status1 == 200, data1
        assert data1.get("stored") is True, f"UPDATE must report stored:true (a row WAS inserted), got: {data1}"
        assert data1.get("superseded_id") == base_id, f"UPDATE shape must surface superseded_id, got: {data1}"
        new_id = data1.get("id")
        assert new_id is not None and not isinstance(new_id, dict), (
            f"UPDATE's new id must be a plain scalar, never a nested dict: {data1}"
        )
        assert new_id != base_id
    finally:
        server.shutdown()
        server.server_close()
        _cleanup_by_ids(base_id, new_id)
