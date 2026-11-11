"""PostgreSQL gets several startup attempts before the daemon falls back to
SQLite; an operator-selected SQLite backend skips PostgreSQL entirely.

Unit-level: the retry loop takes detect/connect/sleep as arguments, so no
database, container or real sleep is involved.
"""
import importlib.util
import os
import tempfile
import unittest
import unittest.mock

import pytest

_DAEMON = os.path.join(os.path.dirname(__file__), "..", "services", "amauta-daemon.py")

PG = {"backend": "postgresql", "connection_url": "postgresql://u:p@127.0.0.1:5433/db",
      "features": [], "message": "pg"}
SQLITE = {"backend": "sqlite", "connection_url": "sqlite:///x.db", "features": [], "message": "sqlite"}


def _load(env=None):
    """Import the daemon module fresh (import never starts a server)."""
    with unittest.mock.patch.dict(os.environ, env or {}, clear=False):
        os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
        spec = importlib.util.spec_from_file_location("amauta_daemon_pgretry", _DAEMON)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


class _Seq:
    """Callable returning/raising queued results; records calls."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = 0

    def __call__(self, *a):
        self.calls += 1
        r = self.results.pop(0) if len(self.results) > 1 else self.results[0]
        if isinstance(r, Exception):
            raise r
        return r


class TestPgStartupRetry(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="amauta-pgretry-")
        self.env = {"GSD_BACKEND": "", "GSD_FORCE_SQLITE": "", "GSD_POSTGRES_URL": "",
                    "DATABASE_URL": "", "GSD_PG_STARTUP_RETRIES": "", "GSD_PG_STARTUP_BACKOFF": ""}
        self.mod = _load(self.env)
        self.mod.DATA_DIR = self.tmp
        self.sleeps = []

    def run_retry(self, detect, connect, env=None):
        with unittest.mock.patch.dict(os.environ, dict(self.env, **(env or {}))):
            return self.mod._connect_postgres_with_retry(detect, connect, sleep=self.sleeps.append)

    def test_connects_first_try_without_sleeping(self):
        store = object()
        infra, got, attempts, err = self.run_retry(_Seq([PG]), _Seq([store]),
                                                   {"GSD_POSTGRES_URL": "postgresql://x"})
        self.assertIs(got, store)
        self.assertEqual((attempts, err, self.sleeps), (1, None, []))

    def test_retries_a_failing_connect_then_succeeds(self):
        store = object()
        connect = _Seq([RuntimeError("connection refused"), RuntimeError("starting up"), store])
        infra, got, attempts, err = self.run_retry(_Seq([PG]), connect,
                                                   {"GSD_POSTGRES_URL": "postgresql://x"})
        self.assertIs(got, store)
        self.assertEqual(attempts, 3)
        self.assertIsNone(err)
        self.assertEqual(self.sleeps, [3.0, 6.0])  # exponential backoff, default base 3s

    def test_retries_when_postgres_is_expected_but_not_yet_detected(self):
        # Reboot case: the container is still starting, detection says sqlite.
        self.mod._write_last_backend("postgresql")
        store = object()
        detect = _Seq([SQLITE, SQLITE, PG])
        infra, got, attempts, err = self.run_retry(detect, _Seq([store]))
        self.assertIs(got, store)
        self.assertEqual(attempts, 3)
        self.assertEqual(infra["backend"], "postgresql")

    def test_gives_up_after_the_configured_attempts_and_reports_why(self):
        connect = _Seq([RuntimeError("connection refused")])
        infra, got, attempts, err = self.run_retry(
            _Seq([PG]), connect, {"GSD_POSTGRES_URL": "postgresql://x", "GSD_PG_STARTUP_RETRIES": "3",
                                  "GSD_PG_STARTUP_BACKOFF": "1"})
        self.assertIsNone(got)
        self.assertEqual(attempts, 3)
        self.assertEqual(connect.calls, 3)
        self.assertIn("connection refused", err)
        self.assertEqual(self.sleeps, [1.0, 2.0])  # no sleep after the last attempt

    def test_a_sqlite_only_machine_does_not_wait(self):
        # No DSN, never ran on PostgreSQL: one attempt, zero delay.
        detect = _Seq([SQLITE])
        infra, got, attempts, err = self.run_retry(detect, _Seq([object()]))
        self.assertIsNone(got)
        self.assertEqual((attempts, detect.calls, self.sleeps), (1, 1, []))
        self.assertEqual(infra["backend"], "sqlite")

    def test_a_detection_crash_is_retried_not_fatal(self):
        store = object()
        detect = _Seq([OSError("docker socket"), PG])
        infra, got, attempts, err = self.run_retry(detect, _Seq([store]),
                                                   {"GSD_POSTGRES_URL": "postgresql://x"})
        self.assertIs(got, store)
        self.assertEqual(attempts, 2)

    def test_bad_env_values_fall_back_to_defaults_and_are_clamped(self):
        with unittest.mock.patch.dict(os.environ, {"GSD_PG_STARTUP_RETRIES": "banana"}):
            self.assertEqual(self.mod._env_int("GSD_PG_STARTUP_RETRIES", 4, 1, 20), 4)
        with unittest.mock.patch.dict(os.environ, {"GSD_PG_STARTUP_RETRIES": "999"}):
            self.assertEqual(self.mod._env_int("GSD_PG_STARTUP_RETRIES", 4, 1, 20), 20)
        with unittest.mock.patch.dict(os.environ, {"GSD_PG_STARTUP_BACKOFF": "-5"}):
            self.assertEqual(self.mod._env_float("GSD_PG_STARTUP_BACKOFF", 3.0, 0.0, 60.0), 0.0)

    def test_last_backend_marker_round_trips(self):
        self.assertEqual(self.mod._read_last_backend(), "")
        self.mod._write_last_backend("postgresql")
        self.assertEqual(self.mod._read_last_backend(), "postgresql")
        with unittest.mock.patch.dict(os.environ, self.env):
            self.assertTrue(self.mod._pg_expected())


# 88-08-04: tests/conftest.py exports GSD_FORCE_SQLITE=1, GSD_BACKEND=sqlite and
# GSD_TEST_MODE=1 for the whole session, and _force_sqlite() answers True for each
# of them, so these tests could not observe their own inputs (the "a fallback written
# later is not a selection" case failed). backend_selection_env clears exactly those
# three names for the test and leaves the socket guard and data-dir scrub in place.
@pytest.mark.usefixtures("backend_selection_env")
class TestOperatorSelectedSqlite(unittest.TestCase):
    def test_gsd_backend_sqlite_at_startup_selects_sqlite(self):
        mod = _load({"GSD_BACKEND": "sqlite", "GSD_FORCE_SQLITE": ""})
        with unittest.mock.patch.dict(os.environ, {"GSD_FORCE_SQLITE": ""}):
            self.assertTrue(mod._force_sqlite())

    def test_a_fallback_written_later_is_not_a_selection(self):
        # The daemon writes GSD_BACKEND=sqlite into its own environment when it
        # falls back; only the value present at startup counts as a choice.
        mod = _load({"GSD_BACKEND": "", "GSD_FORCE_SQLITE": ""})
        with unittest.mock.patch.dict(os.environ, {"GSD_BACKEND": "sqlite", "GSD_FORCE_SQLITE": ""}):
            self.assertFalse(mod._force_sqlite())

    def test_requesting_postgres_makes_it_expected(self):
        mod = _load({"GSD_BACKEND": "postgres", "GSD_FORCE_SQLITE": ""})
        mod.DATA_DIR = tempfile.mkdtemp(prefix="amauta-pgretry-")
        with unittest.mock.patch.dict(os.environ, {"GSD_POSTGRES_URL": "", "DATABASE_URL": ""}):
            self.assertTrue(mod._pg_expected())


if __name__ == "__main__":
    unittest.main()
