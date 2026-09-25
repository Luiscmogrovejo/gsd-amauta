#!/usr/bin/env python3
"""TK-2386: /health must PROBE PostgreSQL, not assert it.

Measured 2026-09-13, the twelfth false green: the daemon's GET /health returned
``pg_available=true`` with 5433 CLOSED (the gsd-postgres container stopped) and
``pg_available=true`` again with 5433 OPEN. The same value in both states,
because the field was ``_pg_store is not None`` -- whether an object had been
constructed at process start -- and never looked at the database.

Downstream, every consumer reads it as liveness:
    amauta.py:3739                  "available": daemon.get("pg_available")
    get-shit-done/bin/gsd-research.cjs   detail: 'PG connected'
    get-shit-done/bin/gsd-amauta.cjs     PostgreSQL: ok
and ``gsd-memory health`` printed "PG: connected" at exit 0 while every
/api/memory/* route answered 500 "connection pool is closed".

The daemon starts servers at import, so (following this repo's existing daemon
test idiom) the module is never imported. Unlike the ``_resolve_project_id``
tests in tests/test_daemon_integration.py -- which REIMPLEMENT the logic inside
the test and therefore cannot fail when the daemon changes -- this file
AST-extracts ``_probe_store`` from the daemon source and executes the DAEMON's
OWN function.

Run: python3 -m pytest tests/test_86_health_probes_pg.py -v
"""
import ast
import os
import sys
import unittest
from pathlib import Path

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

DAEMON_PATH = Path(__file__).parent.parent / "services" / "amauta-daemon.py"
DAEMON_SOURCE = DAEMON_PATH.read_text()


def _extract_function(source: str, name: str):
    """Compile one top-level function out of the daemon source and return it.

    Args:
        source: full daemon source text.
        name: top-level function name to extract.

    Returns:
        The callable, executed in an isolated namespace.

    Raises:
        AssertionError: if the function is not present at module level.
    """
    tree = ast.parse(source)
    node = next(
        (n for n in tree.body
         if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name),
        None,
    )
    assert node is not None, f"{name} is not a module-level function in the daemon"
    ns = {
        # _probe_store's only dependency.
        "_safe_error": lambda e: f"sanitized: {type(e).__name__}",
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), "<daemon>", "exec"), ns)
    return ns[name]


_probe_store = _extract_function(DAEMON_SOURCE, "_probe_store")


class _Store:
    """Minimal stand-in for PGStore / SQLiteStore."""

    def __init__(self, result=None, raises=None):
        self._result = result
        self._raises = raises
        self.calls = 0

    def health(self):
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return self._result


class TestProbeStoreIsAProbe(unittest.TestCase):
    """_probe_store must call health(), not merely observe that a store exists."""

    def test_a_constructed_but_dead_store_is_not_live(self):
        """The measured case: the object exists, the pool is closed."""
        # The exact payload GET /health carried on 2026-09-13.
        store = _Store({"status": "error", "error": "connection pool is closed"})
        probe, live = _probe_store(store)
        self.assertEqual(store.calls, 1, "the store must actually be probed")
        self.assertFalse(
            live,
            "a store object that cannot answer SELECT 1 must not report as live -- "
            "this is the twelfth false green",
        )
        self.assertEqual(probe.get("error"), "connection pool is closed",
                         "the probe's own error must be passed through, not swallowed")

    def test_a_healthy_store_is_live(self):
        store = _Store({"status": "ok", "dsn_host": "127.0.0.1:5433/gsd_amauta"})
        probe, live = _probe_store(store)
        self.assertEqual(store.calls, 1)
        self.assertTrue(live, "a store answering SELECT 1 must report as live")
        self.assertEqual(probe["dsn_host"], "127.0.0.1:5433/gsd_amauta")

    def test_no_store_is_not_live(self):
        probe, live = _probe_store(None)
        self.assertIsNone(probe)
        self.assertFalse(live)

    def test_a_raising_probe_is_evidence_against_liveness(self):
        """An exception from the probe must never read as healthy."""
        store = _Store(raises=RuntimeError("pool exhausted"))
        probe, live = _probe_store(store)
        self.assertFalse(live)
        self.assertEqual(probe["status"], "error")
        self.assertNotIn("pool exhausted", str(probe),
                         "the raw exception must be sanitized before it reaches a caller")

    def test_a_non_dict_probe_result_is_not_live(self):
        """A store returning something unexpected must not default to healthy."""
        for bogus in (None, True, "ok", []):
            with self.subTest(bogus=bogus):
                _, live = _probe_store(_Store(bogus))
                self.assertFalse(live, f"{bogus!r} must not read as live")


class TestHealthPayloadDerivation(unittest.TestCase):
    """Regression pins on the exact constants that produced the false green."""

    def test_pg_available_is_not_derived_from_object_existence(self):
        self.assertNotIn(
            '"pg_available": _pg_store is not None',
            DAEMON_SOURCE,
            "pg_available must come from the probe, not from 'a store object exists'",
        )
        self.assertIn(
            '"pg_available": _pg_live',
            DAEMON_SOURCE,
            "pg_available must be the probe-backed flag",
        )

    def test_configured_and_live_are_reported_separately(self):
        self.assertIn(
            '"pg_configured": _pg_store is not None',
            DAEMON_SOURCE,
            "the configured-backend fact is still worth reporting -- under its own "
            "name, where it cannot be mistaken for liveness",
        )

    def test_critical_down_means_no_usable_store(self):
        self.assertNotIn(
            "critical_down = _pg_store is None and _sqlite_store is None",
            DAEMON_SOURCE,
            "a store that cannot answer must count as down when computing "
            "pipeline_status -- with the pool closed, pipeline_status read "
            "'healthy' and service_errors was empty",
        )
        self.assertIn(
            "critical_down = not _pg_live and not _sqlite_live",
            DAEMON_SOURCE,
        )

    def test_a_dead_store_raises_a_service_error(self):
        self.assertIn(
            "PostgreSQL: configured but not responding",
            DAEMON_SOURCE,
            "a present-but-dead store must appear in service_errors; previously "
            "only a MISSING store did",
        )

    def test_the_probe_is_run_once_and_reused(self):
        """No extra round trip: pg_health reuses the hoisted probe."""
        self.assertIn('health["pg_health"] = _pg_probe', DAEMON_SOURCE)
        self.assertNotIn('health["pg_health"] = _pg_store.health()', DAEMON_SOURCE)


if __name__ == "__main__":
    unittest.main()
