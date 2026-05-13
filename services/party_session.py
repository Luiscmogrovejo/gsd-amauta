#!/usr/bin/env python3
"""
services/party_session.py — Phase 50 PARTY-01 / PARTY-02

Multi-agent collaboration session state machine + Pydantic PartySession model.

References:
  - 50-CONTEXT.md §Area 2 (state machine FROZEN transitions)
  - 50-CONTEXT.md §Area 6 (FROZEN PartySession dict shape, schema_version "1.0")
  - services/pg_store.py _get_conn() (Phase 47 connection pattern)
  - services/agent_hydrator.py _HAS_PG import-safety (Phase 47)
  - services/step-orchestrator.py _HAS_PYDANTIC import-safety (Phase 41)

Wave 1 scope: state machine create/start/pause/resume/terminate/get.
Wave 2 (plan 50-02) adds:
  - post_finding(session_id, agent_name, finding_type, content, ...) — Phase 50 PARTY-01
  - list_findings(session_id) — Phase 50 PARTY-02
  - resume() extended with findings replay via list_findings — Phase 50 PARTY-02
"""

import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional

# ── Import-safety: Pydantic ────────────────────────────────────────────────────
# Mirrors services/step-orchestrator.py L24-48 (Phase 41 pattern)

try:
    from pydantic import BaseModel, Field, model_validator
    _HAS_PYDANTIC = True
except ImportError:
    # Fallback: minimal dataclass shim so module imports without crashing.
    import dataclasses
    print("[party_session] pydantic not available; using dataclass fallback", file=sys.stderr)
    _HAS_PYDANTIC = False

    class _FakeField:
        def __call__(self, **kwargs):
            return dataclasses.field(
                default=kwargs.get("default", dataclasses.MISSING),
                default_factory=kwargs.get("default_factory", dataclasses.MISSING)
            )
    Field = _FakeField()

    class BaseModel:
        pass

    def model_validator(**kwargs):
        def decorator(fn):
            return fn
        return decorator

# ── Import-safety: PG ─────────────────────────────────────────────────────────
# Mirrors services/agent_hydrator.py L27-41 (Phase 47 pattern)

try:
    from services.pg_store import PGStore  # type: ignore
    _HAS_PG = True
except Exception:
    try:
        _pg_dir = os.path.dirname(os.path.abspath(__file__))
        if _pg_dir not in sys.path:
            sys.path.insert(0, _pg_dir)
        from pg_store import PGStore  # type: ignore
        _HAS_PG = True
    except Exception:
        PGStore = None  # type: ignore
        _HAS_PG = False

# ── Module-level constants (FROZEN — Phase 50 PARTY-01/PARTY-02) ──────────────

SCHEMA_VERSION = "1.0"

ALLOWED_STATUSES = ("created", "active", "paused", "terminated")

# Each tuple is (from_status, to_status). 5 allowed transitions per CONTEXT §Area 2.
VALID_TRANSITIONS = frozenset({
    ("created", "active"),
    ("active", "paused"),
    ("paused", "active"),
    ("active", "terminated"),
    ("paused", "terminated"),
})


# ── Exception classes ─────────────────────────────────────────────────────────

class InvalidTransitionError(Exception):
    """Raised when a requested state transition is not in VALID_TRANSITIONS.

    The session row is NOT mutated on this error.
    """
    pass


class SessionNotFoundError(Exception):
    """Raised when a session_id is not found in party_sessions.

    The session row is NOT mutated on this error.
    """
    pass


# ── Pydantic model (FROZEN schema_version "1.0") ──────────────────────────────

class PartySession(BaseModel):
    """Pydantic v2 model for a party session dict.

    Matches the FROZEN dict shape from 50-CONTEXT.md §Area 6.
    schema_version is locked to "1.0" and must not change in Wave 1/2.
    """
    if _HAS_PYDANTIC:
        model_config = {"extra": "forbid"}

    schema_version: str = "1.0"
    session_id: str
    status: str
    participants: list
    created_at: str
    updated_at: str
    paused_at: Optional[str] = None
    terminated_at: Optional[str] = None
    findings: Optional[list] = None  # None in Wave 1; Wave 2 resume() populates this


# ── Internal helpers ──────────────────────────────────────────────────────────

def _ts() -> str:
    """Return current UTC time as ISO8601 string."""
    return datetime.utcnow().replace(tzinfo=timezone.utc).isoformat()


def _row_to_dict(row) -> dict:
    """Map a psycopg2 RealDictRow (or plain row) to the FROZEN PartySession dict shape.

    Converts UUID and datetime fields to strings; sets schema_version "1.0".
    findings is always None in Wave 1 — Wave 2 extends resume() to populate it.
    """
    def _iso(val) -> Optional[str]:
        if val is None:
            return None
        if isinstance(val, datetime):
            if val.tzinfo is None:
                val = val.replace(tzinfo=timezone.utc)
            return val.isoformat()
        return str(val)

    # participants may be a list already (psycopg2 jsonb auto-decode) or a JSON string
    participants = row["participants"]
    if isinstance(participants, str):
        participants = json.loads(participants)

    return {
        "schema_version": SCHEMA_VERSION,
        "session_id": str(row["session_id"]),
        "status": row["status"],
        "participants": participants,
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "paused_at": _iso(row["paused_at"]),
        "terminated_at": _iso(row["terminated_at"]),
        "findings": None,  # Wave 2 populates this in resume(); Wave 1 always None
    }


def _get_store():
    """Return a PGStore instance. Only callable when _HAS_PG is True."""
    if not _HAS_PG or PGStore is None:
        raise RuntimeError("PG not available (_HAS_PG=False)")
    return PGStore()


# ── State-machine functions ───────────────────────────────────────────────────

def create(participants: list, conn=None) -> dict:
    """INSERT a new party session with status='created'.

    Args:
        participants: list of agent name strings (sorted for determinism).
        conn: optional psycopg2 connection. If None, uses pg_store._get_conn().

    Returns:
        PartySession dict shape per CONTEXT §Area 6 with findings=None.
    """
    participants_json = json.dumps(sorted(participants))

    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO party_sessions (participants)
                VALUES (%s::jsonb)
                RETURNING *
                """,
                (participants_json,),
            )
            row = cur.fetchone()
        return _row_to_dict(row)

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def start(session_id: str, conn=None) -> dict:
    """Transition a session from 'created' to 'active'.

    Args:
        session_id: UUID string of the party session.
        conn: optional psycopg2 connection.

    Returns:
        Updated PartySession dict.

    Raises:
        SessionNotFoundError: session_id not found.
        InvalidTransitionError: current status -> 'active' not allowed.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM party_sessions WHERE session_id = %s FOR UPDATE",
                (session_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise SessionNotFoundError(f"Session not found: {session_id}")
        current_status = row["status"]
        target_status = "active"
        if (current_status, target_status) not in VALID_TRANSITIONS:
            raise InvalidTransitionError(
                f"Cannot transition from {current_status} to {target_status}"
            )
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE party_sessions
                SET status = %s, updated_at = NOW()
                WHERE session_id = %s
                RETURNING *
                """,
                (target_status, session_id),
            )
            updated = cur.fetchone()
        return _row_to_dict(updated)

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def pause(session_id: str, conn=None) -> dict:
    """Transition a session from 'active' to 'paused'. Sets paused_at + updated_at.

    Args:
        session_id: UUID string of the party session.
        conn: optional psycopg2 connection.

    Returns:
        Updated PartySession dict.

    Raises:
        SessionNotFoundError: session_id not found.
        InvalidTransitionError: current status -> 'paused' not allowed.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM party_sessions WHERE session_id = %s FOR UPDATE",
                (session_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise SessionNotFoundError(f"Session not found: {session_id}")
        current_status = row["status"]
        target_status = "paused"
        if (current_status, target_status) not in VALID_TRANSITIONS:
            raise InvalidTransitionError(
                f"Cannot transition from {current_status} to {target_status}"
            )
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE party_sessions
                SET status = %s, paused_at = NOW(), updated_at = NOW()
                WHERE session_id = %s
                RETURNING *
                """,
                (target_status, session_id),
            )
            updated = cur.fetchone()
        return _row_to_dict(updated)

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def resume(session_id: str, conn=None) -> dict:
    """Transition a session from 'paused' to 'active'. Clears paused_at; sets updated_at.

    Wave 2 (plan 50-02): Returns session row with findings populated via list_findings().
    The UPDATE and findings SELECT share the same connection/transaction so that resume
    + replay is atomic — no findings can be lost between the state transition and the
    findings query.

    Args:
        session_id: UUID string of the party session.
        conn: optional psycopg2 connection.

    Returns:
        Updated PartySession dict with findings populated (list[dict] ordered by
        created_at ASC). findings is NOT populated when InvalidTransitionError or
        SessionNotFoundError is raised.

    Raises:
        SessionNotFoundError: session_id not found.
        InvalidTransitionError: current status -> 'active' not allowed.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM party_sessions WHERE session_id = %s FOR UPDATE",
                (session_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise SessionNotFoundError(f"Session not found: {session_id}")
        current_status = row["status"]
        # resume() is the ONLY function that triggers paused->active.
        # Enforce strict source state to prevent created->active bypass via resume().
        if current_status != "paused":
            raise InvalidTransitionError(
                f"resume() requires status='paused'; current status is '{current_status}'"
            )
        target_status = "active"
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE party_sessions
                SET status = %s, paused_at = NULL, updated_at = NOW()
                WHERE session_id = %s
                RETURNING *
                """,
                (target_status, session_id),
            )
            updated = cur.fetchone()
        result = _row_to_dict(updated)
        # Phase 50 PARTY-02: resume includes findings replay
        result["findings"] = list_findings(session_id, conn=c)
        return result

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def terminate(session_id: str, conn=None) -> dict:
    """Transition a session from 'active' or 'paused' to 'terminated'.
    Sets terminated_at + updated_at.

    Args:
        session_id: UUID string of the party session.
        conn: optional psycopg2 connection.

    Returns:
        Updated PartySession dict.

    Raises:
        SessionNotFoundError: session_id not found.
        InvalidTransitionError: current status -> 'terminated' not allowed.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM party_sessions WHERE session_id = %s FOR UPDATE",
                (session_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise SessionNotFoundError(f"Session not found: {session_id}")
        current_status = row["status"]
        target_status = "terminated"
        if (current_status, target_status) not in VALID_TRANSITIONS:
            raise InvalidTransitionError(
                f"Cannot transition from {current_status} to {target_status}"
            )
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE party_sessions
                SET status = %s, terminated_at = NOW(), updated_at = NOW()
                WHERE session_id = %s
                RETURNING *
                """,
                (target_status, session_id),
            )
            updated = cur.fetchone()
        return _row_to_dict(updated)

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def get(session_id: str, conn=None) -> Optional[dict]:
    """Return the current session dict, or None if not found.

    Does NOT raise SessionNotFoundError — callers use None check.

    Args:
        session_id: UUID string of the party session.
        conn: optional psycopg2 connection.

    Returns:
        PartySession dict or None.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM party_sessions WHERE session_id = %s",
                (session_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return _row_to_dict(row)

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


# ── Findings helpers (Phase 50 PARTY-01 / PARTY-02) ──────────────────────────

def post_finding(
    session_id: str,
    agent_name: str,
    finding_type: str,
    content: str,
    confidence: float = 0.8,
    recipient_agent: Optional[str] = None,
    severity: Optional[str] = None,
    conn=None,
) -> str:
    """Insert a finding into agent_findings tagged with session_id. Returns the finding id (UUID str).

    Phase 50 PARTY-01: session-scoped finding. Mirrors Phase 38 agent_findings INSERT
    pattern (services/amauta-daemon.py:~3280) but adds session_id, recipient_agent
    (Phase 47), and severity (Phase 47) columns when supplied.

    CONVENTION: task_id is set to session_id to satisfy the NOT NULL constraint on
    agent_findings.task_id from migration 014. Phase 50 conflates task_id with
    session_id for session-scoped rows. Phase 51 may introduce separate per-turn
    task_ids if needed.

    Args:
        session_id: UUID string of the party session; stored as both session_id FK
                    and task_id (NOT NULL bypass).
        agent_name: Name of the posting agent (e.g. 'gsd-planner').
        finding_type: Category string ('observation', 'decision', 'warning', 'blocker',
                      'security_alert', etc.).
        content: Text body of the finding.
        confidence: Float confidence 0.0–1.0 (default 0.8).
        recipient_agent: Target agent name for direct messages; None = broadcast.
        severity: Severity label ('info', 'warning', 'error', 'critical'); None = unset.
        conn: optional psycopg2 connection. If None, uses pg_store._get_conn().

    Returns:
        Finding id as UUID string (36 chars).
    """
    def _run(c):
        with c.cursor() as cur:
            cur.execute(
                """
                INSERT INTO agent_findings
                  (agent_name, task_id, finding_type, content, confidence,
                   recipient_agent, severity, session_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::uuid)
                RETURNING id::text
                """,
                (
                    agent_name,
                    session_id,        # task_id = session_id (NOT NULL bypass — Phase 50 convention)
                    finding_type,
                    content,
                    float(confidence),
                    recipient_agent,
                    severity,
                    session_id,
                ),
            )
            row = cur.fetchone()
        return row[0]

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)


def list_findings(session_id: str, conn=None) -> list:
    """Return all findings for a session in ascending creation order.

    Phase 50 PARTY-02: stable ordering required for replay. Returns dicts
    with the agent_findings column shape (id, agent_name, task_id,
    finding_type, content, confidence, created_at, recipient_agent,
    severity, session_id). Empty list if no findings for the given session_id.

    Args:
        session_id: UUID string of the party session.
        conn: optional psycopg2 connection. If None, uses pg_store._get_conn().

    Returns:
        List of dicts ordered by created_at ASC. created_at as ISO8601 string.
        Returns [] (NOT an error) when no findings exist for the session.
    """
    def _run(c):
        import psycopg2.extras
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id::text, agent_name, task_id, finding_type, content,
                       confidence, created_at, recipient_agent, severity,
                       session_id::text
                  FROM agent_findings
                 WHERE session_id = %s::uuid
                 ORDER BY created_at ASC
                """,
                (session_id,),
            )
            rows = cur.fetchall()

        results = []
        for row in rows:
            d = dict(row)
            # Normalize created_at to ISO8601 string
            if d.get("created_at") is not None and isinstance(d["created_at"], datetime):
                val = d["created_at"]
                if val.tzinfo is None:
                    val = val.replace(tzinfo=timezone.utc)
                d["created_at"] = val.isoformat()
            results.append(d)
        return results

    if conn is not None:
        return _run(conn)
    store = _get_store()
    with store._get_conn() as c:
        return _run(c)
