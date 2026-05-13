"""
tests/test_party_decisions.py — Phase 51 PARTY-03 decision helpers.

Covers DECISION_TYPES validation, post_decision/list_decisions/summarize_decisions,
ValueError on invalid decision_type, 4-type round-trip, and summarize counts.

Mirrors tests/test_party_session_findings.py PG-gate style.
Each test creates a fresh session via create([..]) + start(sid) to avoid
cross-test interference. Skips gracefully when PG unavailable.
"""

import sys
import os
import time
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.party_session import (
    DECISION_TYPES,
    create,
    start,
    post_finding,
    post_decision,
    list_decisions,
    summarize_decisions,
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
        pytest.skip("PG not available — skipping decision test")


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


# ── Tests (7) ─────────────────────────────────────────────────────────────────

def test_decision_types_frozen():
    """DECISION_TYPES is a tuple with exactly the 4 frozen vocabulary items."""
    assert isinstance(DECISION_TYPES, tuple), (
        f"DECISION_TYPES must be a tuple; got {type(DECISION_TYPES)}"
    )
    assert DECISION_TYPES == ("propose", "agree", "dissent", "block"), (
        f"DECISION_TYPES must be ('propose','agree','dissent','block'); got {DECISION_TYPES!r}"
    )


def test_post_decision_rejects_invalid_type():
    """post_decision raises ValueError when decision_type is not in DECISION_TYPES.
    The error message must contain 'must be in' and mention the invalid type.
    No row is inserted (list_decisions count before == count after)."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    # Confirm no decisions before the failed attempt
    before_count = len(list_decisions(sid))

    with pytest.raises(ValueError) as exc_info:
        post_decision(
            session_id=sid,
            agent_name="gsd-planner",
            decision_type="approve",  # invalid — not in DECISION_TYPES
            content="This should be rejected",
        )

    error_msg = str(exc_info.value)
    assert "must be in" in error_msg, (
        f"ValueError message must contain 'must be in'; got: {error_msg!r}"
    )
    assert "approve" in error_msg, (
        f"ValueError message must mention invalid type 'approve'; got: {error_msg!r}"
    )

    # Verify NO row was inserted
    after_count = len(list_decisions(sid))
    assert after_count == before_count, (
        f"No row should be inserted on ValueError; before={before_count}, after={after_count}"
    )


def test_post_decision_writes_decision_type():
    """post_decision returns a 36-char UUID string. list_decisions returns 1 row
    with correct decision_type, content, agent_name, and confidence."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    finding_id = post_decision(
        session_id=sid,
        agent_name="gsd-planner",
        decision_type="propose",
        content="We should refactor the hydrator",
        confidence=0.9,
    )

    assert isinstance(finding_id, str), (
        f"post_decision must return a str; got {type(finding_id)}"
    )
    assert len(finding_id) == 36, (
        f"Expected UUID (36 chars); got len={len(finding_id)}: {finding_id!r}"
    )

    decisions = list_decisions(sid)
    assert len(decisions) == 1, (
        f"Expected 1 decision; got {len(decisions)}"
    )
    row = decisions[0]
    assert row["decision_type"] == "propose", (
        f"decision_type should be 'propose'; got {row['decision_type']!r}"
    )
    assert row["content"] == "We should refactor the hydrator", (
        f"content mismatch; got {row['content']!r}"
    )
    assert row["agent_name"] == "gsd-planner", (
        f"agent_name should be 'gsd-planner'; got {row['agent_name']!r}"
    )
    assert abs(row["confidence"] - 0.9) < 1e-6, (
        f"confidence should be ~0.9; got {row['confidence']!r}"
    )


def test_post_decision_default_finding_type():
    """post_decision without finding_type arg defaults to finding_type='decision'
    in the persisted row (verified via direct SELECT on agent_findings)."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    finding_id = post_decision(
        session_id=sid,
        agent_name="gsd-executor",
        decision_type="agree",
        content="I agree with the proposal",
    )

    # Query agent_findings directly for the finding_type column
    store = PGStore()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT finding_type FROM agent_findings WHERE id = %s::uuid",
                (finding_id,),
            )
            row = cur.fetchone()

    assert row is not None, (
        f"Row with id={finding_id!r} not found in agent_findings"
    )
    assert row[0] == "decision", (
        f"Default finding_type should be 'decision'; got {row[0]!r}"
    )


def test_list_decisions_filters_non_decisions():
    """list_decisions returns only rows where decision_type IS NOT NULL.
    A non-decision finding posted via post_finding must NOT appear.
    Returned decisions are in created_at ASC order."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    # Post 1 non-decision finding
    post_finding(
        session_id=sid,
        agent_name="gsd-planner",
        finding_type="observation",
        content="This is an observation, not a decision",
    )
    time.sleep(0.01)

    # Post 2 decisions
    fid1 = post_decision(
        session_id=sid,
        agent_name="gsd-planner",
        decision_type="propose",
        content="Proposal one",
    )
    time.sleep(0.01)
    fid2 = post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="agree",
        content="Agreement one",
    )

    decisions = list_decisions(sid)

    assert len(decisions) == 2, (
        f"Expected exactly 2 decisions (observation excluded); got {len(decisions)}"
    )
    # Verify ascending order
    assert decisions[0]["finding_id"] == fid1, (
        f"First decision should be {fid1!r}; got {decisions[0]['finding_id']!r}"
    )
    assert decisions[1]["finding_id"] == fid2, (
        f"Second decision should be {fid2!r}; got {decisions[1]['finding_id']!r}"
    )
    # Verify observation not present
    decision_ids = {d["finding_id"] for d in decisions}
    assert len(decision_ids) == 2, (
        f"Should have exactly 2 unique decision IDs; got {decision_ids}"
    )


def test_list_decisions_empty_session():
    """list_decisions returns [] for a fresh session with no decisions posted."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    result = list_decisions(sid)

    assert isinstance(result, list), (
        f"list_decisions must return a list; got {type(result)}"
    )
    assert result == [], (
        f"Expected [] for session with no decisions; got {result}"
    )


def test_summarize_decisions_counts():
    """summarize_decisions returns correct per-type counts.
    Post 2 propose + 1 agree + 1 dissent + 0 block.
    Verify: {propose:2, agree:1, dissent:1, block:0} — block key MUST be present
    (missing-types-default-to-0 contract)."""
    _require_pg()
    session = _make_active_session()
    sid = session["session_id"]

    # Post 2 propose
    post_decision(sid, "gsd-planner", "propose", "Proposal A")
    post_decision(sid, "gsd-planner", "propose", "Proposal B")
    # Post 1 agree
    post_decision(sid, "gsd-checker", "agree", "Agree with A")
    # Post 1 dissent
    post_decision(sid, "gsd-checker", "dissent", "Dissent on B — too risky")
    # Post 0 block

    summary = summarize_decisions(sid)

    assert isinstance(summary, dict), (
        f"summarize_decisions must return a dict; got {type(summary)}"
    )
    assert summary.get("propose") == 2, (
        f"Expected propose=2; got {summary.get('propose')!r}"
    )
    assert summary.get("agree") == 1, (
        f"Expected agree=1; got {summary.get('agree')!r}"
    )
    assert summary.get("dissent") == 1, (
        f"Expected dissent=1; got {summary.get('dissent')!r}"
    )
    assert "block" in summary, (
        f"'block' key MUST be present in summary (missing-types-default-to-0); keys={list(summary.keys())}"
    )
    assert summary["block"] == 0, (
        f"Expected block=0 (no block decisions posted); got {summary['block']!r}"
    )
    # Verify no extra keys
    assert set(summary.keys()) == {"propose", "agree", "dissent", "block"}, (
        f"Summary keys should be exactly DECISION_TYPES; got {set(summary.keys())}"
    )
