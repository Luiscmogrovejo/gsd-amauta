"""
tests/test_migration_020.py — Applies-check for Migration 020 (Phase 47 HYDRA-01).

Verifies that both new columns (recipient_agent, severity) and both new indexes
(idx_agent_findings_recipient, idx_agent_findings_finding_type_recent) are present
on the agent_findings table after the migration runs. Also guards that Phase 38
baseline columns are not disturbed.

Skips gracefully when PG is unavailable (psycopg2 not installed or server unreachable).
"""

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

# ── Helpers ────────────────────────────────────────────────────────────────────

def _store():
    """Return a PGStore instance. Only called when _PG_OK is True."""
    return PGStore()


# ── Tests ──────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_recipient_agent_column_exists():
    """recipient_agent column is VARCHAR(64) on agent_findings after Migration 020 UP."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name, data_type, character_maximum_length
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'recipient_agent'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected exactly 1 row for recipient_agent column, got {len(rows)}"
    )
    col_name, data_type, char_max_len = rows[0]
    assert data_type == "character varying", (
        f"Expected data_type='character varying', got '{data_type}'"
    )
    assert char_max_len == 64, (
        f"Expected character_maximum_length=64, got {char_max_len}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_severity_column_exists():
    """severity column is VARCHAR(16) on agent_findings after Migration 020 UP."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name, data_type, character_maximum_length
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'severity'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected exactly 1 row for severity column, got {len(rows)}"
    )
    col_name, data_type, char_max_len = rows[0]
    assert data_type == "character varying", (
        f"Expected data_type='character varying', got '{data_type}'"
    )
    assert char_max_len == 16, (
        f"Expected character_maximum_length=16, got {char_max_len}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_recipient_agent_index_exists():
    """idx_agent_findings_recipient index exists on agent_findings after Migration 020 UP."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'agent_findings'
                  AND indexname = 'idx_agent_findings_recipient'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected exactly 1 row for idx_agent_findings_recipient, got {len(rows)}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_finding_type_recent_index_exists():
    """idx_agent_findings_finding_type_recent index exists on agent_findings after Migration 020 UP."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'agent_findings'
                  AND indexname = 'idx_agent_findings_finding_type_recent'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected exactly 1 row for idx_agent_findings_finding_type_recent, got {len(rows)}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_recipient_agent_is_nullable():
    """recipient_agent column is nullable (NULL = broadcast per Phase 47 HYDRA-01 contract)."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT is_nullable
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'recipient_agent'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected exactly 1 row for recipient_agent nullable check, got {len(rows)}"
    )
    is_nullable = rows[0][0]
    assert is_nullable == "YES", (
        f"recipient_agent must be nullable (NULL = broadcast); got is_nullable='{is_nullable}'"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_baseline_columns_preserved():
    """Phase 38 baseline columns are all still present on agent_findings after Migration 020.

    Regression guard: Plan 47-00 MUST NOT drop or rename any Phase 38 columns.
    """
    baseline_columns = {
        "content",
        "finding_type",
        "task_id",
        "agent_name",
        "confidence",
        "created_at",
    }
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                """,
            )
            rows = cur.fetchall()

    present = {row[0] for row in rows}
    missing = baseline_columns - present
    assert not missing, (
        f"Migration 020 dropped or renamed Phase 38 baseline columns: {missing}"
    )
