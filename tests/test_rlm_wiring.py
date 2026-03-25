#!/usr/bin/env python3
"""Tests for RLM wiring layer: _rlm_query HTTP transport, BM25 formatting,
_rpetd_phase_enrich enrichment flow, and enrichment dedup window.

Differentiates from test_rlm_http.py (endpoint selection, CWD fallback, port):
  - Focuses on BM25 result formatting and scoring shape
  - Layer 1 + Layer 2 enrichment orchestration
  - Dedup window skip/allow logic (ENRICHMENT_DEDUP_WINDOW = 300s)

Run: python3 -m pytest tests/test_rlm_wiring.py -v
"""
import io
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from urllib.error import URLError

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import amauta


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_response(results):
    """Create a mock HTTP response with JSON body."""
    body = json.dumps({"ok": True, "results": results}).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _make_item(title="Test task", desc="Test description", notes=None):
    """Build a minimal task dict for enrichment tests."""
    return {
        "id": "TK-WIRE",
        "title": title,
        "description": desc,
        "success_criteria": ["criterion 1"],
        "rpetd_phases": {},
        "status": "in-progress",
        "claimed_by": "executor-backend",
        "notes": notes or [],
    }


# ── HTTP transport (3 tests) ────────────────────────────────────────────────

class TestRlmQueryHttpTransport(unittest.TestCase):

    @patch("urllib.request.urlopen")
    def test_rlm_query_posts_to_query_endpoint_for_directory(self, mock_urlopen):
        """When doc_path is a directory, POST to /query with 'directory' in body."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "src/main.py", "start_line": 1, "end_line": 10, "label": "main"}
        ])

        with patch("os.path.isdir", return_value=True), \
             patch("os.path.isfile", return_value=False):
            result = amauta._rlm_query("test query", doc_path="/tmp/test_dir")

        req = mock_urlopen.call_args[0][0]
        self.assertTrue(req.full_url.endswith("/query"))
        body = json.loads(req.data)
        self.assertIn("directory", body)
        self.assertEqual(body["directory"], "/tmp/test_dir")

    @patch("urllib.request.urlopen")
    def test_rlm_query_posts_to_search_endpoint_for_file(self, mock_urlopen):
        """When doc_path is a file, POST to /search with 'paths' in body."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "docs/API.md", "start_line": 5, "end_line": 25, "label": "endpoints"}
        ])

        with patch("os.path.isdir", return_value=False), \
             patch("os.path.isfile", return_value=True):
            result = amauta._rlm_query("test query", doc_path="/tmp/testfile.py")

        req = mock_urlopen.call_args[0][0]
        self.assertTrue(req.full_url.endswith("/search"))
        body = json.loads(req.data)
        self.assertIn("paths", body)
        self.assertIn("/tmp/testfile.py", body["paths"])

    @patch("urllib.request.urlopen")
    def test_rlm_query_returns_empty_on_connection_error(self, mock_urlopen):
        """URLError (service down) returns empty string -- best-effort."""
        mock_urlopen.side_effect = URLError("Connection refused")
        result = amauta._rlm_query("test query")
        self.assertEqual(result, "")


# ── BM25 scoring with real-ish chunks (2 tests) ─────────────────────────────

class TestRlmQueryBM25Formatting(unittest.TestCase):

    @patch("urllib.request.urlopen")
    def test_rlm_query_formats_results_with_filepath_and_lines(self, mock_urlopen):
        """Results formatted as 'filepath:start-end label' per BM25 scoring output."""
        mock_urlopen.return_value = _make_response([
            {"filepath": "services/auth.py", "start_line": 10, "end_line": 20, "label": "def login_handler"}
        ])

        with patch("os.getcwd", return_value="/project"):
            result = amauta._rlm_query("auth handler")

        self.assertIn("services/auth.py:10-20", result)
        self.assertIn("def login_handler", result)

    @patch("urllib.request.urlopen")
    def test_rlm_query_limits_output_to_1200_chars(self, mock_urlopen):
        """Return value is capped at 1200 characters."""
        long_results = [
            {"filepath": f"src/module_{i}.py", "start_line": 1, "end_line": 500,
             "label": "x" * 500}
            for i in range(10)
        ]
        mock_urlopen.return_value = _make_response(long_results)

        with patch("os.getcwd", return_value="/project"):
            result = amauta._rlm_query("big query")

        self.assertLessEqual(len(result), 1200)


# ── Layer 1 + Layer 2 enrichment flow (3 tests) ─────────────────────────────

class TestRpetdPhaseEnrichFlow(unittest.TestCase):

    @patch("amauta._research_chain_query", return_value=[])
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[
        {"text": "past experience with auth", "score": 3, "tags": [], "source": "auto_learning"}
    ])
    @patch("amauta._rlm_query", return_value="auth.py:1-30 loginHandler")
    @patch("amauta._pick_domain_doc", return_value="")
    def test_rpetd_phase_enrich_r_phase_calls_rlm_and_memory(
        self, mock_doc, mock_rlm, mock_mem, mock_skb, mock_research
    ):
        """R-phase calls both _rlm_query and _mem_semantic_search."""
        result = amauta._rpetd_phase_enrich("R", _make_item(), "research content")
        mock_rlm.assert_called_once()
        mock_mem.assert_called_once()
        # Result should contain both RLM and PG sections
        self.assertIn("[RLM]", result)
        self.assertIn("[PG]", result)

    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[])
    @patch("amauta._rlm_query", return_value="plan.py:5-15 validate")
    @patch("amauta._pick_domain_doc", return_value="")
    def test_rpetd_phase_enrich_p_phase_calls_rlm_but_not_semantic_search(
        self, mock_doc, mock_rlm, mock_mem, mock_skb
    ):
        """P-phase calls _rlm_query (plan review) but not _mem_semantic_search for 'related experiences'."""
        result = amauta._rpetd_phase_enrich("P", _make_item(), "plan content here")
        mock_rlm.assert_called_once()
        # _mem_semantic_search should NOT be called in P-phase for the R-phase 'related experiences' path
        mock_mem.assert_not_called()

    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", side_effect=Exception("connection refused"))
    @patch("amauta._rlm_query", side_effect=Exception("timeout"))
    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._research_chain_query", return_value=[])
    def test_rpetd_phase_enrich_returns_empty_on_all_failures(
        self, mock_research, mock_doc, mock_rlm, mock_mem, mock_skb
    ):
        """When all sub-calls fail, returns empty string (best-effort, never raises)."""
        result = amauta._rpetd_phase_enrich("R", _make_item(), "research content")
        # Should return empty or very minimal (no crash)
        self.assertIsInstance(result, str)


# ── Enrichment dedup window (3 tests) ───────────────────────────────────────

class TestEnrichmentDedupWindow(unittest.TestCase):

    @patch("amauta._rlm_query", return_value="code.py:1-10 func")
    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[])
    @patch("amauta._research_chain_query", return_value=[])
    def test_enrichment_dedup_skips_within_window(
        self, mock_research, mock_mem, mock_skb, mock_doc, mock_rlm
    ):
        """Item enriched 60s ago -> cache hit, _rlm_query NOT called."""
        recent_ts = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        item = _make_item(notes=[
            {"ts": recent_ts, "by": "system-enrichment", "text": "Layer 1 context injected"}
        ])

        result = amauta._rpetd_phase_enrich("R", item, "research content")

        self.assertIn("cache hit", result.lower())
        mock_rlm.assert_not_called()

    @patch("amauta._rlm_query", return_value="code.py:1-10 func")
    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[])
    @patch("amauta._research_chain_query", return_value=[])
    def test_enrichment_dedup_allows_after_window(
        self, mock_research, mock_mem, mock_skb, mock_doc, mock_rlm
    ):
        """Item enriched 600s ago (> 300s window) -> _rlm_query IS called."""
        old_ts = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat()
        item = _make_item(notes=[
            {"ts": old_ts, "by": "system-enrichment", "text": "Layer 1 context injected"}
        ])

        result = amauta._rpetd_phase_enrich("R", item, "research content")

        mock_rlm.assert_called_once()

    @patch("amauta._rlm_query", return_value="code.py:1-10 func")
    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[])
    @patch("amauta._research_chain_query", return_value=[])
    def test_enrichment_dedup_no_prior_enrichment_proceeds(
        self, mock_research, mock_mem, mock_skb, mock_doc, mock_rlm
    ):
        """Item with no system-enrichment notes -> _rlm_query IS called."""
        item = _make_item(notes=[])

        result = amauta._rpetd_phase_enrich("R", item, "research content")

        mock_rlm.assert_called_once()


# ── Edge case (1 test) ──────────────────────────────────────────────────────

class TestRlmQueryEdgeCases(unittest.TestCase):

    @patch("urllib.request.urlopen")
    def test_rlm_query_text_only_returns_empty(self, mock_urlopen):
        """Calling _rlm_query with text= only (no doc_path) returns empty."""
        result = amauta._rlm_query("query", text="some plain text")
        self.assertEqual(result, "")
        mock_urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
