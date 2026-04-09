#!/usr/bin/env python3
"""Tests for PGStore integration points: semantic search, memory dedup, retention, task_upsert.

Verifies:
1. memory_semantic_search calls generate_embedding with input_type="query"
2. memory_semantic_search falls back to text_fallback when embedding is None
3. memory_semantic_search excludes __test__ project by default
4. memory_store_with_embedding skips near-duplicate (cosine >= 0.95)
5. memory_store_with_embedding inserts when no duplicate found
6. memory_store_with_embedding respects GSD_DEDUP_THRESHOLD env var
7. memory_retention_cleanup moves old task_event entries
8. memory_retention_cleanup preserves auto_learning (never archived)
9. memory_retention_cleanup calls _ensure_archive_table first
10. task_upsert sends all 40 fields
11. task_upsert extracts rpetd_phases to individual columns
12. task_upsert returns None on psycopg2 OperationalError

Run: python3 -m pytest tests/test_pg_integration.py -v
"""
import json
import os
import sys
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch, PropertyMock, call

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from pg_store import PGStore, RETENTION_DAYS, DEFAULT_EXCLUDE_SOURCES


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_pg_store():
    """Create a PGStore instance without connecting to a real database."""
    with patch.object(PGStore, '__init__', lambda self, *a, **kw: None):
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
            # Reuse last cursor if more calls than expected
            return cursors[-1]

    mock_conn.cursor.side_effect = cursor_factory

    @contextmanager
    def fake_get_conn():
        yield mock_conn

    store._get_conn = fake_get_conn
    return mock_conn, cursors


# ── Semantic Search Tests ────────────────────────────────────────────────────

class TestSemanticSearchQueryType(unittest.TestCase):
    """memory_semantic_search calls generate_embedding with input_type='query'."""

    def test_semantic_search_calls_generate_embedding_with_query_type(self):
        """generate_embedding must receive input_type='query' for retrieval."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        cursor.fetchall.return_value = [
            {"id": 1, "text": "test", "source": "auto_learning", "agent_id": "a",
             "tags": "[]", "metadata": "{}", "project_id": None,
             "semantic_similarity": 0.9, "created_at": "2026-01-01", "updated_at": "2026-01-01",
             "embedding": None}
        ]
        _patch_get_conn(store, [cursor])
        fake_embedding = [0.1] * 1024

        with patch.object(PGStore, 'generate_embedding', return_value=fake_embedding) as mock_embed:
            with patch.object(store, '_score_semantic_results', return_value=[{"text": "test"}]):
                store.memory_semantic_search("test query")
                mock_embed.assert_called_once_with("test query", input_type="query")


class TestSemanticSearchTextFallback(unittest.TestCase):
    """memory_semantic_search returns text_fallback when embedding is None."""

    def test_semantic_search_falls_back_to_text_when_no_embedding(self):
        """When generate_embedding returns None, method returns text_fallback."""
        store = _make_pg_store()

        with patch.object(PGStore, 'generate_embedding', return_value=None):
            with patch.object(store, 'memory_search', return_value=[{"text": "fallback"}]) as mock_search:
                result, method = store.memory_semantic_search("test query")
                self.assertEqual(method, "text_fallback")
                mock_search.assert_called_once()


class TestSemanticSearchExcludesTestProject(unittest.TestCase):
    """memory_semantic_search excludes __test__ project by default."""

    def test_semantic_search_excludes_test_project_by_default(self):
        """SQL should contain project_id != '__test__' when project_id is not __test__."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        cursor.fetchall.return_value = []
        _patch_get_conn(store, [cursor])
        fake_embedding = [0.1] * 1024

        with patch.object(PGStore, 'generate_embedding', return_value=fake_embedding):
            with patch.object(store, 'memory_search', return_value=[]):
                store.memory_semantic_search("test query", project_id=None)

        # When fetchall returns [], it falls back to text search, so cursor.execute is called
        # Check that the SQL passed to execute contains the __test__ exclusion
        executed_sql = cursor.execute.call_args[0][0]
        self.assertIn("__test__", executed_sql)
        self.assertIn("project_id", executed_sql)


# ── Memory Store with Dedup Tests ────────────────────────────────────────────

class TestMemoryStoreDedupSkip(unittest.TestCase):
    """memory_store_with_embedding skips near-duplicate (>0.95 similarity)."""

    def test_memory_store_with_embedding_skips_near_duplicate(self):
        """Cosine similarity 0.97 > 0.95 threshold means dedup_skipped=True."""
        store = _make_pg_store()
        # Dedup check cursor returns existing row with high similarity
        dedup_cursor = _make_mock_cursor()
        dedup_cursor.fetchone.return_value = {"id": 42, "text": "existing", "similarity": 0.97}
        _patch_get_conn(store, [dedup_cursor])
        fake_embedding = [0.1] * 1024

        with patch.object(PGStore, 'generate_embedding', return_value=fake_embedding):
            result = store.memory_store_with_embedding("test text", source="agent")

        self.assertIsInstance(result, dict)
        self.assertTrue(result["dedup_skipped"])
        self.assertEqual(result["existing_id"], 42)
        self.assertAlmostEqual(result["similarity"], 0.97, places=2)


class TestMemoryStoreDedupInsert(unittest.TestCase):
    """memory_store_with_embedding inserts when no duplicate found."""

    def test_memory_store_with_embedding_inserts_when_no_duplicate(self):
        """No existing match means INSERT is executed, returning new ID."""
        store = _make_pg_store()
        # First cursor (dedup check) returns None
        dedup_cursor = _make_mock_cursor()
        dedup_cursor.fetchone.return_value = None
        # Second cursor (insert) returns new ID
        insert_cursor = _make_mock_cursor()
        insert_cursor.fetchone.return_value = (99,)
        _patch_get_conn(store, [dedup_cursor, insert_cursor])
        fake_embedding = [0.1] * 1024

        with patch.object(PGStore, 'generate_embedding', return_value=fake_embedding):
            result = store.memory_store_with_embedding("new text", source="agent")

        self.assertEqual(result, 99)


class TestMemoryStoreDedupEnvThreshold(unittest.TestCase):
    """memory_store_with_embedding respects GSD_DEDUP_THRESHOLD env var."""

    def test_memory_store_with_embedding_respects_env_threshold(self):
        """With GSD_DEDUP_THRESHOLD=0.90, similarity 0.92 should be deduped."""
        store = _make_pg_store()
        dedup_cursor = _make_mock_cursor()
        dedup_cursor.fetchone.return_value = {"id": 10, "text": "similar", "similarity": 0.92}
        _patch_get_conn(store, [dedup_cursor])
        fake_embedding = [0.1] * 1024

        with patch.dict(os.environ, {"GSD_DEDUP_THRESHOLD": "0.90"}):
            with patch.object(PGStore, 'generate_embedding', return_value=fake_embedding):
                result = store.memory_store_with_embedding("test text")

        self.assertIsInstance(result, dict)
        self.assertTrue(result["dedup_skipped"])


# ── Retention Cleanup Tests ──────────────────────────────────────────────────

class TestRetentionMovesOldEntries(unittest.TestCase):
    """memory_retention_cleanup moves old task_event entries."""

    def test_retention_cleanup_moves_old_task_events(self):
        """Result dict should contain task_event_archived count from cursor.rowcount."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        # RETENTION_DAYS has 3 entries (task_event, rpetd_phase, web_search_result)
        # rowcount is read once per source (after INSERT INTO archive)
        type(cursor).rowcount = PropertyMock(side_effect=[5, 3, 2])
        _patch_get_conn(store, [cursor])
        store._ensure_archive_table = MagicMock()

        result = store.memory_retention_cleanup()
        self.assertEqual(result["task_event_archived"], 5)
        self.assertIn("rpetd_phase_archived", result)
        self.assertEqual(result["rpetd_phase_archived"], 3)
        self.assertIn("web_search_result_archived", result)
        self.assertEqual(result["web_search_result_archived"], 2)
        self.assertIn("total", result)
        self.assertEqual(result["total"], 10)


class TestRetentionPreservesAutoLearning(unittest.TestCase):
    """RETENTION_DAYS does NOT contain auto_learning (high-value, never archived)."""

    def test_retention_cleanup_preserves_auto_learning(self):
        """auto_learning must not be a key in RETENTION_DAYS policy."""
        self.assertNotIn("auto_learning", RETENTION_DAYS)
        self.assertNotIn("lesson-learned", RETENTION_DAYS)
        self.assertNotIn("best-practice", RETENTION_DAYS)


class TestRetentionCreatesArchiveFirst(unittest.TestCase):
    """memory_retention_cleanup calls _ensure_archive_table before any inserts."""

    def test_retention_cleanup_creates_archive_table_first(self):
        """_ensure_archive_table must be called before cursor.execute on gsd_memory_archive."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        type(cursor).rowcount = PropertyMock(return_value=0)
        _patch_get_conn(store, [cursor])

        call_order = []
        original_ensure = MagicMock(side_effect=lambda: call_order.append("ensure_archive"))
        store._ensure_archive_table = original_ensure

        original_execute = cursor.execute
        def track_execute(*args, **kwargs):
            call_order.append("execute")
            return original_execute(*args, **kwargs)
        cursor.execute = MagicMock(side_effect=track_execute)

        store.memory_retention_cleanup()

        self.assertTrue(len(call_order) > 0)
        self.assertEqual(call_order[0], "ensure_archive",
                         f"Expected _ensure_archive_table first, got: {call_order}")


# ── Task Upsert Tests ───────────────────────────────────────────────────────

def _make_full_task_item():
    """Create an item dict with all fields populated for task_upsert."""
    return {
        "id": "TK-FULL-001",
        "project_id": "gsd-amauta",
        "type": "task",
        "title": "Full roundtrip test",
        "description": "Testing all 40 fields",
        "details": "Detailed info here",
        "status": "in-progress",
        "priority": "high",
        "assigned_to": "executor-backend",
        "claimed_by": "executor-backend",
        "claimed_at": "2026-03-25T12:00:00Z",
        "rpetd_phases": {"R": "research", "P": "plan", "E": "execute", "T": "test", "D": "document"},
        "rpetd_complete": True,
        "importance": 8,
        "urgency": 7,
        "success_criteria": ["criterion 1", "criterion 2"],
        "deliverables": ["file1.py", "file2.py"],
        "dependencies": ["TK-DEP-001"],
        "tags": ["backend", "test"],
        "notes": ["Note 1"],
        "parent": "ST-001",
        "validation_notes": "Validated successfully",
        "validated_by": "validator-agent",
        "test_strategy": "unit + integration",
        "phase": "22",
        "plan": "02",
        "evidence": {"commit": "abc123"},
        "outcome": "success",
        "lesson": "Always test roundtrips",
        "doc_refs": ["doc1.md"],
        "risks": ["risk1"],
        "validation_checklist": ["check1", "check2"],
        "estimated_hours": 2.5,
        "due_date": "2026-03-30",
        "sprint": "v2.4",
        "children": ["TK-CHILD-001"],
    }


class TestTaskUpsertAllFields(unittest.TestCase):
    """task_upsert sends all 40 fields to the database."""

    def test_task_upsert_sends_all_40_fields(self):
        """The params dict passed to execute() must have exactly 40 keys."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        _patch_get_conn(store, [cursor])

        item = _make_full_task_item()
        store.task_upsert(item)

        # Get the params dict passed to cursor.execute()
        call_args = cursor.execute.call_args
        params_dict = call_args[0][1]  # Second positional arg is the params dict

        self.assertEqual(len(params_dict), 40,
                         f"Expected 40 fields, got {len(params_dict)}: {sorted(params_dict.keys())}")


class TestTaskUpsertRpetdExtraction(unittest.TestCase):
    """task_upsert extracts rpetd_phases dict to individual rpetd_* columns."""

    def test_task_upsert_extracts_rpetd_phases_to_columns(self):
        """rpetd_phases={R:r,P:p,E:e,T:t,D:d} => rpetd_r=r, rpetd_p=p, etc."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        _patch_get_conn(store, [cursor])

        item = _make_full_task_item()
        item["rpetd_phases"] = {"R": "r-content", "P": "p-content", "E": "e-content",
                                "T": "t-content", "D": "d-content"}
        store.task_upsert(item)

        params = cursor.execute.call_args[0][1]
        self.assertEqual(params["rpetd_r"], "r-content")
        self.assertEqual(params["rpetd_p"], "p-content")
        self.assertEqual(params["rpetd_e"], "e-content")
        self.assertEqual(params["rpetd_t"], "t-content")
        self.assertEqual(params["rpetd_d"], "d-content")


class TestTaskUpsertReturnsNoneOnError(unittest.TestCase):
    """task_upsert returns None on psycopg2 OperationalError."""

    def test_task_upsert_returns_none_on_pg_error(self):
        """Exception from cursor.execute => return None + enqueue_retry."""
        store = _make_pg_store()
        cursor = _make_mock_cursor()
        _patch_get_conn(store, [cursor])
        store.enqueue_retry = MagicMock()

        cursor.execute.side_effect = Exception("connection refused")

        item = _make_full_task_item()
        result = store.task_upsert(item)

        self.assertIsNone(result)
        store.enqueue_retry.assert_called_once_with(item)


if __name__ == "__main__":
    unittest.main()
