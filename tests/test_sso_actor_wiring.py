#!/usr/bin/env python3
"""Tests for SSO-04: OIDC sub claim injected as actor in audit records.

Tests:
  - When SSO disabled: actor stored as "local" (not None)
  - When SSO enabled with valid sub: actor stored as sub claim value
  - When caller sends explicit actor in body: body wins, oidc_sub not used
  - Edge: SSO enabled but sub missing from token -> actor falls back to None

These tests exercise the /api/audit/log POST handler logic directly by
simulating the handler's actor resolution: `body.get("actor") or oidc_sub or None`.

Run with:
  python3 tests/test_sso_actor_wiring.py
  python3 -m pytest tests/test_sso_actor_wiring.py -v
"""
import os
import sys
import tempfile
import unittest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore


def _resolve_actor(body_actor, oidc_sub):
    """Replicate the fixed handler logic: body.get("actor") or self._oidc_sub or None."""
    return body_actor or oidc_sub or None


class TestActorResolutionLogic(unittest.TestCase):
    """Unit tests for the actor resolution expression used in the handler fix."""

    def test_sso_disabled_no_body_actor_gives_local(self):
        """SSO disabled: _check_oidc returns sub='local', body has no actor."""
        result = _resolve_actor(body_actor=None, oidc_sub="local")
        self.assertEqual(result, "local")

    def test_sso_enabled_valid_token_gives_sub_claim(self):
        """SSO enabled, valid token: sub claim used as actor when body has no actor."""
        result = _resolve_actor(body_actor=None, oidc_sub="user-abc-123")
        self.assertEqual(result, "user-abc-123")

    def test_body_actor_wins_over_oidc_sub(self):
        """Explicit actor in body takes precedence over OIDC sub."""
        result = _resolve_actor(body_actor="agent-executor-1", oidc_sub="user-abc-123")
        self.assertEqual(result, "agent-executor-1")

    def test_body_actor_wins_when_sso_disabled(self):
        """Explicit actor in body takes precedence even when SSO is disabled."""
        result = _resolve_actor(body_actor="validator-agent", oidc_sub="local")
        self.assertEqual(result, "validator-agent")

    def test_edge_sso_enabled_missing_sub_gives_none(self):
        """Edge case: SSO enabled but sub not extracted from token -> None."""
        result = _resolve_actor(body_actor=None, oidc_sub=None)
        self.assertIsNone(result)

    def test_empty_string_body_actor_falls_through_to_oidc_sub(self):
        """Empty string actor in body is falsy -- OIDC sub should be used."""
        result = _resolve_actor(body_actor="", oidc_sub="user-xyz")
        self.assertEqual(result, "user-xyz")


class TestActorStoredInAuditRecord(unittest.TestCase):
    """Integration tests: verify actor value ends up in stored audit record."""

    def setUp(self):
        self.tmpfile = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmpfile.close()
        self.store = SQLiteStore(db_path=self.tmpfile.name)

    def tearDown(self):
        self.store.close()
        os.unlink(self.tmpfile.name)

    def test_actor_local_stored_correctly(self):
        """actor='local' (SSO disabled path) is stored and retrievable."""
        self.store.audit_log(
            task_id="TK-9001",
            event_type="validation",
            actor="local",
            status="pass",
        )
        results = self.store.audit_query(task_id="TK-9001")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["actor"], "local")

    def test_actor_sub_claim_stored_correctly(self):
        """actor=sub_claim (SSO enabled path) is stored and retrievable."""
        self.store.audit_log(
            task_id="TK-9002",
            event_type="validation",
            actor="user@example.com",
            status="pass",
        )
        results = self.store.audit_query(task_id="TK-9002")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["actor"], "user@example.com")

    def test_actor_none_stored_when_both_absent(self):
        """actor=None when both body and oidc_sub are absent."""
        self.store.audit_log(
            task_id="TK-9003",
            event_type="validation",
            actor=None,
            status="pass",
        )
        results = self.store.audit_query(task_id="TK-9003")
        self.assertEqual(len(results), 1)
        self.assertIsNone(results[0]["actor"])

    def test_explicit_agent_actor_not_overwritten(self):
        """Explicit agent_id as actor is preserved -- not replaced by oidc_sub."""
        self.store.audit_log(
            task_id="TK-9004",
            event_type="rpetd",
            actor="executor-backend",
            agent_id="executor-backend",
            phase="E",
        )
        results = self.store.audit_query(task_id="TK-9004")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["actor"], "executor-backend")


class TestDaemonHandlerActorFix(unittest.TestCase):
    """Verify the handler source code has the correct fix applied.

    This is a static code check -- it does not run the daemon.
    It confirms the fix was applied and the old bare form is gone.
    """

    def _read_daemon_source(self):
        daemon_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "services", "amauta-daemon.py"
        )
        with open(daemon_path, "r") as f:
            return f.read()

    def test_fixed_actor_expression_present(self):
        """The fixed actor line must be present in the daemon source."""
        source = self._read_daemon_source()
        self.assertIn(
            'actor=body.get("actor") or self._oidc_sub or None',
            source,
            "Fixed actor expression not found in amauta-daemon.py"
        )

    def test_bare_actor_expression_absent(self):
        """The old bare actor=body.get('actor') line (without oidc_sub) must be gone."""
        source = self._read_daemon_source()
        # The old line had exactly: actor=body.get("actor"),
        # After fix it must include 'or self._oidc_sub'
        lines_with_actor = [
            ln.strip() for ln in source.splitlines()
            if 'actor=body.get("actor")' in ln
        ]
        for ln in lines_with_actor:
            self.assertIn(
                "self._oidc_sub",
                ln,
                f"Found actor line without oidc_sub injection: {ln!r}"
            )


if __name__ == "__main__":
    unittest.main()
