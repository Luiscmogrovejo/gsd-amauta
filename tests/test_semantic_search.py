#!/usr/bin/env python3
"""Tests for semantic search wiring, daemon-mediated writes, and full learning storage.

Verifies:
1. _mem_semantic_search() calls daemon /api/memory/semantic-search
2. _mem_semantic_search() falls back to _mem_pg_search() on daemon failure
3. _mem_log_event() routes through daemon /api/memory/store
4. _mem_log_event() falls back to direct SQL on daemon failure
5. _auto_write_learning() stores full phase content without truncation

Run: python3 -m pytest tests/test_semantic_search.py -v
"""
import importlib
import io
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock, PropertyMock

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

# Import amauta module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import amauta


def _make_http_response(data, status=200):
    """Create a mock HTTP response object."""
    body = json.dumps(data).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.status = status
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestMemSemanticSearch(unittest.TestCase):
    """Tests for _mem_semantic_search() helper."""

    @patch("urllib.request.urlopen")
    def test_calls_daemon_endpoint(self, mock_urlopen):
        """Should POST to /api/memory/semantic-search."""
        mock_urlopen.return_value = _make_http_response({
            "results": [
                {"text": "test memory", "agent_id": "test", "source": "auto_learning",
                 "similarity": 0.85, "tags": ["test"], "created_at": "2026-01-01"}
            ],
            "count": 1,
            "method": "pgvector"
        })
        results = amauta._mem_semantic_search("test query", top_k=3)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["text"], "test memory")
        self.assertEqual(results[0]["source"], "auto_learning")
        # Verify HTTP call was made
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("semantic-search", req.full_url)

    @patch("urllib.request.urlopen")
    def test_score_normalization(self, mock_urlopen):
        """Similarity float (0-1) should be normalized to integer score (0-10)."""
        mock_urlopen.return_value = _make_http_response({
            "results": [
                {"text": "high sim", "similarity": 0.95, "source": "auto_learning",
                 "agent_id": "a", "tags": [], "created_at": "2026-01-01"},
                {"text": "low sim", "similarity": 0.3, "source": "task_event",
                 "agent_id": "b", "tags": [], "created_at": "2026-01-01"},
            ],
            "count": 2, "method": "pgvector"
        })
        results = amauta._mem_semantic_search("query")
        self.assertGreaterEqual(results[0]["score"], 9)
        self.assertLessEqual(results[1]["score"], 3)

    @patch("urllib.request.urlopen", side_effect=ConnectionRefusedError)
    def test_falls_back_to_like_search(self, mock_urlopen):
        """On daemon failure, should fall back to _mem_pg_search."""
        with patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_mem_pg_search", return_value=[{"text": "fallback", "score": 3}]) as mock_like:
            results = amauta._mem_semantic_search("test query", top_k=5)
            mock_like.assert_called_once_with("test query", None, 5)
            self.assertEqual(results[0]["text"], "fallback")

    @patch("urllib.request.urlopen", side_effect=TimeoutError)
    def test_timeout_triggers_fallback(self, mock_urlopen):
        """On timeout, should fall back gracefully."""
        with patch.object(amauta, "_mem_pg_available", return_value=False):
            results = amauta._mem_semantic_search("test query")
            self.assertEqual(results, [])

    @patch("urllib.request.urlopen")
    def test_empty_results_returns_empty_list(self, mock_urlopen):
        """Empty daemon results should return empty list."""
        mock_urlopen.return_value = _make_http_response({
            "results": [],
            "count": 0,
            "method": "pgvector"
        })
        results = amauta._mem_semantic_search("obscure query")
        self.assertEqual(results, [])

    @patch("urllib.request.urlopen")
    def test_result_format_matches_pg_search(self, mock_urlopen):
        """Result dicts should have same keys as _mem_pg_search output."""
        mock_urlopen.return_value = _make_http_response({
            "results": [
                {"text": "memory text", "agent_id": "agent1", "source": "lesson-learned",
                 "similarity": 0.75, "tags": ["tag1", "tag2"], "created_at": "2026-03-24T10:00:00"}
            ],
            "count": 1, "method": "pgvector"
        })
        results = amauta._mem_semantic_search("query")
        self.assertEqual(len(results), 1)
        r = results[0]
        expected_keys = {"ts", "agent_id", "text", "tags", "source", "score"}
        self.assertEqual(set(r.keys()), expected_keys)
        self.assertIsInstance(r["score"], int)
        self.assertIsInstance(r["tags"], list)


class TestMemLogEventDaemonRoute(unittest.TestCase):
    """Tests for daemon-mediated memory writes."""

    @patch("urllib.request.urlopen")
    def test_routes_through_daemon(self, mock_urlopen):
        """Should POST to /api/memory/store when daemon is available."""
        mock_urlopen.return_value = _make_http_response({"stored": True, "id": "MEM-abc", "embedded": True})
        with patch.object(amauta, "_mem_pg_available", return_value=True):
            amauta._mem_log_event("test-agent", ["tag1"], "test text", source="task_event")
        # Verify daemon was called
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("memory/store", req.full_url)

    @patch("urllib.request.urlopen", side_effect=ConnectionRefusedError)
    def test_fallback_to_direct_sql(self, mock_urlopen):
        """On daemon failure, should INSERT directly to PG."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)

        with patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_pg_conn", return_value=mock_conn):
            amauta._mem_log_event("test-agent", ["tag1"], "test text", source="task_event")
        # Direct SQL INSERT should have been called
        mock_cursor.execute.assert_called()
        sql_call = str(mock_cursor.execute.call_args)
        self.assertIn("INSERT INTO amauta_memory", sql_call)


class TestAutoWriteLearningNoTruncation(unittest.TestCase):
    """Tests for _auto_write_learning() without double-truncation."""

    def test_full_phase_content_preserved(self):
        """Phase text should NOT be truncated before assembly."""
        long_r = "R-" * 500  # 1000 chars
        long_p = "P-" * 500
        long_e = "E-" * 500
        long_t = "T-" * 500
        long_d = "D-" * 500

        item = {
            "id": "TK-TEST",
            "title": "Test full learning",
            "success_criteria": ["crit1"],
            "rpetd_phases": {"R": long_r, "P": long_p, "E": long_e, "T": long_t, "D": long_d},
            "notes": [],
        }

        captured_text = None

        def capture_log_event(agent_id, tags, text, *, source="task_event", metadata=None):
            nonlocal captured_text
            if source == "auto_learning":
                captured_text = text

        with patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_mem_log_event", side_effect=capture_log_event), \
             patch.object(amauta, "_skb_promote"):
            amauta._auto_write_learning(item, "validator")

        self.assertIsNotNone(captured_text, "auto_learning should have been written")
        # Full R-phase (1000 chars) should be in the output, not truncated to 200-300
        self.assertIn(long_r[:500], captured_text)
        self.assertIn(long_d[:500], captured_text)
        # Total should be well above the old ~900 char limit
        self.assertGreater(len(captured_text), 3000)

    def test_short_phases_still_work(self):
        """Short phase content should work normally (no minimum length issue)."""
        item = {
            "id": "TK-SHORT",
            "title": "Short test",
            "success_criteria": [],
            "rpetd_phases": {"R": "brief R", "P": "brief P", "E": "brief E", "T": "brief T", "D": "brief D"},
            "notes": [],
        }

        captured_text = None

        def capture_log_event(agent_id, tags, text, *, source="task_event", metadata=None):
            nonlocal captured_text
            if source == "auto_learning":
                captured_text = text

        with patch.object(amauta, "_mem_pg_available", return_value=True), \
             patch.object(amauta, "_mem_log_event", side_effect=capture_log_event), \
             patch.object(amauta, "_skb_promote"):
            amauta._auto_write_learning(item, "validator")

        self.assertIsNotNone(captured_text)
        self.assertIn("brief R", captured_text)
        self.assertIn("brief D", captured_text)


if __name__ == "__main__":
    unittest.main()
