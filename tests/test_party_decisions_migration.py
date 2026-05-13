"""
tests/test_party_decisions_migration.py — Applies-check for Migration 023 (Phase 51 PARTY-03).

Verifies that agent_findings.decision_type column (VARCHAR(16)) and the partial index
idx_agent_findings_session_decision are present after the migration runs.
Also tests DOWN reversal and absence of a CHECK constraint (write-site enforcement only).

Mirrors tests/test_party_session_migration.py style (Phase 50 precedent).
Skips gracefully when PG is unavailable (psycopg2 not installed or server unreachable).
"""

import os
import pytest

# ── PG availability gate ───────────────────────────────────────────────────────

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
    """Call inside a test to skip explicitly when PG is not available."""
    if not _PG_OK:
        pytest.skip("PG not available — skipping migration test")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _store():
    """Return a PGStore instance. Only called when _PG_OK is True."""
    return PGStore()


def _apply_migration(sql_path: str) -> None:
    """Execute a migration SQL file using psycopg2 directly via DATABASE_URL."""
    import psycopg2
    db_url = os.environ.get(
        "DATABASE_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"
    )
    with open(sql_path, "r") as fh:
        sql = fh.read()
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.close()


# ── Tests ──────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_migration_023_applies():
    """Apply migration 023 UP; assert agent_findings.decision_type column exists
    via information_schema.columns with data_type='character varying' and
    character_maximum_length=16."""
    _require_pg()
    _apply_migration("migrations/023-party-decisions.sql")

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name, data_type, character_maximum_length
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'decision_type'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected decision_type column in agent_findings; got {len(rows)} rows"
    )
    col_name, data_type, max_length = rows[0]
    assert data_type == "character varying", (
        f"decision_type expected type 'character varying'; got '{data_type}'"
    )
    assert max_length == 16, (
        f"decision_type expected character_maximum_length=16; got {max_length}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_decision_index_present():
    """pg_indexes shows idx_agent_findings_session_decision on agent_findings
    with WHERE predicate containing 'decision_type IS NOT NULL'."""
    _require_pg()
    # Ensure 023 UP is applied (idempotent if already done)
    _apply_migration("migrations/023-party-decisions.sql")

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE tablename = 'agent_findings'
                  AND indexname = 'idx_agent_findings_session_decision'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected idx_agent_findings_session_decision in pg_indexes; got {len(rows)} rows"
    )
    indexname, indexdef = rows[0]
    assert "decision_type IS NOT NULL" in indexdef, (
        f"Index definition should contain 'decision_type IS NOT NULL'; got: {indexdef!r}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_migration_023_down_reverses():
    """Apply DOWN migration; assert decision_type column is gone AND
    idx_agent_findings_session_decision is gone. Then re-applies UP to
    leave PG in expected state."""
    _require_pg()
    # Apply DOWN
    _apply_migration("migrations/023-party-decisions-DOWN.sql")

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            # decision_type column should be gone
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'decision_type'
                """,
            )
            column_rows = cur.fetchall()

            # index should be gone
            cur.execute(
                """
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'agent_findings'
                  AND indexname = 'idx_agent_findings_session_decision'
                """,
            )
            index_rows = cur.fetchall()

    assert len(column_rows) == 0, (
        f"agent_findings.decision_type should be absent after DOWN; got {len(column_rows)} rows"
    )
    assert len(index_rows) == 0, (
        f"idx_agent_findings_session_decision should be absent after DOWN; got {len(index_rows)} rows"
    )

    # Re-apply UP to leave PG in expected state for subsequent tests
    _apply_migration("migrations/023-party-decisions.sql")


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_no_check_constraint_on_decision_type():
    """pg_constraint confirms there is NO CHECK constraint on agent_findings
    named like 'agent_findings_decision_type_chk'. Write-site enforcement only
    (Phase 51 PARTY-03 design decision)."""
    _require_pg()
    # Ensure 023 UP is applied
    _apply_migration("migrations/023-party-decisions.sql")

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = 'agent_findings'::regclass
                  AND contype = 'c'
                  AND conname LIKE '%decision_type%'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 0, (
        f"Expected no CHECK constraint on decision_type (write-site enforcement only); "
        f"found {len(rows)} constraint(s): {[r[0] for r in rows]}"
    )
