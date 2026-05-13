"""
tests/test_party_dissent_no_rollback.py — Phase 51 SC3: dissent records dissent, does NOT
auto-rollback the propose decision or mutate session state.

SC3 lock: enforces REQUIREMENTS.md Out of Scope "Auto-rollback on Party Mode dissent".
Dissent records DO NOT trigger any Auto-rollback, auto-resolve, or auto-state-change.
The propose row must be byte-identical before and after a dissent post.
Both propose and dissent remain visible in the decision_trail (operator sees everything).

Mirrors tests/test_party_decisions.py PG-gate style: _PG_OK probe + _require_pg() skip.
Each test creates a fresh ephemeral session to avoid cross-test interference.
Skips gracefully when PG is unavailable.
"""

import sys
import os
import time
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.party_session import (
    create,
    start,
    post_finding,
    post_decision,
    list_decisions,
    list_findings,
    summarize_decisions,
    get,
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
        pytest.skip("PG not available — skipping dissent-no-rollback test")


# ── Best-effort: apply migration 023 before tests run ─────────────────────────

def _apply_migration_023_if_needed() -> None:
    """Apply migration 023 UP if decision_type column is not yet present.
    Best-effort: silently no-ops when PG unavailable or already applied."""
    if not _PG_OK:
        return
    try:
        import psycopg2
        db_url = os.environ.get(
            "DATABASE_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"
        )
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'agent_findings' AND column_name = 'decision_type'
                """
            )
            if cur.fetchone() is None:
                migration_path = os.path.join(
                    os.path.dirname(__file__), "..", "migrations", "023-party-decisions.sql"
                )
                with open(migration_path, "r") as fh:
                    sql = fh.read()
                cur.execute(sql)
        conn.close()
    except Exception:
        pass


_apply_migration_023_if_needed()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_active_session(participants=None):
    """Create and start a session. Returns session dict with status='active'."""
    if participants is None:
        participants = ["gsd-planner", "gsd-checker"]
    session = create(participants)
    return start(session["session_id"])


def _query_agent_findings_row(finding_id: str) -> dict:
    """Query agent_findings directly for a single row by finding_id (UUID str).
    Returns a dict with all columns. Raises AssertionError if row not found."""
    store = PGStore()
    with store._get_conn() as conn:
        import psycopg2.extras
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id::text, agent_name, task_id, finding_type, content,
                       confidence, created_at, recipient_agent, severity,
                       session_id::text, decision_type
                  FROM agent_findings
                 WHERE id = %s::uuid
                """,
                (finding_id,),
            )
            row = cur.fetchone()
    assert row is not None, (
        f"agent_findings row with id={finding_id!r} not found in DB"
    )
    return dict(row)


def _get_agent_findings_column_names() -> list:
    """Return all column names on agent_findings via information_schema."""
    store = PGStore()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_name = 'agent_findings'
                 ORDER BY ordinal_position
                """
            )
            rows = cur.fetchall()
    return [r[0] for r in rows]


# ── Tests (4) ─────────────────────────────────────────────────────────────────
#
# SC3 lock — REQUIREMENTS.md Out of Scope item:
#   "Auto-rollback on Party Mode dissent"
#
# None of the tests below cause Auto-rollback. Dissent is recorded, not actioned.

def test_dissent_does_not_rollback():
    """SC3 primary contract: agent A posts propose, agent B posts dissent.
    After the dissent post:
    (a) Session status remains 'active' — no Auto-rollback auto-state change.
    (b) paused_at and terminated_at remain None.
    (c) The propose row in agent_findings is byte-identical: content, decision_type,
        agent_name, and created_at are UNCHANGED.
    (d) No rollback-flavored columns exist on agent_findings (information_schema check).
    (e) list_decisions returns exactly [propose, dissent] in ASC order — BOTH visible."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    agent_a = "gsd-planner"
    agent_b = "gsd-checker"

    # Agent A posts propose — capture row state BEFORE dissent
    propose_finding_id = post_decision(
        session_id=sid,
        agent_name=agent_a,
        decision_type="propose",
        content="Ship feature X",
        confidence=0.85,
    )

    # Capture propose row snapshot immediately after posting
    propose_row_before = _query_agent_findings_row(propose_finding_id)
    propose_created_at = propose_row_before["created_at"]

    time.sleep(0.01)

    # Agent B posts dissent
    dissent_finding_id = post_decision(
        session_id=sid,
        agent_name=agent_b,
        decision_type="dissent",
        content="Migration risk too high",
    )

    # (a) + (b) Session status must still be 'active'; no Auto-rollback triggered
    session_after = get(sid)
    assert session_after is not None, (
        f"get({sid!r}) returned None after dissent post"
    )
    assert session_after["status"] == "active", (
        f"Session status should remain 'active' after dissent; got {session_after['status']!r}"
    )
    assert session_after["paused_at"] is None, (
        f"paused_at should remain None after dissent; got {session_after['paused_at']!r}"
    )
    assert session_after["terminated_at"] is None, (
        f"terminated_at should remain None after dissent; got {session_after['terminated_at']!r}"
    )

    # (c) Propose row byte-identical — content, decision_type, agent_name, created_at UNCHANGED
    propose_row_after = _query_agent_findings_row(propose_finding_id)
    assert propose_row_after["content"] == "Ship feature X", (
        f"propose content MUST be unchanged after dissent; got {propose_row_after['content']!r}"
    )
    assert propose_row_after["decision_type"] == "propose", (
        f"propose decision_type MUST remain 'propose' after dissent; got {propose_row_after['decision_type']!r}"
    )
    assert propose_row_after["agent_name"] == agent_a, (
        f"propose agent_name MUST remain {agent_a!r} after dissent; got {propose_row_after['agent_name']!r}"
    )
    assert propose_row_after["created_at"] == propose_created_at, (
        f"propose created_at MUST be unchanged after dissent; "
        f"before={propose_created_at!r}, after={propose_row_after['created_at']!r}"
    )

    # (d) No rollback-flavored columns on agent_findings
    rollback_keywords = ("rolled_back", "revoked", "invalidated", "retracted", "cancelled")
    column_names = _get_agent_findings_column_names()
    for keyword in rollback_keywords:
        assert keyword not in column_names, (
            f"Rollback-flavored column '{keyword}' found on agent_findings — "
            f"Auto-rollback column must not exist (SC3 Out of Scope). Columns: {column_names}"
        )

    # (e) Both propose AND dissent remain visible in list_decisions (decision_trail preserved)
    decisions = list_decisions(sid)
    assert len(decisions) == 2, (
        f"decision_trail must contain exactly 2 rows [propose, dissent]; got {len(decisions)}"
    )
    assert decisions[0]["finding_id"] == propose_finding_id, (
        f"First decision must be propose ({propose_finding_id!r}); got {decisions[0]['finding_id']!r}"
    )
    assert decisions[1]["finding_id"] == dissent_finding_id, (
        f"Second decision must be dissent ({dissent_finding_id!r}); got {decisions[1]['finding_id']!r}"
    )
    assert decisions[0]["decision_type"] == "propose", (
        f"First decision_type must be 'propose'; got {decisions[0]['decision_type']!r}"
    )
    assert decisions[1]["decision_type"] == "dissent", (
        f"Second decision_type must be 'dissent'; got {decisions[1]['decision_type']!r}"
    )


def test_block_does_not_rollback_propose():
    """Same shape as test_dissent_does_not_rollback but agent B posts 'block' instead
    of 'dissent'. Session status remains 'active'; propose row is UNCHANGED;
    both rows present in list_decisions. No Auto-rollback on block either."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    agent_a = "gsd-planner"
    agent_b = "gsd-checker"

    # Agent A posts propose
    propose_finding_id = post_decision(
        session_id=sid,
        agent_name=agent_a,
        decision_type="propose",
        content="Propose: adopt new deployment pipeline",
        confidence=0.9,
    )

    propose_row_before = _query_agent_findings_row(propose_finding_id)
    propose_created_at = propose_row_before["created_at"]
    propose_content_before = propose_row_before["content"]

    time.sleep(0.01)

    # Agent B posts block
    block_finding_id = post_decision(
        session_id=sid,
        agent_name=agent_b,
        decision_type="block",
        content="Block: incomplete rollback plan — cannot proceed",
    )

    # Session status must remain 'active' — no Auto-rollback on block
    session_after = get(sid)
    assert session_after is not None, (
        f"get({sid!r}) returned None after block post"
    )
    assert session_after["status"] == "active", (
        f"Session status should remain 'active' after block; got {session_after['status']!r}"
    )
    assert session_after["paused_at"] is None, (
        f"paused_at should be None after block; got {session_after['paused_at']!r}"
    )
    assert session_after["terminated_at"] is None, (
        f"terminated_at should be None after block; got {session_after['terminated_at']!r}"
    )

    # Propose row must be byte-identical
    propose_row_after = _query_agent_findings_row(propose_finding_id)
    assert propose_row_after["content"] == propose_content_before, (
        f"propose content MUST be unchanged after block; "
        f"before={propose_content_before!r}, after={propose_row_after['content']!r}"
    )
    assert propose_row_after["decision_type"] == "propose", (
        f"propose decision_type must remain 'propose' after block; got {propose_row_after['decision_type']!r}"
    )
    assert propose_row_after["agent_name"] == agent_a, (
        f"propose agent_name must remain {agent_a!r} after block; got {propose_row_after['agent_name']!r}"
    )
    assert propose_row_after["created_at"] == propose_created_at, (
        f"propose created_at must be unchanged after block; "
        f"before={propose_created_at!r}, after={propose_row_after['created_at']!r}"
    )

    # Both propose AND block remain visible in list_decisions
    decisions = list_decisions(sid)
    assert len(decisions) == 2, (
        f"decision_trail must contain exactly 2 rows [propose, block]; got {len(decisions)}"
    )
    returned_types = [d["decision_type"] for d in decisions]
    assert "propose" in returned_types, (
        f"'propose' must be in decision_trail; got types={returned_types!r}"
    )
    assert "block" in returned_types, (
        f"'block' must be in decision_trail; got types={returned_types!r}"
    )


def test_dissent_does_not_mutate_other_agents_findings():
    """In a session: agent A posts propose AND an unrelated observation (non-decision).
    Agent B posts dissent on the propose. Assert the observation finding from agent A
    is byte-identical pre/post (content, finding_type, created_at) via direct SQL query."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    agent_a = "gsd-planner"
    agent_b = "gsd-checker"

    # Agent A posts propose
    post_decision(
        session_id=sid,
        agent_name=agent_a,
        decision_type="propose",
        content="Propose: cache refactor",
    )
    time.sleep(0.01)

    # Agent A also posts an unrelated observation finding
    observation_finding_id = post_finding(
        session_id=sid,
        agent_name=agent_a,
        finding_type="observation",
        content="Observation: cache hit rate dropped 5% — unrelated to proposal",
    )

    # Capture observation row BEFORE dissent
    obs_row_before = _query_agent_findings_row(observation_finding_id)
    obs_content_before = obs_row_before["content"]
    obs_finding_type_before = obs_row_before["finding_type"]
    obs_created_at_before = obs_row_before["created_at"]

    time.sleep(0.01)

    # Agent B posts dissent
    post_decision(
        session_id=sid,
        agent_name=agent_b,
        decision_type="dissent",
        content="Dissent: cache refactor scope too broad for this sprint",
    )

    # Verify observation row is byte-identical AFTER dissent
    obs_row_after = _query_agent_findings_row(observation_finding_id)
    assert obs_row_after["content"] == obs_content_before, (
        f"Observation content must be unchanged after dissent; "
        f"before={obs_content_before!r}, after={obs_row_after['content']!r}"
    )
    assert obs_row_after["finding_type"] == obs_finding_type_before, (
        f"Observation finding_type must be unchanged after dissent; "
        f"before={obs_finding_type_before!r}, after={obs_row_after['finding_type']!r}"
    )
    assert obs_row_after["created_at"] == obs_created_at_before, (
        f"Observation created_at must be unchanged after dissent; "
        f"before={obs_created_at_before!r}, after={obs_row_after['created_at']!r}"
    )
    assert obs_row_after["agent_name"] == agent_a, (
        f"Observation agent_name must remain {agent_a!r} after dissent; "
        f"got {obs_row_after['agent_name']!r}"
    )

    # Confirm observation still exists in list_findings (not deleted)
    all_findings = list_findings(sid)
    obs_ids = [f["id"] for f in all_findings]
    assert observation_finding_id in obs_ids, (
        f"Observation finding {observation_finding_id!r} must still be in list_findings after dissent"
    )


def test_dissent_visible_in_summarize_decisions():
    """Post 1 propose + 1 dissent. Assert summarize_decisions returns
    {propose:1, agree:0, dissent:1, block:0} — dissent is COUNTED, not hidden.
    This confirms dissent records are first-class visible items in the decision trail."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    post_decision(
        session_id=sid,
        agent_name="gsd-planner",
        decision_type="propose",
        content="Propose: adopt async queue for job dispatch",
    )
    time.sleep(0.01)
    post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="dissent",
        content="Dissent: async queue adds operational complexity without clear ROI",
    )

    summary = summarize_decisions(sid)

    expected = {"propose": 1, "agree": 0, "dissent": 1, "block": 0}
    assert summary == expected, (
        f"summarize_decisions after 1 propose + 1 dissent must return {expected}; got {summary}"
    )

    # Confirm dissent count is non-zero (dissent is counted, not hidden)
    assert summary["dissent"] == 1, (
        f"dissent count must be 1 (dissent is visible, not suppressed); got {summary['dissent']!r}"
    )
    assert summary["agree"] == 0, (
        f"agree count must be 0 (no agree posted); got {summary['agree']!r}"
    )
    assert summary["block"] == 0, (
        f"block count must be 0 (no block posted); got {summary['block']!r}"
    )
