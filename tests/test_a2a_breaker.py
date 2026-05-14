#!/usr/bin/env python3
"""
tests/test_a2a_breaker.py — Phase 56 A2A-05: Circuit breaker state machine tests.

All tests use mocked Valkey (no live redis required).
Tests grouped into:
  TestBreakerConstants — frozen vocabulary
  TestBreakerKeyFormat — key naming convention
  TestBreakerStateMachine — CLOSED/OPEN/HALF_OPEN transitions
  TestBreakerProbe — HALF_OPEN probe lock (SETNX)
  TestBreakerFailOpen — Valkey unavailability degrades gracefully
  TestA2AClientBreakerIntegration — _check_breaker wired in send_request
"""

import json
import os
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

_REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.a2a_breaker import (
    BREAKER_FAILURE_THRESHOLD,
    BREAKER_WINDOW_S,
    BREAKER_OPEN_DURATION_S,
    BREAKER_KEY_PREFIX,
    BREAKER_SCHEMA_VERSION,
    STATE_CLOSED,
    STATE_OPEN,
    STATE_HALF_OPEN,
    _breaker_key,
    get_state,
    record_failure,
    record_success,
    check_and_allow,
)


def _make_redis_mock():
    """Build a MagicMock that behaves like a Valkey redis.Redis client."""
    mock = MagicMock()
    mock.get.return_value = None
    mock.set.return_value = True
    mock.incr.return_value = 1
    mock.expire.return_value = True
    mock.delete.return_value = 1
    return mock


def _make_closed_redis():
    """Redis mock that returns no key (closed state)."""
    mock = _make_redis_mock()
    mock.get.return_value = None
    return mock


def _make_open_redis(failure_count=3, opened_at=None):
    """Redis mock that returns an OPEN breaker state."""
    mock = _make_redis_mock()
    if opened_at is None:
        opened_at = time.time()
    data = json.dumps({
        "state": STATE_OPEN,
        "failure_count": failure_count,
        "opened_at": opened_at,
        "schema_version": BREAKER_SCHEMA_VERSION,
    })
    mock.get.return_value = data.encode("utf-8")
    return mock


def _make_half_open_redis(opened_at=None):
    """Redis mock that returns a HALF_OPEN breaker state."""
    mock = _make_redis_mock()
    if opened_at is None:
        opened_at = time.time() - BREAKER_OPEN_DURATION_S - 1
    data = json.dumps({
        "state": STATE_HALF_OPEN,
        "failure_count": 3,
        "opened_at": opened_at,
        "schema_version": BREAKER_SCHEMA_VERSION,
    })
    mock.get.return_value = data.encode("utf-8")
    return mock


class TestBreakerConstants(unittest.TestCase):
    """Verify frozen constants match Phase 56 A2A-05 spec."""

    def test_failure_threshold(self):
        """BREAKER_FAILURE_THRESHOLD must be exactly 3."""
        self.assertEqual(BREAKER_FAILURE_THRESHOLD, 3)

    def test_window_s(self):
        """BREAKER_WINDOW_S must be exactly 60."""
        self.assertEqual(BREAKER_WINDOW_S, 60)

    def test_open_duration_s(self):
        """BREAKER_OPEN_DURATION_S must be exactly 60."""
        self.assertEqual(BREAKER_OPEN_DURATION_S, 60)

    def test_key_prefix(self):
        """BREAKER_KEY_PREFIX must be 'a2a:breaker'."""
        self.assertEqual(BREAKER_KEY_PREFIX, "a2a:breaker")

    def test_schema_version(self):
        """BREAKER_SCHEMA_VERSION must be '1.0'."""
        self.assertEqual(BREAKER_SCHEMA_VERSION, "1.0")

    def test_state_tokens(self):
        """All three state tokens must match frozen spec."""
        self.assertEqual(STATE_CLOSED, "closed")
        self.assertEqual(STATE_OPEN, "open")
        self.assertEqual(STATE_HALF_OPEN, "half_open")


class TestBreakerKeyFormat(unittest.TestCase):
    """Verify key naming convention."""

    def test_key_format(self):
        """Key must follow a2a:breaker:<from>:<to> format."""
        key = _breaker_key("gsd-executor", "gsd-reviewer")
        self.assertEqual(key, "a2a:breaker:gsd-executor:gsd-reviewer")

    def test_key_prefix_present(self):
        """Key must start with BREAKER_KEY_PREFIX."""
        key = _breaker_key("alpha", "beta")
        self.assertTrue(key.startswith(BREAKER_KEY_PREFIX))


class TestBreakerStateMachine(unittest.TestCase):
    """State machine transition tests: CLOSED/OPEN/HALF_OPEN."""

    def test_initial_state_is_closed(self):
        """get_state on missing key returns STATE_CLOSED."""
        mock = _make_closed_redis()
        state = get_state("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_CLOSED)

    def test_failure_below_threshold_stays_closed(self):
        """2 failures (below threshold of 3) — breaker stays CLOSED."""
        mock = _make_redis_mock()
        mock.get.return_value = None
        mock.incr.return_value = 1
        record_failure("from_agent", "to_agent", redis_client=mock)
        mock.incr.return_value = 2
        state = record_failure("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_CLOSED)

    def test_third_failure_opens_breaker(self):
        """3rd failure (at threshold) transitions CLOSED → OPEN."""
        mock = _make_redis_mock()
        mock.get.return_value = None  # no key = CLOSED
        mock.incr.return_value = 3   # 3rd failure hits threshold
        state = record_failure("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_OPEN)

    def test_open_breaker_blocks_request(self):
        """check_and_allow() returns False when breaker is OPEN."""
        mock = _make_open_redis(opened_at=time.time())
        result = check_and_allow("from_agent", "to_agent", redis_client=mock)
        self.assertFalse(result)

    def test_closed_breaker_allows_request(self):
        """check_and_allow() returns True when breaker is CLOSED."""
        mock = _make_closed_redis()
        result = check_and_allow("from_agent", "to_agent", redis_client=mock)
        self.assertTrue(result)

    def test_open_transitions_to_half_open_after_duration(self):
        """get_state with opened_at 61s ago returns STATE_HALF_OPEN."""
        opened_at = time.time() - 61  # 61 seconds ago (> BREAKER_OPEN_DURATION_S=60)
        mock = _make_open_redis(opened_at=opened_at)
        state = get_state("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_HALF_OPEN)

    def test_half_open_does_not_transition_before_duration(self):
        """get_state with opened_at 59s ago returns STATE_OPEN (not yet half_open)."""
        opened_at = time.time() - 59  # 59 seconds ago (< BREAKER_OPEN_DURATION_S=60)
        mock = _make_open_redis(opened_at=opened_at)
        state = get_state("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_OPEN)

    def test_success_from_half_open_closes_breaker(self):
        """record_success when HALF_OPEN transitions to STATE_CLOSED and deletes key."""
        mock = _make_half_open_redis()
        state = record_success("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_CLOSED)
        # Verify delete was called on the main key
        mock.delete.assert_called()


class TestBreakerProbe(unittest.TestCase):
    """HALF_OPEN probe lock (SETNX) tests."""

    def test_half_open_first_probe_allowed(self):
        """HALF_OPEN + SETNX returns True → check_and_allow() returns True."""
        mock = _make_half_open_redis()
        # SETNX acquired (lock available)
        mock.set.return_value = True
        result = check_and_allow("from_agent", "to_agent", redis_client=mock)
        self.assertTrue(result)

    def test_half_open_second_probe_blocked(self):
        """HALF_OPEN + SETNX returns None (lock held) → check_and_allow() returns False."""
        mock = _make_half_open_redis()
        # SETNX not acquired (lock already held)
        mock.set.return_value = None
        result = check_and_allow("from_agent", "to_agent", redis_client=mock)
        self.assertFalse(result)

    def test_successful_probe_closes_breaker(self):
        """record_success when half_open → STATE_CLOSED."""
        mock = _make_half_open_redis()
        state = record_success("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_CLOSED)


class TestBreakerFailOpen(unittest.TestCase):
    """Valkey unavailability degrades gracefully (fail-open)."""

    def test_valkey_unavailable_get_state_returns_closed(self):
        """redis.get raises Exception → get_state returns STATE_CLOSED."""
        mock = _make_redis_mock()
        mock.get.side_effect = Exception("connection refused")
        state = get_state("from_agent", "to_agent", redis_client=mock)
        self.assertEqual(state, STATE_CLOSED)

    def test_valkey_unavailable_check_and_allow_returns_true(self):
        """redis exception in get_state path → check_and_allow returns True (allow)."""
        mock = _make_redis_mock()
        mock.get.side_effect = Exception("timeout")
        result = check_and_allow("from_agent", "to_agent", redis_client=mock)
        self.assertTrue(result)

    def test_valkey_unavailable_record_failure_does_not_raise(self):
        """redis exception in record_failure → no raise (fail-open, returns STATE_CLOSED)."""
        mock = _make_redis_mock()
        mock.incr.side_effect = Exception("connection refused")
        # Should not raise — fail-open
        try:
            state = record_failure("from_agent", "to_agent", redis_client=mock)
            self.assertEqual(state, STATE_CLOSED)
        except Exception as exc:
            self.fail(f"record_failure raised unexpectedly: {exc}")


class TestA2AClientBreakerIntegration(unittest.TestCase):
    """Verify _check_breaker and record_* helpers are wired in a2a_client.py."""

    def test_check_breaker_function_exists(self):
        """_check_breaker must be importable from services.a2a_client."""
        from services.a2a_client import _check_breaker
        self.assertTrue(callable(_check_breaker))

    def test_record_a2a_failure_function_exists(self):
        """record_a2a_failure must be importable from services.a2a_client."""
        from services.a2a_client import record_a2a_failure
        self.assertTrue(callable(record_a2a_failure))

    def test_record_a2a_success_function_exists(self):
        """record_a2a_success must be importable from services.a2a_client."""
        from services.a2a_client import record_a2a_success
        self.assertTrue(callable(record_a2a_success))

    def test_check_breaker_raises_unavailable_when_blocked(self):
        """_check_breaker raises A2AAgentUnavailableError when check_and_allow returns False."""
        import services.a2a_client as client_mod
        from services.a2a_client import A2AAgentUnavailableError, _check_breaker

        original_has_breaker = client_mod._HAS_BREAKER
        original_check_and_allow = client_mod.check_and_allow
        try:
            client_mod._HAS_BREAKER = True
            client_mod.check_and_allow = lambda *args, **kwargs: False
            with self.assertRaises(A2AAgentUnavailableError):
                _check_breaker("agent-a", "agent-b")
        finally:
            client_mod._HAS_BREAKER = original_has_breaker
            client_mod.check_and_allow = original_check_and_allow


if __name__ == "__main__":
    unittest.main(verbosity=2)
