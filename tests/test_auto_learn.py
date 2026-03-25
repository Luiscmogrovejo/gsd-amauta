#!/usr/bin/env python3
"""Tests for auto-learn workflow: D-phase extraction, full content storage, SKB dedup, web_search capture.

Verifies:
1. _auto_write_learning includes all RPETD phases in learning text
2. _auto_write_learning returns None when PG unavailable
3. Full D-phase content stored (not truncated)
4. Full R-phase content stored (not truncated)
5. Multiline E-phase content preserved
6. _auto_write_learning calls _skb_promote with correct params
7. _skb_promote skips duplicate by Jaccard >0.7
8. _skb_promote writes when no duplicate exists
9. _auto_write_learning extracts web_search findings
10. No web_search text => _mem_log_event called once
11. web_search_result metadata contains task_id
12. _auto_write_learning returns False on exception
13. _mem_log_event dedup prevents flooding (>=3 existing)

Run: python3 -m pytest tests/test_auto_learn.py -v
"""
import json
import os
import re
import sys
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch, call

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import amauta


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_item(rpetd=None, task_id="TK-AUTO-001", title="Test auto-learn task",
               tags=None, notes=None, success_criteria=None):
    """Build a minimal task dict suitable for _auto_write_learning."""
    phases = rpetd or {}
    all_filled = all(phases.get(ph, "").strip() for ph in ("R", "P", "E", "T", "D"))
    return {
        "id": task_id,
        "type": "task",
        "title": title,
        "status": "validation",
        "assigned_to": "executor-backend",
        "claimed_by": "executor-backend",
        "rpetd_phases": phases,
        "rpetd_complete": all_filled,
        "tags": tags or ["backend"],
        "notes": notes or [],
        "success_criteria": success_criteria or ["All tests pass"],
    }


def _full_rpetd(r_text="R: Research findings", p_text="P: Plan designed",
                e_text="E: Execution done", t_text="T: Tests pass",
                d_text="D: Delivered. LEARNING: key insight"):
    """Build a complete RPETD phases dict."""
    return {"R": r_text, "P": p_text, "E": e_text, "T": t_text, "D": d_text}


# ── D-phase LEARNING extraction Tests ───────────────────────────────────────

class TestAutoWriteLearningPhasesIncluded(unittest.TestCase):
    """_auto_write_learning includes all RPETD phases in learning text."""

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_includes_all_rpetd_phases(self, mock_pg, mock_log, mock_skb):
        """Learning text must contain R-phase, P-phase, E-phase, T-phase, D-phase sections."""
        item = _make_item(rpetd=_full_rpetd())
        amauta._auto_write_learning(item, "validator")

        # Get the text passed to _mem_log_event
        mock_log.assert_called()
        first_call_args = mock_log.call_args_list[0]
        learning_text = first_call_args[0][2]  # Third positional arg is text

        self.assertIn("R-phase findings:", learning_text)
        self.assertIn("P-phase design:", learning_text)
        self.assertIn("E-phase execution:", learning_text)
        self.assertIn("T-phase evidence:", learning_text)
        self.assertIn("D-phase delivery:", learning_text)


class TestAutoWriteLearningPgUnavailable(unittest.TestCase):
    """_auto_write_learning returns None when PG is unavailable."""

    @patch("amauta._mem_pg_available", return_value=False)
    def test_auto_write_learning_returns_none_when_pg_unavailable(self, mock_pg):
        """When PG is down, the function should return None (not False)."""
        item = _make_item(rpetd=_full_rpetd())
        result = amauta._auto_write_learning(item, "validator")
        self.assertIsNone(result)


# ── Full content storage -- no truncation Tests ──────────────────────────────

class TestAutoWriteLearningFullContent(unittest.TestCase):
    """_auto_write_learning stores full phase content without truncation."""

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_stores_full_d_phase_content(self, mock_pg, mock_log, mock_skb):
        """D-phase with 2000 chars must appear in full in learning text."""
        d_text = "D: " + "x" * 2000
        item = _make_item(rpetd=_full_rpetd(d_text=d_text))
        amauta._auto_write_learning(item, "validator")

        learning_text = mock_log.call_args_list[0][0][2]
        # The full 2000 chars should be present
        self.assertIn("x" * 2000, learning_text)

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_stores_full_r_phase_content(self, mock_pg, mock_log, mock_skb):
        """R-phase with 1500 chars of research must appear in full."""
        r_text = "R: " + "y" * 1500
        item = _make_item(rpetd=_full_rpetd(r_text=r_text))
        amauta._auto_write_learning(item, "validator")

        learning_text = mock_log.call_args_list[0][0][2]
        self.assertIn("y" * 1500, learning_text)

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_preserves_multiline_content(self, mock_pg, mock_log, mock_skb):
        """E-phase with newlines and code blocks must preserve all newlines."""
        e_text = "E: Line 1\n  - bullet\n  ```python\n  def foo():\n      pass\n  ```\nLine 2"
        item = _make_item(rpetd=_full_rpetd(e_text=e_text))
        amauta._auto_write_learning(item, "validator")

        learning_text = mock_log.call_args_list[0][0][2]
        self.assertIn("Line 1\n  - bullet", learning_text)
        self.assertIn("def foo():", learning_text)
        self.assertIn("Line 2", learning_text)


# ── SKB promotion dedup -- FIX-10 Tests ──────────────────────────────────────

class TestAutoWriteLearningSkbPromotion(unittest.TestCase):
    """_auto_write_learning calls _skb_promote with correct parameters."""

    @patch("amauta._skb_promote", return_value=True)
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_calls_skb_promote(self, mock_pg, mock_log, mock_skb):
        """_skb_promote called with LESSON: title, category='workflow', importance=5."""
        item = _make_item(rpetd=_full_rpetd(), title="Fix database connection pooling",
                          tags=["backend"])  # "backend" tag => code lane
        amauta._auto_write_learning(item, "validator")

        mock_skb.assert_called_once()
        call_kwargs = mock_skb.call_args
        # Check positional or keyword args
        skb_title = call_kwargs[1].get("title", "") or call_kwargs[0][0] if call_kwargs[0] else ""
        if not skb_title and call_kwargs[1]:
            skb_title = call_kwargs[1].get("title", "")
        self.assertTrue(skb_title.startswith("LESSON:"))
        self.assertEqual(call_kwargs[1].get("importance") or
                         (call_kwargs[0][5] if len(call_kwargs[0]) > 5 else None), 5)


class TestSkbPromoteJaccardDedup(unittest.TestCase):
    """_skb_promote skips duplicate when Jaccard >0.7."""

    @patch("amauta._pg_conn")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_skb_promote_skips_duplicate_by_jaccard(self, mock_pg, mock_pg_conn):
        """Existing SKB entry with Jaccard >0.7 causes _skb_promote to return False."""
        mock_cursor = MagicMock()
        # Return an existing entry that will have high Jaccard similarity
        mock_cursor.fetchall.return_value = [
            ("LESSON: Fix database pooling", "Learn about connection pooling in PostgreSQL for better performance")
        ]
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_pg_conn.return_value = mock_conn

        # Call with very similar content (Jaccard >0.7)
        result = amauta._skb_promote(
            title="LESSON: Fix database pooling",
            content="Learn about connection pooling in PostgreSQL for better performance and reliability",
            category="workflow",
            agent_id="executor-backend",
            importance=5
        )
        self.assertFalse(result)


class TestSkbPromoteWritesWhenNoDuplicate(unittest.TestCase):
    """_skb_promote writes when no duplicate exists."""

    @patch("amauta._pg_conn")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_skb_promote_writes_when_no_duplicate(self, mock_pg, mock_pg_conn):
        """No existing entries => INSERT INTO agent_shared_knowledge executed, returns True."""
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []  # No existing entries
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_pg_conn.return_value = mock_conn

        result = amauta._skb_promote(
            title="LESSON: New unique insight",
            content="Completely novel learning about testing patterns",
            category="workflow",
            agent_id="executor-backend",
            importance=5
        )
        self.assertTrue(result)
        # Verify INSERT was called
        execute_calls = mock_cursor.execute.call_args_list
        insert_found = any("INSERT INTO agent_shared_knowledge" in str(c) for c in execute_calls)
        self.assertTrue(insert_found, f"Expected INSERT INTO agent_shared_knowledge, got: {execute_calls}")


# ── web_search_result capture Tests ──────────────────────────────────────────

class TestAutoWriteLearningWebSearch(unittest.TestCase):
    """_auto_write_learning extracts web_search findings from R-phase."""

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_extracts_web_search_findings(self, mock_pg, mock_log, mock_skb):
        """R-phase with 'web_search findings:' triggers second _mem_log_event call."""
        r_text = "R: Research done. web_search findings: FastAPI uses Starlette under the hood for async routing"
        item = _make_item(rpetd=_full_rpetd(r_text=r_text))
        amauta._auto_write_learning(item, "validator")

        # Should be called twice: once for auto_learning, once for web_search_result
        self.assertEqual(mock_log.call_count, 2)
        # Second call should be web_search_result source
        second_call = mock_log.call_args_list[1]
        second_kwargs = second_call[1]  # keyword args
        self.assertEqual(second_kwargs.get("source"), "web_search_result")

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_no_web_search_skips_second_write(self, mock_pg, mock_log, mock_skb):
        """No web_search text in any phase => _mem_log_event called exactly once."""
        item = _make_item(rpetd=_full_rpetd())  # No web_search in default RPETD
        amauta._auto_write_learning(item, "validator")

        self.assertEqual(mock_log.call_count, 1)

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event")
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_web_search_metadata_has_task_id(self, mock_pg, mock_log, mock_skb):
        """web_search_result _mem_log_event call has metadata with task_id and event."""
        r_text = "R: web_search findings: pytest fixtures are powerful for setup/teardown"
        item = _make_item(rpetd=_full_rpetd(r_text=r_text), task_id="TK-WS-001")
        amauta._auto_write_learning(item, "validator")

        # Second call = web_search_result
        ws_call = mock_log.call_args_list[1]
        ws_metadata = ws_call[1].get("metadata", {})
        self.assertEqual(ws_metadata.get("task_id"), "TK-WS-001")
        self.assertEqual(ws_metadata.get("event"), "web_search_result")


# ── Edge Cases Tests ─────────────────────────────────────────────────────────

class TestAutoWriteLearningEdgeCases(unittest.TestCase):
    """Edge cases: exception handling and dedup flooding prevention."""

    @patch("amauta._skb_promote")
    @patch("amauta._mem_log_event", side_effect=Exception("DB error"))
    @patch("amauta._mem_pg_available", return_value=True)
    def test_auto_write_learning_returns_false_on_exception(self, mock_pg, mock_log, mock_skb):
        """Exception from _mem_log_event => _auto_write_learning returns False (never raises)."""
        item = _make_item(rpetd=_full_rpetd())
        result = amauta._auto_write_learning(item, "validator")
        self.assertFalse(result)

    @patch("amauta._skb_promote")
    @patch("amauta._mem_pg_available", return_value=True)
    @patch("amauta._pg_conn")
    def test_auto_write_learning_dedup_prevents_flooding(self, mock_pg_conn, mock_pg, mock_skb):
        """_mem_log_event checks existing count >=3 for same task_id; returns early."""
        # Mock PG conn to return count=3 for dedup check
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (3,)  # 3 existing entries
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_pg_conn.return_value = mock_conn

        item = _make_item(rpetd=_full_rpetd(), task_id="TK-FLOOD-001")

        # _mem_log_event should detect the 3 existing entries and return early
        # We need to actually call the real _mem_log_event to test its dedup logic
        amauta._mem_log_event(
            "executor-backend",
            ["task", "tk-flood-001"],
            "test learning text",
            source="auto_learning",
            metadata={"task_id": "TK-FLOOD-001"}
        )

        # The function should have returned early without trying to store via daemon
        # or direct SQL. The key assertion is that no INSERT was attempted after dedup check.
        execute_calls = [str(c) for c in mock_cursor.execute.call_args_list]
        insert_calls = [c for c in execute_calls if "INSERT" in c]
        self.assertEqual(len(insert_calls), 0,
                         f"Expected no INSERT after dedup (3 existing), got: {insert_calls}")


if __name__ == "__main__":
    unittest.main()
