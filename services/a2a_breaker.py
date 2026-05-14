#!/usr/bin/env python3
"""
services/a2a_breaker.py — Phase 56 A2A-05: Per agent-pair circuit breaker.

Valkey-backed state machine: CLOSED → OPEN (3 failures in 60s) → HALF_OPEN (after 60s) → CLOSED|OPEN.

Key format: a2a:breaker:<from_agent>:<to_agent>
Failure window key: a2a:breaker:<from_agent>:<to_agent>:failures (INCR + EXPIRE 60s)
Probe lock key: a2a:breaker:<from_agent>:<to_agent>:probe (SETNX EX 5s)

Fail-open: Valkey unavailability returns 'closed' / allows request through.
Does NOT import from amauta-daemon.py. Receives redis_client as injectable param.

References:
  - services/amauta-daemon.py L1663-1693 (BEHAV-02 /api/circuit-breaker/ pattern)
  - services/agent_hydrator.py L68 (circuit_breaker_open finding type vocab)
  - BREAKER_SCHEMA_VERSION = "1.0"
"""

import json
import os
import sys
import time
from typing import Any, Dict, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    import redis as redis_lib
    _HAS_REDIS = True
except ImportError:
    _HAS_REDIS = False
    redis_lib = None  # type: ignore

# ── Frozen constants (FROZEN — must appear verbatim for VC grep tests) ─────────
BREAKER_FAILURE_THRESHOLD: int = 3       # failures to trip breaker
BREAKER_WINDOW_S: int = 60               # sliding failure window seconds (Valkey TTL)
BREAKER_OPEN_DURATION_S: int = 60        # open → half-open transition seconds
BREAKER_KEY_PREFIX: str = "a2a:breaker"  # Valkey key prefix
BREAKER_SCHEMA_VERSION: str = "1.0"

# State tokens (FROZEN)
STATE_CLOSED: str = "closed"
STATE_OPEN: str = "open"
STATE_HALF_OPEN: str = "half_open"

# Probe lock TTL in seconds — expires to prevent a stuck probe from locking forever
_PROBE_LOCK_TTL_S: int = 5


def _breaker_key(from_agent: str, to_agent: str) -> str:
    """Return Valkey key for this agent pair."""
    return f"{BREAKER_KEY_PREFIX}:{from_agent}:{to_agent}"


def _read_breaker_data(key: str, redis_client) -> Optional[Dict[str, Any]]:
    """Read and parse the breaker JSON from Valkey. Returns None if key missing or parse error."""
    try:
        raw = redis_client.get(key)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)
    except Exception:
        return None


def _write_breaker_data(key: str, data: Dict[str, Any], redis_client) -> None:
    """Write breaker JSON to Valkey with no TTL (state persists until time check or explicit delete)."""
    redis_client.set(key, json.dumps(data))


def get_state(from_agent: str, to_agent: str, redis_client=None) -> str:
    """Return current breaker state: 'closed', 'open', or 'half_open'.

    Transitions OPEN → HALF_OPEN automatically when BREAKER_OPEN_DURATION_S
    has elapsed since opened_at. If Valkey is unavailable, returns 'closed'
    (fail-open: prefer availability over protection when infra is down).

    Args:
        from_agent: Source agent name.
        to_agent: Target agent name.
        redis_client: Optional injected redis.Redis client (for testing).

    Returns:
        One of STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN.
    """
    if redis_client is None:
        return STATE_CLOSED  # fail-open: no client injected

    try:
        key = _breaker_key(from_agent, to_agent)
        data = _read_breaker_data(key, redis_client)

        if data is None:
            return STATE_CLOSED

        state = data.get("state", STATE_CLOSED)

        if state == STATE_OPEN:
            opened_at = data.get("opened_at", 0.0)
            elapsed = time.time() - opened_at
            if elapsed >= BREAKER_OPEN_DURATION_S:
                # Auto-transition OPEN → HALF_OPEN
                data["state"] = STATE_HALF_OPEN
                _write_breaker_data(key, data, redis_client)
                return STATE_HALF_OPEN
            return STATE_OPEN

        return state

    except Exception:
        return STATE_CLOSED  # fail-open: Valkey unavailable


def record_failure(from_agent: str, to_agent: str, redis_client=None) -> str:
    """Record a failure for this agent pair. Returns new state after recording.

    Increments the failure counter with BREAKER_WINDOW_S TTL.
    If failure_count >= BREAKER_FAILURE_THRESHOLD and state is CLOSED,
    transitions to OPEN (sets state='open', opened_at=now, failure_count=N).

    If state is already OPEN or HALF_OPEN, refreshes opened_at (re-opens).

    Args:
        from_agent: Source agent name.
        to_agent: Target agent name.
        redis_client: Optional injected redis.Redis client (for testing).

    Returns:
        New state string after recording.
    """
    if redis_client is None:
        return STATE_CLOSED  # fail-open: no client injected

    try:
        key = _breaker_key(from_agent, to_agent)
        failures_key = f"{key}:failures"

        # Increment failure counter with sliding window TTL
        count = redis_client.incr(failures_key)
        redis_client.expire(failures_key, BREAKER_WINDOW_S)

        # Read current state
        data = _read_breaker_data(key, redis_client)
        current_state = data.get("state", STATE_CLOSED) if data else STATE_CLOSED

        if current_state == STATE_CLOSED:
            if count >= BREAKER_FAILURE_THRESHOLD:
                # Trip breaker: CLOSED → OPEN
                new_data = {
                    "state": STATE_OPEN,
                    "failure_count": count,
                    "opened_at": time.time(),
                    "schema_version": BREAKER_SCHEMA_VERSION,
                }
                _write_breaker_data(key, new_data, redis_client)
                return STATE_OPEN
            # Still below threshold — stay CLOSED
            return STATE_CLOSED

        elif current_state in (STATE_OPEN, STATE_HALF_OPEN):
            # Re-arm the timer (refresh opened_at)
            if data is None:
                data = {}
            data["state"] = STATE_OPEN
            data["opened_at"] = time.time()
            data["failure_count"] = count
            data.setdefault("schema_version", BREAKER_SCHEMA_VERSION)
            _write_breaker_data(key, data, redis_client)
            return STATE_OPEN

        return current_state

    except Exception:
        return STATE_CLOSED  # fail-open: Valkey unavailable


def record_success(from_agent: str, to_agent: str, redis_client=None) -> str:
    """Record a success for this agent pair. Returns new state after recording.

    If state is HALF_OPEN, transitions to CLOSED (probe succeeded).
    Deletes the Valkey key entirely (resets to clean closed state).

    If state is CLOSED or OPEN, does nothing (success when closed is fine;
    success from OPEN shouldn't happen — OPEN rejects requests before they fire).

    Args:
        from_agent: Source agent name.
        to_agent: Target agent name.
        redis_client: Optional injected redis.Redis client (for testing).

    Returns:
        New state string.
    """
    if redis_client is None:
        return STATE_CLOSED  # fail-open: no client injected

    try:
        key = _breaker_key(from_agent, to_agent)
        data = _read_breaker_data(key, redis_client)

        if data is None:
            return STATE_CLOSED

        current_state = data.get("state", STATE_CLOSED)

        if current_state == STATE_HALF_OPEN:
            # Probe succeeded — close the breaker
            probe_key = f"{key}:probe"
            failures_key = f"{key}:failures"
            redis_client.delete(key, probe_key, failures_key)
            return STATE_CLOSED

        # CLOSED or OPEN — success from OPEN is unexpected (breaker blocks before send)
        return current_state

    except Exception:
        return STATE_CLOSED  # fail-open: Valkey unavailable


def check_and_allow(from_agent: str, to_agent: str, redis_client=None) -> bool:
    """Return True if the request is allowed through, False if blocked.

    Rules:
    - CLOSED: allow (return True)
    - OPEN: block (return False) — caller raises A2AAgentUnavailableError
    - HALF_OPEN: allow exactly ONE probe at a time.
      Implemented via a Valkey SETNX probe-lock key `a2a:breaker:<from>:<to>:probe`
      with TTL 5s. If lock acquired → allow (return True, probe in flight).
      If lock already held → block (return False, another probe is in flight).

    On Valkey unavailability: return True (fail-open).

    Args:
        from_agent: Source agent name.
        to_agent: Target agent name.
        redis_client: Optional injected redis.Redis client (for testing).

    Returns:
        True if request may proceed, False if blocked.
    """
    if redis_client is None:
        return True  # fail-open: no client injected

    try:
        state = get_state(from_agent, to_agent, redis_client=redis_client)

        if state == STATE_CLOSED:
            return True

        if state == STATE_OPEN:
            return False

        if state == STATE_HALF_OPEN:
            # Exactly one probe allowed — use SETNX probe lock
            key = _breaker_key(from_agent, to_agent)
            probe_key = f"{key}:probe"
            # SET NX EX 5 — returns True if lock acquired, False/None if already held
            acquired = redis_client.set(probe_key, "1", nx=True, ex=_PROBE_LOCK_TTL_S)
            return bool(acquired)

        # Unknown state — fail-open
        return True

    except Exception:
        return True  # fail-open: Valkey unavailable
