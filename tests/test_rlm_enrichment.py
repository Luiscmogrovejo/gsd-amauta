#!/usr/bin/env python3
"""Tests for RLM enrichment integration in amauta.py.

Verifies:
1. _rpetd_phase_enrich calls _rlm_query for ALL 5 phases without doc_path gate
2. _enrich_task_context includes 2 RLM queries at claim-time
3. RLM results appear in enrichment output

Run: python3 -m pytest tests/test_rlm_enrichment.py -v
"""
import os
import sys
import time
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

import amauta


class TestRpetdPhaseEnrichGateFree(unittest.TestCase):
    """Verify _rpetd_phase_enrich calls RLM on all phases without doc_path gate."""

    def _make_item(self, title="Test task", desc="Test description"):
        return {
            "id": "TK-TEST",
            "title": title,
            "description": desc,
            "success_criteria": ["criterion 1", "criterion 2"],
            "rpetd_phases": {"P": "plan content", "T": "test content"},
            "status": "in-progress",
            "claimed_by": "executor-backend",
        }

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="test.py:1-10 testFunction")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    def test_r_phase_calls_rlm_without_docpath(self, mock_skb, mock_pg, mock_rlm, mock_doc):
        """R-phase should call _rlm_query even when _pick_domain_doc returns empty."""
        result = amauta._rpetd_phase_enrich("R", self._make_item(), "research content")
        mock_rlm.assert_called_once()
        self.assertIn("[RLM]", result)
        self.assertIn("test.py", result)

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="src/plan.py:5-20 planValidator")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    def test_p_phase_calls_rlm_without_docpath(self, mock_skb, mock_pg, mock_rlm, mock_doc):
        """P-phase should call _rlm_query even when _pick_domain_doc returns empty."""
        result = amauta._rpetd_phase_enrich("P", self._make_item(), "plan content here")
        mock_rlm.assert_called_once()
        self.assertIn("[RLM]", result)

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="src/exec.py:10-30 executor")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    def test_e_phase_calls_rlm_without_docpath(self, mock_skb, mock_pg, mock_rlm, mock_doc):
        """E-phase should call _rlm_query even when _pick_domain_doc returns empty."""
        result = amauta._rpetd_phase_enrich("E", self._make_item(), "executed the code changes successfully")
        mock_rlm.assert_called_once()
        self.assertIn("[RLM]", result)

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="tests/test_x.py:1-15 testSuite")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    def test_t_phase_calls_rlm_without_docpath(self, mock_skb, mock_pg, mock_rlm, mock_doc):
        """T-phase enrichment is disabled (TOK-02). Returns empty string, no RLM call."""
        result = amauta._rpetd_phase_enrich("T", self._make_item(), "all 5 tests pass")
        # TOK-02: T-phase early return -- no RLM call, no enrichment output
        mock_rlm.assert_not_called()
        self.assertEqual(result, "")

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="amauta.py:100-120 delivery")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    def test_d_phase_calls_rlm_without_docpath(self, mock_skb, mock_pg, mock_rlm, mock_doc):
        """D-phase RLM delivery check removed (TOK-02). Memory writes still fire via _mem_pg_available."""
        result = amauta._rpetd_phase_enrich("D", self._make_item(), "delivery: PR merged, all criteria met")
        # TOK-02: D-phase RLM call removed -- enrichment output is empty string
        mock_rlm.assert_not_called()
        self.assertEqual(result, "")

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[])
    @patch("amauta._research_chain_query", return_value=[])
    def test_rlm_empty_result_no_crash(self, mock_research, mock_mem_search, mock_skb, mock_pg, mock_rlm, mock_doc):
        """When RLM returns empty, enrichment should still work (best-effort)."""
        result = amauta._rpetd_phase_enrich("R", self._make_item(), "research")
        # Should not crash and should not include [RLM] in output
        mock_rlm.assert_called_once()
        self.assertNotIn("[RLM]", result)


class TestEnrichTaskContextRLM(unittest.TestCase):
    """Verify _enrich_task_context includes 2 RLM queries."""

    def _make_item(self):
        return {
            "id": "TK-CLAIM",
            "title": "Add user authentication endpoint",
            "description": "Implement OAuth2 login flow with JWT tokens",
            "dependencies": [],
            "sprint": "",
            "notes": [],
            "claimed_by": "executor-backend",
            "assigned_to": "executor-backend",
            "status": "open",
        }

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._agent_performance_summary", return_value=None)
    def test_layer1_makes_two_rlm_queries(self, mock_perf, mock_skb, mock_pg, mock_rlm, mock_doc):
        """Layer 1 enrichment should make exactly 2 RLM queries."""
        mock_rlm.side_effect = [
            "auth.py:1-30 loginHandler",        # Query 1: existing implementations
            "middleware.py:5-20 authMiddleware",  # Query 2: patterns
        ]
        result = amauta._enrich_task_context(self._make_item(), [])
        self.assertEqual(mock_rlm.call_count, 2)
        self.assertIn("Existing implementations", result)
        self.assertIn("Patterns to follow", result)
        self.assertIn("auth.py", result)
        self.assertIn("middleware.py", result)

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._agent_performance_summary", return_value=None)
    def test_layer1_rlm_empty_no_crash(self, mock_perf, mock_skb, mock_pg, mock_rlm, mock_doc):
        """When both RLM queries return empty, enrichment continues without RLM sections."""
        result = amauta._enrich_task_context(self._make_item(), [])
        self.assertNotIn("Existing implementations", result)
        self.assertNotIn("Patterns to follow", result)

    @patch("amauta._pick_domain_doc", return_value="/some/kb/doc.md")
    @patch("amauta._rlm_query", return_value="found.py:1-10 function")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._agent_performance_summary", return_value=None)
    def test_layer1_passes_docpath_to_rlm(self, mock_perf, mock_skb, mock_pg, mock_rlm, mock_doc):
        """When _pick_domain_doc returns a path, it should be passed to _rlm_query."""
        amauta._enrich_task_context(self._make_item(), [])
        for call in mock_rlm.call_args_list:
            self.assertEqual(call.kwargs.get("doc_path", call[1].get("doc_path", "")),
                             "/some/kb/doc.md")

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="x" * 2000)
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._agent_performance_summary", return_value=None)
    def test_layer1_rlm_output_capped(self, mock_perf, mock_skb, mock_pg, mock_rlm, mock_doc):
        """RLM output in Layer 1 should be capped at 600 chars per query."""
        result = amauta._enrich_task_context(self._make_item(), [])
        # Each [RLM] section should not contain more than ~600 chars of RLM content
        # (the full _rlm_query returns 2000 but Layer 1 caps at 600)
        sections = [s for s in result.split("\n\n") if "[RLM]" in s]
        for section in sections:
            # Section = label line (up to ~70 chars) + "  " indent + 600 content
            # Label example: "[RLM] Existing implementations (start here, don't rewrite):\n  "
            self.assertLessEqual(len(section), 750,
                                 f"RLM section exceeds cap ({len(section)} chars)")


class TestEnrichmentTiming(unittest.TestCase):
    """Verify enrichment completes within latency budget."""

    @patch("amauta._pick_domain_doc", return_value="")
    @patch("amauta._rlm_query", return_value="")
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._skb_search", return_value=[])
    @patch("amauta._mem_semantic_search", return_value=[])
    def test_all_phases_under_budget(self, mock_sem, mock_skb, mock_pg, mock_rlm, mock_doc):
        """Full RPETD cycle (5 phases) should complete within 1.5s with mocked RLM."""
        item = {
            "id": "TK-TIME",
            "title": "Performance test task",
            "description": "Check enrichment timing",
            "success_criteria": ["fast"],
            "rpetd_phases": {"P": "plan", "T": "tests pass"},
            "status": "in-progress",
            "claimed_by": "executor-backend",
        }

        t0 = time.time()
        for phase in ["R", "P", "E", "T", "D"]:
            amauta._rpetd_phase_enrich(phase, item, f"{phase}-phase content with enough text to pass length checks")
        elapsed = time.time() - t0

        self.assertLess(elapsed, 1.5,
                        f"5-phase enrichment took {elapsed:.2f}s, budget is 1.5s")


if __name__ == "__main__":
    unittest.main()
