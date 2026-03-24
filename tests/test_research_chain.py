#!/usr/bin/env python3
"""Tests for research chain auto-invocation in R-phase.

Verifies:
1. _research_chain_query() calls gsd-research.cjs with correct args
2. _research_chain_query() handles timeout gracefully
3. _research_chain_query() handles missing node gracefully
4. _research_chain_query() handles missing script gracefully
5. _research_chain_query() handles nonzero exit gracefully
6. _research_chain_query() caps results at limit
7. _research_chain_query() handles nested provider JSON format
8. R-phase invokes research chain when memory returns <2 results
9. R-phase does NOT invoke research chain when memory returns >=2 results
10. R-phase does NOT invoke research chain in E-phase

Run: python3 -m pytest tests/test_research_chain.py -v
"""
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock
import subprocess

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import amauta


class TestResearchChainQuery(unittest.TestCase):
    """Tests for _research_chain_query() helper."""

    @patch("subprocess.run")
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_calls_research_script_with_correct_args(self, mock_isfile, mock_which, mock_run):
        """Should invoke gsd-research.cjs with correct arguments."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "query": "pgvector embedding search",
                "results": [{
                    "provider": "perplexity",
                    "count": 1,
                    "results": [
                        {"text": "Found: Voyage AI embeddings use cosine similarity for vector search", "source": "perplexity"}
                    ]
                }]
            })
        )
        results = amauta._research_chain_query("pgvector embedding search", limit=3)
        self.assertEqual(len(results), 1)
        self.assertIn("Voyage AI", results[0]["text"])
        self.assertEqual(results[0]["source"], "perplexity")
        # Verify subprocess args
        call_args = mock_run.call_args[0][0]
        self.assertIn("search", call_args)
        self.assertIn("--json", call_args)
        self.assertIn("--limit", call_args)
        self.assertIn("3", call_args)

    @patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="node", timeout=45))
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_timeout_returns_empty(self, mock_isfile, mock_which, mock_run):
        """On timeout, should return empty list."""
        results = amauta._research_chain_query("slow query")
        self.assertEqual(results, [])

    @patch("shutil.which", return_value=None)
    def test_no_node_returns_empty(self, mock_which):
        """When node is not installed, should return empty list."""
        results = amauta._research_chain_query("any query")
        self.assertEqual(results, [])

    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=False)
    def test_missing_script_returns_empty(self, mock_isfile, mock_which):
        """When gsd-research.cjs is missing, should return empty list."""
        results = amauta._research_chain_query("any query")
        self.assertEqual(results, [])

    @patch("subprocess.run")
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_nonzero_exit_returns_empty(self, mock_isfile, mock_which, mock_run):
        """On subprocess failure (nonzero exit), should return empty list."""
        mock_run.return_value = MagicMock(returncode=1, stdout="")
        results = amauta._research_chain_query("failing query")
        self.assertEqual(results, [])

    @patch("subprocess.run")
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_results_capped_at_limit(self, mock_isfile, mock_which, mock_run):
        """Should return at most `limit` results."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "query": "test",
                "results": [{
                    "provider": "perplexity",
                    "count": 10,
                    "results": [
                        {"text": f"Result {i} with enough text to pass the length check easily", "source": "perplexity"}
                        for i in range(10)
                    ]
                }]
            })
        )
        results = amauta._research_chain_query("query", limit=3)
        self.assertLessEqual(len(results), 3)

    @patch("subprocess.run")
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_handles_nested_provider_format(self, mock_isfile, mock_which, mock_run):
        """Should handle { results: [ { provider, results: [...] } ] } format from gsd-research.cjs."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "query": "test query",
                "results": [
                    {
                        "provider": "memory",
                        "count": 1,
                        "results": [
                            {"text": "Memory result from prior session with enough chars to pass filter", "source": "memory"}
                        ]
                    },
                    {
                        "provider": "perplexity",
                        "count": 1,
                        "results": [
                            {"text": "Perplexity result with detailed web findings from 2025 research papers", "source": "perplexity"}
                        ]
                    }
                ]
            })
        )
        results = amauta._research_chain_query("test query", limit=3)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["source"], "memory")
        self.assertEqual(results[1]["source"], "perplexity")

    @patch("subprocess.run")
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_filters_short_results(self, mock_isfile, mock_which, mock_run):
        """Should filter out results with text <= 20 chars."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "query": "test",
                "results": [{
                    "provider": "memory",
                    "count": 2,
                    "results": [
                        {"text": "too short"},
                        {"text": "This is a long enough result that should pass the 20-char minimum filter"}
                    ]
                }]
            })
        )
        results = amauta._research_chain_query("query")
        self.assertEqual(len(results), 1)
        self.assertIn("long enough", results[0]["text"])

    @patch("subprocess.run")
    @patch("shutil.which", return_value="/usr/local/bin/node")
    @patch("os.path.isfile", return_value=True)
    def test_truncates_long_text_to_500(self, mock_isfile, mock_which, mock_run):
        """Should cap each result text at 500 chars."""
        long_text = "A" * 1000
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "query": "test",
                "results": [{
                    "provider": "perplexity",
                    "count": 1,
                    "results": [{"text": long_text}]
                }]
            })
        )
        results = amauta._research_chain_query("query")
        self.assertEqual(len(results), 1)
        self.assertLessEqual(len(results[0]["text"]), 500)


class TestRPhaseResearchChainIntegration(unittest.TestCase):
    """Tests for research chain invocation during R-phase enrichment."""

    def test_invoked_when_few_memory_results(self):
        """Research chain should fire when memory returns <2 results."""
        item = {
            "id": "TK-TEST",
            "title": "Implement quantum flux capacitor",
            "description": "Novel feature with no prior art in existing codebase",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_semantic_search", return_value=[]), \
             patch.object(amauta, "_skb_search", return_value=[]), \
             patch.object(amauta, "_research_chain_query", return_value=[
                 {"text": "Research finding about flux capacitors from the web", "source": "perplexity"}
             ]) as mock_research:
            result = amauta._rpetd_phase_enrich("R", item, "researching...")

        mock_research.assert_called_once()
        self.assertIn("RESEARCH", result)

    def test_not_invoked_when_enough_memory(self):
        """Research chain should NOT fire when memory returns >=2 results."""
        item = {
            "id": "TK-TEST",
            "title": "Deploy Authentik SSO",
            "description": "SSO setup for homelab services",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        many_results = [
            {"text": f"Past experience {i} with SSO deployment and troubleshooting steps",
             "score": 5, "tags": [], "source": "auto_learning"}
            for i in range(5)
        ]

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_semantic_search", return_value=many_results), \
             patch.object(amauta, "_skb_search", return_value=[]), \
             patch.object(amauta, "_research_chain_query") as mock_research:
            amauta._rpetd_phase_enrich("R", item, "researching...")

        mock_research.assert_not_called()

    def test_not_invoked_in_e_phase(self):
        """Research chain should NOT fire in E-phase (only R-phase)."""
        item = {
            "id": "TK-TEST",
            "title": "Some task for testing phases",
            "description": "desc for testing",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_pg_available", return_value=False), \
             patch.object(amauta, "_research_chain_query") as mock_research:
            amauta._rpetd_phase_enrich("E", item, "executing...")

        mock_research.assert_not_called()

    def test_not_invoked_in_t_phase(self):
        """Research chain should NOT fire in T-phase."""
        item = {
            "id": "TK-TEST",
            "title": "Another task for phase testing",
            "description": "desc for testing",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_pg_available", return_value=False), \
             patch.object(amauta, "_research_chain_query") as mock_research:
            amauta._rpetd_phase_enrich("T", item, "test output: 10 passed")

        mock_research.assert_not_called()

    def test_research_label_in_output(self):
        """Research chain output should have [RESEARCH] label and source tags."""
        item = {
            "id": "TK-TEST2",
            "title": "Build novel embedding pipeline",
            "description": "Totally new domain with no prior work",
            "success_criteria": [],
            "rpetd_phases": {},
        }

        with patch.object(amauta, "_rlm_query", return_value=""), \
             patch.object(amauta, "_mem_semantic_search", return_value=[]), \
             patch.object(amauta, "_skb_search", return_value=[]), \
             patch.object(amauta, "_research_chain_query", return_value=[
                 {"text": "Voyage AI v3 uses 1024-dim embeddings with cosine similarity", "source": "perplexity"},
                 {"text": "pgvector supports HNSW index for fast nearest-neighbor search", "source": "memory"}
             ]):
            result = amauta._rpetd_phase_enrich("R", item, "researching novel domain...")

        self.assertIn("[RESEARCH]", result)
        self.assertIn("[perplexity]", result)
        self.assertIn("[memory]", result)
        self.assertIn("auto-invoked", result)


if __name__ == "__main__":
    unittest.main()
