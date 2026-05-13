"""
tests/test_party_session_findings.py — SC3: two-agent posting + ordering + attribution.

Phase 50 PARTY-01/PARTY-02: Verifies post_finding() and list_findings() helpers.
Each test creates ephemeral session_ids to avoid cross-test interference.
Skips gracefully when PG is unavailable.
"""

import sys
import os
import time
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.party_session import (
    create,
    start,
    post_finding,
    list_findings,
    InvalidTransitionError,
    SessionNotFoundError,
)

# ── PG availability gate ───────────────────────────────────────────────────────

_PG_OK = False

try:
    from services.pg_store import PGStore

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

    _PG_OK = _pg_available()

except (ImportError, Exception):
    def _pg_available() -> bool:  # type: ignore[misc]
        return False


def _require_pg():
    """Skip test when PG is not available."""
    if not _PG_OK:
        pytest.skip("PG not available — skipping findings test")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_active_session(participants=None):
    """Create and start a session. Returns session dict with status='active'."""
    if participants is None:
        participants = ["gsd-planner", "gsd-checker"]
    session = create(participants)
    return start(session["session_id"])


# ── Tests (7) ─────────────────────────────────────────────────────────────────

def test_post_finding_returns_uuid():
    """post_finding() returns a 36-char UUID string AND row exists in agent_findings."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    finding_id = post_finding(
        session_id=sid,
        agent_name="gsd-planner",
        finding_type="observation",
        content="Test finding content",
    )

    assert isinstance(finding_id, str), (
        f"post_finding must return a str; got {type(finding_id)}"
    )
    assert len(finding_id) == 36, (
        f"Expected UUID (36 chars); got len={len(finding_id)}: {finding_id!r}"
    )
    # Verify UUID format: 8-4-4-4-12
    parts = finding_id.split("-")
    assert len(parts) == 5, (
        f"UUID must have 5 hyphen-delimited parts; got {len(parts)} in {finding_id!r}"
    )

    # Confirm row exists via list_findings
    findings = list_findings(sid)
    ids_in_db = [f["id"] for f in findings]
    assert finding_id in ids_in_db, (
        f"Returned finding_id {finding_id!r} not found in agent_findings for session {sid!r}"
    )


def test_post_finding_persists_session_id():
    """post_finding() persists the session_id FK on the inserted row."""
    _require_pg()
    session = _make_active_session(["gsd-executor"])
    sid = session["session_id"]

    finding_id = post_finding(
        session_id=sid,
        agent_name="gsd-executor",
        finding_type="decision",
        content="Decision recorded",
    )

    findings = list_findings(sid)
    matching = [f for f in findings if f["id"] == finding_id]
    assert len(matching) == 1, (
        f"Expected exactly 1 row with id={finding_id!r}; found {len(matching)}"
    )
    assert matching[0]["session_id"] == sid, (
        f"Persisted session_id {matching[0]['session_id']!r} does not match {sid!r}"
    )


def test_list_findings_empty_for_new_session():
    """list_findings() returns [] for a session with no findings posted."""
    _require_pg()
    session = create(["gsd-planner"])
    sid = session["session_id"]

    result = list_findings(sid)

    assert isinstance(result, list), (
        f"list_findings must return a list; got {type(result)}"
    )
    assert result == [], (
        f"Expected [] for session with no findings; got {result}"
    )


def test_two_agents_post_findings_ordered():
    """SC3: two agents post F1, F2, F3 in order; list_findings returns them in created_at ASC order
    with correct agent_name attribution."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    # Agent A posts F1
    fid1 = post_finding(
        session_id=sid,
        agent_name="gsd-planner",
        finding_type="observation",
        content="Finding F1 from gsd-planner",
    )

    # Small sleep to ensure distinct created_at timestamps
    time.sleep(0.01)

    # Agent B posts F2
    fid2 = post_finding(
        session_id=sid,
        agent_name="gsd-checker",
        finding_type="warning",
        content="Finding F2 from gsd-checker",
    )

    time.sleep(0.01)

    # Agent A posts F3
    fid3 = post_finding(
        session_id=sid,
        agent_name="gsd-planner",
        finding_type="decision",
        content="Finding F3 from gsd-planner",
    )

    findings = list_findings(sid)

    assert len(findings) == 3, (
        f"Expected 3 findings; got {len(findings)}"
    )
    assert findings[0]["id"] == fid1, (
        f"First finding should be F1 (id={fid1!r}); got id={findings[0]['id']!r}"
    )
    assert findings[1]["id"] == fid2, (
        f"Second finding should be F2 (id={fid2!r}); got id={findings[1]['id']!r}"
    )
    assert findings[2]["id"] == fid3, (
        f"Third finding should be F3 (id={fid3!r}); got id={findings[2]['id']!r}"
    )

    # Verify agent_name attribution preserved
    assert findings[0]["agent_name"] == "gsd-planner", (
        f"F1 agent_name should be 'gsd-planner'; got {findings[0]['agent_name']!r}"
    )
    assert findings[1]["agent_name"] == "gsd-checker", (
        f"F2 agent_name should be 'gsd-checker'; got {findings[1]['agent_name']!r}"
    )
    assert findings[2]["agent_name"] == "gsd-planner", (
        f"F3 agent_name should be 'gsd-planner'; got {findings[2]['agent_name']!r}"
    )


def test_list_findings_only_for_session():
    """list_findings() returns only findings for the requested session_id; no cross-session leakage."""
    _require_pg()
    session_s1 = _make_active_session(["gsd-planner"])
    session_s2 = _make_active_session(["gsd-checker"])
    sid1 = session_s1["session_id"]
    sid2 = session_s2["session_id"]

    # Post 2 findings to S1
    post_finding(sid1, "gsd-planner", "observation", "S1 finding 1")
    post_finding(sid1, "gsd-planner", "decision", "S1 finding 2")

    # Post 1 finding to S2
    post_finding(sid2, "gsd-checker", "warning", "S2 finding 1")

    findings_s1 = list_findings(sid1)
    findings_s2 = list_findings(sid2)

    assert len(findings_s1) == 2, (
        f"Expected 2 findings for S1; got {len(findings_s1)}"
    )
    assert len(findings_s2) == 1, (
        f"Expected 1 finding for S2; got {len(findings_s2)}"
    )

    # Verify no cross-session leakage
    for f in findings_s1:
        assert f["session_id"] == sid1, (
            f"S1 finding session_id={f['session_id']!r} does not match expected {sid1!r}"
        )
    for f in findings_s2:
        assert f["session_id"] == sid2, (
            f"S2 finding session_id={f['session_id']!r} does not match expected {sid2!r}"
        )


def test_post_finding_with_recipient_and_severity():
    """post_finding() persists recipient_agent and severity fields correctly."""
    _require_pg()
    session = _make_active_session(["gsd-planner"])
    sid = session["session_id"]

    finding_id = post_finding(
        session_id=sid,
        agent_name="gsd-planner",
        finding_type="warning",
        content="Direct warning to gsd-checker",
        recipient_agent="gsd-checker",
        severity="warning",
    )

    findings = list_findings(sid)
    matching = [f for f in findings if f["id"] == finding_id]
    assert len(matching) == 1, (
        f"Expected exactly 1 row with id={finding_id!r}; found {len(matching)}"
    )
    row = matching[0]
    assert row["recipient_agent"] == "gsd-checker", (
        f"recipient_agent should be 'gsd-checker'; got {row['recipient_agent']!r}"
    )
    assert row["severity"] == "warning", (
        f"severity should be 'warning'; got {row['severity']!r}"
    )


def test_post_finding_minimal_args():
    """post_finding() with only required args: recipient_agent and severity are None in persisted row."""
    _require_pg()
    session = _make_active_session(["gsd-executor"])
    sid = session["session_id"]

    finding_id = post_finding(
        session_id=sid,
        agent_name="gsd-executor",
        finding_type="blocker",
        content="Minimal finding — no optional fields",
    )

    findings = list_findings(sid)
    matching = [f for f in findings if f["id"] == finding_id]
    assert len(matching) == 1, (
        f"Expected exactly 1 row with id={finding_id!r}; found {len(matching)}"
    )
    row = matching[0]
    assert row["recipient_agent"] is None, (
        f"recipient_agent should be None for minimal post; got {row['recipient_agent']!r}"
    )
    assert row["severity"] is None, (
        f"severity should be None for minimal post; got {row['severity']!r}"
    )
