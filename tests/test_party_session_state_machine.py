"""
tests/test_party_session_state_machine.py — the thirteen state-machine scenarios,
converted into decision-trail tests (Phase 89 ORC-02 part 2, plan 89-13).

Until plan 89-13 a party session was a four-state machine and this file pinned
its five allowed and seven refused transitions. The machine is gone (decision
D2): a party session is a container row plus the decisions recorded in it, and
`status` is a label that gates nothing. Each scenario below is the SAME scenario
it was — the same sequence of calls, minus the verbs that no longer exist — but
what it proves is what the harness actually needs from a session: that the
decisions posted along the way are readable, in order, attributable to the agent
that posted them, and summarised correctly, whatever label the container
carries. Every test states the old assertion and the new one in a comment.

The file keeps its name so its history stays in one place.

Skips when no disposable PostgreSQL is configured (developer machines); it runs
on all nine CI cells. Each test creates its own session.
"""

import time
import uuid

import pytest

# ── Imports ────────────────────────────────────────────────────────────────────

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import services.party_session as party_session
from services.party_session import (

    PartySession,
    SessionNotFoundError,
    SCHEMA_VERSION,
    ALLOWED_STATUSES,
    DECISION_TYPES,
    create,
    start,
    terminate,
    get,
    post_decision,
    list_decisions,
    summarize_decisions,
)

# ── PG availability gate ───────────────────────────────────────────────────────

# Plan 88-16-09: ONE reason for "there is no disposable PostgreSQL". Nine
# different sentences said the same thing, and plan 88-19's gate reads the
# reason, so nine spellings are nine rows a human has to recognise as one cause.
from conftest import PG_SKIP_REASON  # noqa: E402

_PG_OK = False

try:
    from services.pg_store import PGStore

    def _pg_available() -> bool:
        """Return True if a PG connection can be obtained within 1 second."""
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
    """Skip test explicitly when PG is not available."""
    if not _PG_OK:
        pytest.skip(PG_SKIP_REASON)


# ── Decision-trail vocabulary (shared by every scenario) ───────────────────────

def _post(sid, agent, decision_type, content):
    """Post one decision and leave a gap so created_at orders the trail.

    Returns:
        (finding_id, agent, decision_type, content) — what the trail must return.
    """
    fid = post_decision(sid, agent, decision_type, content)
    time.sleep(0.01)
    return (fid, agent, decision_type, content)


def _assert_trail(sid, expected):
    """The trail of `sid` is exactly `expected`: readable, ordered, attributable,
    and summarised to the same counts.

    Args:
        sid: session id.
        expected: list of (finding_id, agent, decision_type, content) in post order.
    """
    trail = list_decisions(sid)
    got = [(d["finding_id"], d["agent_name"], d["decision_type"], d["content"]) for d in trail]
    assert got == list(expected), (
        f"decision trail mismatch for {sid}:\n  expected {list(expected)!r}\n  got      {got!r}"
    )
    stamps = [d["created_at"] for d in trail]
    assert stamps == sorted(stamps), f"trail is not in created_at order: {stamps!r}"
    want = {dt: 0 for dt in DECISION_TYPES}
    for _fid, _agent, dt, _content in expected:
        want[dt] += 1
    assert summarize_decisions(sid) == want, (
        f"summary does not match the posts: expected {want!r}, got {summarize_decisions(sid)!r}"
    )


def _no_lifecycle_verbs():
    """The removed verbs and the transition table are absent from the module."""
    for name in ("pause", "resume", "VALID_TRANSITIONS", "InvalidTransitionError"):
        assert not hasattr(party_session, name), (
            f"services.party_session.{name} was removed by plan 89-13 and is back"
        )


# ── The five scenarios that were ALLOWED transitions ───────────────────────────

def test_create_to_active():
    """A decision recorded before start() and one recorded after are one trail."""
    # used to assert: start() moves status created -> active and refreshes updated_at.
    # asserts now: decisions posted on either side of start() are both in the
    # trail, in order and attributed; the label reads 'active' and gated nothing.
    _require_pg()
    session = create(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]
    assert session["status"] == "created"
    before = _post(sid, "gsd-planner", "propose", "Proposed before the session was started")

    result = start(sid)
    assert result["status"] == "active", (
        f"Expected status='active' after start(); got '{result['status']}'"
    )
    assert result["updated_at"] is not None, "updated_at must not be None after start()"
    assert result["session_id"] == sid
    after = _post(sid, "gsd-checker", "agree", "Agreed after the session was started")

    _assert_trail(sid, [before, after])


def test_interrupted_session_keeps_its_trail():
    """Was test_active_to_paused. Work stops mid-session; nothing has to be paused."""
    # used to assert: pause() moves status active -> paused and sets paused_at.
    # asserts now: there is no pause verb; the decisions recorded before the
    # interruption are readable, ordered and attributed, and the container is
    # left exactly as it was (label 'active', paused_at never written).
    _require_pg()
    _no_lifecycle_verbs()
    sid = start(create(["gsd-planner"])["session_id"])["session_id"]
    first = _post(sid, "gsd-planner", "propose", "Split the migration in two")
    second = _post(sid, "gsd-planner", "block", "Blocked until the backup exists")

    row = get(sid)
    assert row["status"] == "active", f"an interrupted session stays 'active'; got {row['status']!r}"
    assert row["paused_at"] is None, f"nothing writes paused_at any more; got {row['paused_at']!r}"
    _assert_trail(sid, [first, second])


def test_work_continues_after_interruption_in_one_trail():
    """Was test_paused_to_active. Work picks up again without a resume verb."""
    # used to assert: resume() moves status paused -> active and clears paused_at.
    # asserts now: decisions posted before and after a gap form ONE ordered
    # trail with no verb in between, and a second agent's decision is attributed
    # to that agent.
    _require_pg()
    _no_lifecycle_verbs()
    sid = start(create(["gsd-executor", "gsd-checker"])["session_id"])["session_id"]
    before = _post(sid, "gsd-executor", "propose", "Before the gap")
    time.sleep(0.05)  # the gap that used to be a pause/resume pair
    after = _post(sid, "gsd-checker", "dissent", "After the gap")

    row = get(sid)
    assert row["status"] == "active"
    assert row["paused_at"] is None
    _assert_trail(sid, [before, after])


def test_active_to_terminated():
    """Closing a container keeps every decision recorded in it."""
    # used to assert: terminate() moves status active -> terminated and sets terminated_at.
    # asserts now: the same, AND the trail recorded before the close is still
    # readable, ordered, attributed and summarised after it.
    _require_pg()
    sid = start(create(["gsd-planner", "gsd-executor"])["session_id"])["session_id"]
    posted = [
        _post(sid, "gsd-planner", "propose", "Ship it"),
        _post(sid, "gsd-executor", "agree", "Shipping"),
    ]

    result = terminate(sid)
    assert result["status"] == "terminated", (
        f"Expected status='terminated' after terminate(); got '{result['status']}'"
    )
    assert result["terminated_at"] is not None, "terminated_at must be set after terminate()"
    _assert_trail(sid, posted)


def test_interrupted_then_terminated_trail_is_complete():
    """Was test_paused_to_terminated. A session abandoned mid-work is closed."""
    # used to assert: terminate() from 'paused' sets terminated_at and keeps paused_at.
    # asserts now: a session interrupted and then closed still returns every
    # decision, including the one posted after the interruption; terminate() is
    # idempotent and a second close does not move terminated_at.
    _require_pg()
    sid = start(create(["gsd-checker"])["session_id"])["session_id"]
    first = _post(sid, "gsd-checker", "propose", "Recorded before the interruption")
    time.sleep(0.05)
    second = _post(sid, "gsd-checker", "block", "Recorded after it, just before the close")

    closed = terminate(sid)
    assert closed["status"] == "terminated"
    assert closed["terminated_at"] is not None
    again = terminate(sid)
    assert again["status"] == "terminated"
    assert again["terminated_at"] == closed["terminated_at"], (
        "closing twice must not move the closing time: "
        f"{closed['terminated_at']!r} -> {again['terminated_at']!r}"
    )
    _assert_trail(sid, [first, second])


# ── The seven scenarios that were REFUSED transitions ──────────────────────────

def test_terminated_to_active():
    """Reopening a closed container neither loses nor reorders its trail."""
    # used to assert: start() on a terminated session raises InvalidTransitionError
    # and the row stays 'terminated'.
    # asserts now: nothing is refused. start() relabels the row 'active' and
    # clears terminated_at; the decisions recorded before the close are intact,
    # and one recorded after the reopen is appended in order.
    _require_pg()
    sid = start(create(["gsd-planner"])["session_id"])["session_id"]
    before = _post(sid, "gsd-planner", "propose", "Recorded before the close")
    assert terminate(sid)["status"] == "terminated"

    reopened = start(sid)
    assert reopened["status"] == "active", (
        f"start() is never refused because of the label; got {reopened['status']!r}"
    )
    assert reopened["terminated_at"] is None, (
        "a row labelled 'active' must not carry a termination time"
    )
    after = _post(sid, "gsd-planner", "agree", "Recorded after the reopen")
    _assert_trail(sid, [before, after])


def test_terminated_session_cannot_be_paused_and_keeps_its_trail():
    """Was test_terminated_to_paused. There is no pause to refuse."""
    # used to assert: pause() on a terminated session raises InvalidTransitionError
    # and the row stays 'terminated'.
    # asserts now: pause does not exist at all; the closed session's label and
    # its trail are exactly what they were when it was closed.
    _require_pg()
    _no_lifecycle_verbs()
    sid = start(create(["gsd-planner"])["session_id"])["session_id"]
    posted = [_post(sid, "gsd-planner", "dissent", "Dissent recorded before the close")]
    closed = terminate(sid)

    row = get(sid)
    assert row["status"] == "terminated", (
        f"Row must remain 'terminated'; got '{row['status']}'"
    )
    assert row["terminated_at"] == closed["terminated_at"]
    _assert_trail(sid, posted)


def test_created_session_records_decisions_before_it_is_started():
    """Was test_created_to_paused. A session nobody started is still a container."""
    # used to assert: pause() on a 'created' session raises InvalidTransitionError
    # and the row stays 'created'.
    # asserts now: the label gates nothing — decisions posted into a session
    # that was never started are recorded, ordered and attributed, and the row
    # still reads 'created' because recording a decision is not a transition.
    _require_pg()
    _no_lifecycle_verbs()
    sid = create(["gsd-executor"])["session_id"]
    posted = [
        _post(sid, "gsd-executor", "propose", "Proposed in a session nobody started"),
        _post(sid, "gsd-checker", "agree", "Agreed by a second agent"),
    ]

    row = get(sid)
    assert row["status"] == "created", (
        f"Recording a decision must not move the label; got '{row['status']}'"
    )
    _assert_trail(sid, posted)


def test_created_to_terminated():
    """A session can be closed without ever being started."""
    # used to assert: terminate() on a 'created' session raises
    # InvalidTransitionError and the row stays 'created'.
    # asserts now: nothing is refused. The container closes, and the decision
    # recorded in it beforehand is still in the trail.
    _require_pg()
    sid = create(["gsd-executor"])["session_id"]
    posted = [_post(sid, "gsd-executor", "block", "Blocked before anyone started")]

    result = terminate(sid)
    assert result["status"] == "terminated", (
        f"terminate() is never refused because of the label; got '{result['status']}'"
    )
    assert result["terminated_at"] is not None
    _assert_trail(sid, posted)


def test_legacy_paused_row_is_readable_and_can_be_started():
    """Was test_paused_to_created. A row a previous version left 'paused'."""
    # used to assert: pause() on a 'paused' session raises InvalidTransitionError
    # and the row stays 'paused' (the paused-state guard).
    # asserts now: 'paused' is a label only an older version could have written
    # (migration 021's CHECK still accepts it, which is why it is in
    # ALLOWED_STATUSES). Such a row is readable, its trail is intact, and
    # start() is its way out: 'active', paused_at cleared.
    _require_pg()
    assert "paused" in ALLOWED_STATUSES
    sid = start(create(["gsd-planner"])["session_id"])["session_id"]
    posted = [_post(sid, "gsd-planner", "propose", "Recorded before the old version paused it")]
    store = PGStore()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            # What pause() used to write. No current code path does this.
            cur.execute(
                "UPDATE party_sessions SET status = 'paused', paused_at = NOW() "
                "WHERE session_id = %s",
                (sid,),
            )
            assert cur.rowcount == 1, "the legacy label was not written; the test would be vacuous"

    row = get(sid)
    assert row["status"] == "paused", f"a legacy row must be readable as it is; got {row['status']!r}"
    assert row["paused_at"] is not None
    _assert_trail(sid, posted)

    result = start(sid)
    assert result["status"] == "active"
    assert result["paused_at"] is None, "start() clears a legacy paused_at"
    _assert_trail(sid, posted)


def test_same_state_active_active():
    """Starting twice changes nothing about the trail."""
    # used to assert: a second start() raises InvalidTransitionError and the row
    # stays 'active'.
    # asserts now: start() is idempotent — the second call succeeds, the row is
    # 'active', and the trail is neither duplicated nor reordered by it.
    _require_pg()
    sid = start(create(["gsd-planner", "gsd-checker"])["session_id"])["session_id"]
    first = _post(sid, "gsd-planner", "propose", "Recorded between the two starts")

    again = start(sid)
    assert again["status"] == "active", (
        f"Row must read 'active' after a repeated start(); got '{again['status']}'"
    )
    second = _post(sid, "gsd-checker", "agree", "Recorded after the second start")
    _assert_trail(sid, [first, second])


def test_session_not_found():
    """An unknown session id is an error for the container and empty for the trail."""
    # used to assert: start() with a random UUID raises SessionNotFoundError.
    # asserts now: the same for start() and terminate(), and the trail readers
    # answer an empty trail and an all-zero summary instead of raising.
    _require_pg()
    random_id = str(uuid.uuid4())

    with pytest.raises(SessionNotFoundError):
        start(random_id)
    with pytest.raises(SessionNotFoundError):
        terminate(random_id)
    assert get(random_id) is None
    assert list_decisions(random_id) == []
    assert summarize_decisions(random_id) == {dt: 0 for dt in DECISION_TYPES}


# ── Shape ──────────────────────────────────────────────────────────────────────

def test_partysession_schema_version_locked():
    """create() returns the FROZEN nine-key dict, and a new container has an empty trail."""
    # used to assert: the nine keys, schema_version '1.0', status 'created',
    # findings/paused_at/terminated_at None.
    # asserts now: all of that unchanged, plus an empty trail and an all-zero
    # summary for a container nothing has been recorded in.
    _require_pg()
    session_dict = create(["gsd-planner", "gsd-executor"])

    required_keys = {
        "schema_version",
        "session_id",
        "status",
        "participants",
        "created_at",
        "updated_at",
        "paused_at",
        "terminated_at",
        "findings",
    }
    for key in required_keys:
        assert key in session_dict, (
            f"Key '{key}' missing from create() return dict; got keys: {list(session_dict.keys())}"
        )

    ps = PartySession(**session_dict)
    assert ps.schema_version == "1.0" == SCHEMA_VERSION, (
        f"schema_version must be '1.0'; got '{ps.schema_version}'"
    )
    assert ps.status == "created", (
        f"Fresh session must have status='created'; got '{ps.status}'"
    )
    assert ps.findings is None, (
        f"findings must be None on create(); got '{ps.findings}'"
    )
    assert ps.paused_at is None, (
        "paused_at must be None on fresh create()"
    )
    assert ps.terminated_at is None, (
        "terminated_at must be None on fresh create()"
    )
    assert isinstance(ps.participants, list), (
        f"participants must be a list; got {type(ps.participants)}"
    )
    _assert_trail(session_dict["session_id"], [])
