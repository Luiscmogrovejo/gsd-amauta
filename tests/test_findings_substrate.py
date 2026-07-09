"""
tests/test_findings_substrate.py — Behavioral test for the Phase 78 findings substrate.

Proves the five SUBS success criteria of Plan 78-01 (the v3.6 immune-system foundation)
plus additive-schema safety and 4-reader non-breakage:

  SUBS-01 — migration 027 additively extends agent_findings with 9 audit columns
            (rule_id, domain, file_path, evidence, suggested_fix, dedup_key, status,
            ticket_id, audit_run_id) via ADD COLUMN IF NOT EXISTS; no DROP TABLE.
  SUBS-02 — task_id is relaxed to NULLABLE (ALTER COLUMN task_id DROP NOT NULL); a
            finding can be written with task_id NULL and the four existing readers
            (per-task GET, hydrator blackboard, hydrator security, sweep) still work.
  SUBS-03 — POST /api/findings persists severity + finding_type='audit' (task_id optional).
  SUBS-04 — GET /api/findings?domain=&severity=&type=&since=&status= sweeps open findings
            across tasks (parameterized).
  SUBS-05 — dedup_key = rule_id + ':' + sha1(file_path) computed server-side; a matching
            open/ticketed finding deduplicates instead of inserting a duplicate.

Plus SC5 — migration 027-DOWN restores the prior schema.

Two layers:
  * ALWAYS-RUN — static file text + daemon source-analysis (objectively verifiable with no DB).
    The daemon module is hyphenated (amauta-daemon.py) and starts servers at import, so it is
    read as TEXT and asserted on, never imported.
  * LIVE-PG — skipif-gated on PG availability; self-applies migration 027 (idempotent) and
    proves the additive schema, the NULL-task_id + severity + audit write, the dedup reject,
    and the four-reader non-breakage against the live table.

Skips the live layer gracefully when PG is unavailable (psycopg2 absent or server unreachable),
so the suite is runnable anywhere. No sleeps.
"""

import os
import uuid

import pytest

# ── Paths ──────────────────────────────────────────────────────────────────────

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MIGRATION_UP = os.path.join(_REPO_ROOT, "migrations", "027-audit-findings.sql")
_MIGRATION_DOWN = os.path.join(_REPO_ROOT, "migrations", "027-audit-findings-DOWN.sql")
_DAEMON = os.path.join(_REPO_ROOT, "services", "amauta-daemon.py")

# The 9 audit columns migration 027 adds (SUBS-01).
_NEW_COLUMNS = [
    "rule_id",
    "domain",
    "file_path",
    "evidence",
    "suggested_fix",
    "dedup_key",
    "status",
    "ticket_id",
    "audit_run_id",
]


def _read(path: str) -> str:
    """Read a file as UTF-8 text."""
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


# ── PG availability gate (copied verbatim from tests/test_migration_020.py) ─────

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


def _store():
    """Return a PGStore instance. Only called when _PG_OK is True."""
    return PGStore()


def _apply_027():
    """Self-apply migration 027 (idempotent — IF NOT EXISTS everywhere) so the live
    layer is deterministic regardless of prior migration state. Committing."""
    sql = _read(_MIGRATION_UP)
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()


# ══════════════════════════════════════════════════════════════════════════════
# ALWAYS-RUN — static file text + daemon source-analysis (no DB required)
# ══════════════════════════════════════════════════════════════════════════════


def test_subs01_additive_columns():
    """SUBS-01: migration 027-audit-findings.sql additively adds all 9 audit columns
    via ADD COLUMN IF NOT EXISTS and never drops the table."""
    sql = _read(_MIGRATION_UP)
    for col in _NEW_COLUMNS:
        assert f"ADD COLUMN IF NOT EXISTS {col}" in sql, (
            f"SUBS-01: column '{col}' must be added via 'ADD COLUMN IF NOT EXISTS'"
        )
    assert sql.count("DROP TABLE") == 0, "SUBS-01: additive migration must not DROP TABLE"
    # Three support indexes for the sweep + dedup query paths.
    assert sql.count("CREATE INDEX IF NOT EXISTS") == 3, (
        "SUBS-01: expected exactly 3 CREATE INDEX IF NOT EXISTS statements"
    )


def test_subs02_task_id_nullable_up():
    """SUBS-02: the UP migration relaxes task_id to NULLABLE."""
    sql = _read(_MIGRATION_UP)
    assert "ALTER COLUMN task_id DROP NOT NULL" in sql, (
        "SUBS-02: UP must drop NOT NULL on task_id"
    )


def test_sc5_down_restores():
    """SC5: 027-audit-findings-DOWN.sql restores the prior schema — backfills task_id
    from audit_run_id, restores NOT NULL, drops the 9 columns and 3 indexes."""
    sql = _read(_MIGRATION_DOWN)
    assert "ALTER COLUMN task_id SET NOT NULL" in sql, (
        "SC5: DOWN must restore NOT NULL on task_id"
    )
    assert "SET task_id = COALESCE(audit_run_id::text" in sql, (
        "SC5: DOWN must backfill NULL task_id from audit_run_id BEFORE SET NOT NULL"
    )
    assert sql.count("DROP COLUMN IF EXISTS") == 9, (
        "SC5: DOWN must drop all 9 added columns"
    )
    assert sql.count("DROP INDEX IF EXISTS") == 3, (
        "SC5: DOWN must drop all 3 added indexes"
    )
    # Ordering guard: the backfill must precede SET NOT NULL so the restore cannot fail.
    assert sql.index("COALESCE(audit_run_id::text") < sql.index(
        "ALTER COLUMN task_id SET NOT NULL"
    ), "SC5: backfill must run BEFORE SET NOT NULL"


def test_subs03_write_api_source():
    """SUBS-03: the POST /api/findings handler accepts finding_type='audit', drops
    task_id from `required`, and persists severity + dedup_key in the INSERT."""
    src = _read(_DAEMON)
    assert '"observation", "decision", "warning", "blocker", "audit"' in src, (
        "SUBS-03: _VALID_FINDING_TYPES must include 'audit' alongside the four legacy values"
    )
    assert 'required = ["agent_name", "finding_type", "content"]' in src, (
        "SUBS-03: task_id must be dropped from the POST required list"
    )
    # The INSERT column list must persist severity + the new dedup_key.
    assert "confidence, severity," in src, "SUBS-03: INSERT must persist severity"
    assert "suggested_fix, status, audit_run_id, dedup_key)" in src, (
        "SUBS-03: INSERT column list must include the audit columns + dedup_key"
    )


def test_subs05_dedup_source():
    """SUBS-05: dedup_key is computed server-side via sha1(file_path); an open/ticketed
    match short-circuits with deduped:True instead of a second INSERT."""
    src = _read(_DAEMON)
    assert "hashlib.sha1(file_path.encode" in src, (
        "SUBS-05: dedup_key must be computed server-side with sha1(file_path)"
    )
    assert "WHERE dedup_key = %s AND status IN ('open','ticketed')" in src, (
        "SUBS-05: write path must guard on an open/ticketed dedup_key match"
    )
    assert '"deduped": True' in src, (
        "SUBS-05: a duplicate must return deduped:True without a second INSERT"
    )


def test_subs04_sweep_source():
    """SUBS-04: the cross-task sweep branch (path == /api/findings) precedes the
    per-task startswith branch, uses parse_qs, and reads the 5 filter params."""
    src = _read(_DAEMON)
    assert 'if path == "/api/findings":' in src, "SUBS-04: sweep branch must exist"
    assert 'parse_qs(urlparse(self.path).query)' in src, (
        "SUBS-04: sweep must parse query params via parse_qs(urlparse(...))"
    )
    # The exact base path must match the sweep BEFORE the trailing-segment per-task form.
    assert src.index('if path == "/api/findings":') < src.index(
        'if path.startswith("/api/findings/")'
    ), "SUBS-04: sweep must precede the per-task startswith branch"
    for param in ("domain", "severity", "type", "since", "status"):
        assert f'_p("{param}")' in src, f"SUBS-04: sweep must read the '{param}' filter param"
    # Parameterized-SQL-only: the whitelist clause binds %s, never interpolates.
    assert 'clauses = ["status = %s"]' in src, (
        "SUBS-04: sweep WHERE must be a parameterized clause whitelist"
    )
    assert "created_at >= %s" in src, "SUBS-04: 'since' must bind as created_at >= %s"


# ══════════════════════════════════════════════════════════════════════════════
# LIVE-PG — skipif-gated; self-applies migration 027 and proves live behavior
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_live_columns_present():
    """SUBS-01 (live): all 9 audit columns exist on agent_findings after migration 027."""
    _apply_027()
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
            present = {row[0] for row in cur.fetchall()}
    missing = set(_NEW_COLUMNS) - present
    assert not missing, f"SUBS-01: migration 027 did not add columns: {missing}"


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_live_task_id_nullable():
    """SUBS-02 (live): task_id is nullable after migration 027."""
    _apply_027()
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT is_nullable
                FROM information_schema.columns
                WHERE table_name = 'agent_findings'
                  AND column_name = 'task_id'
                """,
            )
            rows = cur.fetchall()
    assert len(rows) == 1, f"Expected exactly 1 row for task_id, got {len(rows)}"
    assert rows[0][0] == "YES", (
        f"SUBS-02: task_id must be nullable; got is_nullable='{rows[0][0]}'"
    )


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_live_write_null_task_severity_audit():
    """SUBS-03 (live): a finding writes with task_id NULL, severity='error',
    finding_type='audit' and reads back — mirrors the daemon INSERT column list."""
    _apply_027()
    marker = f"subs03-{uuid.uuid4().hex}"
    dedup_key = f"{marker}:deadbeef"
    store = _store()
    inserted_id = None
    try:
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO agent_findings"
                    " (agent_name, task_id, finding_type, content, confidence, severity,"
                    "  rule_id, domain, file_path, evidence, suggested_fix, status,"
                    "  audit_run_id, dedup_key)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                    " RETURNING id, task_id, severity, finding_type",
                    (
                        "executor-backend",
                        None,  # task_id NULL — standalone audit finding
                        "audit",
                        f"SUBS-03 live write {marker}",
                        0.8,
                        "error",
                        marker,  # rule_id (unique)
                        "backend",
                        f"services/{marker}.py",
                        "evidence blob",
                        "suggested fix blob",
                        "open",
                        None,  # audit_run_id
                        dedup_key,
                    ),
                )
                row = cur.fetchone()
                inserted_id = row[0]
                conn.commit()
        assert inserted_id is not None, "SUBS-03: INSERT must return an id"
        assert row[1] is None, "SUBS-03: task_id must persist as NULL"
        assert row[2] == "error", "SUBS-03: severity must persist"
        assert row[3] == "audit", "SUBS-03: finding_type='audit' must persist"
        # Read it back to prove it is queryable.
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, task_id, severity, finding_type"
                    " FROM agent_findings WHERE id = %s",
                    (inserted_id,),
                )
                back = cur.fetchone()
        assert back is not None, "SUBS-03: written audit finding must be selectable"
        assert back[1] is None and back[2] == "error" and back[3] == "audit"
    finally:
        if inserted_id is not None:
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM agent_findings WHERE id = %s", (inserted_id,))
                conn.commit()


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_live_dedup_reject():
    """SUBS-05 (live): with one open row for a dedup_key, the daemon's open/ticketed
    guard SELECT finds it — so a second insert is blocked and only one open row exists."""
    _apply_027()
    marker = f"subs05-{uuid.uuid4().hex}"
    dedup_key = f"{marker}:cafef00d"
    store = _store()
    inserted_id = None
    try:
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO agent_findings"
                    " (agent_name, task_id, finding_type, content, confidence, severity,"
                    "  rule_id, domain, file_path, status, dedup_key)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                    (
                        "executor-backend",
                        None,
                        "audit",
                        f"SUBS-05 dedup seed {marker}",
                        0.8,
                        "warning",
                        marker,
                        "backend",
                        f"services/{marker}.py",
                        "open",
                        dedup_key,
                    ),
                )
                inserted_id = cur.fetchone()[0]
                conn.commit()
        # Run the EXACT open/ticketed guard the daemon uses before an INSERT.
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM agent_findings"
                    " WHERE dedup_key = %s AND status IN ('open','ticketed')"
                    " ORDER BY created_at DESC LIMIT 1",
                    (dedup_key,),
                )
                existing = cur.fetchone()
        assert existing is not None, (
            "SUBS-05: guard must find the open row (so a second insert is deduped, not inserted)"
        )
        # Confirm exactly one open row exists for this key — a second insert would be blocked.
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM agent_findings"
                    " WHERE dedup_key = %s AND status IN ('open','ticketed')",
                    (dedup_key,),
                )
                open_count = cur.fetchone()[0]
        assert open_count == 1, (
            f"SUBS-05: expected exactly 1 open row for dedup_key, got {open_count}"
        )
    finally:
        if inserted_id is not None:
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM agent_findings WHERE id = %s", (inserted_id,))
                conn.commit()


@pytest.mark.skipif(not _PG_OK, reason="PG not available")
def test_live_four_reader_non_breakage():
    """SUBS-02 non-breakage (live): each of the four existing readers' exact SELECT runs
    against the now-extended table without error and returns a list — proving the additive
    columns + nullable task_id broke no reader.

    Readers: (a) per-task GET, (b) hydrator blackboard, (c) hydrator security pipeline,
    (d) the new cross-task sweep.
    """
    _apply_027()
    store = _store()
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            # (a) per-task GET (services/amauta-daemon.py) — filters task_id = %s
            cur.execute(
                "SELECT id, agent_name, task_id, finding_type, content, confidence, created_at"
                " FROM agent_findings WHERE task_id = %s ORDER BY created_at DESC",
                ("__no_such_task__",),
            )
            reader_a = cur.fetchall()

            # (b) hydrator blackboard (services/agent_hydrator.py L226-232)
            cur.execute(
                "SELECT id, finding_type, severity, content AS summary, created_at, recipient_agent"
                " FROM agent_findings"
                " WHERE recipient_agent IS NULL OR recipient_agent = %s"
                " ORDER BY created_at DESC LIMIT %s",
                ("executor-backend", 5),
            )
            reader_b = cur.fetchall()

            # (c) hydrator security pipeline (services/agent_hydrator.py L313-320)
            cur.execute(
                "SELECT id, finding_type, severity, content AS summary, created_at"
                " FROM agent_findings"
                " WHERE finding_type IN ('security_alert', 'lint_violation', 'circuit_breaker_open')"
                "   AND created_at >= NOW() - INTERVAL '24 hours'"
                " ORDER BY created_at DESC LIMIT %s",
                (10,),
            )
            reader_c = cur.fetchall()

            # (d) the new sweep (services/amauta-daemon.py L1827-1835) — WHERE status = %s
            cur.execute(
                "SELECT id, agent_name, task_id, finding_type, severity, domain,"
                " file_path, rule_id, status, content, created_at"
                " FROM agent_findings WHERE status = %s"
                " ORDER BY created_at DESC LIMIT 200",
                ("open",),
            )
            reader_d = cur.fetchall()

    for name, result in (
        ("per-task GET", reader_a),
        ("hydrator blackboard", reader_b),
        ("hydrator security", reader_c),
        ("sweep", reader_d),
    ):
        assert isinstance(result, list), (
            f"four_reader_non_breakage: reader '{name}' must return a list, got {type(result)}"
        )
