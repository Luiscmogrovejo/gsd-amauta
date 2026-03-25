#!/usr/bin/env python3
"""Tests for graceful fallback degradation paths in amauta.py.

Covers:
  - _mem_semantic_search: daemon HTTP -> LIKE fallback via _mem_pg_search -> empty
  - _mem_log_event: daemon HTTP -> direct SQL INSERT -> JSONL _mem_append fallback
  - _rlm_query: connection refused -> empty, timeout -> empty, success
  - _research_chain_query: subprocess timeout -> [], parse error -> stderr, node missing -> []

Mock strategy: Patch urllib.request.urlopen for HTTP fallback tests.
Patch _mem_pg_available, _mem_pg_search, _pg_conn, _mem_append for log_event tests.
Patch subprocess.run and shutil.which for research chain tests.

Run: python3 -m pytest tests/test_fallback_paths.py -v
"""
import io
import json
import os
import socket
import subprocess
import sys
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch, call
from urllib.error import URLError

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import amauta


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_urlopen_response(data: dict):
    """Create a mock urllib response object returning JSON data."""
    json_bytes = json.dumps(data).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = json_bytes
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ── _mem_semantic_search daemon-down fallback ────────────────────────────────

class TestSemanticSearchFallsBackToLikeOnDaemonError(unittest.TestCase):
    """When daemon is down, semantic search falls back to LIKE-based _mem_pg_search."""

    @patch("amauta._mem_pg_search")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_semantic_search_falls_back_to_like_on_daemon_error(self, mock_pg_avail, mock_pg_search):
        """Patch urlopen to raise URLError; _mem_pg_search should be called as LIKE fallback."""
        like_results = [{"ts": "2026-01-01", "agent_id": "test", "text": "LIKE result",
                         "tags": [], "source": "auto_learning", "score": 5}]
        mock_pg_search.return_value = like_results

        with patch("urllib.request.urlopen", side_effect=URLError("Connection refused")):
            result = amauta._mem_semantic_search("test query")

        mock_pg_search.assert_called_once()
        self.assertEqual(result, like_results)


class TestSemanticSearchReturnsEmptyWhenAllFallbacksFail(unittest.TestCase):
    """When daemon is down AND PG is unavailable, returns []."""

    @patch("amauta._mem_pg_available", return_value=False)
    def test_semantic_search_returns_empty_when_all_fallbacks_fail(self, mock_pg):
        """No daemon, no PG -> returns empty list."""
        with patch("urllib.request.urlopen", side_effect=URLError("Connection refused")):
            result = amauta._mem_semantic_search("query that should find nothing")

        self.assertEqual(result, [])


class TestSemanticSearchUsesDaemonWhenAvailable(unittest.TestCase):
    """When daemon is up, use daemon results; _mem_pg_search NOT called."""

    @patch("amauta._mem_pg_search")
    def test_semantic_search_uses_daemon_when_available(self, mock_pg_search):
        """Daemon returns valid results; LIKE fallback should NOT be called."""
        daemon_data = {
            "results": [
                {"text": "daemon result", "score": 0.95, "created_at": "2026-01-01",
                 "agent_id": "test", "tags": [], "source": "auto_learning"}
            ]
        }
        resp = _make_urlopen_response(daemon_data)

        with patch("urllib.request.urlopen", return_value=resp):
            result = amauta._mem_semantic_search("test query")

        mock_pg_search.assert_not_called()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["text"], "daemon result")


# ── _mem_log_event daemon timeout fallback ───────────────────────────────────

class TestLogEventFallsBackToDirectSqlOnDaemonTimeout(unittest.TestCase):
    """_mem_log_event falls back to direct SQL INSERT when daemon times out."""

    @patch("amauta._mem_append")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_log_event_falls_back_to_direct_sql_on_daemon_timeout(self, mock_pg_avail, mock_append):
        """Daemon timeout -> direct SQL INSERT via _pg_conn."""
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (0,)  # Idempotency check: not already stored

        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        @contextmanager
        def mock_pg_conn():
            yield mock_conn

        with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")), \
             patch("amauta._pg_conn", mock_pg_conn):
            amauta._mem_log_event("test-agent", ["tag1"], "test text")

        # Should have executed INSERT (direct SQL fallback)
        self.assertTrue(mock_cursor.execute.called, "cursor.execute should have been called for SQL INSERT")
        # Find the INSERT call
        insert_calls = [c for c in mock_cursor.execute.call_args_list
                        if c[0] and "INSERT INTO gsd_memory" in str(c[0][0])]
        self.assertGreater(len(insert_calls), 0, "Should have called INSERT INTO gsd_memory")


class TestLogEventIdempotencyGuardPreventsDoubleWrite(unittest.TestCase):
    """Idempotency guard prevents double write when daemon already committed."""

    @patch("amauta._mem_append")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_log_event_idempotency_guard_prevents_double_write(self, mock_pg_avail, mock_append):
        """If idempotency check finds existing entry, skip INSERT."""
        mock_cursor = MagicMock()
        # Idempotency check returns count > 0 (daemon already stored it)
        mock_cursor.fetchone.return_value = (1,)

        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        @contextmanager
        def mock_pg_conn():
            yield mock_conn

        with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")), \
             patch("amauta._pg_conn", mock_pg_conn):
            amauta._mem_log_event("test-agent", ["tag1"], "test text")

        # INSERT should NOT have been called (idempotency guard caught it)
        insert_calls = [c for c in mock_cursor.execute.call_args_list
                        if c[0] and "INSERT INTO gsd_memory" in str(c[0][0])]
        self.assertEqual(len(insert_calls), 0, "INSERT should NOT be called when idempotency guard fires")


class TestLogEventFallsBackToJsonlWhenPgUnavailable(unittest.TestCase):
    """_mem_log_event falls back to JSONL _mem_append when PG is unavailable."""

    @patch("amauta._mem_append")
    @patch("amauta._mem_pg_available", return_value=False)
    def test_log_event_falls_back_to_jsonl_when_pg_unavailable(self, mock_pg, mock_append):
        """No daemon, no PG -> falls back to JSONL _mem_append."""
        with patch("urllib.request.urlopen", side_effect=Exception("no daemon")):
            amauta._mem_log_event("test-agent", ["tag1"], "test text")

        mock_append.assert_called_once()


class TestLogEventNeverRaisesOnTotalFailure(unittest.TestCase):
    """_mem_log_event never raises even when all paths fail."""

    def test_log_event_never_raises_on_total_failure(self):
        """All fallbacks fail -> function completes silently (no exception)."""
        with patch("amauta._mem_pg_available", side_effect=Exception("pg check failed")), \
             patch("amauta._mem_append", side_effect=Exception("append failed")), \
             patch("urllib.request.urlopen", side_effect=Exception("no daemon")):
            # Should NOT raise
            try:
                amauta._mem_log_event("test-agent", ["tag1"], "test text")
            except Exception as e:
                self.fail(f"_mem_log_event should never raise, but got: {e}")


# ── _rlm_query service-down fallback ────────────────────────────────────────

class TestRlmQueryReturnsEmptyOnConnectionRefused(unittest.TestCase):
    """_rlm_query returns empty string on connection refused."""

    def test_rlm_query_returns_empty_on_connection_refused(self):
        """RLM service down -> returns '' (no context, best-effort)."""
        with patch("urllib.request.urlopen", side_effect=ConnectionRefusedError("refused")):
            result = amauta._rlm_query("test query")

        self.assertEqual(result, "")


class TestRlmQueryReturnsEmptyOnTimeout(unittest.TestCase):
    """_rlm_query returns empty string on timeout."""

    def test_rlm_query_returns_empty_on_timeout(self):
        """RLM service timeout -> returns '' (never blocks, never raises)."""
        with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
            result = amauta._rlm_query("test query")

        self.assertEqual(result, "")


class TestRlmQueryReturnsResultsOnSuccess(unittest.TestCase):
    """_rlm_query returns formatted results on success."""

    def test_rlm_query_returns_results_on_success(self):
        """RLM service returns valid JSON -> returns filepath:line output."""
        rlm_data = {
            "results": [
                {"filepath": "/src/main.py", "start_line": 10, "end_line": 20, "label": "def handler"},
            ]
        }
        resp = _make_urlopen_response(rlm_data)

        with patch("urllib.request.urlopen", return_value=resp):
            result = amauta._rlm_query("test query")

        self.assertIn("/src/main.py", result)
        self.assertIn("10-20", result)
        self.assertIn("def handler", result)


# ── _research_chain_query timeout/error fallback ────────────────────────────

class TestResearchChainReturnsEmptyOnSubprocessTimeout(unittest.TestCase):
    """_research_chain_query returns [] on subprocess timeout."""

    def test_research_chain_returns_empty_on_subprocess_timeout(self):
        """Subprocess.TimeoutExpired -> returns [] without hanging."""
        with patch("shutil.which", return_value="/usr/bin/node"), \
             patch("os.path.isfile", return_value=True), \
             patch("subprocess.run", side_effect=subprocess.TimeoutExpired("node", 45)):
            result = amauta._research_chain_query("test topic")

        self.assertEqual(result, [])


class TestResearchChainReturnsEmptyOnParseError(unittest.TestCase):
    """_research_chain_query returns [] on JSON parse error and writes to stderr."""

    def test_research_chain_returns_empty_on_parse_error(self):
        """Invalid JSON in stdout -> returns [] and writes error to stderr."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "this is not valid json at all"

        stderr_output = []

        with patch("shutil.which", return_value="/usr/bin/node"), \
             patch("os.path.isfile", return_value=True), \
             patch("subprocess.run", return_value=mock_result), \
             patch("sys.stderr") as mock_stderr:
            mock_stderr.write = lambda s: stderr_output.append(s)
            result = amauta._research_chain_query("test topic")

        self.assertEqual(result, [])
        stderr_text = "".join(stderr_output)
        self.assertIn("[RESEARCH_CHAIN] Parse error", stderr_text)


class TestResearchChainReturnsEmptyWhenNodeNotFound(unittest.TestCase):
    """_research_chain_query returns [] immediately when node is not found."""

    def test_research_chain_returns_empty_when_node_not_found(self):
        """shutil.which returns None -> returns [] without calling subprocess."""
        with patch("shutil.which", return_value=None), \
             patch("subprocess.run") as mock_run:
            result = amauta._research_chain_query("test topic")

        self.assertEqual(result, [])
        mock_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
