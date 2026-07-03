#!/usr/bin/env python3
"""Tests for the Phase 65 / RETR-05 dependency graph wiring
(services/rlm_graph.py edge resolution + reverse-pass dependents, and
services/rlm-service.py's _rebuild_graph_safe guard).

Skips the whole module if networkx is not installed (rlm_graph.py's own
HAS_NETWORKX guard makes the graph functions no-ops without it).

Run: python3 -m pytest tests/test_65_graph_wiring.py -v
"""
import importlib.util
import os

import pytest

networkx = pytest.importorskip("networkx")

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

from services import rlm_graph  # noqa: E402


class _FakeCursor:
    """Cursor context manager over a shared FakePgConn -- records executed
    SQL+params on the connection, returns canned rows for fetchall()."""

    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        if self._conn.raise_on_execute:
            raise RuntimeError("simulated PG failure")
        self._conn.executed.append((query, params))

    def fetchall(self):
        return self._conn.rows


class FakePgConn:
    """Fake psycopg2-like connection: cursor() returns canned SELECT rows
    and records every executed statement; commit()/rollback() are counted."""

    def __init__(self, rows=None, raise_on_execute=False):
        self.rows = rows or []
        self.raise_on_execute = raise_on_execute
        self.executed = []
        self.commit_calls = 0
        self.rollback_calls = 0

    def cursor(self):
        return _FakeCursor(self)

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        self.rollback_calls += 1

    @property
    def committed(self):
        return self.commit_calls > 0

    @property
    def rolled_back(self):
        return self.rollback_calls > 0


class DictCache:
    """Minimal Valkey/redis-py stand-in: set/get backed by a plain dict,
    ignores the ex= (TTL) kwarg."""

    def __init__(self):
        self._store = {}

    def set(self, key, value, ex=None):
        self._store[key] = value

    def get(self, key):
        return self._store.get(key)


FIXTURE_ROWS = [
    ("main_entry", ["frobnicate_widget", "totally_unresolved_dep"], "caller.py"),
    ("frobnicate_widget", [], "worker.py"),
    ("Cls.helper", [], "cls.py"),
    ("uses_helper", ["helper"], "user.py"),
]


class TestEdgeResolution:
    def test_edges_resolve_only_to_known_symbols(self):
        pg = FakePgConn(rows=FIXTURE_ROWS)
        G = rlm_graph.build_graph_from_pg(pg)

        assert G.has_edge("main_entry", "frobnicate_widget")
        assert "totally_unresolved_dep" not in G.nodes()
        for _u, v in G.edges():
            assert v != "totally_unresolved_dep"

    def test_suffix_resolution_unique_match(self):
        pg = FakePgConn(rows=FIXTURE_ROWS)
        G = rlm_graph.build_graph_from_pg(pg)

        assert G.has_edge("uses_helper", "Cls.helper")

    def test_no_self_edges(self):
        rows = [("recursive_fn", ["recursive_fn"], "r.py")]
        pg = FakePgConn(rows=rows)
        G = rlm_graph.build_graph_from_pg(pg)

        assert G.number_of_edges() == 0
        assert not G.has_edge("recursive_fn", "recursive_fn")


class TestReversePassDependents:
    def test_reverse_pass_updates_dependents(self):
        pg_build = FakePgConn(rows=FIXTURE_ROWS)
        G = rlm_graph.build_graph_from_pg(pg_build)

        pg_update = FakePgConn()
        count = rlm_graph.update_dependents_in_pg(G, pg_update)

        assert count >= 1
        assert pg_update.commit_calls == 1
        found = any(
            params == (["main_entry"], "frobnicate_widget")
            for _query, params in pg_update.executed
        )
        assert found, f"expected (['main_entry'], 'frobnicate_widget') in {pg_update.executed}"

    def test_reverse_pass_swallows_pg_errors(self):
        pg_build = FakePgConn(rows=FIXTURE_ROWS)
        G = rlm_graph.build_graph_from_pg(pg_build)

        pg_fail = FakePgConn(raise_on_execute=True)
        count = rlm_graph.update_dependents_in_pg(G, pg_fail)

        assert count == 0
        assert pg_fail.rolled_back is True


class TestExpandChunksWithGraph:
    def test_expand_chunks_returns_real_callers(self):
        pg = FakePgConn(rows=FIXTURE_ROWS)
        G = rlm_graph.build_graph_from_pg(pg)

        cache = DictCache()
        rlm_graph.store_graph_in_valkey(G, cache)

        result = rlm_graph.expand_chunks_with_graph(
            [{"symbol_name": "frobnicate_widget"}], cache
        )
        assert result[0]["graph_callers"] == ["main_entry"]


class TestRebuildGraphSafe:
    def test_rebuild_graph_safe_pg_down_returns_none(self):
        rlm_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py"
        )
        spec = importlib.util.spec_from_file_location("rlm_service_65_graph", rlm_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        mod._get_pg_conn = lambda: None
        result = mod._rebuild_graph_safe()

        assert result is None


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
