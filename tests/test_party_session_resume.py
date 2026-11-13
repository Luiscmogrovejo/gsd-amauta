"""
tests/test_party_session_resume.py — what resume() was FOR, without resume().

Until plan 89-13 (Phase 89 ORC-02 part 2) `resume()` flipped a session from
'paused' to 'active' and returned its findings in one transaction — the "finding
replay". Both the transition and the replay are removed (decision D2). The six
scenarios here are the ones this file always had: read a session's record back
in order, read it back after the process that wrote it is gone, and never leak
another session's rows. They now read the record the way a caller does today —
`list_findings` for the blackboard rows and `list_decisions` /
`summarize_decisions` for the decision trail — with no transition attached.
Every test states what it used to assert and what it asserts now.

The file keeps its name so its history stays in one place.

Skips when no disposable PostgreSQL is configured; runs on all nine CI cells.
"""

import sys
import os
import time
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import services.party_session as party_session
from services.party_session import (

    PartySession,
    DECISION_TYPES,
    create,
    start,
    terminate,
    get,
    post_finding,
    list_findings,
    post_decision,
    list_decisions,
    summarize_decisions,
    SCHEMA_VERSION,
)

# ── PG availability gate ───────────────────────────────────────────────────────

# Plan 88-16-09: ONE reason for "there is no disposable PostgreSQL". Nine
# different sentences said the same thing, and plan 88-19's gate reads the
# reason, so nine spellings are nine rows a human has to recognise as one cause.
from conftest import PG_SKIP_REASON  # noqa: E402

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
        pytest.skip(PG_SKIP_REASON)


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



def _post_two_decisions(session_id, conn=None):
    """Post a propose and a dissent from two agents. Returns the expected trail
    as (finding_id, agent, decision_type, content) tuples in post order."""
    decisions = [
        ("gsd-planner", "propose", "Decision 1 from planner"),
        ("gsd-checker", "dissent", "Decision 2 from checker"),
    ]
    result = []
    for agent, dtype, content in decisions:
        fid = post_decision(session_id, agent, dtype, content, conn=conn)
        result.append((fid, agent, dtype, content))
        time.sleep(0.01)
    return result


def _trail(session_id, conn=None):
    """The decision trail as comparable tuples."""
    return [
        (d["finding_id"], d["agent_name"], d["decision_type"], d["content"])
        for d in list_decisions(session_id, conn=conn)
    ]


# ── Tests (6) ─────────────────────────────────────────────────────────────────

def test_findings_and_decisions_read_back_in_order():
    """Was test_resume_returns_findings_in_order."""
    # used to assert: resume() returns status 'active', paused_at None and
    # dict.findings as the 3 posted findings in post order.
    # asserts now: with no pause and no resume, list_findings returns the same
    # 3 rows in post order with their ids, and the 2 decisions posted with them
    # are an ordered, attributed trail whose summary matches.
    _require_pg()
    assert not hasattr(party_session, "resume") and not hasattr(party_session, "pause")
    session = create(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]
    start(sid)
    expected = _post_three_findings(sid)
    expected_trail = _post_two_decisions(sid)

    row = get(sid)
    assert row["status"] == "active", f"status must be 'active'; got {row['status']!r}"
    assert row["paused_at"] is None, f"paused_at is never written; got {row['paused_at']!r}"

    findings = [f for f in list_findings(sid) if f["id"] in {fid for fid, _ in expected}]
    assert len(findings) == 3, f"Expected 3 findings; got {len(findings)}"
    for i, (fid, content) in enumerate(expected):
        assert findings[i]["content"] == content, (
            f"findings[{i}].content mismatch: "
            f"expected {content!r}; got {findings[i]['content']!r}"
        )
        assert findings[i]["id"] == fid, (
            f"findings[{i}].id mismatch: expected {fid!r}; got {findings[i]['id']!r}"
        )
    assert _trail(sid) == expected_trail
    assert summarize_decisions(sid) == {"propose": 1, "agree": 0, "dissent": 1, "block": 0}


def test_trail_survives_simulated_daemon_restart():
    """Was test_resume_after_simulated_daemon_restart."""
    # used to assert: after create+start+post+pause on connection C1 and a
    # close, resume() on a NEW connection C2 returns all 3 findings in order.
    # asserts now: the same restart — C1 writes and is closed, C2 is new — and
    # C2 reads the 3 findings AND the 2 decisions back complete and in order.
    # Nothing was held in memory, and no verb is needed to get the record back.
    _require_pg()

    c1 = _open_conn()
    try:
        session = create(["gsd-planner", "gsd-checker"], conn=c1)
        sid = session["session_id"]
        start(sid, conn=c1)
        expected = _post_three_findings(sid, conn=c1)
        c1.commit()  # one transaction per decision, so created_at orders them
        expected_trail = []
        for agent, dtype, content in (
            ("gsd-planner", "propose", "Decision 1 before the restart"),
            ("gsd-checker", "agree", "Decision 2 before the restart"),
        ):
            fid = post_decision(sid, agent, dtype, content, conn=c1)
            c1.commit()
            expected_trail.append((fid, agent, dtype, content))
            time.sleep(0.01)
    finally:
        # Simulate daemon restart: explicitly close C1
        c1.close()

    c2 = _open_conn()
    try:
        row = get(sid, conn=c2)
        findings = list_findings(sid, conn=c2)
        trail = _trail(sid, conn=c2)
        summary = summarize_decisions(sid, conn=c2)
        c2.commit()
    finally:
        c2.close()

    assert row["status"] == "active", (
        f"status must be 'active' after the reconnect; got {row['status']!r}"
    )
    # list_findings returns every blackboard row of the session, decisions
    # included; the three plain findings are picked out by id. They were written
    # in ONE transaction, so they share a created_at and are compared as a set.
    plain = [f for f in findings if f["id"] in {fid for fid, _ in expected}]
    assert len(findings) == 5, f"3 findings + 2 decisions must be read back; got {len(findings)}"
    assert len(plain) == 3, f"All 3 findings must survive the connection close; got {len(plain)}"
    assert {f["id"] for f in plain} == {fid for fid, _ in expected}
    assert {f["content"] for f in plain} == {content for _, content in expected}
    assert trail == expected_trail, (
        f"the decision trail must survive the restart in order:\n  expected {expected_trail!r}\n  got {trail!r}"
    )
    assert summary == {"propose": 1, "agree": 1, "dissent": 0, "block": 0}


def test_reading_a_created_session_changes_nothing():
    """Was test_resume_invalid_transition_does_not_replay."""
    # used to assert: resume() on a 'created' session raises
    # InvalidTransitionError, leaves the row 'created' and posts no finding.
    # asserts now: resume does not exist; reading the record of a session that
    # was never started (findings, trail, summary) leaves the row byte-for-byte
    # as it was and returns an empty record.
    _require_pg()
    assert not hasattr(party_session, "resume")
    assert not hasattr(party_session, "InvalidTransitionError")
    session = create(["gsd-executor"])
    sid = session["session_id"]
    before = get(sid)

    assert list_findings(sid) == [], "No findings should exist in a fresh session"
    assert list_decisions(sid) == []
    assert summarize_decisions(sid) == {dt: 0 for dt in DECISION_TYPES}

    row = get(sid)
    assert row is not None
    assert row == before, f"reading the record must not write the row: {before!r} -> {row!r}"
    assert row["status"] == "created"


def test_terminated_session_record_is_still_readable():
    """Was test_resume_terminated_session_fails."""
    # used to assert: resume() on a 'terminated' session raises
    # InvalidTransitionError and the row stays 'terminated'.
    # asserts now: a closed session cannot be "resumed" because nothing can,
    # and it does not need to be: its decisions read back complete and in
    # order, and reading them leaves it 'terminated'.
    _require_pg()
    assert not hasattr(party_session, "resume")
    session = create(["gsd-planner"])
    sid = session["session_id"]
    start(sid)
    expected_trail = _post_two_decisions(sid)
    closed = terminate(sid)

    assert _trail(sid) == expected_trail
    assert summarize_decisions(sid) == {"propose": 1, "agree": 0, "dissent": 1, "block": 0}

    row = get(sid)
    assert row is not None
    assert row["status"] == "terminated", (
        f"Row must remain 'terminated' after its record is read; got {row['status']!r}"
    )
    assert row["terminated_at"] == closed["terminated_at"]


def test_record_is_session_scoped():
    """Was test_resume_replays_only_session_scoped_findings."""
    # used to assert: resume() on S1 returns only S1's 2 findings, none of S2's 5.
    # asserts now: list_findings, list_decisions and summarize_decisions on S1
    # return only S1's rows while S2 holds 5 findings and 3 decisions of its own.
    _require_pg()
    s1 = create(["gsd-planner"])
    sid1 = s1["session_id"]
    start(sid1)
    post_finding(sid1, "gsd-planner", "observation", "S1 finding 1")
    post_finding(sid1, "gsd-planner", "observation", "S1 finding 2")
    s1_trail = _post_two_decisions(sid1)

    s2 = create(["gsd-checker"])
    sid2 = s2["session_id"]
    start(sid2)
    for i in range(5):
        post_finding(sid2, "gsd-checker", "observation", f"S2 finding {i+1}")
    for dtype in ("propose", "agree", "block"):
        post_decision(sid2, "gsd-checker", dtype, f"S2 {dtype}")

    findings = list_findings(sid1)
    assert len(findings) == 4, (
        f"S1 must return exactly its 2 findings and 2 decisions (no S2 leakage); got {len(findings)}"
    )
    for f in findings:
        assert f["session_id"] == sid1, (
            f"All rows read for S1 must have session_id={sid1!r}; got {f['session_id']!r}"
        )
    assert _trail(sid1) == s1_trail
    assert summarize_decisions(sid1) == {"propose": 1, "agree": 0, "dissent": 1, "block": 0}
    assert summarize_decisions(sid2) == {"propose": 1, "agree": 1, "dissent": 0, "block": 1}


def test_session_with_findings_pydantic_compat():
    """Was test_resume_findings_field_pydantic_compat."""
    # used to assert: the dict resume() returns, findings populated, parses
    # into PartySession with schema_version '1.0' and a list of dict findings.
    # asserts now: the dict a reader builds today — get() plus list_findings(),
    # which is what `party get --with-findings` and `party inspect` do — parses
    # the same way.
    _require_pg()
    session = create(["gsd-planner", "gsd-executor"])
    sid = session["session_id"]
    start(sid)
    post_finding(sid, "gsd-planner", "observation", "Compat finding 1")
    post_decision(sid, "gsd-executor", "agree", "Compat decision 2")

    result = get(sid)
    result["findings"] = list_findings(sid)

    ps = PartySession(**result)
    assert ps.schema_version == SCHEMA_VERSION, (
        f"schema_version must be '{SCHEMA_VERSION}'; got '{ps.schema_version}'"
    )
    assert isinstance(ps.findings, list), (
        f"PartySession.findings must be a list; got {type(ps.findings)}"
    )
    assert len(ps.findings) == 2, (
        f"Expected 2 rows in the Pydantic model; got {len(ps.findings)}"
    )
    for f in ps.findings:
        assert isinstance(f, dict), (
            f"Each finding must be a dict; got {type(f)}"
        )
