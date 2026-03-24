#!/usr/bin/env python3
"""Tests for HTTP-based _rlm_query() in amauta.py.

Uses unittest.mock to patch urllib.request.urlopen so tests don't need
a running RLM service. Verifies:
1. Correct endpoint selection (/search vs /query)
2. CWD fallback when no doc_path
3. Graceful failure when service is down
4. Output formatting and 1200-char cap

Run: python3 -m pytest tests/test_rlm_http.py -v
"""
import io
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"


def _make_response(results):
    """Create a mock HTTP response with JSON body."""
    body = json.dumps({"ok": True, "results": results}).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestRlmQueryHttp(unittest.TestCase):
    """Tests for the HTTP-based _rlm_query function."""

    def setUp(self):
        """Import _rlm_query fresh for each test."""
        import amauta
        self._rlm_query = amauta._rlm_query

    @patch("urllib.request.urlopen")
    def test_directory_query_uses_query_endpoint(self, mock_urlopen):
        """When doc_path is a directory, should POST to /query."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "src/auth.py", "start_line": 10, "end_line": 30, "label": "login"}
        ])

        with patch("os.path.isdir", return_value=True), \
             patch("os.path.isfile", return_value=False):
            result = self._rlm_query("auth flow", doc_path="/some/dir")

        self.assertIn("src/auth.py", result)
        self.assertIn("login", result)
        # Verify the URL contains /query
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("/query", req.full_url)

    @patch("urllib.request.urlopen")
    def test_file_query_uses_search_endpoint(self, mock_urlopen):
        """When doc_path is a file, should POST to /search."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "docs/ARCH.md", "start_line": 1, "end_line": 50, "label": "overview"}
        ])

        with patch("os.path.isdir", return_value=False), \
             patch("os.path.isfile", return_value=True):
            result = self._rlm_query("architecture", doc_path="/some/file.md")

        self.assertIn("docs/ARCH.md", result)
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("/search", req.full_url)

    @patch("urllib.request.urlopen")
    def test_no_docpath_falls_back_to_cwd(self, mock_urlopen):
        """When no doc_path, should query os.getcwd()."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "amauta.py", "start_line": 100, "end_line": 120, "label": "enrichment"}
        ])

        with patch("os.getcwd", return_value="/project/root"):
            result = self._rlm_query("enrichment function")

        self.assertIn("amauta.py", result)
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["directory"], "/project/root")

    @patch("urllib.request.urlopen")
    def test_text_only_returns_empty(self, mock_urlopen):
        """When only text is provided (no path), should return empty string."""
        result = self._rlm_query("query", text="some plain text")
        self.assertEqual(result, "")
        mock_urlopen.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_service_down_returns_empty(self, mock_urlopen):
        """When RLM service is unreachable, should return empty string (best-effort)."""
        mock_urlopen.side_effect = ConnectionRefusedError("Connection refused")
        result = self._rlm_query("test query")
        self.assertEqual(result, "")

    @patch("urllib.request.urlopen")
    def test_output_capped_at_1200_chars(self, mock_urlopen):
        """Output should be truncated at 1200 characters."""
        long_results = [
            {"filepath": f"src/file_{i}.py", "start_line": 1, "end_line": 100,
             "label": "x" * 200}
            for i in range(20)
        ]
        mock_urlopen.return_value = _make_response(long_results)

        with patch("os.getcwd", return_value="/project"):
            result = self._rlm_query("test")

        self.assertLessEqual(len(result), 1200)

    @patch("urllib.request.urlopen")
    def test_empty_results_returns_empty(self, mock_urlopen):
        """When RLM returns no results, should return empty string."""
        mock_urlopen.return_value = _make_response([])
        with patch("os.getcwd", return_value="/project"):
            result = self._rlm_query("nonexistent query")
        self.assertEqual(result, "")

    @patch("urllib.request.urlopen")
    def test_port_from_env(self, mock_urlopen):
        """Should use GSD_RLM_PORT env var for port."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "test.py", "start_line": 1, "end_line": 10, "label": "test"}
        ])

        with patch.dict(os.environ, {"GSD_RLM_PORT": "19999"}), \
             patch("os.getcwd", return_value="/project"):
            self._rlm_query("test")

        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("19999", req.full_url)


if __name__ == "__main__":
    unittest.main()
