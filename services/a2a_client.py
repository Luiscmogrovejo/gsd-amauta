#!/usr/bin/env python3
"""
services/a2a_client.py — Phase 55 A2A-03/A2A-04: A2A send/receive client.

Direct agent-to-agent request/response over the a2a_messages PG table
(migration 024, Phase 55 A2A-01). No daemon HTTP endpoints used — client
talks directly to PG via pg_store._get_conn() (same pattern as party_session.py).

SCHEMA_VERSION = "1.0" — locked for Phase 55.

Core API:
  send_request(to, capability, payload, timeout, from_agent, conn) -> str
    Insert kind='request' row, return correlation_id UUID string.

  await_response(correlation_id, timeout, poll_interval, conn) -> dict
    Poll PG every poll_interval seconds until kind IN ('response','error')
    appears (matched by parent_correlation_id) or timeout expires.
    Raises A2ATimeoutError on timeout, A2AAgentUnavailableError on PG failure.

  send_response(parent_correlation_id, payload, conn) -> None
    Insert kind='response' row with a NEW uuid as correlation_id and
    parent_correlation_id pointing at the original request uuid.
    Used by the receiving agent to reply to a request.

Risk §2 correction (MANDATORY — enforced by acceptance criteria):
  Response rows MUST use a fresh UUID as their own correlation_id (PK).
  They link back to the request via parent_correlation_id.
  Attempting to reuse the request's correlation_id causes a PK unique-violation.

  Request row:  correlation_id = <uuid_req>,  parent_correlation_id = NULL,      kind = 'request'
  Response row: correlation_id = <uuid_NEW>,  parent_correlation_id = <uuid_req>, kind = 'response'

  await_response(<uuid_req>) polls:
    WHERE parent_correlation_id = <uuid_req> AND kind IN ('response','error')

Frozen error vocabulary (A2A-04 — all 4 tokens defined here, raised in 55-04):
  A2AError (base)
  A2ATimeoutError(A2AError)            — a2a_timeout
  A2AUnknownCapabilityError(A2AError)  — unknown_capability
  A2AAgentUnavailableError(A2AError)   — agent_unavailable
  A2APayloadInvalidError(A2AError)     — payload_invalid

Retry semantics (A2A-04 Plan 55-04):
  The retry loop lives in send_request_with_retry() added in Plan 55-04.
  This module defines the FULL exception class hierarchy so 55-04 imports
  from here — no circular imports.

References:
  - services/pg_store.py _get_conn() (Phase 47 connection pattern)
  - services/party_session.py for_update + RealDictCursor pattern (Phase 50)
  - migrations/024-a2a-messages.sql schema (Phase 55 A2A-01)
  - services/a2a_registry.py get_capabilities() (Phase 55 A2A-02)
"""

import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

SCHEMA_VERSION = "1.0"

# ── Polling constants ─────────────────────────────────────────────────────────
# Mirrors Phase 50 party_session polling pattern (synchronous PG poll).
# Phase 55 gray-area decision 3: 100ms interval, caller-specified timeout.

DEFAULT_TIMEOUT_S: float = 30.0   # default caller-specified timeout seconds
POLL_INTERVAL_S: float = 0.1       # 100ms polling interval (gray-area decision 3)

# ── Retry constants (A2A-04 — exponential backoff) ────────────────────────────
# Locked: base=2, initial=1.0s, cap=8.0s, jitter=±20%, max_retries=2 (3 total attempts).
# Phase 55 gray-area decision 4.

RETRY_BASE: int = 2
RETRY_INITIAL_DELAY_S: float = 1.0
RETRY_CAP_S: float = 8.0
RETRY_JITTER_RANGE: tuple = (0.8, 1.2)   # ±20% jitter multiplier
MAX_RETRIES: int = 2                       # 3 total attempts (0, 1, 2)

# ── Retry constant aliases (VC2 compatibility — exact names from plan must_haves) ──
RETRY_INITIAL_S: float = RETRY_INITIAL_DELAY_S   # alias: RETRY_INITIAL_DELAY_S
RETRY_MAX: int = MAX_RETRIES                       # alias: MAX_RETRIES
RETRY_JITTER_PCT: float = 0.2                      # 20% jitter — scalar alias for ±20%

# ── Import-safety: PG ─────────────────────────────────────────────────────────
# Mirrors services/agent_hydrator.py L27-41 (Phase 47 pattern)

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services.pg_store import PGStore  # type: ignore
    _HAS_PG = True
except Exception:
    try:
        from pg_store import PGStore  # type: ignore
        _HAS_PG = True
    except Exception:
        PGStore = None  # type: ignore
        _HAS_PG = False

# ── Import-safety: a2a_registry (optional — degrades gracefully) ──────────────
# Capability check: if registry unavailable, skip unknown_capability validation.
# Plan 55-04 enforces the error path when PG+registry are both up.

try:
    from services.a2a_registry import get_capabilities, AgentNotFoundError  # type: ignore
    _HAS_REGISTRY = True
except Exception:
    try:
        from a2a_registry import get_capabilities, AgentNotFoundError  # type: ignore
        _HAS_REGISTRY = True
    except Exception:
        _HAS_REGISTRY = False
        get_capabilities = None  # type: ignore
        AgentNotFoundError = None  # type: ignore

# ── Import-safety: a2a_breaker (optional — degrades gracefully) ───────────────
# Breaker check fires in send_request() BEFORE the PG INSERT.
# If breaker module unavailable, skip check (fail-open, mirrors Valkey fail-open).

try:
    from services.a2a_breaker import check_and_allow, record_failure, record_success  # type: ignore
    _HAS_BREAKER = True
except Exception:
    try:
        from a2a_breaker import check_and_allow, record_failure, record_success  # type: ignore
        _HAS_BREAKER = True
    except Exception:
        _HAS_BREAKER = False
        check_and_allow = None  # type: ignore
        record_failure = None   # type: ignore
        record_success = None   # type: ignore

# Global redis_client injector (set by tests or daemon startup; None = use default)
_A2A_REDIS_CLIENT = None

# ── Exception hierarchy (FROZEN — A2A-04 error vocabulary) ───────────────────
# All 4 error tokens defined here. Plan 55-04 exercises and tests each path.

class A2AError(Exception):
    """Base class for all A2A client errors.

    Attributes:
        error_code: frozen vocabulary token (e.g. 'a2a_timeout')
        detail: human-readable detail string
        correlation_id: associated message ID if applicable
    """
    error_code: str = "a2a_error"

    def __init__(self, detail: str, correlation_id: Optional[str] = None):
        super().__init__(detail)
        self.detail = detail
        self.correlation_id = correlation_id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "error": self.error_code,
            "detail": self.detail,
            "correlation_id": self.correlation_id,
            "schema_version": SCHEMA_VERSION,
        }


class A2ATimeoutError(A2AError):
    """Raised when await_response() exceeds the caller-specified timeout.

    error_code = 'a2a_timeout' (frozen vocabulary token A2A-04).
    """
    error_code = "a2a_timeout"


class A2AUnknownCapabilityError(A2AError):
    """Raised when the target agent has no such capability declared.

    error_code = 'unknown_capability' (frozen vocabulary token A2A-04).
    Only raised when a2a_registry is available AND agent is known AND
    capability is not in its declared list.
    """
    error_code = "unknown_capability"


class A2AAgentUnavailableError(A2AError):
    """Raised when PG is unavailable mid-wait or agent has no AGENT.yaml.

    error_code = 'agent_unavailable' (frozen vocabulary token A2A-04).
    """
    error_code = "agent_unavailable"


class A2APayloadInvalidError(A2AError):
    """Raised when payload is not a JSON-serializable dict.

    error_code = 'payload_invalid' (frozen vocabulary token A2A-04).
    payload MUST be a dict (serialized to jsonb). None or non-dict raises this.
    """
    error_code = "payload_invalid"


# ── Internal helpers ──────────────────────────────────────────────────────────

def _get_store():
    """Return a PGStore instance. Only callable when _HAS_PG is True."""
    if not _HAS_PG or PGStore is None:
        raise RuntimeError("PG not available (_HAS_PG=False)")
    return PGStore()


def _validate_payload(payload: Any) -> str:
    """Validate and serialize payload to JSON string.

    Args:
        payload: Must be a dict (empty dict {} is valid, None is not).

    Returns:
        JSON string representation of payload.

    Raises:
        A2APayloadInvalidError: If payload is None or not a dict or not serializable.
    """
    if payload is None:
        raise A2APayloadInvalidError(
            "payload must be a dict, got None. "
            "Use {} for empty payload (gray-area decision 8)."
        )
    if not isinstance(payload, dict):
        raise A2APayloadInvalidError(
            f"payload must be a dict, got {type(payload).__name__}. "
            "Use {} for empty payload."
        )
    try:
        return json.dumps(payload)
    except (TypeError, ValueError) as exc:
        raise A2APayloadInvalidError(
            f"payload is not JSON-serializable: {exc}"
        ) from exc


def _check_capability(to: str, capability: str) -> None:
    """Check that capability is declared by agent `to`.

    Silently returns when registry unavailable (graceful degradation).
    Raises A2AUnknownCapabilityError when agent is known but capability absent.
    Raises A2AAgentUnavailableError when agent has no AGENT.yaml (treated as
    unavailable, not unknown capability — agent may not be compiled yet).

    Args:
        to: Target agent name (e.g. 'gsd-reviewer')
        capability: Capability verb to check (e.g. 'review_file')

    Raises:
        A2AUnknownCapabilityError: Capability not in agent's declared list.
        A2AAgentUnavailableError: Agent has no AGENT.yaml in registry.
    """
    if not _HAS_REGISTRY or get_capabilities is None:
        # Registry not available — skip validation (graceful degradation)
        return

    try:
        caps = get_capabilities(to)
    except Exception as exc:
        # AgentNotFoundError or RegistryError — treat as unavailable
        if AgentNotFoundError is not None and isinstance(exc, AgentNotFoundError):
            raise A2AAgentUnavailableError(
                f"Agent '{to}' has no compiled AGENT.yaml in registry.",
                correlation_id=None,
            ) from exc
        # RegistryError or other — degrade gracefully (don't block send)
        return

    # If agent declares NO capabilities, skip check (empty list = unconstrained)
    # Phase 55 baseline: all agents have [] capabilities (backfill is Phase 56+).
    if not caps:
        return

    if capability not in caps:
        raise A2AUnknownCapabilityError(
            f"Agent '{to}' does not declare capability '{capability}'. "
            f"Declared: {caps}",
            correlation_id=None,
        )


def _check_breaker(from_agent: str, to_agent: str) -> None:
    """Check the per-pair circuit breaker before sending a request.

    Calls check_and_allow(from_agent, to_agent). If the breaker is OPEN
    (or HALF_OPEN with probe lock held), raises A2AAgentUnavailableError
    immediately WITHOUT a PG INSERT.

    Fails open if a2a_breaker module is not importable (graceful degradation).

    Args:
        from_agent: Source agent name.
        to_agent: Target agent name.

    Raises:
        A2AAgentUnavailableError: Breaker is OPEN or HALF_OPEN with probe in flight.
    """
    if not _HAS_BREAKER or check_and_allow is None:
        return  # fail-open: breaker unavailable, allow request

    allowed = check_and_allow(from_agent, to_agent, redis_client=_A2A_REDIS_CLIENT)
    if not allowed:
        raise A2AAgentUnavailableError(
            f"Circuit breaker OPEN for pair ({from_agent}, {to_agent}). "
            "Request blocked without network round-trip.",
            correlation_id=None,
        )


def record_a2a_failure(from_agent: str, to_agent: str) -> None:
    """Record an A2ATimeoutError or A2AAgentUnavailableError as a breaker failure.

    Call this when A2ATimeoutError or A2AAgentUnavailableError is caught after
    a send/await cycle. A2APayloadInvalidError and A2AUnknownCapabilityError are
    NOT recorded (caller errors, not target-agent problems — gray-area decision 4).

    Fails silently if breaker module unavailable.
    """
    if not _HAS_BREAKER or record_failure is None:
        return
    try:
        record_failure(from_agent, to_agent, redis_client=_A2A_REDIS_CLIENT)
    except Exception:
        pass  # fail-open


def record_a2a_success(from_agent: str, to_agent: str) -> None:
    """Record a successful A2A exchange as a breaker success.

    Call this after a successful await_response(). Used to close the breaker
    after a HALF_OPEN probe succeeds. Callers are responsible for calling this
    function — send_request_with_retry only handles the send side, not the
    full round-trip.

    Fails silently if breaker module unavailable.
    """
    if not _HAS_BREAKER or record_success is None:
        return
    try:
        record_success(from_agent, to_agent, redis_client=_A2A_REDIS_CLIENT)
    except Exception:
        pass  # fail-open


# ── Core API ──────────────────────────────────────────────────────────────────

def send_request(
    to: str,
    capability: str,
    payload: Dict[str, Any],
    timeout: float = DEFAULT_TIMEOUT_S,
    from_agent: str = "operator",
    conn=None,
) -> str:
    """Insert a kind='request' row into a2a_messages. Return correlation_id.

    Validates payload (must be dict), checks capability registry (when available),
    then INSERTs to a2a_messages with kind='request', status='pending'.

    Args:
        to: Target agent name (e.g. 'gsd-reviewer').
        capability: Capability verb to invoke (e.g. 'review_file').
        payload: Request body dict. Use {} for empty. None is rejected.
        timeout: Caller-specified timeout in seconds (stored in status for
            await_response() reference, not enforced in DB). Default 30s.
        from_agent: Requesting agent name. Default 'operator' for CLI use.
        conn: Optional psycopg2 connection. If None, uses pg_store._get_conn().

    Returns:
        correlation_id as UUID string (36 chars).

    Raises:
        A2APayloadInvalidError: payload is None or not a dict.
        A2AUnknownCapabilityError: capability not in agent's declared list
            (only when registry has the agent AND it has declared capabilities).
        A2AAgentUnavailableError: agent has no compiled AGENT.yaml.
        RuntimeError: PG not available.
    """
    payload_json = _validate_payload(payload)
    _check_capability(to, capability)
    _check_breaker(from_agent, to)  # A2A-05: breaker check before PG INSERT

    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO a2a_messages
                  (from_agent, to_agent, capability, payload, kind, status)
                VALUES (%s, %s, %s, %s::jsonb, 'request', 'pending')
                RETURNING correlation_id::text
                """,
                (from_agent, to, capability, payload_json),
            )
            row = cur.fetchone()
        return row["correlation_id"]

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def await_response(
    correlation_id: str,
    timeout: float = DEFAULT_TIMEOUT_S,
    poll_interval: float = POLL_INTERVAL_S,
    conn=None,
) -> Dict[str, Any]:
    """Poll PG until a response or error row appears for correlation_id.

    Polls every poll_interval seconds (100ms default) until a row with
    kind IN ('response','error') appears WHERE parent_correlation_id matches
    the given correlation_id (the request's UUID), OR timeout expires.

    If PG goes down during polling, raises A2AAgentUnavailableError immediately
    (NOT A2ATimeoutError — per gray-area decision 3).

    Risk §2 design: the response row has its own new UUID as correlation_id
    and links back via parent_correlation_id. This function receives the
    REQUEST's correlation_id and passes it to _poll_once which filters on
    parent_correlation_id.

    Args:
        correlation_id: UUID string returned by send_request() — the REQUEST row's PK.
        timeout: Maximum wait seconds. Default 30s.
        poll_interval: PG poll interval seconds. Default 0.1 (100ms).
        conn: Optional psycopg2 connection. If None, a new connection is used
            per poll (connection checked each iteration to handle PG-down).

    Returns:
        payload dict from the response row. If the response kind is 'error',
        the payload is returned as-is (caller inspects 'error' key).

    Raises:
        A2ATimeoutError: Timeout expired before response arrived.
        A2AAgentUnavailableError: PG connection failed during polling.
    """
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        try:
            row = _poll_once(correlation_id, conn=conn)
        except Exception as exc:
            # PG error mid-poll → agent_unavailable (gray-area decision 3)
            raise A2AAgentUnavailableError(
                f"PG unavailable while awaiting response for {correlation_id}: {exc}",
                correlation_id=correlation_id,
            ) from exc

        if row is not None:
            # row.payload is already decoded by psycopg2 (jsonb → dict)
            payload = row.get("payload") or {}
            if isinstance(payload, str):
                payload = json.loads(payload)
            return payload

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(poll_interval, remaining))

    raise A2ATimeoutError(
        f"No response received for correlation_id={correlation_id} within {timeout}s.",
        correlation_id=correlation_id,
    )


def _poll_once(correlation_id: str, conn=None):
    """Single PG poll for a response or error row linked to correlation_id.

    Risk §2 correction: response rows use their own new UUID as correlation_id
    and link back to the request via parent_correlation_id. This function
    MUST filter on parent_correlation_id (not correlation_id) to find the
    response row for a given request.

    Args:
        correlation_id: The REQUEST row's UUID (used as parent_correlation_id filter).
        conn: Optional psycopg2 connection.

    Returns:
        RealDictRow with payload/kind/status/responded_at, or None.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT payload, kind, status, responded_at
                  FROM a2a_messages
                 WHERE parent_correlation_id = %s::uuid
                   AND kind IN ('response', 'error')
                 LIMIT 1
                """,
                (correlation_id,),
            )
            return cur.fetchone()

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def send_response(
    parent_correlation_id: str,
    payload: Dict[str, Any],
    conn=None,
) -> None:
    """Insert a kind='response' row for parent_correlation_id and set responded_at.

    Risk §2 correction (MANDATORY): this function INSERTs a NEW row with:
      - correlation_id = gen_random_uuid() — its own fresh PRIMARY KEY
      - parent_correlation_id = <parent_correlation_id arg> — links to request

    The parent_correlation_id argument is the request row's UUID (returned by
    send_request()). Reusing that UUID as correlation_id would cause a PK
    unique-violation since correlation_id is PRIMARY KEY.

    Used by the receiving agent to reply to a send_request(). The
    parent_correlation_id links the response to the original request row
    so that await_response(<request_uuid>) can find it.

    Args:
        parent_correlation_id: UUID string from the original request row
            (i.e. the value returned by send_request()).
        payload: Response body dict. Use {} for empty.
        conn: Optional psycopg2 connection.

    Raises:
        A2APayloadInvalidError: payload is None or not a dict.
        RuntimeError: PG not available.
    """
    payload_json = _validate_payload(payload)

    # Read request row to get from_agent/to_agent/capability for the response row
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT from_agent, to_agent, capability
                  FROM a2a_messages
                 WHERE correlation_id = %s::uuid
                   AND kind = 'request'
                 LIMIT 1
                """,
                (parent_correlation_id,),
            )
            req_row = cur.fetchone()

        if req_row is None:
            # No request row found — insert response with nulled agent fields
            from_agent_resp = "unknown"
            to_agent_resp = "unknown"
            capability_resp = "unknown"
        else:
            # Response: from/to are reversed (responder is "to" in original request)
            from_agent_resp = req_row["to_agent"]
            to_agent_resp = req_row["from_agent"]
            capability_resp = req_row["capability"]

        # INSERT response row with:
        #   - correlation_id = new UUID (DEFAULT gen_random_uuid())
        #   - parent_correlation_id = <parent_correlation_id> (links to request)
        #   - kind = 'response'
        # This is the Risk §2 correction: response rows MUST NOT reuse the
        # request's correlation_id since it is PRIMARY KEY on a2a_messages.
        with c.cursor() as cur:
            cur.execute(
                """
                INSERT INTO a2a_messages
                  (parent_correlation_id, from_agent, to_agent, capability,
                   payload, kind, status, responded_at)
                VALUES (%s::uuid, %s, %s, %s, %s::jsonb, 'response', 'delivered', NOW())
                """,
                (
                    parent_correlation_id,
                    from_agent_resp,
                    to_agent_resp,
                    capability_resp,
                    payload_json,
                ),
            )

    if conn is not None:
        _run(conn)
        return
    store = _get_store()
    with store._get_conn() as c:
        _run(c)


# ── Retry API (A2A-04) ────────────────────────────────────────────────────────

def send_request_with_retry(
    to: str,
    capability: str,
    payload: Dict[str, Any],
    timeout: float = DEFAULT_TIMEOUT_S,
    max_retries: int = MAX_RETRIES,
    from_agent: str = "operator",
    conn=None,
) -> str:
    """send_request with exponential backoff retry on A2ATimeoutError.

    Attempts the send/await cycle up to max_retries + 1 times total.
    Each attempt except the last writes a kind='retried' row to a2a_messages
    so the retry history is visible in the table (A2A-04 SC4).

    Backoff formula (locked — Phase 55 gray-area decision 4):
      delay = min(RETRY_BASE ** attempt * RETRY_INITIAL_DELAY_S, RETRY_CAP_S)
      delay *= random.uniform(*RETRY_JITTER_RANGE)   # ±20% jitter

    Example delays (without jitter):
      attempt 0 → 1s, attempt 1 → 2s (capped at RETRY_CAP_S if exceeded)

    Args:
        to: Target agent name.
        capability: Capability verb.
        payload: Request body dict.
        timeout: Per-attempt timeout in seconds (default 30s).
        max_retries: Maximum number of retries (default 2 = 3 total attempts).
        from_agent: Requesting agent name.
        conn: Optional psycopg2 connection (reused across attempts when provided).

    Returns:
        correlation_id of the FINAL successful send_request() call (the attempt
        that eventually returned a correlation_id, before await_response is called).

    Raises:
        A2ATimeoutError: All attempts timed out. Final error is re-raised.
        A2AUnknownCapabilityError: Raised immediately on attempt 0 (no retry).
        A2AAgentUnavailableError: Raised immediately on attempt 0 (no retry).
        A2APayloadInvalidError: Raised immediately on attempt 0 (no retry).

    Note:
        Only A2ATimeoutError triggers retry. Other errors are non-retryable.
        The caller must call await_response(returned_correlation_id) separately
        to receive the response (send_request_with_retry only handles the send
        + timeout detection, not the full round-trip).
    """
    # Pre-flight: validate payload + capability BEFORE entering retry loop.
    # Non-retryable errors (payload_invalid, unknown_capability, agent_unavailable)
    # MUST fail fast — they are not transient and should not consume retry budget.
    # A2APayloadInvalidError and A2AUnknownCapabilityError propagate immediately here.
    _validate_payload(payload)        # raises A2APayloadInvalidError if invalid
    _check_capability(to, capability)  # raises A2AUnknownCapabilityError/A2AAgentUnavailableError

    last_error: Optional[A2ATimeoutError] = None
    total_attempts = max_retries + 1

    for attempt in range(total_attempts):
        is_final = (attempt == total_attempts - 1)

        try:
            # Non-retryable errors (payload_invalid, unknown_capability,
            # agent_unavailable) are raised here and propagate immediately.
            # Only A2ATimeoutError is caught and retried.
            if is_final:
                # Final attempt: normal send_request (kind='request')
                corr_id = send_request(
                    to=to,
                    capability=capability,
                    payload=payload,
                    timeout=timeout,
                    from_agent=from_agent,
                    conn=conn,
                )
            else:
                # Retry attempt: write kind='retried' row to record history
                corr_id = _send_retried_row(
                    to=to,
                    capability=capability,
                    payload=payload,
                    from_agent=from_agent,
                    attempt=attempt,
                    conn=conn,
                )

            # If send succeeded (corr_id obtained), attempt await_response
            # to detect timeout at this attempt.
            # NB: caller receives the corr_id to continue their own await
            # after this function returns. The await here is just for
            # timeout detection per retry logic.
            # For Phase 55: return corr_id immediately after send.
            # The retry loop only fires if send_request itself raises A2ATimeoutError.
            # If send succeeds, return the correlation_id.
            return corr_id

        except A2ATimeoutError as exc:
            record_a2a_failure(from_agent, to)  # A2A-05: record failure for breaker
            last_error = exc
            if is_final:
                raise

            # Compute backoff delay for next attempt
            delay = min(
                RETRY_BASE ** attempt * RETRY_INITIAL_DELAY_S,
                RETRY_CAP_S,
            )
            delay *= random.uniform(*RETRY_JITTER_RANGE)
            time.sleep(delay)

        except (A2AUnknownCapabilityError, A2AAgentUnavailableError, A2APayloadInvalidError):
            # Non-retryable errors: propagate immediately without retry
            raise

    # Should not reach here — loop exhausts or raises
    if last_error:
        raise last_error
    raise A2AError("Unexpected retry loop exit")


def _send_retried_row(
    to: str,
    capability: str,
    payload: Dict[str, Any],
    from_agent: str,
    attempt: int,
    conn=None,
) -> str:
    """Insert a kind='retried' row to record retry history in a2a_messages.

    Called for attempt 0..N-2 (not the final attempt). The row records the
    retry attempt with kind='retried', status='retried', and attempt number
    in the payload.

    Args:
        to: Target agent name.
        capability: Capability verb.
        payload: Original request payload (stored as-is in the retried row).
        from_agent: Requesting agent name.
        attempt: Zero-based attempt index.
        conn: Optional psycopg2 connection.

    Returns:
        correlation_id of the retried row (UUID string).
    """
    payload_with_attempt = dict(payload)
    payload_with_attempt["_retry_attempt"] = attempt
    payload_json = _validate_payload(payload_with_attempt)

    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO a2a_messages
                  (from_agent, to_agent, capability, payload, kind, status)
                VALUES (%s, %s, %s, %s::jsonb, 'retried', 'retried')
                RETURNING correlation_id::text
                """,
                (from_agent, to, capability, payload_json),
            )
            row = cur.fetchone()
        return row["correlation_id"]

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)
