"""
tests/test_a2a_client.py — Phase 55 A2A-03: structural tests for a2a_client.py.

AST-based structural verification (no PG required by default).
PG integration tests gated behind GSD_PG_INTEGRATION=true env var.

Never skips structural tests. Integration tests skip when GSD_PG_INTEGRATION unset.
"""

import ast
import inspect
import os
import sys
import unittest

_REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.a2a_client import (
    A2AError,
    A2ATimeoutError,
    A2AUnknownCapabilityError,
    A2AAgentUnavailableError,
    A2APayloadInvalidError,
    DEFAULT_TIMEOUT_S,
    POLL_INTERVAL_S,
    SCHEMA_VERSION,
    send_request,
    await_response,
    send_response,
    _validate_payload,
)

CLIENT_PY = os.path.join(_REPO_ROOT, "services", "a2a_client.py")


class TestSchemaVersionAndConstants(unittest.TestCase):
    def test_schema_version_is_1_0(self):
        """SCHEMA_VERSION is locked to '1.0' for Phase 55."""
        self.assertEqual(SCHEMA_VERSION, "1.0")

    def test_default_timeout_is_30s(self):
        """DEFAULT_TIMEOUT_S is 30 seconds (gray-area decision — caller-specified default)."""
        self.assertEqual(DEFAULT_TIMEOUT_S, 30.0)

    def test_poll_interval_is_100ms(self):
        """POLL_INTERVAL_S is 0.1 (100ms polling interval, gray-area decision 3)."""
        self.assertEqual(POLL_INTERVAL_S, 0.1)


class TestExceptionHierarchy(unittest.TestCase):
    """All 4 frozen error vocabulary tokens are defined in a2a_client.py."""

    def test_all_errors_inherit_from_a2a_error(self):
        """All A2A exception classes inherit from A2AError."""
        for cls in (A2ATimeoutError, A2AUnknownCapabilityError,
                    A2AAgentUnavailableError, A2APayloadInvalidError):
            self.assertTrue(
                issubclass(cls, A2AError),
                f"{cls.__name__} must inherit from A2AError"
            )

    def test_error_codes_frozen_vocabulary(self):
        """Each exception class has the correct frozen error_code token."""
        expected = {
            A2ATimeoutError: "a2a_timeout",
            A2AUnknownCapabilityError: "unknown_capability",
            A2AAgentUnavailableError: "agent_unavailable",
            A2APayloadInvalidError: "payload_invalid",
        }
        for cls, code in expected.items():
            self.assertEqual(
                cls.error_code, code,
                f"{cls.__name__}.error_code must be '{code}', got '{cls.error_code}'"
            )

    def test_a2a_error_to_dict_has_required_keys(self):
        """A2AError.to_dict() returns all 4 required keys."""
        exc = A2ATimeoutError("test timeout", correlation_id="abc-123")
        d = exc.to_dict()
        for key in ("error", "detail", "correlation_id", "schema_version"):
            self.assertIn(key, d, f"to_dict() missing key '{key}'")
        self.assertEqual(d["error"], "a2a_timeout")
        self.assertEqual(d["schema_version"], "1.0")


class TestFunctionSignatures(unittest.TestCase):
    """send_request, await_response, send_response have the correct signatures."""

    def test_send_request_signature(self):
        """send_request accepts (to, capability, payload, timeout, from_agent, conn)."""
        sig = inspect.signature(send_request)
        params = list(sig.parameters.keys())
        self.assertIn("to", params)
        self.assertIn("capability", params)
        self.assertIn("payload", params)
        self.assertIn("timeout", params)
        self.assertIn("from_agent", params)
        self.assertIn("conn", params)

    def test_await_response_signature(self):
        """await_response accepts (correlation_id, timeout, poll_interval, conn)."""
        sig = inspect.signature(await_response)
        params = list(sig.parameters.keys())
        self.assertIn("correlation_id", params)
        self.assertIn("timeout", params)
        self.assertIn("poll_interval", params)
        self.assertIn("conn", params)

    def test_send_response_signature(self):
        """send_response accepts (parent_correlation_id, payload, conn) — Risk §2 correction."""
        sig = inspect.signature(send_response)
        params = list(sig.parameters.keys())
        # Risk §2: parameter is parent_correlation_id (not correlation_id)
        self.assertIn("parent_correlation_id", params,
            "send_response first param must be parent_correlation_id (Risk §2 correction)")
        self.assertIn("payload", params)
        self.assertIn("conn", params)


class TestValidatePayload(unittest.TestCase):
    """_validate_payload enforces dict-only constraint."""

    def test_none_payload_raises_payload_invalid(self):
        """None payload raises A2APayloadInvalidError."""
        with self.assertRaises(A2APayloadInvalidError):
            _validate_payload(None)

    def test_string_payload_raises_payload_invalid(self):
        """String payload raises A2APayloadInvalidError."""
        with self.assertRaises(A2APayloadInvalidError):
            _validate_payload("not a dict")

    def test_empty_dict_is_valid(self):
        """Empty dict {} is valid (gray-area decision 8: empty body = '{}')."""
        result = _validate_payload({})
        self.assertEqual(result, "{}")

    def test_dict_payload_serializes_to_json(self):
        """Dict payload serializes to JSON string."""
        result = _validate_payload({"key": "value", "n": 42})
        import json
        parsed = json.loads(result)
        self.assertEqual(parsed["key"], "value")

    def test_non_serializable_raises_payload_invalid(self):
        """Non-serializable object in dict raises A2APayloadInvalidError."""
        with self.assertRaises(A2APayloadInvalidError):
            _validate_payload({"fn": lambda x: x})


class TestASTSourceInspection(unittest.TestCase):
    """AST-level source checks — no imports executed, pure text inspection."""

    def setUp(self):
        with open(CLIENT_PY) as f:
            self.source = f.read()
        self.tree = ast.parse(self.source)

    def test_four_frozen_error_codes_in_source(self):
        """All 4 frozen error vocabulary tokens appear in source."""
        for token in ("a2a_timeout", "unknown_capability", "agent_unavailable", "payload_invalid"):
            self.assertIn(token, self.source,
                f"Frozen error token '{token}' not found in a2a_client.py")

    def test_schema_version_string_in_source(self):
        """SCHEMA_VERSION = '1.0' appears in source."""
        self.assertIn('SCHEMA_VERSION = "1.0"', self.source)

    def test_poll_interval_comment_in_source(self):
        """100ms polling interval is documented."""
        self.assertIn("100ms", self.source)

    def test_pg_down_raises_agent_unavailable(self):
        """Source documents that PG-down mid-wait raises agent_unavailable."""
        self.assertIn("agent_unavailable", self.source)
        # Verify the await_response docstring mentions PG-down -> agent_unavailable
        self.assertIn("PG goes down", self.source)

    def test_risk_s2_parent_correlation_id_correction_applied(self):
        """Risk §2 correction: WHERE parent_correlation_id filter exists in _poll_once."""
        # The _poll_once query MUST use parent_correlation_id, NOT correlation_id,
        # because response rows get their own new UUID as correlation_id (PK).
        import re
        self.assertRegex(
            self.source,
            r"WHERE\s+parent_correlation_id",
            "_poll_once must filter on parent_correlation_id (Risk §2 correction)"
        )
        # parent_correlation_id must appear at least 3 times (INSERT + WHERE + param)
        count = self.source.count("parent_correlation_id")
        self.assertGreaterEqual(count, 3,
            f"parent_correlation_id must appear >= 3 times, found {count}")


@unittest.skipUnless(os.environ.get("GSD_PG_INTEGRATION"), "GSD_PG_INTEGRATION not set")
class TestA2AClientPGIntegration(unittest.TestCase):
    """PG integration tests — require live DB. Skipped unless GSD_PG_INTEGRATION=true."""

    def test_send_request_returns_correlation_id(self):
        """send_request() inserts row and returns 36-char UUID string."""
        corr_id = send_request(
            to="gsd-reviewer",
            capability="review_file",
            payload={"file": "test.py"},
            timeout=5,
            from_agent="test-operator",
        )
        self.assertIsInstance(corr_id, str)
        self.assertEqual(len(corr_id), 36,
            f"correlation_id must be 36-char UUID, got: {corr_id!r}")

    def test_send_response_and_await_roundtrip(self):
        """Full round-trip: send_request -> send_response -> await_response."""
        corr_id = send_request(
            to="gsd-reviewer",
            capability="review_file",
            payload={"file": "roundtrip.py"},
            timeout=5,
            from_agent="test-operator",
        )
        send_response(corr_id, {"result": "approve", "findings": []})
        response = await_response(corr_id, timeout=5)
        self.assertIsInstance(response, dict)
        self.assertEqual(response.get("result"), "approve")

    def test_await_response_timeout(self):
        """await_response() raises A2ATimeoutError when no response arrives."""
        corr_id = send_request(
            to="gsd-reviewer",
            capability="review_file",
            payload={},
            timeout=1,
            from_agent="test-operator",
        )
        # No send_response() call — should timeout
        with self.assertRaises(A2ATimeoutError):
            await_response(corr_id, timeout=0.3, poll_interval=0.05)


if __name__ == "__main__":
    unittest.main()
