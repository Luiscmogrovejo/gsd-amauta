"""Plan 89-05 (ORC-02 criterion 5): the blackboard inbox round-trips on BOTH backends.

Plan 89-05 deletes the bespoke A2A request/response surface, which makes the
blackboard (``/api/findings``, ``/api/messages``) the single agent-to-agent channel.
This file is the proof that the channel it becomes actually works, written and
committed BEFORE anything was deleted.

Both arms drive the SAME daemon handlers over real HTTP:

* the **SQLite** arm runs everywhere — it is the operator's live backend;
* the **PostgreSQL** arm needs ``GSD_TEST_POSTGRES_URL`` and skips with
  ``conftest.PG_SKIP_REASON`` where there is none (the macOS and Windows cells until
  plan 89-07, and the operator's machine always). Those skips are listed in
  ``tests/skip-exceptions.d/89-05.json``, each naming task 89-07-04 as the remover.

The PostgreSQL arm runs against its OWN scratch database, created on the disposable
server with every migration applied and dropped afterwards, so it never touches the
configured one. Every daemon here binds ``GSD_AMAUTA_PORT=0`` and announces its port,
so nothing contacts 18799, 18798, 5433 or 6379.

**Why the arm asserts its own backend.** ``_force_sqlite()`` answers True for
``GSD_TEST_MODE``, so a fixture that keeps test mode on and merely adds a DSN serves
SQLite on both arms and the cross-backend claim is vacuous (measured by plan 89-02 for
the Node fixture, routed to 89-07). The PostgreSQL arm therefore starts the daemon
WITHOUT test mode and asserts ``pg_configured``/``degraded`` on ``/health`` before any
other assertion.

Run: python3 -m pytest tests/test_89_05_inbox_round_trip.py -q -rs -p no:cacheprovider
"""

import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent
_REPO = _TESTS.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))
_SERVICES = _REPO / "services"
if str(_SERVICES) not in sys.path:
    sys.path.insert(0, str(_SERVICES))

from conftest import (  # noqa: E402
    PG_SKIP_REASON,
    assert_test_dsn_is_not_live,
    postgres_dsn_or_none,
)

DAEMON = _REPO / "services" / "amauta-daemon.py"
MIGRATIONS_DIR = _REPO / "migrations"

#: The two backends criterion 5 names. Every round-trip test runs on both.
BACKENDS = ("sqlite", "postgres")

#: Readiness budget for a fixture daemon, in seconds. Longer than conftest's 20 s
#: because the PostgreSQL arm connects and probes a real server on startup.
READY_TIMEOUT = float(os.environ.get("GSD_FIXTURE_DAEMON_READY_TIMEOUT", "40"))

TEST_DSN_ABSENT = postgres_dsn_or_none() is None
requires_pg = pytest.mark.skipif(TEST_DSN_ABSENT, reason=PG_SKIP_REASON)


# ─────────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────────


def _http(port, method, path, body=None):
    """One request to a fixture daemon on 127.0.0.1.

    Args:
        port: the daemon's announced port.
        method: an HTTP verb.
        path: the request path, query string included.
        body: a JSON-serialisable body, or None.

    Returns:
        tuple[int, object]: the status and the decoded body (the raw text when it
        is not JSON).
    """
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        status = err.code
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


# ─────────────────────────────────────────────────────────────────────────────
# The two fixture daemons
# ─────────────────────────────────────────────────────────────────────────────


class InboxDaemon:
    """A running daemon, its backend named and its port announced."""

    def __init__(self, backend, port, data_dir, dsn=None):
        self.backend = backend
        self.port = port
        self.data_dir = data_dir
        self.dsn = dsn

    def __repr__(self):  # pragma: no cover - diagnostics only
        return f"InboxDaemon(backend={self.backend!r}, port={self.port!r})"


def _spawn(env, tmp_path, tag):
    """Start ``services/amauta-daemon.py run`` and wait for /health.

    Args:
        env: the complete child environment.
        tmp_path: where the stdout/stderr transcripts go.
        tag: a name for those transcripts.

    Returns:
        tuple[subprocess.Popen, int, io.TextIOBase, io.TextIOBase]: the process,
        the announced port, and the two open transcript handles (the caller closes
        them).

    Raises:
        RuntimeError: when the daemon is not ready within :data:`READY_TIMEOUT`;
            the message carries both transcripts.
    """
    out_path = tmp_path / f"{tag}.out"
    err_path = tmp_path / f"{tag}.err"
    out_f = open(out_path, "w", encoding="utf-8")
    err_f = open(err_path, "w", encoding="utf-8")
    started = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(DAEMON), "run"], stdout=out_f, stderr=err_f, env=env,
    )
    port = None
    deadline = started + READY_TIMEOUT
    while time.time() < deadline and proc.poll() is None:
        if port is None:
            for line in out_path.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("DAEMON_PORT="):
                    port = int(line.split("=", 1)[1])
                    break
        if port is not None:
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:%d/health" % port, timeout=3
                ) as r:
                    if r.status == 200:
                        return proc, port, out_f, err_f
            except Exception:
                pass
        time.sleep(0.1)
    exit_code = proc.poll()
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:  # pragma: no cover - best effort
        pass
    out_f.close()
    err_f.close()
    raise RuntimeError(
        "fixture daemon (%s) not ready: exit_code=%r port=%r elapsed=%.1fs\n"
        "--- stdout ---\n%s\n--- stderr ---\n%s"
        % (tag, exit_code, port, time.time() - started,
           out_path.read_text(encoding="utf-8", errors="replace")[-3000:],
           err_path.read_text(encoding="utf-8", errors="replace")[-5000:])
    )


def _base_env(data_dir):
    """The pinned child environment both arms start from."""
    env = dict(os.environ)
    for key in ("GSD_POSTGRES_URL", "DATABASE_URL", "REDIS_URL", "GSD_DATA_DIR"):
        env.pop(key, None)
    env.update({
        "GSD_AMAUTA_PORT": "0",
        "GSD_DAEMON_PORT": "0",
        "GSD_RLM_PORT": "0",
        "GSD_RLM_ENABLED": "false",
        "GSD_REDIS_ENABLED": "false",
        "AMAUTA_DATA_DIR": str(data_dir),
        "AMAUTA_AUTO_BACKUP": "off",
        "AMAUTA_MEMORY_DATABASE_URL": "",
        "GSD_AMAUTA_NO_AUTO_START": "1",
        "PYTHONFAULTHANDLER": "1",
        # Even on the PostgreSQL arm: if the PG connection ever failed, the
        # fallback must land in the temp dir, never in ~/.amauta/data.
        "GSD_SQLITE_PATH": str(data_dir / "gsd_amauta.db"),
    })
    return env


def _sqlite_daemon(tmp_path):
    """A daemon on the SQLite backend, in test mode (the live fallback's own mode)."""
    data_dir = tmp_path / "sqlite-data"
    data_dir.mkdir()
    env = _base_env(data_dir)
    env.update({"GSD_TEST_MODE": "1", "GSD_FORCE_SQLITE": "1", "GSD_BACKEND": "sqlite"})
    proc, port, out_f, err_f = _spawn(env, tmp_path, "daemon-sqlite")
    return InboxDaemon("sqlite", port, data_dir), proc, out_f, err_f


def _postgres_daemon(tmp_path, dsn):
    """A daemon on the PostgreSQL backend, against one scratch database.

    Test mode is deliberately OFF: ``_force_sqlite()`` answers True for
    ``GSD_TEST_MODE``, so leaving it on would serve SQLite under a PostgreSQL name.
    Everything test mode would otherwise suppress is suppressed by name instead
    (RLM, Redis, the auto-backup, container auto-start), and the data dir and the
    SQLite fallback path are both inside the temp tree.
    """
    data_dir = tmp_path / "pg-data"
    data_dir.mkdir()
    env = _base_env(data_dir)
    for key in ("GSD_TEST_MODE", "GSD_FORCE_SQLITE", "GSD_BACKEND"):
        env.pop(key, None)
    env["GSD_POSTGRES_URL"] = dsn
    proc, port, out_f, err_f = _spawn(env, tmp_path, "daemon-postgres")
    return InboxDaemon("postgres", port, data_dir, dsn=dsn), proc, out_f, err_f


def _stop(proc, out_f, err_f):
    """Terminate a fixture daemon and close its transcripts."""
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover - slow shutdown
        proc.kill()
        proc.wait()
    out_f.close()
    err_f.close()


def _assert_backend(daemon):
    """Fail unless /health says the daemon runs on the backend its arm names."""
    status, health = _http(daemon.port, "GET", "/health")
    assert status == 200, (status, health)
    if daemon.backend == "postgres":
        assert health.get("pg_configured") is True, (
            "the PostgreSQL arm is serving something else; the cross-backend claim "
            f"would be vacuous. /health: {health}"
        )
        assert health.get("degraded") is False, health
        assert health.get("backend") == "postgresql", health
    else:
        assert health.get("pg_configured") is False, health
        assert health.get("degraded") is True, health
    return health


# ─────────────────────────────────────────────────────────────────────────────
# Scratch PostgreSQL
# ─────────────────────────────────────────────────────────────────────────────


def _scratch_database():
    """Create a scratch database on the disposable server; return (dsn, drop).

    Returns:
        tuple[str, callable]: the DSN of a fresh database with every migration
        applied, and a no-argument callable that drops it.
    """
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    from services import migrate_runner, pg_dsn

    test_dsn = postgres_dsn_or_none()
    if not test_dsn:
        pytest.skip(PG_SKIP_REASON)
    assert_test_dsn_is_not_live(test_dsn, where="test_89_05_inbox_round_trip")

    name = "gsd_8905_" + uuid.uuid4().hex[:12]
    admin = pg_dsn.dsn_with_database(test_dsn, "postgres")
    conn = psycopg2.connect(admin, connect_timeout=10)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with conn.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    conn.close()
    dsn = pg_dsn.dsn_with_database(test_dsn, name)
    migrate_runner.apply_migrations(dsn=dsn, log=lambda *_: None)

    def drop():
        c = psycopg2.connect(admin, connect_timeout=10)
        c.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        with c.cursor() as cur2:
            cur2.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()", (name,)
            )
            cur2.execute(f'DROP DATABASE IF EXISTS "{name}"')
        c.close()

    return dsn, drop


@pytest.fixture
def scratch_pg_dsn():
    """A scratch database with every migration applied; dropped afterwards."""
    dsn, drop = _scratch_database()
    try:
        yield dsn
    finally:
        drop()


@pytest.fixture(params=BACKENDS)
def inbox(request, tmp_path):
    """A daemon on each backend in turn, with its backend asserted.

    The PostgreSQL parameterisation skips with ``conftest.PG_SKIP_REASON`` wherever
    ``GSD_TEST_POSTGRES_URL`` is unset.
    """
    backend = request.param
    drop = None
    if backend == "postgres":
        dsn, drop = _scratch_database()
        daemon, proc, out_f, err_f = _postgres_daemon(tmp_path, dsn)
    else:
        daemon, proc, out_f, err_f = _sqlite_daemon(tmp_path)
    try:
        _assert_backend(daemon)
        yield daemon
    finally:
        _stop(proc, out_f, err_f)
        if drop:
            drop()


# ─────────────────────────────────────────────────────────────────────────────
# The fields the two backends must agree on
# ─────────────────────────────────────────────────────────────────────────────

#: Every key `GET /api/messages/:agent` returns per message. Compared as a SET
#: across the backends: a backend that silently stores (or returns) less is the
#: failure mode this file exists to catch.
MESSAGE_FIELDS = {
    "id", "from_agent", "to_agent", "task_id", "message_type", "content",
    "response", "status", "operator_approved", "created_at", "responded_at",
}

#: Every key `GET /api/findings/:task` returns per finding.
FINDING_FIELDS = {
    "id", "agent_name", "task_id", "finding_type", "content", "confidence",
    "created_at",
}


def _is_uuid(value):
    """True when *value* is a canonical 8-4-4-4-12 UUID string."""
    try:
        return str(uuid.UUID(str(value))) == str(value)
    except (ValueError, AttributeError, TypeError):
        return False


def _post_question(daemon, sender, recipient, task_id, text):
    """POST an ASK_QUESTION and return the created body."""
    status, created = _http(daemon.port, "POST", "/api/messages", {
        "from_agent": sender, "to_agent": recipient, "task_id": task_id,
        "message_type": "ASK_QUESTION", "content": text,
    })
    assert status == 201, (status, created)
    return created


def _post_finding(daemon, agent, task_id, text):
    """POST a finding and return the created body."""
    status, created = _http(daemon.port, "POST", "/api/findings", {
        "agent_name": agent, "task_id": task_id, "finding_type": "observation",
        "content": text, "confidence": 0.9,
    })
    assert status == 201, (status, created)
    return created


# ═════════════════════════════════════════════════════════════════════════════
# The round trip, on each backend
# ═════════════════════════════════════════════════════════════════════════════


class TestMessageRoundTrip:
    """post -> read -> answer -> read the answer, on SQLite and on PostgreSQL."""

    def test_a_question_is_read_answered_and_the_answer_read_back(self, inbox):
        task_id = "TK-8905-" + uuid.uuid4().hex[:8]
        question = "Is migration 032 reversible?"
        answer = "Yes: 032-drop-a2a-messages-DOWN.sql copies 024's DDL verbatim."

        # 1. POST /api/messages
        created = _post_question(inbox, "executor-backend", "reviewer", task_id, question)
        msg_id = created["id"]
        assert _is_uuid(msg_id), f"id is not a canonical UUID on {inbox.backend}: {msg_id!r}"
        assert created["created"] is True
        assert created["status"] == "pending", created
        assert created["operator_approved"] is False, created
        assert created["created_at"], created

        # 2. GET /api/messages/:agent — the body and the ids intact
        status, body = _http(inbox.port, "GET", "/api/messages/reviewer")
        assert status == 200, (status, body)
        mine = [m for m in body["messages"] if m["id"] == msg_id]
        assert len(mine) == 1, (inbox.backend, body)
        got = mine[0]
        assert got["content"] == question
        assert got["from_agent"] == "executor-backend"
        assert got["to_agent"] == "reviewer"
        assert got["task_id"] == task_id
        assert got["message_type"] == "ASK_QUESTION"
        assert got["status"] == "pending"
        assert got["response"] is None, "an unanswered message must carry no response"
        assert got["responded_at"] is None
        assert got["operator_approved"] is False
        assert got["created_at"], got
        assert set(got) == MESSAGE_FIELDS, (
            f"{inbox.backend} returns a different field set: "
            f"missing={MESSAGE_FIELDS - set(got)} extra={set(got) - MESSAGE_FIELDS}"
        )

        # 3. PATCH /api/messages/:id — answer it, with the documented verb
        status, patched = _http(inbox.port, "PATCH", f"/api/messages/{msg_id}", {
            "status": "responded", "response": answer,
        })
        assert status == 200, (status, patched)
        assert patched["updated"] is True
        assert patched["id"] == msg_id
        assert patched["status"] == "responded"
        assert patched["responded_at"], "answering must stamp responded_at"
        assert set(patched) == {"id", "status", "operator_approved", "responded_at", "updated"}, (
            inbox.backend, patched
        )

        # 4. GET the answer back. `responded` leaves the DEFAULT inbox — that is
        # the route's documented semantics, and plan 89-05 added ?status= so the
        # answer is still readable instead of write-only.
        status, defaulted = _http(inbox.port, "GET", "/api/messages/reviewer")
        assert status == 200, (status, defaulted)
        assert [m for m in defaulted["messages"] if m["id"] == msg_id] == [], (
            "an answered message must leave the pending/approved inbox"
        )

        status, answered = _http(
            inbox.port, "GET", "/api/messages/reviewer?status=responded")
        assert status == 200, (status, answered)
        back = [m for m in answered["messages"] if m["id"] == msg_id]
        assert len(back) == 1, (inbox.backend, answered)
        assert back[0]["response"] == answer, (
            f"the answer did not round-trip on {inbox.backend}: {back[0]}"
        )
        assert back[0]["status"] == "responded"
        assert back[0]["content"] == question, "answering must not disturb the question"
        assert back[0]["responded_at"], back[0]
        assert set(back[0]) == MESSAGE_FIELDS, (inbox.backend, sorted(back[0]))

    def test_an_approved_answer_stays_in_the_default_inbox(self, inbox):
        """The other half of the vocabulary: `approved` + a response stays visible."""
        task_id = "TK-8905-" + uuid.uuid4().hex[:8]
        created = _post_question(inbox, "a", "b", task_id, "approve me?")
        status, _ = _http(inbox.port, "PATCH", f"/api/messages/{created['id']}", {
            "status": "approved", "response": "approved and answered",
            "operator_approved": True,
        })
        assert status == 200
        status, body = _http(inbox.port, "GET", "/api/messages/b")
        assert status == 200, (status, body)
        mine = [m for m in body["messages"] if m["id"] == created["id"]]
        assert len(mine) == 1, (inbox.backend, body)
        assert mine[0]["response"] == "approved and answered"
        assert mine[0]["operator_approved"] is True, (
            "operator_approved must be a JSON bool on both backends, never 0/1"
        )

    def test_the_status_filter_is_validated_not_interpolated(self, inbox):
        """An unknown status is a typed 400 on both backends, never SQL."""
        status, body = _http(
            inbox.port, "GET", "/api/messages/b?status=pending,nonsense")
        assert status == 400, (status, body)
        assert "status must be a comma-separated subset" in body["error"], body
        # A quote-and-comment injection attempt is rejected by the same check,
        # so it never reaches a cursor.
        status, body = _http(
            inbox.port, "GET", "/api/messages/b?status=pending'%3B--")
        assert status == 400, (status, body)
        # An empty filter is the DEFAULT inbox, never "no statuses".
        status, body = _http(inbox.port, "GET", "/api/messages/b?status=")
        assert status == 200, (status, body)

    def test_an_absent_message_id_is_a_404_not_a_500(self, inbox):
        absent = str(uuid.uuid4())
        status, body = _http(inbox.port, "PATCH", f"/api/messages/{absent}", {
            "status": "approved",
        })
        assert status == 404, (inbox.backend, status, body)
        assert body["error"] == "message not found", body


class TestFindingRoundTrip:
    """The findings half of the blackboard, on both backends."""

    def test_a_finding_is_read_transitioned_and_read_back(self, inbox):
        task_id = "TK-8905F-" + uuid.uuid4().hex[:8]
        text = "the four PG_ONLY_FEATURES lists disagreed about A2A"

        created = _post_finding(inbox, "auditor-backend", task_id, text)
        fid = created["id"]
        assert _is_uuid(fid), f"finding id is not a UUID on {inbox.backend}: {fid!r}"
        assert created["created"] is True
        assert created["created_at"], created

        status, body = _http(inbox.port, "GET", f"/api/findings/{task_id}")
        assert status == 200, (status, body)
        assert body["count"] == 1, (inbox.backend, body)
        got = body["findings"][0]
        assert got["id"] == fid
        assert got["agent_name"] == "auditor-backend"
        assert got["task_id"] == task_id
        assert got["finding_type"] == "observation"
        assert got["content"] == text
        assert got["confidence"] == pytest.approx(0.9)
        assert got["created_at"], got
        assert set(got) == FINDING_FIELDS, (
            f"{inbox.backend} returns a different finding field set: "
            f"missing={FINDING_FIELDS - set(got)} extra={set(got) - FINDING_FIELDS}"
        )

        status, patched = _http(inbox.port, "PATCH", f"/api/findings/{fid}", {
            "status": "ticketed", "ticket_id": "TK-TICKET-1",
        })
        assert status == 200, (status, patched)
        assert patched["updated"] is True
        assert patched["id"] == fid
        assert patched["status"] == "ticketed"
        assert patched["ticket_id"] == "TK-TICKET-1"
        assert set(patched) == {"id", "status", "ticket_id", "updated"}, (
            inbox.backend, patched
        )

        # Read back: the sweep is the route that filters by status.
        status, sweep = _http(inbox.port, "GET", "/api/findings?status=ticketed")
        assert status == 200, (status, sweep)
        assert fid in [f["id"] for f in sweep["findings"]], (inbox.backend, sweep)

        # And the per-task read still returns it, with the content untouched.
        status, body = _http(inbox.port, "GET", f"/api/findings/{task_id}")
        assert status == 200, (status, body)
        assert body["findings"][0]["content"] == text

    def test_an_absent_finding_id_is_a_404_not_a_500(self, inbox):
        absent = str(uuid.uuid4())
        status, body = _http(inbox.port, "PATCH", f"/api/findings/{absent}", {
            "status": "fixed",
        })
        assert status == 404, (inbox.backend, status, body)
        assert body["error"] == "finding not found", body


class TestTheArmRunsOnTheBackendItNames:
    """The claim "on both backends" is only worth what /health says it is."""

    def test_health_names_the_backend_the_arm_asked_for(self, inbox):
        health = _assert_backend(inbox)
        if inbox.backend == "postgres":
            assert health.get("pg_available") is True, health
            assert "pg_health" in health, health
            # A PostgreSQL daemon must publish no degraded feature list at all.
            assert "features_off" not in health, health
        else:
            assert "sqlite_health" in health, health
            assert isinstance(health.get("features_off"), list), health


# ═════════════════════════════════════════════════════════════════════════════
# The cross-backend comparison: one test, both daemons, field by field
# ═════════════════════════════════════════════════════════════════════════════


@requires_pg
class TestBothBackendsReturnTheSameShape:
    """Two daemons at once, the same requests, compared field by field.

    The per-arm tests above assert each backend against the contract. This one
    asserts the backends against EACH OTHER, which is what catches a field that
    both arms happen to agree is absent.
    """

    def test_the_same_fields_with_the_same_types_and_values(self, tmp_path, scratch_pg_dsn):
        sq, sq_proc, sq_out, sq_err = _sqlite_daemon(tmp_path)
        pg, pg_proc, pg_out, pg_err = _postgres_daemon(tmp_path, scratch_pg_dsn)
        try:
            _assert_backend(sq)
            _assert_backend(pg)
            task_id = "TK-8905X-" + uuid.uuid4().hex[:8]
            question = "same question, two backends"
            answer = "same answer, two backends"

            shapes = {}
            for daemon in (sq, pg):
                created = _post_question(daemon, "a", "b", task_id, question)
                _http(daemon.port, "PATCH", f"/api/messages/{created['id']}", {
                    "status": "responded", "response": answer,
                })
                _, read = _http(
                    daemon.port, "GET", "/api/messages/b?status=responded")
                message = [m for m in read["messages"] if m["id"] == created["id"]][0]

                finding = _post_finding(daemon, "auditor", task_id, "same finding")
                _, by_task = _http(daemon.port, "GET", f"/api/findings/{task_id}")
                shapes[daemon.backend] = {
                    "created_message": created,
                    "message": message,
                    "created_finding": finding,
                    "finding": by_task["findings"][0],
                }

            a, b = shapes["sqlite"], shapes["postgres"]

            # 1. The same KEYS everywhere.
            for part in ("created_message", "message", "created_finding", "finding"):
                assert set(a[part]) == set(b[part]), (
                    f"{part}: sqlite-only={set(a[part]) - set(b[part])} "
                    f"postgres-only={set(b[part]) - set(a[part])}"
                )

            # 2. The same TYPES everywhere. An id that is a UUID on one backend and
            # an integer on the other breaks every caller that round-trips it.
            for part in ("created_message", "message", "created_finding", "finding"):
                for key in a[part]:
                    if a[part][key] is None or b[part][key] is None:
                        assert (a[part][key] is None) == (b[part][key] is None), (
                            f"{part}.{key}: sqlite={a[part][key]!r} "
                            f"postgres={b[part][key]!r} — one is null, the other is not"
                        )
                        continue
                    assert type(a[part][key]) is type(b[part][key]), (
                        f"{part}.{key}: sqlite is {type(a[part][key]).__name__}, "
                        f"postgres is {type(b[part][key]).__name__}"
                    )

            # 3. The same VALUES for everything that is not minted per row.
            minted = {"id", "created_at", "responded_at", "existing_id"}
            for part in ("created_message", "message", "created_finding", "finding"):
                for key in sorted(set(a[part]) - minted):
                    assert a[part][key] == b[part][key], (
                        f"{part}.{key}: sqlite={a[part][key]!r} postgres={b[part][key]!r}"
                    )

            # 4. The minted fields are present and well-shaped on both.
            for backend, shape in shapes.items():
                assert _is_uuid(shape["message"]["id"]), (backend, shape["message"]["id"])
                assert _is_uuid(shape["finding"]["id"]), (backend, shape["finding"]["id"])
                for stamp in ("created_at", "responded_at"):
                    value = shape["message"][stamp]
                    assert isinstance(value, str) and value, (backend, stamp, value)
                    # Parseable as a timestamp on both, whatever the precision.
                    import datetime as _dt
                    _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
                assert shape["finding"]["created_at"], (backend, shape["finding"])
        finally:
            _stop(pg_proc, pg_out, pg_err)
            _stop(sq_proc, sq_out, sq_err)
