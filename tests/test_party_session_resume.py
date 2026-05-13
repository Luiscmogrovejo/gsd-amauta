"""
tests/test_party_session_resume.py — SC4: pause -> reconnect PG -> resume -> replay.

Phase 50 PARTY-02: Verifies that resume() populates findings from agent_findings
and that findings persist across a simulated daemon restart (psycopg2 connection
close + reopen). Layer 1 simulation — no subprocess spawning (that is Wave 4 / 50-04).

Skips gracefully when PG is unavailable.
"""

import sys
import os
import time
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.party_session import (
    PartySession,
    create,
    start,
    pause,
    resume,
    terminate,
    get,
    post_finding,
    list_findings,
    InvalidTransitionError,
    SessionNotFoundError,
    SCHEMA_VERSION,
)

# ── PG availability gate ───────────────────────────────────────────────────────

_PG_OK = False
_PG_DSN = None

try:
    from services.pg_store import PGStore
    import psycopg2
    import psycopg2.extras

    def _pg_available() -> bool:
        """Return True if a PG connection can be obtained."""
        try:
            store = PGStore()
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
            return True
        except Exception:
            return False

    def _get_dsn() -> str:
        """Extract DSN from PGStore instance for direct psycopg2.connect() calls."""
        store = PGStore()
        return store.dsn

    _PG_OK = _pg_available()
    if _PG_OK:
        _PG_DSN = _get_dsn()

except (ImportError, Exception):
    def _pg_available() -> bool:  # type: ignore[misc]
        return False
    def _get_dsn() -> str:  # type: ignore[misc]
        return ""


def _require_pg():
    """Skip test when PG is not available."""
    if not _PG_OK:
        pytest.skip("PG not available — skipping resume persistence test")


def _open_conn():
    """Open a fresh psycopg2 connection using the PGStore DSN."""
    conn = psycopg2.connect(_PG_DSN)
    conn.autocommit = False
    return conn


# ── Helpers ────────────────────────────────────────────────────────────────────

def _post_three_findings(session_id, conn=None):
    """Post 3 findings from two agents to the session. Returns list of (fid, content) tuples."""
    findings = [
        ("gsd-planner", "observation", "Finding 1 from planner"),
        ("gsd-checker", "warning",     "Finding 2 from checker"),
        ("gsd-planner", "decision",    "Finding 3 from planner"),
    ]
    result = []
    for agent, ftype, content in findings:
        fid = post_finding(
            session_id=session_id,
            agent_name=agent,
            finding_type=ftype,
            content=content,
            conn=conn,
        )
        result.append((fid, content))
        time.sleep(0.01)  # Ensure distinct created_at timestamps
    return result


# ── Tests (6) ─────────────────────────────────────────────────────────────────

def test_resume_returns_findings_in_order():
    """resume() returns dict.findings as ordered list of 3, matching post order.
    dict.status=='active', dict.paused_at is None."""
    _require_pg()
    session = create(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]
    start(sid)
    expected = _post_three_findings(sid)
    pause(sid)

    result = resume(sid)

    assert result["status"] == "active", (
        f"status must be 'active' after resume(); got {result['status']!r}"
    )
    assert result["paused_at"] is None, (
        f"paused_at must be None after resume(); got {result['paused_at']!r}"
    )
    assert isinstance(result["findings"], list), (
        f"findings must be a list; got {type(result['findings'])}"
    )
    assert len(result["findings"]) == 3, (
        f"Expected 3 findings; got {len(result['findings'])}"
    )
    for i, (fid, content) in enumerate(expected):
        assert result["findings"][i]["content"] == content, (
            f"findings[{i}].content mismatch: "
            f"expected {content!r}; got {result['findings'][i]['content']!r}"
        )
        assert result["findings"][i]["id"] == fid, (
            f"findings[{i}].id mismatch: expected {fid!r}; got {result['findings'][i]['id']!r}"
        )


def test_resume_after_simulated_daemon_restart():
    """SC4 daemon-restart simulation: open conn C1, create+start+post+pause via C1,
    CLOSE C1, open NEW conn C2, call resume(session_id, conn=C2).
    Assert findings length==3, content/order match exactly.
    Proves no state lost across daemon restart."""
    _require_pg()

    # Phase 1: open C1, create session, post 3 findings, pause
    c1 = _open_conn()
    try:
        session = create(["gsd-planner", "gsd-checker"], conn=c1)
        sid = session["session_id"]
        start(sid, conn=c1)
        expected = _post_three_findings(sid, conn=c1)
        pause(sid, conn=c1)
        c1.commit()
    finally:
        # Simulate daemon restart: explicitly close C1
        c1.close()

    # Phase 2: open NEW conn C2 — simulates daemon-restart reconnect
    c2 = _open_conn()
    try:
        result = resume(sid, conn=c2)
        c2.commit()
    finally:
        c2.close()

    # Verify findings survived the connection close
    assert result["status"] == "active", (
        f"status must be 'active' after reconnect+resume(); got {result['status']!r}"
    )
    assert isinstance(result["findings"], list), (
        f"findings must be a list after daemon-restart resume; got {type(result['findings'])}"
    )
    assert len(result["findings"]) == 3, (
        f"All 3 findings must survive conn close; got {len(result['findings'])}"
    )
    for i, (fid, content) in enumerate(expected):
        assert result["findings"][i]["content"] == content, (
            f"findings[{i}].content after restart: "
            f"expected {content!r}; got {result['findings'][i]['content']!r}"
        )
        assert result["findings"][i]["id"] == fid, (
            f"findings[{i}].id after restart: expected {fid!r}; got {result['findings'][i]['id']!r}"
        )


def test_resume_invalid_transition_does_not_replay():
    """Calling resume() on a 'created' session raises InvalidTransitionError;
    no row mutation and no findings replay attempted."""
    _require_pg()
    session = create(["gsd-executor"])
    sid = session["session_id"]
    # Session is 'created' — resume() requires 'paused'

    with pytest.raises(InvalidTransitionError):
        resume(sid)

    # Row must be unchanged
    row = get(sid)
    assert row is not None
    assert row["status"] == "created", (
        f"Row must remain 'created' after invalid resume(); got {row['status']!r}"
    )
    # Confirm no findings were posted
    findings = list_findings(sid)
    assert findings == [], (
        f"No findings should exist after failed resume(); got {findings}"
    )


def test_resume_terminated_session_fails():
    """Calling resume() on a 'terminated' session raises InvalidTransitionError;
    status still 'terminated'."""
    _require_pg()
    session = create(["gsd-planner"])
    sid = session["session_id"]
    start(sid)
    terminate(sid)

    with pytest.raises(InvalidTransitionError):
        resume(sid)

    row = get(sid)
    assert row is not None
    assert row["status"] == "terminated", (
        f"Row must remain 'terminated' after invalid resume(); got {row['status']!r}"
    )


def test_resume_replays_only_session_scoped_findings():
    """resume() on S1 returns only S1's findings; no S2 leakage.

    S1 has 2 findings, S2 has 5 findings. After resume(S1), findings count == 2.
    """
    _require_pg()
    # Create S1: create -> start -> pause (2 findings)
    s1 = create(["gsd-planner"])
    sid1 = s1["session_id"]
    start(sid1)
    post_finding(sid1, "gsd-planner", "observation", "S1 finding 1")
    post_finding(sid1, "gsd-planner", "observation", "S1 finding 2")
    pause(sid1)

    # Create S2: create -> start (5 findings, not paused — we just need them in db)
    s2 = create(["gsd-checker"])
    sid2 = s2["session_id"]
    start(sid2)
    for i in range(5):
        post_finding(sid2, "gsd-checker", "observation", f"S2 finding {i+1}")

    result = resume(sid1)

    assert result["status"] == "active", (
        f"S1 status must be 'active' after resume(); got {result['status']!r}"
    )
    assert len(result["findings"]) == 2, (
        f"S1 resume must return exactly 2 findings (no S2 leakage); "
        f"got {len(result['findings'])}"
    )
    for f in result["findings"]:
        assert f["session_id"] == sid1, (
            f"All findings in S1 resume must have session_id={sid1!r}; "
            f"got {f['session_id']!r}"
        )


def test_resume_findings_field_pydantic_compat():
    """resume() returns dict that PartySession(**dict) parses successfully.
    schema_version=='1.0' and findings is a list of dicts."""
    _require_pg()
    session = create(["gsd-planner", "gsd-executor"])
    sid = session["session_id"]
    start(sid)
    post_finding(sid, "gsd-planner", "observation", "Compat finding 1")
    post_finding(sid, "gsd-executor", "decision",   "Compat finding 2")
    pause(sid)

    result = resume(sid)

    # PartySession must accept the full dict with findings populated
    ps = PartySession(**result)
    assert ps.schema_version == SCHEMA_VERSION, (
        f"schema_version must be '{SCHEMA_VERSION}'; got '{ps.schema_version}'"
    )
    assert isinstance(ps.findings, list), (
        f"PartySession.findings must be a list; got {type(ps.findings)}"
    )
    assert len(ps.findings) == 2, (
        f"Expected 2 findings in Pydantic model; got {len(ps.findings)}"
    )
    for f in ps.findings:
        assert isinstance(f, dict), (
            f"Each finding must be a dict; got {type(f)}"
        )
