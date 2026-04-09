#!/usr/bin/env python3
"""Phase 10 LEARN-05 pytest tests for memory_increment_applied dedup logic.

Mocks the PG connection -- no real database required. Follows the
_make_pg_store / _patch_get_conn pattern from test_pg_integration.py.

Run: pytest tests/test_memory_increment_applied.py -v
"""
import json
import os
import sys
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
os.environ.setdefault("PYTEST_CURRENT_TEST", "1")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from pg_store import PGStore  # noqa: E402


# ---- Helpers (matches test_pg_integration.py pattern) ----

def _make_pg_store():
    """Create a PGStore instance without connecting to a real database."""
    with patch.object(PGStore, "__init__", lambda self, *a, **kw: None):
        store = PGStore.__new__(PGStore)
        store._pool = MagicMock()
        store._lock = MagicMock()
        return store


def _make_mock_cursor():
    """Create a mock cursor that works as a context manager."""
    cursor = MagicMock()
    cursor.__enter__ = MagicMock(return_value=cursor)
    cursor.__exit__ = MagicMock(return_value=False)
    return cursor


def _patch_get_conn(store, cursors=None):
    """Patch _get_conn as a @contextmanager yielding a mock conn.

    conn.cursor() returns cursors in order (or a single shared cursor).
    Returns (mock_conn, cursors_list).
    """
    if cursors is None:
        cursors = [_make_mock_cursor()]

    mock_conn = MagicMock()
    cursor_iter = iter(cursors)

    def cursor_factory(**kwargs):
        try:
            return next(cursor_iter)
        except StopIteration:
            return cursors[-1]

    mock_conn.cursor.side_effect = cursor_factory

    @contextmanager
    def fake_get_conn():
        yield mock_conn

    store._get_conn = fake_get_conn
    return mock_conn, cursors


class TestIncrementAppliedHappyPath:
    def test_first_citation_increments(self):
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        # SELECT ... FOR UPDATE returns (metadata, applied_count)
        # UPDATE ... RETURNING applied_count returns (1,)
        cursor.fetchone.side_effect = [
            ({}, 0),   # SELECT row: empty metadata, count=0
            (1,),      # UPDATE RETURNING: new applied_count=1
        ]
        _patch_get_conn(store, [cursor])

        r = store.memory_increment_applied("mem-abc123def456", "TK-0001", phase="E", reason="used it")
        assert r["incremented"] is True
        assert r["already_cited"] is False
        assert r["applied_count"] == 1

    def test_metadata_citations_list_is_appended(self):
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        cursor.fetchone.side_effect = [
            ({}, 0),
            (1,),
        ]
        _patch_get_conn(store, [cursor])

        store.memory_increment_applied("mem-abc123def456", "TK-0001", phase="E", reason="r")

        # Verify UPDATE was called with metadata containing citations + first_cited_at
        calls = cursor.execute.call_args_list
        update_calls = [c for c in calls if "UPDATE gsd_memory" in str(c)]
        assert len(update_calls) >= 1
        # The first positional arg to execute is the SQL, second is the params tuple
        update_args = update_calls[0][0][1]  # params tuple
        metadata_json = update_args[0]
        parsed_meta = json.loads(metadata_json)
        assert "citations" in parsed_meta
        assert len(parsed_meta["citations"]) == 1
        assert parsed_meta["citations"][0]["task_id"] == "TK-0001"
        assert parsed_meta["citations"][0]["phase"] == "E"
        assert "first_cited_at" in parsed_meta
        assert "last_cited_at" in parsed_meta


class TestIncrementAppliedDedup:
    def test_same_task_twice_dedups(self):
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        existing = {
            "citations": [
                {"task_id": "TK-0001", "phase": "R", "cited_at": "2026-04-01T00:00:00Z"}
            ]
        }
        cursor.fetchone.side_effect = [
            (existing, 1),  # SELECT: existing metadata with TK-0001 citation
        ]
        _patch_get_conn(store, [cursor])

        r = store.memory_increment_applied("mem-abc123def456", "TK-0001", phase="E", reason="again")
        assert r["incremented"] is False
        assert r["already_cited"] is True
        assert r["applied_count"] == 1  # unchanged

    def test_different_task_increments(self):
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        existing = {
            "citations": [
                {"task_id": "TK-0001", "phase": "E", "cited_at": "2026-04-01T00:00:00Z"}
            ]
        }
        cursor.fetchone.side_effect = [
            (existing, 1),  # SELECT: existing citation from TK-0001
            (2,),           # UPDATE RETURNING: new count=2
        ]
        _patch_get_conn(store, [cursor])

        r = store.memory_increment_applied("mem-abc123def456", "TK-0002", phase="E", reason="new task")
        assert r["incremented"] is True
        assert r["already_cited"] is False
        assert r["applied_count"] == 2


class TestIncrementAppliedNotFound:
    def test_missing_mem_id_returns_error(self):
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        cursor.fetchone.side_effect = [
            None,  # SELECT: no row found
        ]
        _patch_get_conn(store, [cursor])

        r = store.memory_increment_applied("mem-nonexistent", "TK-0001")
        assert r["incremented"] is False
        assert "not found" in r.get("error", "").lower()
        assert r["applied_count"] == 0
