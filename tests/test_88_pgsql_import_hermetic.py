"""Plan 88-08-04: the PGSQL-bucket test modules are hermetic at import and the Postgres opt-in is explicit.

Always runs (no database, no container). Two guarantees:

1. Importing every PGSQL-bucket module with the socket guard active raises no
   ``RuntimeError``: none of them opens a connection to the live Postgres port
   (5433) while pytest is merely collecting.
2. ``postgres_dsn`` skips with the reason ``no disposable Postgres`` unless
   ``GSD_TEST_POSTGRES_URL`` is set, and it never falls back to
   ``GSD_POSTGRES_URL`` (the operator's live DSN, which conftest deletes).
"""
import importlib.util
import os
import socket
import sys
from pathlib import Path

import pytest

_TESTS = Path(__file__).resolve().parent

PGSQL_MODULES = (
    "test_pg_integration.py",
    "test_pg_startup_retry.py",
    "test_pg_substrate.py",
)


def _conftest():
    """Return the loaded tests/conftest.py module object.

    Returns:
        The conftest module registered by pytest.
    """
    for name in ("conftest", "tests.conftest"):
        if name in sys.modules:
            return sys.modules[name]
    pytest.fail("tests/conftest.py is not loaded")


def test_the_guard_is_active_for_this_check():
    """Without the guard the import test below would prove nothing."""
    assert getattr(socket.socket.connect, "_gsd_hermetic", False) is True


@pytest.mark.parametrize("filename", PGSQL_MODULES)
def test_pgsql_module_imports_without_touching_a_live_port(filename):
    path = _TESTS / filename
    assert path.is_file(), path
    spec = importlib.util.spec_from_file_location("_88_08_import_probe_" + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except RuntimeError as exc:
        assert "HERMETIC GUARD" not in str(exc), "%s connected to a live port at import: %s" % (filename, exc)
        raise


def test_postgres_dsn_skips_without_the_test_variable(monkeypatch):
    monkeypatch.delenv("GSD_TEST_POSTGRES_URL", raising=False)
    # The live variable must not be consulted even when it is present.
    live_port = sorted(_conftest()._LIVE_PORTS)[0]  # 5433, the operator's PostgreSQL
    monkeypatch.setenv(
        "GSD_POSTGRES_URL", "postgresql://live:live@127.0.0.1:%d/live" % live_port
    )
    with pytest.raises(pytest.skip.Exception) as exc:
        _conftest()._postgres_dsn_or_skip()
    assert "no disposable Postgres" in str(exc.value)
    assert "GSD_TEST_POSTGRES_URL" in str(exc.value)


def test_postgres_dsn_returns_the_test_variable_when_set(monkeypatch):
    monkeypatch.setenv("GSD_TEST_POSTGRES_URL", "postgresql://t:t@127.0.0.1:55432/t")
    assert _conftest()._postgres_dsn_or_skip() == "postgresql://t:t@127.0.0.1:55432/t"


def test_the_only_dsn_in_the_environment_is_one_conftest_validated():
    """The scrub's guarantee, as plan 88-16-09 sharpened it.

    Before: ``GSD_POSTGRES_URL`` was deleted outright, so no test could inherit
    the operator's live DSN. That also meant no test could reach a DISPOSABLE
    one either — `services/pg_store.py` and the party modules read that name
    and nothing else — which is why roughly sixty Postgres tests skipped in CI
    even once CI had a database.

    After: the name is present only when ``GSD_TEST_POSTGRES_URL`` supplied a
    DSN that `tests/conftest.py` CHECKED against the live service ports at
    import, refusing outright if it named one. The property is strictly
    stronger than "the variable is absent": absent OR validated, never
    inherited.
    """
    import conftest as _c

    present = os.environ.get("GSD_POSTGRES_URL")
    if present is None:
        assert _c.postgres_dsn_or_none() is None, (
            "no DSN in the environment, but a disposable one is configured"
        )
        return
    assert present == _c.postgres_dsn_or_none(), (
        "GSD_POSTGRES_URL is set to something other than the validated disposable DSN"
    )
    port = _c._port_of_dsn(present)
    assert port not in _c._LIVE_PORTS, (
        "the DSN in the environment names live service port %r" % (port,)
    )
