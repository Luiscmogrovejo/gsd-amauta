"""
tests/test_party_session_migration.py — Applies-check for Migration 021 (Phase 50 PARTY-01).

Verifies that party_sessions table (8 columns + CHECK constraint) and the
agent_findings.session_id FK column, plus both supporting indexes, are present
after the migration runs. Also tests that the DOWN migration cleanly reverses.

Mirrors tests/test_migration_020.py style (Phase 47 precedent).
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
def test_migration_021_applies():
    """Apply migration 021 UP; assert party_sessions table exists via information_schema."""
    _apply_migration("migrations/021-party-sessions.sql")

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = 'party_sessions'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected party_sessions table in information_schema.tables; got {len(rows)} rows"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_party_sessions_columns_present():
    """All 7 named columns exist on party_sessions with correct types after Migration 021 UP."""
    expected_columns = {
        "session_id": "uuid",
        "status": "character varying",
        "participants": "jsonb",
        "created_at": "timestamp with time zone",
        "updated_at": "timestamp with time zone",
        "paused_at": "timestamp with time zone",
        "terminated_at": "timestamp with time zone",
    }

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = 'party_sessions'
                ORDER BY ordinal_position
                """,
            )
            rows = cur.fetchall()

    actual = {row[0]: row[1] for row in rows}
    for col_name, expected_type in expected_columns.items():
        assert col_name in actual, (
            f"Column '{col_name}' missing from party_sessions; found: {list(actual.keys())}"
        )
        assert actual[col_name] == expected_type, (
            f"Column '{col_name}' has type '{actual[col_name]}'; expected '{expected_type}'"
        )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_party_sessions_status_check_constraint():
    """pg_constraint shows party_sessions_status_chk exists after Migration 021 UP."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = 'party_sessions'::regclass
                  AND conname = 'party_sessions_status_chk'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected party_sessions_status_chk constraint; got {len(rows)} rows"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_agent_findings_session_id_column_added():
    """agent_findings.session_id column has type uuid after Migration 021 UP."""
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'session_id'
                """,
            )
            rows = cur.fetchall()

    assert len(rows) == 1, (
        f"Expected session_id column on agent_findings; got {len(rows)} rows"
    )
    col_name, data_type = rows[0]
    assert data_type == "uuid", (
        f"agent_findings.session_id expected type 'uuid'; got '{data_type}'"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_indexes_present():
    """Both Migration 021 indexes exist: idx_party_sessions_status_recent + idx_agent_findings_session."""
    expected_indexes = {
        "idx_party_sessions_status_recent",
        "idx_agent_findings_session",
    }

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT indexname
                FROM pg_indexes
                WHERE indexname = ANY(%s)
                """,
                (list(expected_indexes),),
            )
            rows = cur.fetchall()

    found = {row[0] for row in rows}
    missing = expected_indexes - found
    assert not missing, (
        f"Migration 021 indexes missing from pg_indexes: {missing}"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_migration_021_down_reverses():
    """Apply DOWN migration; assert party_sessions gone + agent_findings.session_id gone.

    Re-applies UP at the end to leave PG in the expected state for subsequent tests.
    """
    # Apply DOWN
    _apply_migration("migrations/021-party-sessions-DOWN.sql")

    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            # party_sessions table should be gone
            cur.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = 'party_sessions'
                """,
            )
            table_rows = cur.fetchall()

            # agent_findings.session_id should be gone
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'session_id'
                """,
            )
            column_rows = cur.fetchall()

    assert len(table_rows) == 0, (
        f"party_sessions table should be absent after DOWN; got {len(table_rows)} rows"
    )
    assert len(column_rows) == 0, (
        f"agent_findings.session_id should be absent after DOWN; got {len(column_rows)} rows"
    )

    # Re-apply UP so PG is in expected state for state-machine tests
    _apply_migration("migrations/021-party-sessions.sql")
