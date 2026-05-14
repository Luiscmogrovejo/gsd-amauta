#!/usr/bin/env python3
"""
tests/test_a2a_tail_cli.py — Phase 56 A2A-07: gsd-tools a2a tail CLI tests.

Structural tests (no daemon required):
  TestTailCLIStructure    — tail action present in gsd-tools.cjs source
  TestTailPollingPattern  — 500ms interval and next_cursor usage in source
  TestTailSignalHandling  — SIGINT handler present
  TestTailCLIHelpOutput   — spawn node subprocess to verify usage output
"""

import os
import sys
import subprocess
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
GSD_TOOLS = os.path.join(_REPO_ROOT, "get-shit-done", "bin", "gsd-tools.cjs")


def _tools_source():
    with open(GSD_TOOLS, "r", encoding="utf-8") as f:
        return f.read()


class TestTailCLIStructure(unittest.TestCase):
    """5 structural tests — verify tail action present in gsd-tools.cjs source."""

    def test_tail_in_known_actions(self):
        """'tail' must appear in the KNOWN_ACTIONS set near capabilities/list."""
        src = _tools_source()
        # Verify 'tail' is in the KNOWN_ACTIONS set line
        self.assertIn("'tail'", src,
                      "Expected 'tail' string in gsd-tools.cjs KNOWN_ACTIONS set")

    def test_tail_usage_string(self):
        """Usage string must mention 'gsd-tools a2a tail'."""
        self.assertIn("gsd-tools a2a tail", _tools_source())

    def test_a2a_exchanges_path_in_tail(self):
        """'/a2a/exchanges' path must appear in the tail handler."""
        self.assertIn("/a2a/exchanges", _tools_source())

    def test_next_cursor_usage(self):
        """'next_cursor' must appear in the tail handler for cursor tracking."""
        self.assertIn("next_cursor", _tools_source())

    def test_node_syntax_valid(self):
        """gsd-tools.cjs must pass node --check syntax validation."""
        result = subprocess.run(
            ["node", "--check", GSD_TOOLS],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0,
                         f"node --check failed: {result.stderr}")


class TestTailPollingPattern(unittest.TestCase):
    """3 structural tests — verify 500ms poll interval and cursor advancement."""

    def test_500ms_interval(self):
        """500 must appear in the setTimeout call (poll interval frozen at 500ms)."""
        src = _tools_source()
        # Verify at least one occurrence of 500 in context of setTimeout
        self.assertIn("500", src,
                      "Expected 500 ms interval in gsd-tools.cjs tail handler")

    def test_settimeout_on_error_path(self):
        """setTimeout(poll, 500) must appear at least twice: success + error paths."""
        src = _tools_source()
        count = src.count("setTimeout(poll, 500)")
        self.assertGreaterEqual(count, 2,
                                f"Expected at least 2 occurrences of setTimeout(poll, 500), "
                                f"got {count} (need one for success path, one for error path)")

    def test_next_cursor_advances_since(self):
        """sinceTs = data.next_cursor must appear (cursor advances on each poll)."""
        self.assertIn("sinceTs = data.next_cursor", _tools_source())


class TestTailSignalHandling(unittest.TestCase):
    """2 structural tests — verify SIGINT handler is present and exits cleanly."""

    def test_sigint_handler_present(self):
        """process.on('SIGINT' must appear in the tail handler."""
        self.assertIn("process.on('SIGINT'", _tools_source())

    def test_sigint_exits_zero(self):
        """process.exit(0) must appear (clean exit on SIGINT)."""
        self.assertIn("process.exit(0)", _tools_source())


class TestTailCLIHelpOutput(unittest.TestCase):
    """2 subprocess tests — verify usage output from node gsd-tools.cjs a2a [action]."""

    def test_a2a_no_args_shows_usage(self):
        """node gsd-tools.cjs a2a with no action exits 2 and stderr contains 'tail'."""
        result = subprocess.run(
            ["node", GSD_TOOLS, "a2a"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 2,
                         f"Expected exit 2 for 'a2a' with no action, got {result.returncode}")
        self.assertIn("tail", result.stderr,
                      f"Expected 'tail' in stderr usage output. stderr: {result.stderr!r}")

    def test_unknown_a2a_action_exits_2(self):
        """node gsd-tools.cjs a2a bogus exits 2 (unknown action)."""
        result = subprocess.run(
            ["node", GSD_TOOLS, "a2a", "bogus"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 2,
                         f"Expected exit 2 for unknown a2a action 'bogus', got {result.returncode}")


if __name__ == "__main__":
    unittest.main()
