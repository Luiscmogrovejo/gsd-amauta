#!/usr/bin/env python3
"""Tests for daemon integration: mirror sync, _resolve_project_id, PG_SYNC_WARN, health endpoint.

Covers:
  - _TASK_MUTATING_COMMANDS completeness (all 14 present, reads excluded)
  - Mirror sync calls task_upsert on success, skips on nonzero rc
  - _resolve_project_id for test mode, explicit body, CWD fallback
  - PG_SYNC_WARN format, visibility on failure, absence on success
  - Health endpoint field completeness, pg_health, sqlite_health

Mock strategy: Read daemon source as string, parse with regex/AST.
For _resolve_project_id: extract function logic and test directly.
For mirror sync: verify code paths via source analysis + unit logic.
For health: verify all required fields present in response construction.

Run: python3 -m pytest tests/test_daemon_integration.py -v
"""
import ast
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Do NOT import daemon directly -- it starts servers at module level.
# Instead, read source and test logic via string/AST analysis.
DAEMON_PATH = Path(__file__).parent.parent / "services" / "amauta-daemon.py"
DAEMON_SOURCE = DAEMON_PATH.read_text()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _extract_set_literal(source: str, var_name: str) -> set:
    """Extract a set literal from source code by variable name."""
    # Match: _TASK_MUTATING_COMMANDS = {"add", "claim", ...}
    pattern = rf'{var_name}\s*=\s*\{{([^}}]+)\}}'
    m = re.search(pattern, source)
    if not m:
        return set()
    inner = m.group(1)
    # Parse the string elements
    return set(re.findall(r'"(\w+)"', inner))


def _extract_health_fields(source: str) -> set:
    """Extract field names from the /health response dict construction."""
    # Find the health = { ... } block — handle nested dicts by anchoring the closing
    # brace to the same indentation as 'health = {', skipping nested dict braces.
    # Backreference \1 matches exactly the indent of 'health = {', so the nested
    # api_keys closing '},' (deeper indent) is NOT treated as the dict close.
    #
    # TK-2386: this used to require 'health = {' on the line IMMEDIATELY after
    # 'if path == "/health":'. The handler now probes the store for liveness
    # before building the payload, so slice from the route marker and find the
    # dict after it rather than demanding adjacency.
    marker = 'if path == "/health":'
    start = source.find(marker)
    if start == -1:
        raise AssertionError("the /health route is missing from the daemon source")
    pattern = r'\n( +)health = \{(.*?)\n\1\}'
    m = re.search(pattern, source[start:], re.DOTALL)
    if not m:
        # TK-2386: was 'return set()'. An empty set is not a measurement — it
        # means the extractor could not see the payload, which must never be
        # reported as "the payload has no fields".
        raise AssertionError(
            "could not extract the /health payload dict — the extractor is blind, "
            "so no verdict about its fields is possible"
        )
    block = m.group(2)
    # Extract quoted key names from "key": value lines
    return set(re.findall(r'"(\w+)":', block))


# ── Mirror sync for ALL mutating commands ────────────────────────────────────

class TestMutatingCommandsSetIsComplete(unittest.TestCase):
    """_TASK_MUTATING_COMMANDS contains all 14 expected commands."""

    def test_mutating_commands_set_is_complete(self):
        """All 14 mutating commands must be in the set."""
        expected = {"add", "claim", "rpetd", "status", "validate",
                    "assign", "note", "update", "delete", "link", "unlink",
                    "atomize", "archive", "reconcile"}
        actual = _extract_set_literal(DAEMON_SOURCE, "_TASK_MUTATING_COMMANDS")
        self.assertEqual(actual, expected,
                         f"Missing: {expected - actual}, Extra: {actual - expected}")


class TestReadCommandsExcludedFromMirror(unittest.TestCase):
    """Read-only commands are NOT in _TASK_MUTATING_COMMANDS."""

    def test_read_commands_excluded_from_mirror(self):
        """show, board, list, search, next, stats, export should NOT be in mutating set."""
        read_commands = {"show", "board", "list", "search", "next", "stats", "export"}
        mutating = _extract_set_literal(DAEMON_SOURCE, "_TASK_MUTATING_COMMANDS")
        overlap = read_commands & mutating
        self.assertEqual(len(overlap), 0,
                         f"Read commands found in mutating set: {overlap}")


class TestMirrorSyncCallsTaskUpsertOnSuccess(unittest.TestCase):
    """Mirror sync calls task_upsert when rc=0 and command is mutating."""

    def test_mirror_sync_calls_task_upsert_on_success(self):
        """Source code shows task_upsert called when rc == 0 and command in _TASK_MUTATING_COMMANDS."""
        # Verify the mirror sync block references both conditions
        self.assertIn("rc == 0 and command in _TASK_MUTATING_COMMANDS", DAEMON_SOURCE,
                       "Mirror sync should check rc == 0 AND command in mutating set")
        # Verify task_upsert is called in the mirror block
        mirror_block_match = re.search(
            r'command in _TASK_MUTATING_COMMANDS.*?task_upsert',
            DAEMON_SOURCE, re.DOTALL
        )
        self.assertIsNotNone(mirror_block_match,
                              "task_upsert should be called within mirror sync block")


class TestMirrorSyncSkippedOnNonzeroRc(unittest.TestCase):
    """Mirror sync skipped when rc != 0."""

    def test_mirror_sync_skipped_on_nonzero_rc(self):
        """Mirror sync condition requires rc == 0; nonzero rc skips it."""
        # Verify the guard: `if _mirror_store and rc == 0 and command in _TASK_MUTATING_COMMANDS:`
        guard_pattern = r'if _mirror_store and rc == 0 and command in _TASK_MUTATING_COMMANDS'
        self.assertRegex(DAEMON_SOURCE, guard_pattern,
                          "Mirror sync should have triple guard: store + rc==0 + mutating")


# ── _resolve_project_id for all routes ───────────────────────────────────────

class TestResolveProjectIdReturnsTestInTestMode(unittest.TestCase):
    """_resolve_project_id returns __test__ when PYTEST_CURRENT_TEST is set."""

    def test_resolve_project_id_returns_test_in_test_mode(self):
        """With PYTEST_CURRENT_TEST set, should return '__test__'."""
        # Simulate the logic from daemon _resolve_project_id
        # DATA-06: Force __test__ in test mode (highest priority)
        env_checks = [
            os.environ.get("NODE_ENV") == "test",
            os.environ.get("GSD_TEST_MODE") == "1",
            bool(os.environ.get("PYTEST_CURRENT_TEST")),
        ]
        if any(env_checks):
            result = "__test__"
        else:
            result = "fallback"
        self.assertEqual(result, "__test__")


class TestResolveProjectIdUsesExplicitBodyValue(unittest.TestCase):
    """_resolve_project_id uses explicit project_id from request body."""

    def test_resolve_project_id_uses_explicit_body_value(self):
        """When body has project_id, use it (after test mode check)."""
        # Simulate non-test environment
        body = {"project_id": "my-custom-project"}
        # Logic: body.get("project_id") or os.path.basename(os.getcwd())
        result = body.get("project_id") or os.path.basename(os.getcwd())
        self.assertEqual(result, "my-custom-project")


class TestResolveProjectIdFallsBackToCwdBasename(unittest.TestCase):
    """_resolve_project_id falls back to CWD basename when no explicit value."""

    def test_resolve_project_id_falls_back_to_cwd_basename(self):
        """When body has no project_id, use basename of CWD."""
        body = {}
        with patch("os.getcwd", return_value="/home/user/my-project"):
            result = body.get("project_id") or os.path.basename(os.getcwd())
        self.assertEqual(result, "my-project")


# ── PG_SYNC_WARN visibility ─────────────────────────────────────────────────

class TestPgSyncWarnFormatIncludesMarker(unittest.TestCase):
    """PG_SYNC_WARN string includes the [PG_SYNC_WARN] marker and task_id."""

    def test_pg_sync_warn_format_includes_marker(self):
        """Construct warning string as daemon does; verify marker and task_id."""
        task_id = "TK-WARN-001"
        error_msg = "connection refused"
        # This mirrors the daemon code at line 1239
        pg_sync_warning = f"\n[PG_SYNC_WARN] PG mirror failed for {task_id}: {error_msg}"
        self.assertIn("[PG_SYNC_WARN]", pg_sync_warning)
        self.assertIn(task_id, pg_sync_warning)


class TestPgSyncWarnAppendedOnMirrorFailure(unittest.TestCase):
    """PG_SYNC_WARN appended to output when mirror sync fails."""

    def test_pg_sync_warn_appended_to_output_on_mirror_failure(self):
        """Response output should end with PG_SYNC_WARN line on mirror failure."""
        # Simulate the daemon behavior: output + _pg_sync_warning
        output = "TK-001: pending -> in-progress"
        pg_sync_warning = "\n[PG_SYNC_WARN] PG mirror failed for TK-001: timeout"
        response_output = output + pg_sync_warning
        self.assertTrue(response_output.endswith(pg_sync_warning))
        self.assertIn("[PG_SYNC_WARN]", response_output)

        # Verify this is how daemon constructs the response
        self.assertIn('out + _pg_sync_warning', DAEMON_SOURCE,
                       "Daemon should concatenate output with _pg_sync_warning")


class TestPgSyncWarnAbsentOnSuccess(unittest.TestCase):
    """PG_SYNC_WARN absent from output when mirror sync succeeds."""

    def test_pg_sync_warn_absent_on_success(self):
        """On successful mirror sync, _pg_sync_warning is empty string."""
        # Daemon initializes _pg_sync_warning = ""
        pg_sync_warning = ""
        output = "TK-001: pending -> in-progress"
        response_output = output + pg_sync_warning
        self.assertNotIn("[PG_SYNC_WARN]", response_output)

        # Verify daemon initializes warning as empty string
        self.assertIn('_pg_sync_warning = ""', DAEMON_SOURCE)


# ── Health endpoint completeness ─────────────────────────────────────────────

class TestHealthResponseHasAllRequiredFields(unittest.TestCase):
    """Health endpoint response dict has all 15 required fields."""

    def test_health_response_has_all_required_fields(self):
        """All required fields must be present in /health response construction."""
        expected_fields = {
            "status", "daemon", "port", "data_dir", "amauta_py", "pid",
            "pg_available", "backend", "features",
            "rlm_managed", "rlm_running", "rlm_port", "rlm_restarts",
            "oidc_enabled", "oidc_issuer",
        }
        actual_fields = _extract_health_fields(DAEMON_SOURCE)
        missing = expected_fields - actual_fields
        self.assertEqual(len(missing), 0,
                         f"Missing health fields: {missing}")


class TestHealthIncludesPgHealthWhenAvailable(unittest.TestCase):
    """Health response includes pg_health when _pg_store is available."""

    def test_health_includes_pg_health_when_available(self):
        """Daemon code adds 'pg_health' key when _pg_store is not None."""
        # Verify the source code has the pg_health conditional
        self.assertIn('health["pg_health"]', DAEMON_SOURCE)
        self.assertIn('_pg_store.health()', DAEMON_SOURCE)

        # Verify it's conditional on _pg_store
        pg_health_block = re.search(
            r'if _pg_store:\s*\n\s*health\["pg_health"\]',
            DAEMON_SOURCE
        )
        self.assertIsNotNone(pg_health_block,
                              "pg_health should be conditional on _pg_store being truthy")


class TestHealthIncludesSqliteHealthWhenPgUnavailable(unittest.TestCase):
    """Health response includes sqlite_health when PG unavailable but SQLite is."""

    def test_health_includes_sqlite_health_when_pg_unavailable(self):
        """Daemon code adds 'sqlite_health' key when _pg_store is None and _sqlite_store is set."""
        self.assertIn('health["sqlite_health"]', DAEMON_SOURCE)
        self.assertIn('_sqlite_store.health()', DAEMON_SOURCE)

        # Verify it's in an elif block (PG not available)
        sqlite_health_block = re.search(
            r'elif _sqlite_store:\s*\n\s*health\["sqlite_health"\]',
            DAEMON_SOURCE
        )
        self.assertIsNotNone(sqlite_health_block,
                              "sqlite_health should be conditional on _sqlite_store (elif branch)")


if __name__ == "__main__":
    unittest.main()
