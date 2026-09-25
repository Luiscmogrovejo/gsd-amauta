"""
tests/test_pg_pool_closed.py — a closed pool reconnects, and /health cannot call it healthy.

2026-09-25: the daemon ran eight days on a psycopg2 pool left closed by a failed
reconnect. `_get_conn` caught OperationalError/InterfaceError but not PoolError
("connection pool is closed"), so it never rebuilt the pool; /health reported
pg_health.status=error beside pipeline_status=healthy. Both halves are pinned here.
"""

import importlib.util
import os
import sys

import pytest

psycopg2 = pytest.importorskip("psycopg2")
import psycopg2.pool  # noqa: E402

_SERVICES = os.path.join(os.path.dirname(__file__), "..", "services")
sys.path.insert(0, _SERVICES)
import pg_store  # noqa: E402


class _Cursor:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a):
        pass


class _Conn:
    autocommit = True

    def cursor(self):
        return _Cursor()

    def commit(self):
        pass

    def rollback(self):
        pass


class _ClosedPool:
    def getconn(self):
        raise psycopg2.pool.PoolError("connection pool is closed")

    def putconn(self, *a, **k):
        pass

    def closeall(self):
        pass


class _OpenPool(_ClosedPool):
    def getconn(self):
        return _Conn()


def _store_on_closed_pool(monkeypatch):
    store = object.__new__(pg_store.PGStore)
    import threading
    store._lock = threading.Lock()
    store.min_conn, store.max_conn, store.dsn = 1, 2, "postgresql://unused@127.0.0.1:1/x"
    store._pool = _ClosedPool()
    monkeypatch.setattr(pg_store, "ThreadedConnectionPool", lambda *a, **k: _OpenPool())
    return store


def test_closed_pool_is_rebuilt_on_next_query(monkeypatch):
    store = _store_on_closed_pool(monkeypatch)
    assert store.health()["status"] == "ok"
    assert isinstance(store._pool, _OpenPool)


def _daemon():
    spec = importlib.util.spec_from_file_location(
        "amauta_daemon_under_test", os.path.join(_SERVICES, "amauta-daemon.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_failed_pg_probe_is_a_service_error():
    d = _daemon()
    assert d._pg_health_error({"status": "ok", "dsn_host": "h"}) is None
    assert d._pg_health_error(None) is None
    err = d._pg_health_error({"status": "error", "error": "connection pool is closed"})
    assert err and "connection pool is closed" in err
