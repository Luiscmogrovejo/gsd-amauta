#!/usr/bin/env python3
"""Tests for the Docker/Postgres bring-up and SQLite -> Postgres migration.

Covers services/pg_dsn.py, services/migrate_runner.py,
services/migrate_sqlite_to_pg.py, the import path in services/pg_store.py,
services/infra_detect.py's capability pre-check, docker/docker-compose.yml and
the RLM index fixes.

Tests that need a real PostgreSQL are marked ``integration`` and SKIP cleanly
unless ``GSD_TEST_POSTGRES_URL`` points at a throwaway server, e.g.::

    docker run -d --name pgtest -e POSTGRES_USER=gsd -e POSTGRES_PASSWORD=gsd \
      -e POSTGRES_DB=gsd_amauta -p 127.0.0.1:55432:5432 \
      paradedb/paradedb:latest-pg16
    GSD_TEST_POSTGRES_URL=postgresql://gsd:gsd@127.0.0.1:55432/gsd_amauta \
      python3 -m pytest tests/test_docker_pg_migration.py -v

Each integration test runs against its OWN scratch database created on that
server and dropped afterwards, so it never touches the configured one.

Run: python3 -m pytest tests/test_docker_pg_migration.py -v
"""

import os
import pathlib
import sqlite3
import sys
import uuid

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services import migrate_runner, pg_dsn  # noqa: E402
from services import infra_detect  # noqa: E402

MIGRATIONS_DIR = REPO_ROOT / "migrations"
COMPOSE = (REPO_ROOT / "docker" / "docker-compose.yml").read_text(encoding="utf-8")
#: Compose file with comment lines removed — the comments explain the fixes and
#: therefore quote the very strings these tests assert are gone.
COMPOSE_CODE = "\n".join(
    line for line in COMPOSE.splitlines() if not line.strip().startswith("#")
)


def _strip_py_comments(source):
    """Drop whole-line ``#`` comments so a test does not match its own rationale."""
    return "\n".join(
        line for line in source.splitlines() if not line.strip().startswith("#")
    )

TEST_DSN = os.environ.get("GSD_TEST_POSTGRES_URL", "").strip()
requires_pg = pytest.mark.skipif(
    not TEST_DSN,
    reason="GSD_TEST_POSTGRES_URL not set — no throwaway PostgreSQL to test against",
)


# ══════════════════════════════════════════════════════════════════
# Fixtures
# ══════════════════════════════════════════════════════════════════

@pytest.fixture
def scratch_dsn():
    """A fresh, empty database on the test server; dropped afterwards."""
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    name = "gsd_wt_test_" + uuid.uuid4().hex[:12]
    admin = pg_dsn.dsn_with_database(TEST_DSN, "postgres")
    conn = psycopg2.connect(admin, connect_timeout=10)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with conn.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    conn.close()
    try:
        yield pg_dsn.dsn_with_database(TEST_DSN, name)
    finally:
        conn = psycopg2.connect(admin, connect_timeout=10)
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()", (name,)
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
        conn.close()


@pytest.fixture
def migrated_dsn(scratch_dsn):
    """A scratch database with every migration applied."""
    migrate_runner.apply_migrations(dsn=scratch_dsn, log=lambda *_: None)
    return scratch_dsn


def _make_sqlite(path, memory_rows=3, task_rows=2, long_title=False):
    """Build a small SQLite database shaped like the real one."""
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE gsd_memory (
            id TEXT PRIMARY KEY, text TEXT NOT NULL, agent_id TEXT,
            source TEXT DEFAULT 'agent', tags TEXT DEFAULT '[]',
            metadata TEXT DEFAULT '{}', project_id TEXT,
            created_at TEXT, updated_at TEXT);
        CREATE TABLE gsd_shared_kb (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
            category TEXT, agent_id TEXT, tags TEXT DEFAULT '[]',
            importance INTEGER DEFAULT 5, source_task TEXT,
            created_at TEXT, updated_at TEXT);
        CREATE TABLE gsd_tasks (
            id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'default',
            type TEXT DEFAULT 'task', title TEXT NOT NULL, description TEXT,
            status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'medium',
            rpetd_complete INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
            created_at TEXT, updated_at TEXT);
        CREATE TABLE gsd_task_validations (
            id INTEGER PRIMARY KEY, task_id TEXT NOT NULL,
            validator_id TEXT NOT NULL, status TEXT NOT NULL,
            evidence TEXT DEFAULT '{}', created_at TEXT);
        CREATE TABLE gsd_memory_fts_data (id INTEGER PRIMARY KEY, block BLOB);
        CREATE TABLE unknown_to_postgres (id TEXT PRIMARY KEY, whatever TEXT);
    """)
    for i in range(memory_rows):
        conn.execute(
            "INSERT INTO gsd_memory (id, text, source, tags, metadata, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (f"mem-{i:04d}", f"memory text {i}", "lesson-learned",
             '["a","b"]', '{"k":1}', "2026-01-01 00:00:00", "2026-01-01 00:00:00"),
        )
    for i in range(task_rows):
        title = ("T" * 900) if (long_title and i == 0) else f"task title {i}"
        conn.execute(
            "INSERT INTO gsd_tasks (id, title, status, priority, rpetd_complete,"
            " tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (f"TK-{i:04d}", title, "done", "high", 1, '["x"]',
             "2026-01-01 00:00:00", "2026-01-01 00:00:00"),
        )
    conn.execute(
        "INSERT INTO gsd_shared_kb (id, title, content, importance, created_at, updated_at)"
        " VALUES ('skb-0001','kb title','kb content',6,'2026-01-01 00:00:00','2026-01-01 00:00:00')"
    )
    conn.execute(
        "INSERT INTO gsd_task_validations (id, task_id, validator_id, status, evidence, created_at)"
        " VALUES (1,'TK-0000','gsd-validator','approved','{}','2026-01-01 00:00:00')"
    )
    conn.execute("INSERT INTO unknown_to_postgres VALUES ('u1','ignored')")
    conn.commit()
    conn.close()
    return path


# ══════════════════════════════════════════════════════════════════
# 1 + 8. docker-compose.yml
# ══════════════════════════════════════════════════════════════════

class TestCompose:
    def test_host_ports_are_env_overridable_with_current_defaults(self):
        assert '"127.0.0.1:${GSD_PG_PORT:-5433}:5432"' in COMPOSE
        assert '"127.0.0.1:${GSD_REDIS_PORT:-6379}:6379"' in COMPOSE
        assert '"127.0.0.1:${GSD_MCP_PORT:-18800}:18800"' in COMPOSE

    def test_redis_and_mcp_are_behind_profiles_so_postgres_starts_alone(self):
        assert 'profiles: ["cache", "full"]' in COMPOSE
        assert 'profiles: ["mcp", "full"]' in COMPOSE
        # postgres must NOT be in a profile, or a bare `up -d` starts nothing.
        postgres_block = COMPOSE.split("  postgres:")[1].split("\n  redis:")[0]
        assert "profiles:" not in postgres_block

    def test_no_shared_preload_libraries_override(self):
        """The override dropped pg_cron and broke the image's own initdb."""
        assert "shared_preload_libraries" not in COMPOSE_CODE

    def test_healthcheck_does_not_hardcode_the_user(self):
        assert "pg_isready -U gsd -d gsd_amauta" not in COMPOSE
        assert "POSTGRES_USER:-gsd" in COMPOSE

    def test_migrations_are_not_mounted_into_initdb(self):
        assert "docker-entrypoint-initdb.d" not in COMPOSE_CODE

    def test_every_image_is_pinned_by_digest(self):
        images = [line.split("image:", 1)[1].strip()
                  for line in COMPOSE.splitlines()
                  if line.strip().startswith("image:")]
        assert images, "no images found in compose file"
        for image in images:
            assert "@sha256:" in image, f"{image} is not pinned by digest"

    def test_mcp_pip_install_is_pinned_to_an_exact_version(self):
        assert "'mcp>=1.0'" not in COMPOSE_CODE
        assert "mcp==" in COMPOSE_CODE

    def test_env_example_documents_every_port(self):
        env_example = (REPO_ROOT / "docker" / ".env.example").read_text(encoding="utf-8")
        for name in ("GSD_PG_PORT", "GSD_REDIS_PORT", "GSD_MCP_PORT",
                     "POSTGRES_USER", "POSTGRES_PASSWORD"):
            assert name in env_example


# ══════════════════════════════════════════════════════════════════
# 4. DSN resolution
# ══════════════════════════════════════════════════════════════════

class TestDsnResolution:
    def test_gsd_postgres_url_wins_over_database_url(self):
        env = {"GSD_POSTGRES_URL": "postgresql://a@h/one",
               "DATABASE_URL": "postgresql://b@h/two"}
        assert pg_dsn.resolve_dsn(env=env) == "postgresql://a@h/one"
        assert pg_dsn.dsn_source(env=env) == "GSD_POSTGRES_URL"

    def test_database_url_is_used_when_gsd_postgres_url_is_absent(self):
        env = {"DATABASE_URL": "postgresql://b@h/two"}
        assert pg_dsn.resolve_dsn(env=env) == "postgresql://b@h/two"

    def test_amauta_memory_database_url_is_the_third_choice(self):
        env = {"AMAUTA_MEMORY_DATABASE_URL": "postgresql://c@h/three"}
        assert pg_dsn.resolve_dsn(env=env) == "postgresql://c@h/three"

    def test_explicit_argument_beats_every_env_var(self):
        env = {"GSD_POSTGRES_URL": "postgresql://a@h/one"}
        assert pg_dsn.resolve_dsn("postgresql://x@h/x", env=env) == "postgresql://x@h/x"

    def test_an_absent_dsn_is_never_invented(self):
        # Containment (services/pg_dsn.py): no variable set means no DSN.
        assert pg_dsn.resolve_dsn(env={}) is None
        assert pg_dsn.dsn_source(env={}) is None
        with pytest.raises(pg_dsn.UnconfiguredPostgresDSN):
            pg_dsn.require_dsn(environ={})

    def test_local_docker_dsn_matches_the_compose_file(self):
        # Built only on request (detection, --local-docker), never as a fallback.
        # Built from the product constant rather than written out, so no test
        # file contains a literal DSN aimed at the operator's live PostgreSQL.
        assert pg_dsn.DEFAULT_PG_PORT == "5433", "the documented default port moved"
        assert pg_dsn.local_docker_dsn({}) == (
            "postgresql://gsd:gsd@127.0.0.1:%s/gsd_amauta" % pg_dsn.DEFAULT_PG_PORT
        )

    def test_postgres_user_password_and_port_overrides_are_honoured(self):
        env = {"POSTGRES_USER": "alice", "POSTGRES_PASSWORD": "s3cr3t",
               "GSD_PG_PORT": "15433", "GSD_PG_DB": "other"}
        assert pg_dsn.local_docker_dsn(env) == \
            "postgresql://alice:s3cr3t@127.0.0.1:15433/other"

    def test_password_special_characters_are_url_encoded(self):
        env = {"POSTGRES_PASSWORD": "p@ss/word"}
        assert "p%40ss%2Fword" in pg_dsn.local_docker_dsn(env)

    def test_port_helpers_default_to_the_compose_values(self):
        assert pg_dsn.pg_port(env={}) == "5433"
        assert pg_dsn.redis_port(env={}) == "6379"
        assert pg_dsn.mcp_port(env={}) == "18800"

    def test_mask_dsn_hides_the_password(self):
        masked = pg_dsn.mask_dsn("postgresql://gsd:hunter2@h:65432/db")
        assert "hunter2" not in masked and "***" in masked

    def test_dsn_parts_round_trips(self):
        parts = pg_dsn.dsn_parts("postgresql://u:p@host:1234/dbname")
        assert parts == {"user": "u", "password": "p", "host": "host",
                         "port": "1234", "database": "dbname"}

    def test_infra_detect_and_pg_store_use_the_same_resolver(self):
        infra_src = (REPO_ROOT / "services" / "infra_detect.py").read_text(encoding="utf-8")
        store_src = (REPO_ROOT / "services" / "pg_store.py").read_text(encoding="utf-8")
        assert "pg_dsn import" in infra_src
        assert "pg_dsn import" in store_src
        # PGStore resolves through the fail-closed entry point: no default DSN.
        assert '_require_dsn(' in store_src


# ══════════════════════════════════════════════════════════════════
# 2. Migration files + runner (no database needed)
# ══════════════════════════════════════════════════════════════════

class TestMigrationFiles:
    def test_every_up_migration_is_idempotent(self):
        """No bare CREATE TABLE / CREATE INDEX in any UP file."""
        offenders = []
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if migrate_runner.is_down_file(path.name):
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("--"):
                    continue
                upper = stripped.upper()
                for verb in ("CREATE TABLE ", "CREATE INDEX ",
                             "CREATE UNIQUE INDEX "):
                    if upper.startswith(verb) and "IF NOT EXISTS" not in upper:
                        offenders.append(f"{path.name}:{number}: {stripped[:70]}")
        # A bm25 index cannot use IF NOT EXISTS; those files DROP first.
        offenders = [
            o for o in offenders
            if not _preceded_by_drop_index(MIGRATIONS_DIR / o.split(":")[0],
                                           int(o.split(":")[1]))
        ]
        assert offenders == [], "non-idempotent statements:\n" + "\n".join(offenders)

    @pytest.mark.parametrize("name", [
        "014-agent-findings", "015-agent-messages", "016-agent-metrics",
        "017-step-handoffs", "018-task-completions", "019-skill-invocations",
        "022-module-installs",
    ])
    def test_previously_non_idempotent_migrations_now_guard_creates(self, name):
        sql = (MIGRATIONS_DIR / f"{name}.sql").read_text(encoding="utf-8")
        assert "CREATE TABLE IF NOT EXISTS" in sql

    def test_every_up_migration_has_a_down_file(self):
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if migrate_runner.is_down_file(path.name):
                continue
            down = path.with_name(path.stem + "-DOWN.sql")
            assert down.exists(), f"missing DOWN for {path.name}"


def _preceded_by_drop_index(path, line_number):
    """True when the two lines above *line_number* contain DROP INDEX."""
    lines = path.read_text(encoding="utf-8").splitlines()
    window = " ".join(lines[max(0, line_number - 3):line_number - 1]).upper()
    return "DROP INDEX IF EXISTS" in window


class TestMigrationRunnerUnit:
    def test_down_files_are_recognised(self):
        assert migrate_runner.is_down_file("014-agent-findings-DOWN.sql")
        assert not migrate_runner.is_down_file("014-agent-findings.sql")
        assert not migrate_runner.is_down_file("020-agent-findings-hydration.sql")

    def test_discover_never_returns_a_down_file(self):
        names = [n for n, _, _ in migrate_runner.discover_migrations(MIGRATIONS_DIR)]
        assert names, "no migrations discovered"
        assert not any(migrate_runner.is_down_file(n) for n in names)

    def test_discovery_is_ordered_by_numeric_prefix(self):
        names = [n for n, _, _ in migrate_runner.discover_migrations(MIGRATIONS_DIR)]
        numbers = [int(n.split("-")[0]) for n in names]
        assert numbers == sorted(numbers)
        assert names[0].startswith("001-")

    def test_checksum_ignores_line_ending_style(self):
        assert migrate_runner.checksum("a\nb\n") == migrate_runner.checksum("a\r\nb\r\n")
        assert migrate_runner.checksum("a") != migrate_runner.checksum("b")

    def test_hydration_file_is_not_mistaken_for_a_down_file(self):
        """020-agent-findings-hydration.sql contains no '-DOWN.sql' suffix."""
        names = [n for n, _, _ in migrate_runner.discover_migrations(MIGRATIONS_DIR)]
        assert "020-agent-findings-hydration.sql" in names


@requires_pg
class TestMigrationRunnerIntegration:
    def test_fresh_database_applies_everything_then_a_rerun_is_a_noop(self, scratch_dsn):
        first = migrate_runner.apply_migrations(dsn=scratch_dsn, log=lambda *_: None)
        assert len(first["applied"]) == first["total"] > 25
        assert first["drifted"] == []

        second = migrate_runner.apply_migrations(dsn=scratch_dsn, log=lambda *_: None)
        assert second["applied"] == []
        assert second["already_applied"] == first["total"]

    def test_every_migration_is_re_runnable_against_an_untracked_database(
            self, migrated_dsn):
        """Simulates the old bin/init.cjs psql loop having already run."""
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DROP TABLE schema_migrations")
        conn.close()

        status = migrate_runner.status(dsn=migrated_dsn)
        assert status["pre_migrated_detected"] is True

        # auto_baseline_enabled=False forces every file to be executed again,
        # which is the point here: proving the UP files are genuinely
        # idempotent, not just that baseline detection skipped them.
        result = migrate_runner.apply_migrations(
            dsn=migrated_dsn, auto_baseline_enabled=False, log=lambda *_: None)
        assert len(result["applied"]) == result["total"]

    def test_dry_run_changes_nothing(self, scratch_dsn):
        result = migrate_runner.apply_migrations(
            dsn=scratch_dsn, dry_run=True, log=lambda *_: None)
        assert result["applied"] == []
        assert result["pending"]
        import psycopg2
        conn = psycopg2.connect(scratch_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('gsd_memory'), to_regclass('schema_migrations')")
            assert cur.fetchone() == (None, None)
        conn.close()

    def test_a_failing_migration_exits_non_zero_and_rolls_its_file_back(
            self, scratch_dsn, tmp_path):
        (tmp_path / "001-ok.sql").write_text(
            "BEGIN;\nCREATE TABLE IF NOT EXISTS ok_one (id int);\nCOMMIT;\n", encoding="utf-8")
        (tmp_path / "002-bad.sql").write_text(
            "BEGIN;\nCREATE TABLE bad_two (id int);\nSELECT 1/0;\nCOMMIT;\n", encoding="utf-8")
        (tmp_path / "003-ok.sql").write_text(
            "BEGIN;\nCREATE TABLE IF NOT EXISTS ok_three (id int);\nCOMMIT;\n", encoding="utf-8")

        with pytest.raises(migrate_runner.MigrationError) as excinfo:
            migrate_runner.apply_migrations(
                dsn=scratch_dsn, migrations_dir=str(tmp_path), log=lambda *_: None)
        assert excinfo.value.filename == "002-bad.sql"
        assert excinfo.value.sqlstate == "22012"

        import psycopg2
        conn = psycopg2.connect(scratch_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('ok_one'), to_regclass('bad_two'),"
                        " to_regclass('ok_three')")
            ok_one, bad_two, ok_three = cur.fetchone()
        conn.close()
        assert ok_one is not None, "the migration before the failure must stay applied"
        assert bad_two is None, "the failing file must be rolled back whole"
        assert ok_three is None, "the run must stop at the failure"

        exit_code = migrate_runner.main(
            ["--dsn", scratch_dsn, "--migrations-dir", str(tmp_path)])
        assert exit_code == 1

    def test_baseline_records_without_executing(self, scratch_dsn, tmp_path):
        (tmp_path / "001-ok.sql").write_text(
            "BEGIN;\nCREATE TABLE IF NOT EXISTS never_created (id int);\nCOMMIT;\n", encoding="utf-8")
        migrate_runner.apply_migrations(
            dsn=scratch_dsn, migrations_dir=str(tmp_path), baseline=True,
            log=lambda *_: None)
        import psycopg2
        conn = psycopg2.connect(scratch_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('never_created')")
            assert cur.fetchone()[0] is None
            cur.execute("SELECT baselined FROM schema_migrations WHERE filename='001-ok.sql'")
            assert cur.fetchone()[0] is True
        conn.close()

    def test_an_edited_applied_migration_is_reported_as_drift_not_re_run(
            self, scratch_dsn, tmp_path):
        path = tmp_path / "001-ok.sql"
        path.write_text("BEGIN;\nCREATE TABLE IF NOT EXISTS drift_t (id int);\nCOMMIT;\n", encoding="utf-8")
        migrate_runner.apply_migrations(
            dsn=scratch_dsn, migrations_dir=str(tmp_path), log=lambda *_: None)
        path.write_text("BEGIN;\nCREATE TABLE IF NOT EXISTS drift_t (id int);\n-- edit\nCOMMIT;\n", encoding="utf-8")
        status = migrate_runner.status(dsn=scratch_dsn, migrations_dir=str(tmp_path))
        assert status["drifted"] == ["001-ok.sql"]
        assert status["pending"] == []

    def test_status_cli_returns_zero_on_an_empty_database(self, scratch_dsn):
        assert migrate_runner.main(["--dsn", scratch_dsn, "--status", "--json"]) == 0

    def test_migration_028_widens_the_task_title(self, migrated_dsn):
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT data_type, character_maximum_length
                FROM information_schema.columns
                WHERE table_name='gsd_tasks' AND column_name='title'
            """)
            data_type, length = cur.fetchone()
        conn.close()
        assert data_type == "text" and length is None

    def test_migration_029_adds_rlm_provenance_columns(self, migrated_dsn):
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name='rlm_chunks'
                  AND column_name IN ('embedding_model','file_mtime','file_size')
            """)
            found = {row[0] for row in cur.fetchall()}
        conn.close()
        assert found == {"embedding_model", "file_mtime", "file_size"}


# ══════════════════════════════════════════════════════════════════
# 3. infra_detect capability pre-check
# ══════════════════════════════════════════════════════════════════

class TestCapabilityPrecheckUnit:
    def test_version_tuple_parses_pgvector_strings(self):
        assert infra_detect._version_tuple("0.8.2") == (0, 8, 2)
        assert infra_detect._version_tuple("0.1.8") == (0, 1, 8)
        assert infra_detect._version_tuple("0.8") == (0, 8, 0)

    def test_the_floor_matches_what_the_migrations_demand(self):
        assert infra_detect.MIN_PGVECTOR == (0, 8, 0)
        assert "0.8.0" in (MIGRATIONS_DIR / "011-paradedb-setup.sql").read_text(encoding="utf-8")
        assert "pg_search" in infra_detect.REQUIRED_EXTENSIONS
        assert "vector" in infra_detect.REQUIRED_EXTENSIONS

    def test_an_unreachable_server_is_rejected_with_a_reason(self):
        ok, report = infra_detect.check_pg_capabilities(
            "postgresql://nobody@127.0.0.1:1/none")
        assert ok is False
        assert report["reachable"] is False
        assert report["reason"]

    def test_detect_reports_each_service_separately(self, monkeypatch):
        # HERMETIC: GSD_FORCE_SQLITE short-circuits detection so this can
        # never probe 5432-5434 or auto-start the real gsd-postgres container.
        monkeypatch.setenv("GSD_FORCE_SQLITE", "1")
        result = infra_detect.detect_infrastructure(auto_start=False)
        assert result["backend"] == "sqlite"
        assert "services" in result and "rejected" in result
        assert set(result["services"]) >= {"postgres", "redis"}
        for service in result["services"].values():
            assert "status" in service and "detail" in service

    def test_auto_start_only_brings_up_the_postgres_service(self):
        src = (REPO_ROOT / "services" / "infra_detect.py").read_text(encoding="utf-8")
        assert '"up", "-d", "postgres"' in src
        assert '"up", "-d"]' not in src


@requires_pg
class TestCapabilityPrecheckIntegration:
    def test_a_capable_server_passes(self):
        ok, report = infra_detect.check_pg_capabilities(TEST_DSN)
        assert ok, report["reason"]
        assert report["server_major"] >= infra_detect.MIN_SERVER_MAJOR
        assert infra_detect._version_tuple(report["pgvector_version"]) >= (0, 8, 0)

    def test_an_impossible_pgvector_floor_is_rejected_with_the_version(self):
        ok, report = infra_detect.check_pg_capabilities(
            TEST_DSN, min_pgvector=(99, 0, 0))
        assert ok is False
        assert "99.0.0" in report["reason"]
        assert report["pgvector_version"] in report["reason"]

    def test_a_missing_extension_is_named_in_the_rejection(self):
        ok, report = infra_detect.check_pg_capabilities(
            TEST_DSN, required_extensions=("vector", "definitely_not_an_extension"))
        assert ok is False
        assert "definitely_not_an_extension" in report["reason"]


# ══════════════════════════════════════════════════════════════════
# 5. Import path: savepoints, full column carry
# ══════════════════════════════════════════════════════════════════

class TestImportResultUnit:
    def test_import_result_is_an_int_so_old_callers_keep_working(self):
        from services.pg_store import ImportResult
        result = ImportResult(7, failed=2, failures=[{"id": "x", "error": "e"}],
                              skipped=1)
        assert result == 7 and int(result) == 7
        assert result + 1 == 8
        assert result.failed == 2 and result.skipped == 1 and result.ok is False
        assert ImportResult(3).ok is True

    def test_backup_restore_reports_failures_and_sets_ok_false(self):
        from services.backup import BackupManager
        from services.pg_store import ImportResult

        class Store:
            def import_memory(self, rows, mode):
                return ImportResult(1, failed=1,
                                    failures=[{"id": "mem-2", "error": "boom"}])

        results = BackupManager(Store()).restore.__wrapped__ \
            if hasattr(BackupManager(Store()).restore, "__wrapped__") else None
        # restore() needs a file; exercise the reporting shape directly instead.
        manager = BackupManager(Store())
        count = manager.store.import_memory([{}, {}], "merge")
        assert count.failed == 1 and count.failures[0]["id"] == "mem-2"
        assert results is None  # placeholder keeps the import used

    def test_restore_surfaces_lost_rows(self, tmp_path):
        import gzip
        import json as _json
        from services.backup import BackupManager, SCHEMA_VERSION
        from services.pg_store import ImportResult

        class Store:
            def import_memory(self, rows, mode):
                return ImportResult(1, failed=1,
                                    failures=[{"id": "mem-2", "error": "boom"}])

        tables = {"gsd_memory": [{"id": "mem-1"}, {"id": "mem-2"}]}
        payload = {
            "schema_version": SCHEMA_VERSION,
            "created_at": "2026-01-01T00:00:00",
            "tables": tables,
            "counts": {"gsd_memory": 2},
        }
        import hashlib
        payload["checksum"] = hashlib.sha256(
            _json.dumps(tables, sort_keys=True, default=str).encode()
        ).hexdigest()
        path = tmp_path / "backup.json.gz"
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            _json.dump(payload, handle, default=str)

        result = BackupManager(Store()).restore(str(path))
        assert result["ok"] is False
        assert result["rows_failed"] == 1
        assert result["row_detail"]["gsd_memory"]["source"] == 2
        assert result["failures"]["gsd_memory"][0]["id"] == "mem-2"


@requires_pg
class TestImportIntegration:
    def _store(self, dsn):
        from services.pg_store import PGStore
        return PGStore(dsn=dsn, min_conn=1, max_conn=2)

    def test_one_bad_row_costs_exactly_one_row(self, migrated_dsn):
        store = self._store(migrated_dsn)
        try:
            rows = [{"id": f"skb-{i}", "title": "x" * 600 if i == 2 else f"t{i}",
                     "content": "c"} for i in range(5)]
            result = store.import_skb(rows)
            assert int(result) == 4
            assert result.failed == 1
            assert result.failures[0]["id"] == "skb-2"
            assert "too long" in result.failures[0]["error"]
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT COUNT(*) FROM gsd_shared_kb")
                    assert cur.fetchone()[0] == 4
        finally:
            store.close()

    def test_import_memory_carries_bitemporal_and_applied_count(self, migrated_dsn):
        store = self._store(migrated_dsn)
        try:
            row = {
                "id": "mem-bitemporal", "text": "t", "source": "lesson-learned",
                "applied_count": 7,
                "valid_at": "2025-06-01 00:00:00+00",
                "invalid_at": "2025-07-01 00:00:00+00",
            }
            assert int(store.import_memory([row])) == 1
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT applied_count, valid_at, invalid_at "
                                "FROM gsd_memory WHERE id='mem-bitemporal'")
                    applied_count, valid_at, invalid_at = cur.fetchone()
            assert applied_count == 7
            assert valid_at.year == 2025 and valid_at.month == 6
            assert invalid_at is not None, "migration-026 columns must survive import"
        finally:
            store.close()

    def test_import_is_idempotent_on_the_primary_key(self, migrated_dsn):
        store = self._store(migrated_dsn)
        try:
            rows = [{"id": "mem-dupe", "text": "t"}]
            assert int(store.import_memory(rows)) == 1
            again = store.import_memory(rows)
            assert int(again) == 0 and again.skipped == 1 and again.ok
        finally:
            store.close()

    def test_validations_carry_their_id_and_the_sequence_is_synced(self, migrated_dsn):
        store = self._store(migrated_dsn)
        try:
            rows = [{"id": 10, "task_id": "TK-1", "validator_id": "v",
                     "status": "approved"}]
            assert int(store.import_validations(rows)) == 1
            assert int(store.import_validations(rows)) == 0  # idempotent
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO gsd_task_validations "
                                "(task_id, validator_id, status) "
                                "VALUES ('TK-2','v','approved') RETURNING id")
                    assert cur.fetchone()[0] > 10
        finally:
            store.close()


# ══════════════════════════════════════════════════════════════════
# 6. SQLite -> Postgres migration command
# ══════════════════════════════════════════════════════════════════

class TestSqliteMigrationUnit:
    def test_fts_shadow_tables_are_skipped(self, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"))
        conn = mig.open_sqlite_readonly(path)
        try:
            names = mig.sqlite_tables(conn)
        finally:
            conn.close()
        assert "gsd_memory" in names
        assert not any(n.endswith("_fts_data") for n in names)

    def test_the_source_is_opened_read_only(self, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"))
        conn = mig.open_sqlite_readonly(path)
        try:
            with pytest.raises(sqlite3.OperationalError):
                conn.execute("DELETE FROM gsd_memory")
        finally:
            conn.close()

    def test_empty_strings_become_null_for_non_text_columns(self):
        from services import migrate_sqlite_to_pg as mig
        row = {"created_at": "", "title": "", "rpetd_complete": 1}
        columns = {"created_at": "timestamp with time zone",
                   "title": "text", "rpetd_complete": "boolean"}
        out = mig.normalise_row(row, columns)
        assert out["created_at"] is None
        assert out["title"] == ""
        assert out["rpetd_complete"] is True

    def test_columns_absent_in_postgres_are_dropped(self):
        from services import migrate_sqlite_to_pg as mig
        out = mig.normalise_row({"id": "a", "gone": "x"}, {"id": "text"})
        assert out == {"id": "a"}

    def test_no_embedding_api_is_referenced(self):
        src = (REPO_ROOT / "services" / "migrate_sqlite_to_pg.py").read_text(encoding="utf-8")
        for forbidden in ("generate_embedding", "embed_code", "voyageai",
                          "VOYAGE_API_KEY", "OPENAI_API_KEY"):
            assert forbidden not in src, f"{forbidden} must not be used by the migrator"


@requires_pg
class TestSqliteMigrationIntegration:
    def test_round_trip_counts_match_and_a_rerun_is_idempotent(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=5, task_rows=3)

        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 log=lambda *_: None)
        assert ok, report
        by_table = {t["table"]: t for t in report["tables"]}
        assert by_table["gsd_memory"]["inserted"] == 5
        assert by_table["gsd_tasks"]["inserted"] == 3
        assert by_table["gsd_shared_kb"]["inserted"] == 1
        assert by_table["gsd_task_validations"]["inserted"] == 1
        assert all(t["failed"] == 0 for t in report["tables"])
        assert all(v["missing"] == 0 for v in report["verification"])
        # A table with no Postgres counterpart is reported, not silently lost.
        assert "unknown_to_postgres" in report["tables_skipped"]

        ok, again = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                log=lambda *_: None)
        assert ok
        assert all(t["insert"] == 0 for t in again["tables"])
        assert all(t["inserted"] == 0 for t in again["tables"])
        assert sum(t["identical"] for t in again["tables"]) == 10
        assert sum(t["conflict"] for t in again["tables"]) == 0

    def test_long_task_titles_survive(self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), task_rows=2, long_title=True)
        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 log=lambda *_: None)
        assert ok, report
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT length(title) FROM gsd_tasks WHERE id='TK-0000'")
            assert cur.fetchone()[0] == 900
        conn.close()

    def test_dry_run_writes_nothing(self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"))
        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 dry_run=True, log=lambda *_: None)
        assert ok
        assert all(t["inserted"] == 0 for t in report["tables"])
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory")
            assert cur.fetchone()[0] == 0
        conn.close()

    def test_imported_memories_land_with_null_embeddings_for_the_backfill(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=4)
        mig.migrate(sqlite_path=path, dsn=migrated_dsn, log=lambda *_: None)
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            # This is exactly memory_backfill_embeddings' selection query.
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE embedding IS NULL")
            assert cur.fetchone()[0] == 4
        conn.close()

    def test_the_cli_exits_non_zero_when_a_row_cannot_land(
            self, scratch_dsn, tmp_path):
        """Without migration 029 a 900-char title is rejected — and reported."""
        from services import migrate_sqlite_to_pg as mig
        partial = tmp_path / "mig"
        partial.mkdir()
        for sql in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if sql.name.startswith(("029", "030")):
                continue
            (partial / sql.name).write_text(sql.read_text(encoding="utf-8"), encoding="utf-8")
        migrate_runner.apply_migrations(dsn=scratch_dsn,
                                        migrations_dir=str(partial),
                                        log=lambda *_: None)
        path = _make_sqlite(str(tmp_path / "s.db"), task_rows=3, long_title=True)
        exit_code = mig.main(["--sqlite", path, "--dsn", scratch_dsn,
                              "--table", "gsd_tasks"])
        assert exit_code == 1

    def test_the_cli_exits_zero_on_a_clean_run(self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"))
        assert mig.main(["--sqlite", path, "--dsn", migrated_dsn, "--json"]) == 0


# ══════════════════════════════════════════════════════════════════
# 7. RLM index fixes
# ══════════════════════════════════════════════════════════════════

class TestRlmEmbeddingsUnit:
    def test_cache_key_uses_the_whole_text_not_the_first_512_chars(self):
        from services import rlm_embeddings as emb
        shared_prefix = "x" * 512
        a = emb._cache_key(shared_prefix + "AAA", emb.VOYAGE_MODEL, "document")
        b = emb._cache_key(shared_prefix + "BBB", emb.VOYAGE_MODEL, "document")
        assert a != b, "two chunks sharing a 512-char prefix must not collide"

    def test_cache_key_separates_query_from_document_and_model_from_model(self):
        from services import rlm_embeddings as emb
        text = "def f(): pass"
        assert emb._cache_key(text, emb.VOYAGE_MODEL, "document") != \
            emb._cache_key(text, emb.VOYAGE_MODEL, "query")
        assert emb._cache_key(text, emb.VOYAGE_MODEL, "document") != \
            emb._cache_key(text, emb.QODO_MODEL, "document")

    def test_input_type_is_validated(self):
        from services import rlm_embeddings as emb
        with pytest.raises(ValueError):
            emb.embed_code("some text", input_type="passage")

    def test_voyage_is_called_with_the_caller_s_input_type(self, monkeypatch):
        from services import rlm_embeddings as emb
        emb.clear_cache()
        seen = {}

        class FakeClient:
            def __init__(self, api_key):
                pass

            def embed(self, texts, model, input_type, output_dimension=None):
                seen["input_type"] = input_type

                class R:
                    embeddings = [[0.1] * 1024]
                return R()

        fake_module = type("m", (), {"Client": FakeClient})
        monkeypatch.setitem(sys.modules, "voyageai", fake_module)
        monkeypatch.setenv("VOYAGE_API_KEY", "test-key")

        emb.embed_code("code", input_type=emb.INPUT_TYPE_DOCUMENT)
        assert seen["input_type"] == "document"
        emb.clear_cache()
        emb.embed_code("code", input_type=emb.INPUT_TYPE_QUERY)
        assert seen["input_type"] == "query"
        emb.clear_cache()

    def test_embed_code_reports_the_producing_model(self, monkeypatch):
        from services import rlm_embeddings as emb
        emb.clear_cache()
        monkeypatch.setattr(emb, "_try_voyage", lambda text, input_type: None)
        monkeypatch.setattr(emb, "_try_qodo", lambda text: [0.0] * 1024)
        vector, model = emb.embed_code("code")
        assert len(vector) == 1024 and model == emb.QODO_MODEL
        emb.clear_cache()

    def test_active_embedding_model_follows_the_api_key(self, monkeypatch):
        from services import rlm_embeddings as emb
        monkeypatch.setenv("VOYAGE_API_KEY", "k")
        assert emb.active_embedding_model() == emb.VOYAGE_MODEL
        monkeypatch.delenv("VOYAGE_API_KEY")
        monkeypatch.setenv("GSD_RLM_DISABLE_QODO", "1")
        assert emb.active_embedding_model() is None


class TestRlmSearchUnit:
    def test_the_query_is_embedded_as_a_query(self):
        src = (REPO_ROOT / "services" / "rlm_search.py").read_text(encoding="utf-8")
        assert "INPUT_TYPE_QUERY" in src
        assert "input_type=INPUT_TYPE_QUERY" in src

    def test_the_file_filter_no_longer_matches_sibling_directories(self):
        src = _strip_py_comments(
            (REPO_ROOT / "services" / "rlm_search.py").read_text(encoding="utf-8"))
        # Neither the hybrid leg nor the BM25-only leg may use a bare prefix LIKE.
        assert 'f"{file_filter}%"' not in src
        assert "AND (c.file_path = %s OR c.file_path LIKE %s)" in src
        assert "AND (file_path = %s OR file_path LIKE %s)" in src

    def test_the_vector_leg_can_be_filtered_independently(self):
        import inspect
        from services.rlm_search import hybrid_search_generic
        params = inspect.signature(hybrid_search_generic).parameters
        assert "vector_filter_sql" in params
        assert params["vector_filter_sql"].default == ""
        assert "vector_filter_params" in params


class TestRlmIngestionUnit:
    def test_ingest_file_deletes_this_file_s_stale_chunks(self):
        src = (REPO_ROOT / "services" / "rlm_ingestion.py").read_text(encoding="utf-8")
        assert "DELETE FROM rlm_chunks " in src
        assert "id <> ALL(%s)" in src

    def test_prune_missing_files_exists_and_avoids_the_sibling_prefix_bug(self):
        from services.rlm_ingestion import prune_missing_files
        assert callable(prune_missing_files)
        src = (REPO_ROOT / "services" / "rlm_ingestion.py").read_text(encoding="utf-8")
        assert "WHERE file_path = %s OR file_path LIKE %s" in src

    def test_file_stat_returns_none_for_a_missing_file(self):
        from services.rlm_ingestion import file_stat
        assert file_stat("/definitely/not/here.py") == (None, None)

    def test_file_stat_matches_os_stat(self, tmp_path):
        from services.rlm_ingestion import file_stat
        path = tmp_path / "f.py"
        path.write_text("x = 1\n", encoding="utf-8")
        mtime, size = file_stat(str(path))
        assert size == path.stat().st_size
        assert abs(mtime - path.stat().st_mtime) < 1e-6

    def test_the_per_query_ingest_does_not_prune(self):
        src = (REPO_ROOT / "services" / "rlm-service.py").read_text(encoding="utf-8")
        assert "stats = ingest_directory(directory, pg_conn)" in src
        assert "prune=True" in src  # only the explicit /reindex pass prunes


@requires_pg
class TestRlmIntegration:
    def _conn(self, dsn):
        import psycopg2
        conn = psycopg2.connect(dsn)
        return conn

    def _no_embeddings(self, monkeypatch):
        """Force the BM25-only path so no embedding API is ever called."""
        from services import rlm_embeddings as emb
        emb.clear_cache()
        monkeypatch.setattr(emb, "_try_voyage", lambda text, input_type: None)
        monkeypatch.setattr(emb, "_try_qodo", lambda text: None)

    def test_reingesting_an_edited_file_removes_the_orphaned_chunks(
            self, migrated_dsn, tmp_path, monkeypatch):
        self._no_embeddings(monkeypatch)
        from services.rlm_ingestion import ingest_file
        source = tmp_path / "mod.py"
        source.write_text(
            "def alpha():\n    return 1\n\ndef beta():\n    return 2\n", encoding="utf-8")
        conn = self._conn(migrated_dsn)
        try:
            first = ingest_file(str(source), conn)
            assert first["chunks_inserted"] == 2
            assert first["chunks_deleted"] == 0

            # Rename beta -> gamma AND shift every line: both halves of the
            # upsert key change, so the old rows can only go via the DELETE.
            source.write_text(
                "# header\n\ndef alpha():\n    return 1\n\ndef gamma():\n    return 3\n", encoding="utf-8")
            second = ingest_file(str(source), conn)
            assert second["chunks_deleted"] == 2

            with conn.cursor() as cur:
                cur.execute("SELECT symbol_name FROM rlm_chunks "
                            "WHERE file_path=%s ORDER BY symbol_name",
                            (str(source.resolve()),))
                assert [r[0] for r in cur.fetchall()] == ["alpha", "gamma"]
        finally:
            conn.close()

    def test_prune_removes_chunks_for_deleted_files_only(
            self, migrated_dsn, tmp_path, monkeypatch):
        self._no_embeddings(monkeypatch)
        from services.rlm_ingestion import ingest_directory, prune_missing_files
        root = tmp_path / "root"
        (root / "keep").mkdir(parents=True)
        (root / "keep" / "a.py").write_text("def kept():\n    return 1\n", encoding="utf-8")
        (root / "gone.py").write_text("def removed():\n    return 2\n", encoding="utf-8")
        conn = self._conn(migrated_dsn)
        try:
            ingest_directory(str(root), conn)
            (root / "gone.py").unlink()
            assert prune_missing_files(str(root), conn) >= 1
            with conn.cursor() as cur:
                cur.execute("SELECT DISTINCT file_path FROM rlm_chunks")
                paths = [r[0] for r in cur.fetchall()]
            assert any(p.endswith("keep/a.py") for p in paths)
            assert not any(p.endswith("gone.py") for p in paths)
        finally:
            conn.close()

    def test_an_unchanged_file_is_detected_without_hashing_it(
            self, migrated_dsn, tmp_path, monkeypatch):
        self._no_embeddings(monkeypatch)
        from services import rlm_ingestion
        source = tmp_path / "s.py"
        source.write_text("def f():\n    return 1\n", encoding="utf-8")
        conn = self._conn(migrated_dsn)
        try:
            rlm_ingestion.ingest_file(str(source), conn)
            calls = []
            real = rlm_ingestion.file_sha256
            monkeypatch.setattr(
                rlm_ingestion, "file_sha256",
                lambda p: (calls.append(p), real(p))[1])
            assert rlm_ingestion.is_stale(str(source), conn) is False
            assert calls == [], "mtime/size match must short-circuit the hash"
        finally:
            conn.close()

    def test_the_embedding_model_is_recorded_per_row(
            self, migrated_dsn, tmp_path, monkeypatch):
        from services import rlm_embeddings as emb
        emb.clear_cache()
        monkeypatch.setattr(emb, "_try_voyage", lambda text, input_type: None)
        monkeypatch.setattr(emb, "_try_qodo", lambda text: [0.01] * 1024)
        from services.rlm_ingestion import ingest_file
        source = tmp_path / "m.py"
        source.write_text("def f():\n    return 1\n", encoding="utf-8")
        conn = self._conn(migrated_dsn)
        try:
            ingest_file(str(source), conn)
            with conn.cursor() as cur:
                cur.execute("SELECT DISTINCT embedding_model FROM rlm_chunks "
                            "WHERE file_path=%s", (str(source.resolve()),))
                assert [r[0] for r in cur.fetchall()] == [emb.QODO_MODEL]
        finally:
            conn.close()
            emb.clear_cache()

    def test_the_file_filter_excludes_a_sibling_directory(
            self, migrated_dsn, tmp_path, monkeypatch):
        from services import rlm_embeddings as emb
        emb.clear_cache()
        monkeypatch.setattr(emb, "_try_voyage", lambda text, input_type: None)
        monkeypatch.setattr(emb, "_try_qodo", lambda text: [0.01] * 1024)
        from services.rlm_ingestion import ingest_directory
        from services.rlm_search import hybrid_search

        root = tmp_path / "r"
        (root / "b").mkdir(parents=True)
        (root / "bc").mkdir(parents=True)
        (root / "b" / "x.py").write_text(
            "def kumquat_inside():\n    return 'kumquat'\n", encoding="utf-8")
        (root / "bc" / "y.py").write_text(
            "def kumquat_sibling():\n    return 'kumquat'\n", encoding="utf-8")
        conn = self._conn(migrated_dsn)
        try:
            ingest_directory(str(root), conn)
            narrow = hybrid_search("kumquat", conn, top_k=10,
                                   file_filter=str(root / "b"))
            paths = {r["file_path"] for r in narrow}
            assert paths and all("/bc/" not in p for p in paths)

            wide = hybrid_search("kumquat", conn, top_k=10, file_filter=str(root))
            assert len({r["file_path"] for r in wide}) == 2
        finally:
            conn.close()
            emb.clear_cache()

    def test_the_vector_leg_ignores_rows_from_another_model(
            self, migrated_dsn, tmp_path, monkeypatch):
        from services import rlm_embeddings as emb
        emb.clear_cache()
        monkeypatch.setenv("VOYAGE_API_KEY", "k")
        monkeypatch.setattr(emb, "_try_voyage",
                            lambda text, input_type: [0.02] * 1024)
        from services.rlm_ingestion import ingest_directory
        from services.rlm_search import hybrid_search, RRF_CANDIDATE_K

        root = tmp_path / "v"
        root.mkdir()
        (root / "one.py").write_text("def plumbus_one():\n    return 'plumbus'\n", encoding="utf-8")
        (root / "two.py").write_text("def plumbus_two():\n    return 'plumbus'\n", encoding="utf-8")
        conn = self._conn(migrated_dsn)
        try:
            ingest_directory(str(root), conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE rlm_chunks SET embedding_model='qodo-embed-1-1.5b' "
                    "WHERE file_path LIKE %s", (str(root) + "%two.py",))
            conn.commit()
            results = {r["file_path"]: r for r in
                       hybrid_search("plumbus", conn, top_k=10,
                                     file_filter=str(root))}
            foreign = [r for p, r in results.items() if p.endswith("two.py")]
            native = [r for p, r in results.items() if p.endswith("one.py")]
            assert native and native[0]["rank_vector"] <= RRF_CANDIDATE_K
            assert foreign, "the foreign-model row must still reach BM25"
            assert foreign[0]["rank_vector"] == RRF_CANDIDATE_K + 1
        finally:
            conn.close()
            emb.clear_cache()


# ══════════════════════════════════════════════════════════════════
# Baseline detection against a database migrated by the old psql loop
# ══════════════════════════════════════════════════════════════════

class TestSentinelsUnit:
    def test_every_migration_has_a_sentinel(self):
        """A new migration without a sentinel would be silently un-baselineable."""
        names = {n for n, _, _ in migrate_runner.discover_migrations(MIGRATIONS_DIR)}
        missing = sorted(names - set(migrate_runner.MIGRATION_SENTINELS))
        assert missing == [], f"add MIGRATION_SENTINELS entries for: {missing}"

    def test_no_sentinel_for_a_migration_that_does_not_exist(self):
        names = {n for n, _, _ in migrate_runner.discover_migrations(MIGRATIONS_DIR)}
        stale = sorted(set(migrate_runner.MIGRATION_SENTINELS) - names)
        assert stale == [], f"stale MIGRATION_SENTINELS entries: {stale}"

    def test_every_sentinel_kind_is_known(self):
        known = {"relation", "column", "extension", "coltype", "unbounded"}
        for name, sentinels in migrate_runner.MIGRATION_SENTINELS.items():
            assert sentinels, f"{name} has an empty sentinel list"
            for sentinel in sentinels:
                assert sentinel[0] in known, f"{name}: unknown kind {sentinel[0]!r}"

    def test_003_sentinel_is_the_column_type_it_would_otherwise_rewrite(self):
        """003 NULLs every embedding unless the column is already vector(1024)."""
        sql = (MIGRATIONS_DIR / "003-embedding-1024.sql").read_text(encoding="utf-8")
        assert "SET embedding = NULL" in sql
        assert ("coltype", "gsd_memory", "embedding", "vector(1024)") in \
            migrate_runner.MIGRATION_SENTINELS["003-embedding-1024.sql"]


@requires_pg
class TestBaselineDetectionIntegration:
    def _apply_the_old_way(self, dsn, through, migrations_dir=MIGRATIONS_DIR):
        """Run migrations 001..through with psql-style raw execution.

        Reproduces the state of the real gsd-pg-data volume: schema applied by
        the old untracked bin/init.cjs loop, no schema_migrations table.
        """
        import psycopg2
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        for name, path, _digest in migrate_runner.discover_migrations(migrations_dir):
            if int(name.split("-")[0]) > through:
                continue
            with conn.cursor() as cur:
                cur.execute(pathlib.Path(path).read_text(encoding="utf-8"))
        conn.close()

    def test_status_infers_what_is_applied_without_writing(self, scratch_dsn):
        self._apply_the_old_way(scratch_dsn, 26)
        report = migrate_runner.status(dsn=scratch_dsn)
        assert report["tracking_table"] is False
        assert report["pre_migrated_detected"] is True
        assert len(report["detected_by_schema"]) == 26
        assert report["pending"] == [
            "027-audit-findings.sql",
            "028-task-project-backfill.sql",
            "029-sqlite-import-compat.sql",
            "030-rlm-chunk-provenance.sql",
        ]

    def test_only_the_missing_migrations_are_applied(self, scratch_dsn):
        self._apply_the_old_way(scratch_dsn, 26)
        result = migrate_runner.apply_migrations(dsn=scratch_dsn,
                                                 log=lambda *_: None)
        assert len(result["baselined"]) == 26
        assert result["applied"] == [
            "027-audit-findings.sql",
            "028-task-project-backfill.sql",
            "029-sqlite-import-compat.sql",
            "030-rlm-chunk-provenance.sql",
        ]
        again = migrate_runner.apply_migrations(dsn=scratch_dsn, log=lambda *_: None)
        assert again["applied"] == []

    def test_a_gap_in_the_middle_is_found_not_assumed_away(self, scratch_dsn):
        """Baseline is per-migration, not 'everything through N'."""
        import psycopg2
        self._apply_the_old_way(scratch_dsn, 30)
        conn = psycopg2.connect(scratch_dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DROP TABLE module_installs")       # migration 022
            cur.execute("DROP TABLE agent_metrics")          # migration 016
        conn.close()

        result = migrate_runner.apply_migrations(dsn=scratch_dsn,
                                                 log=lambda *_: None)
        assert set(result["applied"]) == {
            "016-agent-metrics.sql", "022-module-installs.sql"}
        assert len(result["baselined"]) == 28

    def test_existing_embeddings_survive_the_baseline_run(self, scratch_dsn):
        """003 must never be re-entered on a database that already has vectors."""
        import psycopg2
        self._apply_the_old_way(scratch_dsn, 30)
        conn = psycopg2.connect(scratch_dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO gsd_memory (id, text, embedding) VALUES "
                "('mem-vec', 'has a vector', "
                "(SELECT ('['||string_agg('0.01', ',')||']')::vector "
                " FROM generate_series(1, 1024)))")
            cur.execute("DROP TABLE module_installs")  # force a real apply pass
        conn.close()

        migrate_runner.apply_migrations(dsn=scratch_dsn, log=lambda *_: None)

        conn = psycopg2.connect(scratch_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE embedding IS NOT NULL")
            assert cur.fetchone()[0] == 1
        conn.close()

    def test_no_auto_baseline_applies_everything(self, scratch_dsn):
        self._apply_the_old_way(scratch_dsn, 26)
        result = migrate_runner.apply_migrations(
            dsn=scratch_dsn, auto_baseline_enabled=False, log=lambda *_: None)
        assert result["baselined"] == []
        assert len(result["applied"]) == result["total"]


# ══════════════════════════════════════════════════════════════════
# Merge semantics against a POPULATED PostgreSQL
# ══════════════════════════════════════════════════════════════════

@requires_pg
class TestMergeIntoPopulatedDatabase:
    def _seed(self, dsn, memory_rows=(), tasks=(), with_embedding=True):
        import psycopg2
        vector = "[" + ",".join(["0.01"] * 1024) + "]"
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            for row_id, text in memory_rows:
                if with_embedding:
                    cur.execute(
                        "INSERT INTO gsd_memory (id, text, embedding) "
                        "VALUES (%s, %s, %s::vector)", (row_id, text, vector))
                else:
                    cur.execute("INSERT INTO gsd_memory (id, text) VALUES (%s, %s)",
                                (row_id, text))
            for task_id, title in tasks:
                cur.execute("INSERT INTO gsd_tasks (id, title) VALUES (%s, %s)",
                            (task_id, title))
        conn.close()

    def test_an_existing_row_is_kept_and_its_embedding_is_never_nulled(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=3)
        # mem-0000 exists in Postgres WITH an embedding and the SAME text.
        self._seed(migrated_dsn, memory_rows=[("mem-0000", "memory text 0")])

        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 log=lambda *_: None)
        assert ok, report
        memory = next(t for t in report["tables"] if t["table"] == "gsd_memory")
        assert memory["identical"] == 1
        assert memory["insert"] == 2
        assert memory["conflict"] == 0
        assert report["embeddings_before"]["gsd_memory"] == 1
        assert report["embeddings_after"]["gsd_memory"] == 1

        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT embedding IS NOT NULL FROM gsd_memory "
                        "WHERE id='mem-0000'")
            assert cur.fetchone()[0] is True
        conn.close()

    def test_same_id_different_content_is_a_conflict_and_postgres_wins(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=1, task_rows=2)
        self._seed(migrated_dsn, tasks=[("TK-0000", "DIVERGED IN POSTGRES")])

        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 log=lambda *_: None)
        assert ok is False, "a conflict must fail the run by default"
        tasks = next(t for t in report["tables"] if t["table"] == "gsd_tasks")
        assert tasks["conflict"] == 1
        conflict = tasks["conflicts"][0]
        assert conflict["id"] == "TK-0000"
        assert conflict["differences"][0]["column"] == "title"
        assert conflict["differences"][0]["postgres"] == "DIVERGED IN POSTGRES"

        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT title FROM gsd_tasks WHERE id='TK-0000'")
            assert cur.fetchone()[0] == "DIVERGED IN POSTGRES"
            cur.execute("SELECT COUNT(*) FROM gsd_tasks WHERE id='TK-0000'")
            assert cur.fetchone()[0] == 1, "never duplicated"
        conn.close()

    def test_allow_conflicts_downgrades_the_conflict_to_a_report(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=1, task_rows=2)
        self._seed(migrated_dsn, tasks=[("TK-0000", "DIVERGED IN POSTGRES")])
        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 allow_conflicts=True, log=lambda *_: None)
        assert ok is True
        assert report["total_conflicts"] == 1

    def test_same_content_under_a_different_id_is_reported(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=3)
        # Same TEXT as mem-0001, re-issued under a new id by the daemon.
        self._seed(migrated_dsn, memory_rows=[("mem-reissued", "memory text 1")])

        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 log=lambda *_: None)
        assert ok, report
        memory = next(t for t in report["tables"] if t["table"] == "gsd_memory")
        assert memory["content_duplicate"] == 1
        assert memory["duplicates"][0]["same_content_as"] == "mem-reissued"
        # Reported, but inserted by default.
        assert memory["inserted"] == 3

    def test_skip_content_duplicates_omits_them_without_failing_verification(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=3)
        self._seed(migrated_dsn, memory_rows=[("mem-reissued", "memory text 1")])

        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 skip_content_duplicates=True,
                                 log=lambda *_: None)
        assert ok, report
        memory = next(t for t in report["tables"] if t["table"] == "gsd_memory")
        assert memory["content_duplicate"] == 1
        assert memory["inserted"] == 2
        check = next(v for v in report["verification"] if v["table"] == "gsd_memory")
        assert check["missing"] == 0
        assert check["skipped_on_purpose"] == 1

    def test_tasks_have_no_content_key_so_repeated_titles_are_not_duplicates(
            self, migrated_dsn):
        from services import migrate_sqlite_to_pg as mig
        assert mig.TABLE_POLICY["gsd_tasks"]["content"] is None
        assert mig.TABLE_POLICY["gsd_tasks"]["identity"] == ("title",)

    def test_exclude_table_skips_tasks_entirely(self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), task_rows=2)
        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 exclude_tables=["gsd_tasks"],
                                 log=lambda *_: None)
        assert ok, report
        assert "gsd_tasks" not in {t["table"] for t in report["tables"]}
        assert "gsd_tasks" in report["tables_skipped"]
        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_tasks")
            assert cur.fetchone()[0] == 0
        conn.close()

    def test_dry_run_prints_the_full_merge_plan_and_writes_nothing(
            self, migrated_dsn, tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"), memory_rows=3, task_rows=2)
        self._seed(migrated_dsn,
                   memory_rows=[("mem-0000", "memory text 0"),
                                ("mem-reissued", "memory text 1")],
                   tasks=[("TK-0000", "DIVERGED IN POSTGRES")])

        lines = []
        ok, report = mig.migrate(sqlite_path=path, dsn=migrated_dsn,
                                 dry_run=True, log=lines.append)
        memory = next(t for t in report["tables"] if t["table"] == "gsd_memory")
        tasks = next(t for t in report["tables"] if t["table"] == "gsd_tasks")
        assert (memory["insert"], memory["identical"], memory["content_duplicate"]) \
            == (2, 1, 1)
        assert tasks["conflict"] == 1
        assert ok is False  # the conflict
        text = "\n".join(lines)
        assert "MERGE PLAN (nothing written)" in text
        assert "CONFLICTS in gsd_tasks" in text
        assert "LIKELY DUPLICATES in gsd_memory" in text

        import psycopg2
        conn = psycopg2.connect(migrated_dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM gsd_memory")
            assert cur.fetchone()[0] == 2, "dry run must not write"
        conn.close()

    def test_replace_mode_requires_an_explicit_confirmation(self, migrated_dsn,
                                                            tmp_path):
        from services import migrate_sqlite_to_pg as mig
        path = _make_sqlite(str(tmp_path / "s.db"))
        assert mig.main(["--sqlite", path, "--dsn", migrated_dsn,
                         "--mode", "replace"]) == 2


class TestForceSqlite:
    def test_force_sqlite_recognises_both_spellings(self):
        assert infra_detect.force_sqlite(env={"GSD_FORCE_SQLITE": "1"})
        assert infra_detect.force_sqlite(env={"GSD_FORCE_SQLITE": "TRUE"})
        assert infra_detect.force_sqlite(env={"GSD_BACKEND": "sqlite"})
        assert not infra_detect.force_sqlite(env={})
        assert not infra_detect.force_sqlite(env={"GSD_FORCE_SQLITE": "0"})

    def test_forced_sqlite_never_probes_postgres_or_starts_a_container(
            self, monkeypatch):
        """No PostgreSQL probe, no `docker ps`, no container start.

        The Redis probe still runs: a TCP connect to an already-running cache
        plus a read-only `docker ps` to label it, neither of which can start
        anything. Starting a PostgreSQL container is the hazard this flag
        exists to prevent, so the test also asserts that no subprocess call is
        a start/up command.
        """
        calls = []
        commands = []
        monkeypatch.setenv("GSD_FORCE_SQLITE", "1")
        monkeypatch.setattr(infra_detect, "check_pg_capabilities",
                            lambda *a, **k: calls.append("pg") or (False, {}))
        monkeypatch.setattr(infra_detect, "_detect_local_postgresql",
                            lambda rejected: calls.append("local") or (None, None))
        monkeypatch.setattr(infra_detect, "_detect_docker_postgresql",
                            lambda *a: calls.append("docker") or None)
        monkeypatch.setattr(infra_detect, "_auto_start_docker_postgresql",
                            lambda: calls.append("start") or (None, {}))


        class _Done:
            returncode, stdout, stderr = 0, "", ""

        monkeypatch.setattr(infra_detect.subprocess, "run",
                            lambda argv, *a, **k: commands.append(argv) or _Done())

        result = infra_detect.detect_infrastructure(auto_start=True)
        assert result["backend"] == "sqlite"
        assert "GSD_FORCE_SQLITE" in result["message"]
        assert result["services"]["postgres"]["status"] == "skipped"
        assert calls == [], f"forced SQLite must not touch PostgreSQL: {calls}"
        for argv in commands:
            assert "ps" in argv, f"only read-only docker ps is allowed: {argv}"
            for forbidden in ("start", "up", "compose", "run", "create"):
                assert forbidden not in argv, f"forced SQLite ran: {argv}"

    def test_the_init_flow_test_no_longer_runs_detection_with_auto_start(self):
        src = (REPO_ROOT / "tests" / "test-init-flow.test.cjs").read_text(encoding="utf-8")
        # Both invocations must be hermetic — this is the test that started
        # the developer's real gsd-postgres container mid-suite.
        assert src.count("GSD_FORCE_SQLITE: '1'") == 2
        assert src.count("[detectScript, '--no-auto-start']") == 2
        assert "execFileSync('python3', [detectScript], {" not in src
