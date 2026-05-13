"""
tests/test_party_decision_trail.py — Phase 51 SC1: all four decision types queryable
as a structured trail.

Tests the full 4-decision-type sequence via post_decision/list_decisions/summarize_decisions.
Mirrors tests/test_party_decisions.py PG-gate style: _PG_OK probe + _require_pg() skip.
Each test creates a fresh ephemeral session to avoid cross-test interference.
Skips gracefully when PG is unavailable.

Phase 51 PARTY-03 success criteria: propose, agree, dissent, block are ALL first-class
queryable entities in the structured trail with correct attribution, ordering, confidence,
and summary counts.
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
    list_findings,
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
        pytest.skip("PG not available — skipping decision trail test")


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
        participants = ["gsd-planner", "gsd-checker", "gsd-operator"]
    session = create(participants)
    return start(session["session_id"])


# ── Tests (5) ─────────────────────────────────────────────────────────────────

def test_all_four_decision_types_round_trip():
    """SC1: In a single fresh session, post propose/agree/dissent/block from at least 2 agents.
    Assert list_decisions returns all 4 in created_at ASC order with correct
    decision_type tags and agent attribution. Each row must have a 36-char UUID finding_id."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker", "gsd-operator"])
    sid = session["session_id"]

    # Post 4 decisions from 2 agents with small time gaps to guarantee created_at ordering
    fid_propose = post_decision(
        session_id=sid,
        agent_name="gsd-planner",
        decision_type="propose",
        content="Propose: refactor the hydrator module",
    )
    time.sleep(0.01)

    fid_agree = post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="agree",
        content="Agree: hydrator refactor is sound",
    )
    time.sleep(0.01)

    fid_dissent = post_decision(
        session_id=sid,
        agent_name="gsd-operator",
        decision_type="dissent",
        content="Dissent: migration risk too high in current sprint",
    )
    time.sleep(0.01)

    fid_block = post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="block",
        content="Block: regression in Phase 49 coverage unacceptable",
    )

    decisions = list_decisions(sid)

    assert len(decisions) == 4, (
        f"Expected exactly 4 decisions (one per type); got {len(decisions)}"
    )

    # Verify ASC order matches posting order
    assert decisions[0]["finding_id"] == fid_propose, (
        f"First decision should be propose (id={fid_propose!r}); got {decisions[0]['finding_id']!r}"
    )
    assert decisions[1]["finding_id"] == fid_agree, (
        f"Second decision should be agree (id={fid_agree!r}); got {decisions[1]['finding_id']!r}"
    )
    assert decisions[2]["finding_id"] == fid_dissent, (
        f"Third decision should be dissent (id={fid_dissent!r}); got {decisions[2]['finding_id']!r}"
    )
    assert decisions[3]["finding_id"] == fid_block, (
        f"Fourth decision should be block (id={fid_block!r}); got {decisions[3]['finding_id']!r}"
    )

    # Verify decision_type tags
    assert decisions[0]["decision_type"] == "propose", (
        f"Row 0 decision_type should be 'propose'; got {decisions[0]['decision_type']!r}"
    )
    assert decisions[1]["decision_type"] == "agree", (
        f"Row 1 decision_type should be 'agree'; got {decisions[1]['decision_type']!r}"
    )
    assert decisions[2]["decision_type"] == "dissent", (
        f"Row 2 decision_type should be 'dissent'; got {decisions[2]['decision_type']!r}"
    )
    assert decisions[3]["decision_type"] == "block", (
        f"Row 3 decision_type should be 'block'; got {decisions[3]['decision_type']!r}"
    )

    # Verify agent attribution
    assert decisions[0]["agent_name"] == "gsd-planner", (
        f"propose agent_name should be 'gsd-planner'; got {decisions[0]['agent_name']!r}"
    )
    assert decisions[1]["agent_name"] == "gsd-checker", (
        f"agree agent_name should be 'gsd-checker'; got {decisions[1]['agent_name']!r}"
    )
    assert decisions[2]["agent_name"] == "gsd-operator", (
        f"dissent agent_name should be 'gsd-operator'; got {decisions[2]['agent_name']!r}"
    )
    assert decisions[3]["agent_name"] == "gsd-checker", (
        f"block agent_name should be 'gsd-checker'; got {decisions[3]['agent_name']!r}"
    )

    # Verify content matches
    assert decisions[0]["content"] == "Propose: refactor the hydrator module", (
        f"propose content mismatch; got {decisions[0]['content']!r}"
    )
    assert decisions[1]["content"] == "Agree: hydrator refactor is sound", (
        f"agree content mismatch; got {decisions[1]['content']!r}"
    )
    assert decisions[2]["content"] == "Dissent: migration risk too high in current sprint", (
        f"dissent content mismatch; got {decisions[2]['content']!r}"
    )
    assert decisions[3]["content"] == "Block: regression in Phase 49 coverage unacceptable", (
        f"block content mismatch; got {decisions[3]['content']!r}"
    )

    # Verify all finding_ids are valid 36-char UUIDs
    for row in decisions:
        fid = row["finding_id"]
        assert isinstance(fid, str) and len(fid) == 36, (
            f"finding_id must be a 36-char string; got {fid!r}"
        )
        assert fid.count("-") == 4, (
            f"finding_id must contain exactly 4 dashes; got {fid!r}"
        )


def test_decision_trail_includes_confidence():
    """Post a propose with confidence=0.95 and an agree with confidence=0.6.
    Assert list_decisions returns both rows with confidence floats matching
    the posted values within 1e-6."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    propose_confidence = 0.95
    agree_confidence = 0.6

    fid_propose = post_decision(
        session_id=sid,
        agent_name="gsd-planner",
        decision_type="propose",
        content="High-confidence proposal",
        confidence=propose_confidence,
    )
    time.sleep(0.01)

    fid_agree = post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="agree",
        content="Moderate-confidence agreement",
        confidence=agree_confidence,
    )

    decisions = list_decisions(sid)

    assert len(decisions) == 2, (
        f"Expected 2 decisions; got {len(decisions)}"
    )

    # Find by finding_id for robust matching
    propose_row = next((d for d in decisions if d["finding_id"] == fid_propose), None)
    agree_row = next((d for d in decisions if d["finding_id"] == fid_agree), None)

    assert propose_row is not None, (
        f"propose row with finding_id={fid_propose!r} not found in list_decisions"
    )
    assert agree_row is not None, (
        f"agree row with finding_id={fid_agree!r} not found in list_decisions"
    )

    assert abs(propose_row["confidence"] - propose_confidence) < 1e-6, (
        f"propose confidence should be ~{propose_confidence}; got {propose_row['confidence']!r}"
    )
    assert abs(agree_row["confidence"] - agree_confidence) < 1e-6, (
        f"agree confidence should be ~{agree_confidence}; got {agree_row['confidence']!r}"
    )


def test_decision_trail_excludes_non_decision_findings():
    """In the same session, post 3 decisions interleaved with 2 post_finding(observation).
    Assert list_decisions returns exactly 3 rows (the decisions only).
    Assert list_findings returns 5 rows (all findings, decisions and non-decisions)."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    # Post observation 1 (non-decision)
    post_finding(
        session_id=sid,
        agent_name="gsd-planner",
        finding_type="observation",
        content="Observation 1 — not a decision",
    )
    time.sleep(0.01)

    # Post decision 1 — propose
    post_decision(
        session_id=sid,
        agent_name="gsd-planner",
        decision_type="propose",
        content="Decision 1 — propose",
    )
    time.sleep(0.01)

    # Post observation 2 (non-decision)
    post_finding(
        session_id=sid,
        agent_name="gsd-checker",
        finding_type="observation",
        content="Observation 2 — not a decision",
    )
    time.sleep(0.01)

    # Post decision 2 — agree
    post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="agree",
        content="Decision 2 — agree",
    )
    time.sleep(0.01)

    # Post decision 3 — dissent
    post_decision(
        session_id=sid,
        agent_name="gsd-checker",
        decision_type="dissent",
        content="Decision 3 — dissent",
    )

    decisions = list_decisions(sid)
    all_findings = list_findings(sid)

    assert len(decisions) == 3, (
        f"list_decisions should return exactly 3 rows (decisions only); got {len(decisions)}"
    )
    assert len(all_findings) == 5, (
        f"list_findings should return exactly 5 rows (all findings); got {len(all_findings)}"
    )

    # Verify all returned decisions have decision_type set (not None)
    for row in decisions:
        assert row["decision_type"] is not None, (
            f"list_decisions row must have decision_type set; got None in {row!r}"
        )
        assert row["decision_type"] in DECISION_TYPES, (
            f"decision_type must be in DECISION_TYPES; got {row['decision_type']!r}"
        )


def test_summarize_decisions_after_four_types():
    """In a fresh session, post exactly 1 of each type (propose, agree, dissent, block).
    Assert summarize_decisions returns {propose:1, agree:1, dissent:1, block:1}."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    post_decision(sid, "gsd-planner", "propose", "Exactly one propose")
    time.sleep(0.01)
    post_decision(sid, "gsd-checker", "agree", "Exactly one agree")
    time.sleep(0.01)
    post_decision(sid, "gsd-checker", "dissent", "Exactly one dissent")
    time.sleep(0.01)
    post_decision(sid, "gsd-planner", "block", "Exactly one block")

    summary = summarize_decisions(sid)

    expected = {"propose": 1, "agree": 1, "dissent": 1, "block": 1}
    assert summary == expected, (
        f"summarize_decisions should return {expected}; got {summary}"
    )


def test_decision_trail_finding_id_unique():
    """Post 4 decisions in a single session.
    Assert all 4 finding_ids are distinct (set() length == 4) and are valid
    UUID strings (length 36, contains exactly 4 dashes)."""
    _require_pg()
    session = _make_active_session(["gsd-planner", "gsd-checker"])
    sid = session["session_id"]

    fid1 = post_decision(sid, "gsd-planner", "propose", "Proposal for uniqueness test")
    time.sleep(0.01)
    fid2 = post_decision(sid, "gsd-checker", "agree", "Agreement for uniqueness test")
    time.sleep(0.01)
    fid3 = post_decision(sid, "gsd-checker", "dissent", "Dissent for uniqueness test")
    time.sleep(0.01)
    fid4 = post_decision(sid, "gsd-planner", "block", "Block for uniqueness test")

    finding_ids = [fid1, fid2, fid3, fid4]

    # All must be distinct
    unique_ids = set(finding_ids)
    assert len(unique_ids) == 4, (
        f"All 4 finding_ids must be distinct; got {len(unique_ids)} unique in {finding_ids!r}"
    )

    # All must be valid UUID strings (36 chars, 4 dashes)
    for fid in finding_ids:
        assert isinstance(fid, str), (
            f"finding_id must be a str; got {type(fid)} for {fid!r}"
        )
        assert len(fid) == 36, (
            f"finding_id must be 36 chars (UUID format); got len={len(fid)}: {fid!r}"
        )
        assert fid.count("-") == 4, (
            f"UUID finding_id must contain exactly 4 dashes; got {fid.count('-')} in {fid!r}"
        )

    # Verify list_decisions also returns the same 4 finding_ids
    decisions = list_decisions(sid)
    returned_ids = {d["finding_id"] for d in decisions}
    assert returned_ids == unique_ids, (
        f"list_decisions finding_ids {returned_ids!r} do not match post_decision ids {unique_ids!r}"
    )
