#!/usr/bin/env python3
"""End-to-end daemon tests on the SQLite fallback backend.

Starts services/amauta-daemon.py as a subprocess on a free port with a temp
data dir and a temp SQLite file, pinned to SQLite with GSD_FORCE_SQLITE=1 so
infrastructure detection (which probes ports 5432-5434 and will auto-START a
Docker PostgreSQL container) never runs. RLM, Redis and the startup
auto-backup are disabled, so the daemon touches nothing outside its temp dir.

What it proves:
  - Blackboard (/api/findings, /api/messages), step handoffs and agent
    metrics work on SQLite instead of answering 500 with
    "'sqlite3.Cursor' object does not support the context manager protocol".
  - Decimal phase identifiers (72.1) round-trip through /api/steps.
  - PG-only features answer a typed 503 requires_postgres, never a 500.
  - /api/memory/search honors tags/category filters.
  - /api/memory/delete reports a real deletion.
  - /health carries a degraded section while keeping its existing keys.
  - The daemon writes a log file under its data dir.

Run: /opt/homebrew/bin/python3 -m pytest tests/test_sqlite_first_class_daemon.py -v
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DAEMON = os.path.join(_ROOT, "services", "amauta-daemon.py")
_PYTHON = os.environ.get("GSD_TEST_PYTHON", sys.executable)

_STARTUP_TIMEOUT_S = 40.0

# Module-level daemon shared by every test (startup costs a couple of seconds).
_proc = None
_tmp = None
_base = None
_stdout_path = None
_skip_reason = None


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _request(method, path, body=None, timeout=20):
    """Call the test daemon. Returns (status, parsed_json)."""
    req = urllib.request.Request(
        _base + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, (json.loads(raw) if raw else {})


def setUpModule():
    global _proc, _tmp, _base, _stdout_path, _skip_reason

    _tmp = tempfile.mkdtemp(prefix="amauta-sqlite-e2e-")
    data_dir = os.path.join(_tmp, "data")
    os.makedirs(data_dir, exist_ok=True)
    port = _free_port()
    _base = f"http://127.0.0.1:{port}"

    env = dict(os.environ)
    # Nothing may point the daemon at a real database or require a token.
    # DATABASE_URL joined the list in plan 88-16-09: conftest hands the
    # validated disposable DSN to the product's clients under BOTH names, and
    # services/complexity_scorer.py reads DATABASE_URL first — so this file,
    # whose whole subject is "the daemon on SQLite degrades without erroring",
    # found PostgreSQL and stored the row it asserts is not stored.
    for key in ("GSD_POSTGRES_URL", "DATABASE_URL", "AMAUTA_MEMORY_DATABASE_URL",
                "AMAUTA_DAEMON_TOKEN", "GSD_OIDC_ISSUER", "GSD_OIDC_CLIENT_ID"):
        env.pop(key, None)
    env.update({
        "GSD_FORCE_SQLITE": "1",
        "GSD_SQLITE_PATH": os.path.join(_tmp, "gsd_amauta.db"),
        "GSD_DATA_DIR": _tmp,
        "AMAUTA_DATA_DIR": data_dir,
        "GSD_AMAUTA_PORT": str(port),
        "GSD_RLM_ENABLED": "false",
        "GSD_REDIS_ENABLED": "false",
        "AMAUTA_AUTO_BACKUP": "off",
        "GSD_TEST_MODE": "1",
    })

    _stdout_path = os.path.join(_tmp, "daemon-stdout.log")
    with open(_stdout_path, "w", encoding="utf-8") as out:
        _proc = subprocess.Popen(
            [_PYTHON, _DAEMON, "run"],
            cwd=_ROOT, env=env, stdout=out, stderr=subprocess.STDOUT,
        )

    deadline = time.time() + _STARTUP_TIMEOUT_S
    while time.time() < deadline:
        if _proc.poll() is not None:
            _skip_reason = (
                "daemon exited during startup:\n" + open(_stdout_path, encoding="utf-8").read()[-2000:]
            )
            return
        try:
            _request("GET", "/health", timeout=2)
            return
        except Exception:
            time.sleep(0.15)
    _skip_reason = (
        "daemon did not answer /health within %.0fs:\n%s"
        % (_STARTUP_TIMEOUT_S, open(_stdout_path, encoding="utf-8").read()[-2000:])
    )


def tearDownModule():
    global _proc, _tmp
    if _proc is not None and _proc.poll() is None:
        _proc.send_signal(signal.SIGTERM)
        try:
            _proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _proc.kill()
            _proc.wait(timeout=5)
        # The daemon unlinks its PID file on a clean shutdown; if it was
        # killed it cannot, and a stale file would make `status` lie to the
        # next run. PID_FILE lives beside the script, not in the temp dir.
        pid_file = os.path.join(_ROOT, "services", "amauta-daemon.pid")
        try:
            if os.path.exists(pid_file) and int(open(pid_file, encoding="utf-8").read().strip()) == _proc.pid:
                os.unlink(pid_file)
        except Exception:
            pass
    _proc = None
    if _tmp:
        shutil.rmtree(_tmp, ignore_errors=True)
        _tmp = None


class _DaemonCase(unittest.TestCase):

    def setUp(self):
        if _skip_reason:
            self.skipTest(_skip_reason)

    def assertNot500(self, status, payload, what):
        self.assertNotEqual(
            status, 500,
            f"{what} answered 500 on the SQLite backend: {payload}",
        )


# ── Backend selection ────────────────────────────────────────────────────────

class TestBackendIsSQLite(_DaemonCase):

    def test_daemon_runs_on_sqlite(self):
        status, health = _request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(health.get("backend"), "sqlite")
        self.assertFalse(health.get("pg_available"))


# ── Blackboard: findings ─────────────────────────────────────────────────────

class TestFindingsEndpoints(_DaemonCase):

    def test_post_and_get_findings_for_a_task(self):
        status, created = _request("POST", "/api/findings", {
            "agent_name": "gsd-planner", "finding_type": "observation",
            "content": "blackboard works", "task_id": "TK-7001",
        })
        self.assertNot500(status, created, "POST /api/findings")
        self.assertEqual(status, 201, created)
        self.assertTrue(created.get("created"))

        status, body = _request("GET", "/api/findings/TK-7001")
        self.assertNot500(status, body, "GET /api/findings/:task_id")
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["findings"][0]["content"], "blackboard works")
        self.assertEqual(body["findings"][0]["id"], created["id"])

    def test_sweep_filters_and_status_transition(self):
        _request("POST", "/api/findings", {
            "agent_name": "gsd-auditor-backend", "finding_type": "audit",
            "content": "missing timeout", "severity": "warning",
            "domain": "api-connections", "rule_id": "API-01",
            "file_path": "services/sweep_target.py",
        })
        status, sweep = _request("GET", "/api/findings?status=open&domain=api-connections")
        self.assertNot500(status, sweep, "GET /api/findings sweep")
        self.assertEqual(status, 200)
        self.assertEqual(sweep["count"], 1, sweep)
        finding = sweep["findings"][0]
        self.assertEqual(finding["severity"], "warning")
        self.assertEqual(finding["rule_id"], "API-01")

        status, patched = _request("PATCH", "/api/findings/" + finding["id"],
                                   {"status": "ticketed", "ticket_id": "TK-7002"})
        self.assertNot500(status, patched, "PATCH /api/findings/:id")
        self.assertEqual(status, 200)
        self.assertEqual(patched["status"], "ticketed")
        self.assertEqual(patched["ticket_id"], "TK-7002")

        _, after = _request("GET", "/api/findings?status=open&domain=api-connections")
        self.assertEqual(after["count"], 0, "the ticketed finding must leave the open sweep")

    def test_dedup_is_enforced_server_side(self):
        payload = {
            "agent_name": "gsd-auditor-infra", "finding_type": "audit",
            "content": "unpinned image", "rule_id": "INF-02",
            "file_path": "docker/Dockerfile.dedup-test",
        }
        status, first = _request("POST", "/api/findings", payload)
        self.assertEqual(status, 201, first)
        status, second = _request("POST", "/api/findings", payload)
        self.assertEqual(status, 200, second)
        self.assertTrue(second.get("deduped"), second)
        self.assertFalse(second.get("created"))
        self.assertEqual(second["existing_id"], first["id"])

    def test_patch_unknown_finding_is_404(self):
        status, body = _request("PATCH", "/api/findings/00000000-0000-0000-0000-000000000000",
                                {"status": "fixed"})
        self.assertNot500(status, body, "PATCH unknown finding")
        self.assertEqual(status, 404, body)


# ── Blackboard: messages ─────────────────────────────────────────────────────

class TestMessagesEndpoints(_DaemonCase):

    def test_send_read_and_respond(self):
        status, created = _request("POST", "/api/messages", {
            "from_agent": "gsd-executor-backend", "to_agent": "gsd-reviewer-mailbox",
            "task_id": "TK-7010", "message_type": "ASK_QUESTION", "content": "approve?",
        })
        self.assertNot500(status, created, "POST /api/messages")
        self.assertEqual(status, 201, created)
        self.assertEqual(created["status"], "pending")
        self.assertIs(created["operator_approved"], False)

        status, inbox = _request("GET", "/api/messages/gsd-reviewer-mailbox")
        self.assertNot500(status, inbox, "GET /api/messages/:agent")
        self.assertEqual(status, 200)
        self.assertEqual(inbox["count"], 1)
        self.assertEqual(inbox["messages"][0]["content"], "approve?")

        status, patched = _request("PATCH", "/api/messages/" + created["id"],
                                   {"status": "responded", "response": "yes"})
        self.assertNot500(status, patched, "PATCH /api/messages/:id")
        self.assertEqual(status, 200)
        self.assertEqual(patched["status"], "responded")
        self.assertIsNotNone(patched["responded_at"])

        _, inbox_after = _request("GET", "/api/messages/gsd-reviewer-mailbox")
        self.assertEqual(inbox_after["count"], 0)

    def test_auto_approved_type_is_approved_on_arrival(self):
        status, created = _request("POST", "/api/messages", {
            "from_agent": "a", "to_agent": "auto-approve-mailbox", "task_id": "TK-7011",
            "message_type": "SHARE_FINDING", "content": "fyi",
        })
        self.assertEqual(status, 201, created)
        self.assertEqual(created["status"], "approved")
        self.assertIs(created["operator_approved"], True)
        _, inbox = _request("GET", "/api/messages/auto-approve-mailbox")
        self.assertIs(inbox["messages"][0]["operator_approved"], True)

    def test_patch_unknown_message_is_404(self):
        status, body = _request("PATCH", "/api/messages/00000000-0000-0000-0000-000000000000",
                                {"status": "approved"})
        self.assertNot500(status, body, "PATCH unknown message")
        self.assertEqual(status, 404, body)


# ── Agent metrics ────────────────────────────────────────────────────────────

class TestMetricsEndpoints(_DaemonCase):

    def test_record_and_aggregate(self):
        status, created = _request("POST", "/api/metrics", {
            "agent_name": "metrics-probe", "task_id": "TK-7020", "outcome": "pass",
            "completion_time_ms": 1200, "token_usage": 800,
        })
        self.assertNot500(status, created, "POST /api/metrics")
        self.assertEqual(status, 201, created)

        status, stats = _request("GET", "/api/metrics/stats")
        self.assertNot500(status, stats, "GET /api/metrics/stats")
        self.assertEqual(status, 200)
        probe = next((s for s in stats["stats"] if s["agent_name"] == "metrics-probe"), None)
        self.assertIsNotNone(probe, stats)
        self.assertEqual(probe["tasks_completed"], 1)
        self.assertEqual(probe["avg_time_ms"], 1200)
        self.assertAlmostEqual(probe["pass_rate"], 1.0)


# ── Step handoffs ────────────────────────────────────────────────────────────

class TestStepHandoffEndpoints(_DaemonCase):

    def test_whole_phase_round_trip(self):
        status, created = _request("POST", "/api/steps/execute-phase/41/handoff", {
            "step_id": "executor", "task_id": "TK-7030",
            "context_snapshot": {"complexity_score": 7}, "completed_steps": ["plan"],
            "next_step": "validate",
        })
        self.assertNot500(status, created, "POST /api/steps/:wf/:phase/handoff")
        self.assertEqual(status, 201, created)

        status, row = _request("GET", "/api/steps/execute-phase/41")
        self.assertNot500(status, row, "GET /api/steps/:wf/:phase")
        self.assertEqual(status, 200)
        self.assertEqual(row["step_id"], "executor")
        self.assertEqual(row["phase_number"], 41)
        self.assertEqual(row["context_snapshot"], {"complexity_score": 7})
        self.assertEqual(row["completed_steps"], ["plan"])
        self.assertEqual(row["next_step"], "validate")

    def test_decimal_phase_round_trip(self):
        """A /amauta:insert-phase phase (72.1) used to be rejected with 400."""
        status, created = _request("POST", "/api/steps/execute-phase/72.1/handoff", {
            "step_id": "inserted", "task_id": "TK-7031", "context_snapshot": {"k": "v"},
        })
        self.assertNotEqual(status, 400, f"decimal phase rejected: {created}")
        self.assertEqual(status, 201, created)

        status, row = _request("GET", "/api/steps/execute-phase/72.1")
        self.assertEqual(status, 200, row)
        self.assertEqual(row["step_id"], "inserted")
        self.assertEqual(row["phase_number"], 72.1)

    def test_decimal_phase_does_not_collide_with_its_whole_phase(self):
        _request("POST", "/api/steps/collide/72/handoff",
                 {"step_id": "whole", "context_snapshot": {}})
        _request("POST", "/api/steps/collide/72.1/handoff",
                 {"step_id": "decimal", "context_snapshot": {}})
        _, whole = _request("GET", "/api/steps/collide/72")
        _, decimal = _request("GET", "/api/steps/collide/72.1")
        self.assertEqual(whole["step_id"], "whole")
        self.assertEqual(decimal["step_id"], "decimal")

    def test_latest_handoff_wins(self):
        _request("POST", "/api/steps/latest-wins/3/handoff",
                 {"step_id": "first", "context_snapshot": {"n": 1}})
        _request("POST", "/api/steps/latest-wins/3/handoff",
                 {"step_id": "second", "context_snapshot": {"n": 2}})
        _, row = _request("GET", "/api/steps/latest-wins/3")
        self.assertEqual(row["step_id"], "second")

    def test_missing_handoff_is_a_200_with_a_null_step(self):
        status, row = _request("GET", "/api/steps/execute-phase/9999")
        self.assertEqual(status, 200, row)
        self.assertIsNone(row["step_id"])

    def test_non_numeric_phase_is_400(self):
        status, body = _request("GET", "/api/steps/execute-phase/not-a-phase")
        self.assertEqual(status, 400, body)
        self.assertIn("error", body)


# ── PG-only features ─────────────────────────────────────────────────────────

class TestPGOnlyFeaturesAreTyped(_DaemonCase):

    def test_a2a_exchanges_is_a_typed_503(self):
        status, body = _request("GET", "/a2a/exchanges")
        self.assertNot500(status, body, "GET /a2a/exchanges")
        self.assertEqual(status, 503, body)
        self.assertEqual(body.get("error"), "requires_postgres")
        self.assertEqual(body.get("feature"), "a2a")
        self.assertTrue(body.get("detail"), "a typed refusal must say what to do")

    def test_semantic_cache_degrades_without_erroring(self):
        status, body = _request("POST", "/api/semantic-cache/search", {"query": "anything"})
        self.assertNot500(status, body, "POST /api/semantic-cache/search")
        self.assertEqual(status, 200, body)
        self.assertIs(body.get("hit"), False)

    def test_skill_invocation_degrades_without_erroring(self):
        status, body = _request("POST", "/api/skills/invoke",
                                {"skill_name": "probe", "prompt": "p"})
        self.assertNot500(status, body, "POST /api/skills/invoke")

    def test_task_completion_degrades_without_erroring(self):
        status, body = _request("POST", "/api/complexity/complete", {
            "task_id": "TK-7040", "phase_number": 1, "outcome_label": "validator_pass",
        })
        self.assertNot500(status, body, "POST /api/complexity/complete")
        self.assertIs(body.get("stored"), False)


# ── Memory ───────────────────────────────────────────────────────────────────

class TestMemoryEndpoints(_DaemonCase):

    def test_search_honors_tag_and_category_filters(self):
        status, stored = _request("POST", "/api/memory/store", {
            "text": "zarzaparrilla filterable memory row",
            "source": "lesson-learned", "tags": ["postgresql"],
            "metadata": {"category": "pattern"},
        })
        self.assertNot500(status, stored, "POST /api/memory/store")
        self.assertTrue(stored.get("stored"), stored)

        status, hit = _request("POST", "/api/memory/search",
                               {"query": "zarzaparrilla", "tags": ["postgresql"]})
        self.assertNot500(status, hit, "POST /api/memory/search?tags")
        self.assertEqual(status, 200)
        self.assertEqual(hit["count"], 1, hit)

        status, miss = _request("POST", "/api/memory/search",
                                {"query": "zarzaparrilla", "tags": ["no-such-tag"]})
        self.assertEqual(status, 200, miss)
        self.assertEqual(miss["count"], 0, miss)

        status, by_cat = _request("POST", "/api/memory/search",
                                  {"query": "zarzaparrilla", "category": "pattern"})
        self.assertEqual(status, 200, by_cat)
        self.assertEqual(by_cat["count"], 1, by_cat)

        status, wrong_cat = _request("POST", "/api/memory/search",
                                     {"query": "zarzaparrilla", "category": "workflow"})
        self.assertEqual(wrong_cat["count"], 0, wrong_cat)

    def test_delete_reports_whether_a_row_went_away(self):
        _, stored = _request("POST", "/api/memory/store",
                             {"text": "delete me please", "source": "lesson-learned"})
        mem_id = stored["id"]
        status, deleted = _request("POST", "/api/memory/delete", {"id": mem_id})
        self.assertEqual(status, 200, deleted)
        self.assertIs(deleted["deleted"], True)

        status, again = _request("POST", "/api/memory/delete", {"id": mem_id})
        self.assertEqual(status, 200, again)
        self.assertIs(again["deleted"], False,
                      "deleting a row that is already gone must not report success")

    def test_delete_of_an_unknown_id_reports_false(self):
        _, body = _request("POST", "/api/memory/delete", {"id": "mem-never-existed"})
        self.assertIs(body["deleted"], False, body)


# ── /health ──────────────────────────────────────────────────────────────────

class TestHealthDegradedSection(_DaemonCase):

    def test_degraded_section_is_present_and_specific(self):
        status, health = _request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertIs(health.get("degraded"), True)
        features_off = health.get("features_off")
        self.assertIsInstance(features_off, list)
        for feature in ("vector_search", "rlm_index", "semantic_cache", "a2a", "party_sessions"):
            self.assertIn(feature, features_off, health)

    def test_degraded_counts_are_real(self):
        _request("POST", "/api/memory/store",
                 {"text": "counted row for health", "source": "lesson-learned"})
        _, health = _request("GET", "/health")
        counts = health.get("degraded_counts")
        self.assertIsInstance(counts, dict, health)
        self.assertGreaterEqual(counts.get("memory_rows", -1), 1, counts)
        self.assertEqual(counts.get("memory_rows_with_embeddings"), 0)
        self.assertEqual(counts.get("rlm_chunks"), 0)

    def test_existing_health_keys_are_untouched(self):
        """Additive change: current consumers must not break."""
        _, health = _request("GET", "/health")
        for key in ("status", "daemon", "port", "data_dir", "amauta_py", "pid",
                    "pg_available", "pg_configured", "backend", "features",
                    "rlm_managed", "rlm_running", "redis_managed", "redis_running",
                    "api_keys", "oidc_enabled", "pipeline_status", "service_errors",
                    "cache_metrics", "sqlite_health"):
            self.assertIn(key, health, f"/health lost the pre-existing key {key!r}")


# ── Log file ─────────────────────────────────────────────────────────────────

class TestDaemonLogFile(_DaemonCase):

    def test_daemon_writes_a_log_file_under_its_data_dir(self):
        log_path = os.path.join(_tmp, "data", "amauta-daemon.log")
        self.assertTrue(os.path.exists(log_path),
                        "the daemon must leave a log behind — both spawners discard stderr")
        self.assertGreater(os.path.getsize(log_path), 0)
        self.assertIn("daemon_started", open(log_path, encoding="utf-8").read())


def _load_daemon_module():
    """Import amauta-daemon.py as a module (hyphenated filename).

    Module import does not start a server — start_server() only runs under
    __main__ — so this is safe in-process.
    """
    import importlib.util
    os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
    spec = importlib.util.spec_from_file_location("amauta_daemon_unit", _DAEMON)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakePGStore:
    """Stands in for PGStore: anything whose class is not SQLiteStore."""


class _FakeSQLiteStore:
    """Stands in for SQLiteStore — _is_sqlite matches on the class name."""


_FakeSQLiteStore.__name__ = "SQLiteStore"


class TestPhaseParsingAgainstEachBackend(unittest.TestCase):
    """_parse_phase_arg is the one place that decides what a phase string means.

    The PostgreSQL branch cannot be exercised end-to-end here (no database),
    so it is tested directly with a stand-in store.
    """

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_daemon_module()

    def test_sqlite_accepts_a_decimal_phase(self):
        value, err = self.mod._parse_phase_arg("72.1", _FakeSQLiteStore())
        self.assertIsNone(err, err)
        self.assertEqual(value, 72.1)

    def test_postgres_accepts_a_decimal_phase_too(self):
        """CONVERTED by plan 89-02 (FND-11).

        This case used to assert the HTTP 400 that named the PostgreSQL column type,
        because `step_handoffs.phase_number` was INTEGER on PostgreSQL (migration 017)
        and truncating 72.1 to 72 would have filed a handoff under the wrong phase.
        Migration 031 retyped the column to NUMERIC(10,3), so the refusal is gone with
        its cause and the PostgreSQL branch now answers exactly as the SQLite one does.
        The test is converted rather than deleted: the behaviour it guards —
        "a decimal phase is not truncated" — still matters, it is just satisfied by
        acceptance now instead of by refusal.
        """
        value, err = self.mod._parse_phase_arg("72.1", _FakePGStore())
        self.assertIsNone(err, err)
        self.assertEqual(value, 72.1)
        self.assertIsInstance(value, float)

    def test_the_two_backends_parse_a_decimal_phase_identically(self):
        """One parser, one answer — the point of removing the backend branch."""
        for raw in ("72", "72.0", "72.1", "7.25"):
            sqlite_value, sqlite_err = self.mod._parse_phase_arg(raw, _FakeSQLiteStore())
            pg_value, pg_err = self.mod._parse_phase_arg(raw, _FakePGStore())
            self.assertIsNone(sqlite_err, sqlite_err)
            self.assertIsNone(pg_err, pg_err)
            self.assertEqual(sqlite_value, pg_value, raw)
            self.assertIs(type(sqlite_value), type(pg_value), raw)

    def test_a_decimal_phase_binds_as_numeric_not_as_a_float(self):
        """`_pg_phase` is what keeps `= 72.1` an exact comparison on NUMERIC(10,3)."""
        from decimal import Decimal

        self.assertEqual(self.mod._pg_phase(72.1), Decimal("72.1"))
        self.assertIsInstance(self.mod._pg_phase(72.1), Decimal)
        self.assertEqual(self.mod._pg_phase(72), Decimal("72"))
        self.assertIsNone(self.mod._pg_phase(None))

    def test_a_phase_read_back_has_the_same_shape_on_both_backends(self):
        """`_phase_out` hides psycopg2's Decimal so one route has one JSON type."""
        from decimal import Decimal

        self.assertEqual(self.mod._phase_out(Decimal("72.000")), 72)
        self.assertIsInstance(self.mod._phase_out(Decimal("72.000")), int)
        self.assertEqual(self.mod._phase_out(Decimal("72.100")), 72.1)
        self.assertEqual(self.mod._phase_out("72.1"), 72.1)
        self.assertIsNone(self.mod._phase_out(None))

    def test_whole_phases_pass_on_both_backends(self):
        for store in (_FakeSQLiteStore(), _FakePGStore()):
            value, err = self.mod._parse_phase_arg("72", store)
            self.assertIsNone(err, err)
            self.assertEqual(value, 72)
            self.assertIsInstance(value, int)

    def test_garbage_is_a_400_on_both_backends(self):
        for store in (_FakeSQLiteStore(), _FakePGStore()):
            value, err = self.mod._parse_phase_arg("seventy-two", store)
            self.assertIsNone(value)
            self.assertEqual(err[1], 400)

    def test_is_sqlite_distinguishes_the_backends(self):
        self.assertTrue(self.mod._is_sqlite(_FakeSQLiteStore()))
        self.assertFalse(self.mod._is_sqlite(_FakePGStore()))
        self.assertFalse(self.mod._is_sqlite(None))

    def test_requires_postgres_payload_is_typed_and_explains_itself(self):
        payload = self.mod._requires_postgres_payload("a2a")
        self.assertEqual(payload["error"], "requires_postgres")
        self.assertEqual(payload["feature"], "a2a")
        self.assertEqual(payload["backend"], "sqlite")
        self.assertTrue(payload["detail"])
        # An unlisted feature still gets a usable sentence, not a KeyError.
        self.assertIn("unlisted", self.mod._requires_postgres_payload("unlisted")["detail"])

    @pytest.mark.usefixtures("backend_selection_env")
    def test_force_sqlite_reads_the_env_flag(self):
        # _force_sqlite() changed in ee1af14 (88-01) to answer True under GSD_TEST_MODE.
        # The hermetic scrub (tests/conftest.py) exports GSD_BACKEND=sqlite, GSD_FORCE_SQLITE=1
        # and GSD_TEST_MODE=1, and _force_sqlite() is True for each (test mode since 88-01,
        # GSD_BACKEND captured at import as _REQUESTED_BACKEND). The class-level module was
        # imported under that scrub, so it cannot show the "unset => False" rows. Load a
        # fresh module while backend_selection_env has cleared the three names, then drive
        # GSD_FORCE_SQLITE alone. Only the three backend-selection names are cleared; the
        # socket guard and the data-dir isolation stay in force.
        mod = _load_daemon_module()
        for raw, expected in (("1", True), ("true", True), ("on", True),
                              ("", False), ("0", False), ("no", False)):
            with unittest.mock.patch.dict(os.environ, {"GSD_FORCE_SQLITE": raw}):
                self.assertIs(mod._force_sqlite(), expected, raw)


class TestLogRotationIsBounded(unittest.TestCase):
    """The file handler rotates, so an unattended daemon cannot fill the disk."""

    def test_handler_rotates_at_the_configured_size(self):
        import importlib.util
        import logging

        tmp = tempfile.mkdtemp(prefix="amauta-logrot-")
        try:
            spec = importlib.util.spec_from_file_location("amauta_daemon_logtest", _DAEMON)
            # Importing the daemon module must not start a server: it only does
            # that under __main__.
            os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)

            log_path = os.path.join(tmp, "rotate.log")
            handler = mod._attach_log_file(log_path, max_bytes=2048, backups=2)
            self.assertIsNotNone(handler, "file handler must attach")
            try:
                logger = logging.getLogger("amauta.daemon.rotationtest")
                for i in range(400):
                    logger.warning("padding line %d %s", i, "x" * 80)
                handler.flush()
                self.assertTrue(os.path.exists(log_path + ".1"),
                                "no rotation happened — the log is unbounded")
                self.assertLessEqual(os.path.getsize(log_path), 4096)
                self.assertFalse(os.path.exists(log_path + ".3"),
                                 "backupCount must cap the number of rotated files")
            finally:
                logging.getLogger().removeHandler(handler)
                handler.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
