"""Plan 89-02 (FND-11): decimal phase numbers write and read back on both backends.

Two halves, and the order they were written in matters:

1. **The SQLite golden block** (``TestNormalizePhaseNumberContract``,
   ``TestSqliteHandoffGoldenRoundTrip``, ``TestParsePhaseArgOnSqlite``) was written and
   committed in task 89-02-01, **before** migration 031 existed. It pins the behaviour
   that already worked on SQLite — ``72``, ``72.0``, ``72.1``, ``7.25`` and a non-number
   against ``services/sqlite_store.py`` ``normalize_phase_number``, a SQLite handoff
   round trip, and the non-collision pair (a ``72`` handoff is not read back by a lookup
   for ``72.1``). Had it been written after the Postgres change it would have pinned the
   NEW contract, which is the trap the ordering exists to avoid.

2. **The Postgres block** needs a disposable database. It is gated on
   ``conftest.postgres_dsn_or_none()``, which returns None (and the tests skip with the
   one standard reason) wherever ``GSD_TEST_POSTGRES_URL`` is unset — the macOS and
   Windows cells until plan 89-07, and the operator's machine always. Those skips are
   listed in ``tests/skip-exceptions.d/89-02.json``, each naming task 89-07-04 as the
   remover.

Every Postgres test runs against its OWN scratch database created on the disposable
server and dropped afterwards, so it never touches the configured one.

Run: python3 -m pytest tests/test_89_02_decimal_phase.py -q -rs -p no:cacheprovider
"""

import importlib.util
import json
import os
import pathlib
import sys
import time
import uuid
import warnings
from decimal import Decimal

import pytest

_TESTS = pathlib.Path(__file__).resolve().parent
_REPO = _TESTS.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))
_SERVICES = _REPO / "services"
if str(_SERVICES) not in sys.path:
    sys.path.insert(0, str(_SERVICES))

from conftest import (  # noqa: E402
    PG_SKIP_REASON,
    postgres_dsn_or_none,
    product_pg_dsn,
)

from sqlite_store import SQLiteStore, normalize_phase_number  # noqa: E402

#: The parameter set this plan's acceptance names: three spellings of a whole phase,
#: two genuinely decimal ones, and a value that is not a number at all.
PHASE_CASES = ["72", "72.0", "72.1", "7.25"]
NON_NUMBER = "seventy-two"

TEST_DSN_ABSENT = postgres_dsn_or_none() is None
requires_pg = pytest.mark.skipif(TEST_DSN_ABSENT, reason=PG_SKIP_REASON)

#: Where the DOWN file and the UP file live, by name — the plan owns number 031 and
#: `-DOWN.sql` is the convention every file in migrations/ uses (measured, not assumed:
#: `ls migrations | grep DOWN`).
MIGRATION_UP = _REPO / "migrations" / "031-decimal-phase-number.sql"
MIGRATION_DOWN = _REPO / "migrations" / "031-decimal-phase-number-DOWN.sql"


class Measured(UserWarning):
    """Carries a measured number into the CI log.

    ``pytest -q`` hides a passing test's stdout but always prints the warnings
    summary, and plan 89-02's acceptance asks for row counts, a wire type and an
    applied duration as **measured** numbers rather than claims. Emitting them as a
    warning puts them in the log of the only cell that has a disposable database.
    """


def _measure(record_property, key, value):
    """Record one measured number both in the JUnit XML and in the warnings summary.

    Args:
        record_property: pytest's ``record_property`` fixture.
        key: the measurement's name.
        value: the measured value.

    Returns:
        The value, unchanged, so a caller can inline the call.
    """
    record_property("89-02-" + key, str(value))
    warnings.warn(f"[89-02 MEASURED] {key} = {value}", Measured, stacklevel=2)
    return value


# ─────────────────────────────────────────────────────────────────────────────
# Module loaders — both subjects have names Python cannot import directly.
# ─────────────────────────────────────────────────────────────────────────────


def _load_by_path(module_name, relative_path):
    """Load a module from a file whose name is not a valid Python identifier.

    ``services/amauta-daemon.py`` and ``services/step-orchestrator.py`` both carry a
    hyphen. Importing the daemon does not start a server — ``start_server()`` only runs
    under ``__main__``.

    Args:
        module_name: the name to register in ``sys.modules``.
        relative_path: path relative to the repository root.

    Returns:
        The executed module object.
    """
    os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
    spec = importlib.util.spec_from_file_location(module_name, str(_REPO / relative_path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def daemon_mod():
    """``services/amauta-daemon.py`` as an importable module."""
    return _load_by_path("amauta_daemon_89_02", "services/amauta-daemon.py")


@pytest.fixture(scope="module")
def orchestrator_mod():
    """``services/step-orchestrator.py`` as an importable module."""
    return _load_by_path("step_orchestrator", "services/step-orchestrator.py")


class FakePGStore:
    """Stands in for PGStore: anything whose class is not named SQLiteStore.

    ``services/amauta-daemon.py`` ``_is_sqlite`` identifies the backend by class name,
    so this is the sanctioned stand-in and the one the existing daemon unit tests use.
    """


class FakeSQLiteStore:
    """Stands in for SQLiteStore — matched on the class name, as ``_is_sqlite`` does."""


FakeSQLiteStore.__name__ = "SQLiteStore"


@pytest.fixture
def sqlite_store(tmp_path):
    """A SQLiteStore on a throwaway file.

    SQLiteStore ignores ``AMAUTA_DATA_DIR`` and would otherwise default to the live
    ``~/.amauta/data/gsd_amauta.db``, so the path is passed explicitly.
    """
    return SQLiteStore(db_path=str(tmp_path / "gsd_amauta.db"))


# ═════════════════════════════════════════════════════════════════════════════
# GOLDEN BLOCK 1 — normalize_phase_number, the one contract both backends follow
# (written in task 89-02-01, before migration 031)
# ═════════════════════════════════════════════════════════════════════════════


class TestNormalizePhaseNumberContract:
    """``services/sqlite_store.py:135-150`` — int when integral, else float."""

    @pytest.mark.parametrize(
        "raw,expected,expected_type",
        [
            ("72", 72, int),
            (72, 72, int),
            ("72.0", 72, int),
            (72.0, 72, int),
            ("72.1", 72.1, float),
            (72.1, 72.1, float),
            ("7.25", 7.25, float),
        ],
    )
    def test_whole_phases_are_int_and_decimal_phases_are_float(self, raw, expected, expected_type):
        value = normalize_phase_number(raw)
        assert value == expected
        assert isinstance(value, expected_type), (
            f"normalize_phase_number({raw!r}) returned {type(value).__name__}, "
            f"expected {expected_type.__name__}"
        )

    def test_72_and_72_0_normalise_to_the_same_key(self):
        assert normalize_phase_number("72") == normalize_phase_number("72.0") == 72
        assert str(normalize_phase_number("72")) == str(normalize_phase_number(72.0))

    def test_72_and_72_1_never_normalise_to_the_same_key(self):
        assert normalize_phase_number("72") != normalize_phase_number("72.1")
        assert str(normalize_phase_number("72")) != str(normalize_phase_number("72.1"))

    def test_a_non_number_raises_value_error(self):
        with pytest.raises(ValueError):
            normalize_phase_number(NON_NUMBER)

    def test_int_of_a_decimal_string_raises_rather_than_truncating(self):
        """Why the fix for the two complexity endpoints is a typed 400, not a rounding rule.

        ``int("72.1")`` is a ValueError; only ``int(72.1)`` truncates. An endpoint that
        called ``int(body.get("phase_number"))`` therefore answered 500, not a silently
        wrong row.
        """
        with pytest.raises(ValueError):
            int("72.1")
        assert int(72.1) == 72


# ═════════════════════════════════════════════════════════════════════════════
# GOLDEN BLOCK 2 — the SQLite handoff round trip (written before migration 031)
# ═════════════════════════════════════════════════════════════════════════════


class TestSqliteHandoffGoldenRoundTrip:
    """What already worked on SQLite, pinned before Postgres was touched."""

    @pytest.mark.parametrize("raw", PHASE_CASES)
    def test_a_handoff_writes_and_reads_back_with_the_same_phase(self, sqlite_store, raw):
        sqlite_store.step_handoff_insert(
            "execute-phase", raw,
            step_id="step-01-prepare", task_id="TK-8902",
            context_snapshot={"golden": raw},
        )
        back = sqlite_store.step_handoff_latest("execute-phase", raw)
        assert back is not None, f"no handoff read back for phase {raw!r}"
        assert back["phase_number"] == normalize_phase_number(raw)
        assert back["context_snapshot"] == {"golden": raw}

    def test_a_72_handoff_is_not_read_back_by_a_lookup_for_72_1(self, sqlite_store):
        sqlite_store.step_handoff_insert(
            "execute-phase", "72",
            step_id="step-01-prepare", task_id="TK-WHOLE",
            context_snapshot={"phase": "72"},
        )
        assert sqlite_store.step_handoff_latest("execute-phase", "72.1") is None, (
            "a lookup for 72.1 read back phase 72's handoff — the truncation bug"
        )

    def test_a_72_1_handoff_is_not_read_back_by_a_lookup_for_72(self, sqlite_store):
        sqlite_store.step_handoff_insert(
            "execute-phase", "72.1",
            step_id="step-01-prepare", task_id="TK-DECIMAL",
            context_snapshot={"phase": "72.1"},
        )
        assert sqlite_store.step_handoff_latest("execute-phase", "72") is None, (
            "a lookup for 72 read back phase 72.1's handoff"
        )

    def test_72_and_72_0_do_read_each_other_back(self, sqlite_store):
        sqlite_store.step_handoff_insert(
            "execute-phase", "72.0",
            step_id="step-01-prepare", task_id="TK-ZERO-SCALE",
            context_snapshot={"phase": "72.0"},
        )
        back = sqlite_store.step_handoff_latest("execute-phase", "72")
        assert back is not None, "72 did not read back a handoff written for 72.0"
        assert back["task_id"] == "TK-ZERO-SCALE"
        assert back["phase_number"] == 72

    def test_a_non_number_is_refused_by_the_store_itself(self, sqlite_store):
        with pytest.raises(ValueError):
            sqlite_store.step_handoff_insert(
                "execute-phase", NON_NUMBER,
                step_id="step-01-prepare", task_id="TK-GARBAGE",
                context_snapshot={},
            )


# ═════════════════════════════════════════════════════════════════════════════
# GOLDEN BLOCK 3 — _parse_phase_arg on the SQLite backend (before migration 031)
# ═════════════════════════════════════════════════════════════════════════════


class TestParsePhaseArgOnSqlite:
    """``services/amauta-daemon.py`` ``_parse_phase_arg`` — the one URL-segment parser."""

    @pytest.mark.parametrize("raw", PHASE_CASES)
    def test_every_number_in_the_parameter_set_parses(self, daemon_mod, raw):
        value, err = daemon_mod._parse_phase_arg(raw, FakeSQLiteStore())
        assert err is None, err
        assert value == normalize_phase_number(raw)

    def test_a_non_number_is_a_typed_400(self, daemon_mod):
        value, err = daemon_mod._parse_phase_arg(NON_NUMBER, FakeSQLiteStore())
        assert value is None
        payload, status = err
        assert status == 400
        assert "number" in payload["error"], payload


# ═════════════════════════════════════════════════════════════════════════════
# POSTGRES FIXTURES — every test gets its OWN scratch database on the
# disposable server, created and dropped here, so the configured one is never
# touched. Same shape as tests/test_docker_pg_migration.py's `scratch_dsn`.
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def scratch_dsn():
    """A fresh, empty database on the disposable server; dropped afterwards."""
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    from services import pg_dsn

    test_dsn = postgres_dsn_or_none()
    if not test_dsn:
        pytest.skip(PG_SKIP_REASON)

    name = "gsd_8902_" + uuid.uuid4().hex[:12]
    admin = pg_dsn.dsn_with_database(test_dsn, "postgres")
    conn = psycopg2.connect(admin, connect_timeout=10)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with conn.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    conn.close()
    try:
        yield pg_dsn.dsn_with_database(test_dsn, name)
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
    """A scratch database with every migration applied, 031 included."""
    from services import migrate_runner

    migrate_runner.apply_migrations(dsn=scratch_dsn, log=lambda *_: None)
    return scratch_dsn


def _connect(dsn):
    """A psycopg2 connection to *dsn* in autocommit, for catalogue reads and DDL."""
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    conn = psycopg2.connect(dsn, connect_timeout=10)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    return conn


def _exec_file(dsn, path):
    """Run one SQL file against *dsn* and return how long the server took, in ms.

    Exactly how ``services/migrate_runner.py`` applies a file: one ``cur.execute`` of
    the whole text on a NON-autocommit connection, commit on success, rollback and
    re-raise on failure. A file that raises therefore leaves the database untouched,
    which is what the DOWN's refusal test asserts.
    """
    import psycopg2

    sql = pathlib.Path(path).read_text(encoding="utf-8")
    conn = psycopg2.connect(dsn, connect_timeout=10)
    started = time.time()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return int((time.time() - started) * 1000)


def _column_facts(dsn, table):
    """``(data_type, numeric_precision, numeric_scale)`` of ``<table>.phase_number``.

    Read from ``information_schema.columns`` — the catalogue, never the DDL text, so
    the assertion cannot be satisfied by a migration file that was never applied.
    """
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT data_type, numeric_precision, numeric_scale"
                " FROM information_schema.columns"
                " WHERE table_name = %s AND column_name = 'phase_number'",
                (table,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    assert len(rows) == 1, f"expected one phase_number column on {table}, got {rows}"
    return rows[0]


def _index_names(dsn, table):
    """Every index name on *table*, from ``pg_indexes``."""
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = %s", (table,))
            return sorted(row[0] for row in cur.fetchall())
    finally:
        conn.close()


#: The exact SQL the daemon's PostgreSQL branch runs for a handoff INSERT
#: (services/amauta-daemon.py, POST /api/steps/:workflow/:phase/handoff) — copied so the
#: test proves the DATA PATH the route uses, not a paraphrase of it.
_PG_HANDOFF_INSERT = (
    "INSERT INTO step_handoffs"
    " (workflow_name, step_id, task_id, phase_number,"
    "  completed_steps, context_snapshot, artifacts,"
    "  decisions, user_inputs, next_step, escalation_flags)"
    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
    " RETURNING id, created_at"
)

#: The exact SQL the daemon's PostgreSQL branch runs for the handoff LOOKUP
#: (GET /api/steps/:workflow/:phase).
_PG_HANDOFF_SELECT = (
    "SELECT id, workflow_name, step_id, task_id, phase_number,"
    " completed_steps, context_snapshot, artifacts, decisions,"
    " user_inputs, next_step, escalation_flags, created_at"
    " FROM step_handoffs"
    " WHERE workflow_name = %s AND phase_number = %s"
    " ORDER BY created_at DESC LIMIT 1"
)


def _pg_handoff_insert(dsn, workflow, phase, task_id, snapshot):
    """Insert one handoff through the daemon's own PG statement, binding a Decimal."""
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                _PG_HANDOFF_INSERT,
                (workflow, "step-01-prepare", task_id, phase, [],
                 json.dumps(snapshot), json.dumps({}), json.dumps([]),
                 json.dumps([]), "step-02-route", []),
            )
            return cur.fetchone()
    finally:
        conn.close()


def _pg_handoff_latest(dsn, workflow, phase):
    """The daemon's own PG lookup, or None."""
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(_PG_HANDOFF_SELECT, (workflow, phase))
            return cur.fetchone()
    finally:
        conn.close()


# ═════════════════════════════════════════════════════════════════════════════
# MIGRATION 031 — the catalogue, the indexes, the DOWN and idempotency
# ═════════════════════════════════════════════════════════════════════════════


@requires_pg
class TestMigration031:
    """Proved from the catalogue on a disposable database, never from the DDL text."""

    def test_both_columns_are_numeric_10_3(self, migrated_dsn, record_property):
        for table in ("step_handoffs", "task_completions"):
            data_type, precision, scale = _column_facts(migrated_dsn, table)
            _measure(record_property, f"{table}.phase_number",
                     f"{data_type}({precision},{scale})")
            assert data_type == "numeric", (
                f"{table}.phase_number is {data_type!r}, expected 'numeric'"
            )
            assert precision == 10, f"{table}.phase_number precision {precision}, expected 10"
            assert scale == 3, f"{table}.phase_number scale {scale}, expected 3"

    def test_both_indexes_survive_the_rewrite(self, migrated_dsn, record_property):
        """Each ALTER rewrites its table; the indexes must come back, by name."""
        handoff_indexes = _index_names(migrated_dsn, "step_handoffs")
        completion_indexes = _index_names(migrated_dsn, "task_completions")
        _measure(record_property, "pg_indexes.step_handoffs", handoff_indexes)
        _measure(record_property, "pg_indexes.task_completions", completion_indexes)
        assert "idx_handoffs_latest" in handoff_indexes, handoff_indexes
        assert "idx_handoffs_task" in handoff_indexes, handoff_indexes
        assert "idx_task_completions_embedding" in completion_indexes, completion_indexes
        assert "idx_task_completions_outcome" in completion_indexes, completion_indexes

    def test_the_column_comment_states_the_reason(self, migrated_dsn):
        """The three-way type choice is recorded where a DBA will find it."""
        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT col_description('step_handoffs'::regclass,"
                    " (SELECT attnum FROM pg_attribute"
                    "  WHERE attrelid = 'step_handoffs'::regclass"
                    "    AND attname = 'phase_number'))"
                )
                comment = cur.fetchone()[0] or ""
        finally:
            conn.close()
        assert "NUMERIC(10,3)" in comment, comment
        assert "031" in comment, comment

    def test_reapplying_is_a_no_op_reported_through_schema_migrations(self, migrated_dsn,
                                                                     record_property):
        """A second apply_migrations reports zero pending and applies nothing."""
        from services import migrate_runner

        lines = []
        result = migrate_runner.apply_migrations(dsn=migrated_dsn, log=lines.append)
        _measure(record_property, "second-apply.pending", result["pending"])
        _measure(record_property, "second-apply.applied", result["applied"])
        _measure(record_property, "second-apply.already_applied", result["already_applied"])
        _measure(record_property, "second-apply.log", " | ".join(lines))
        assert result["pending"] == [], result["pending"]
        assert result["applied"] == [], result["applied"]
        assert result["drifted"] == [], result["drifted"]
        assert "031-decimal-phase-number.sql" in [
            row[0] for row in _applied_rows(migrated_dsn)
        ], "031 is not recorded in schema_migrations"
        assert any("nothing to do" in line for line in lines), lines

    def test_the_applied_duration_and_row_counts_are_measured_with_rows_present(
        self, migrated_dsn, record_property
    ):
        """The rewrite is timed on tables that actually hold rows.

        A fresh scratch database has none, so this test takes the column back to
        INTEGER with the DOWN, fills both tables with integral rows, and re-applies the
        UP file directly — which is the rewrite an operator pays for, measured rather
        than assumed to be cheap.
        """
        _exec_file(migrated_dsn, MIGRATION_DOWN)
        assert _column_facts(migrated_dsn, "step_handoffs")[0] == "integer"

        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                for i in range(200):
                    cur.execute(
                        _PG_HANDOFF_INSERT,
                        ("execute-phase", "step-01-prepare", f"TK-{i:04d}", 72, [],
                         json.dumps({"i": i}), json.dumps({}), json.dumps([]),
                         json.dumps([]), "step-02-route", []),
                    )
                for i in range(200):
                    cur.execute(
                        "INSERT INTO task_completions"
                        " (task_id, phase_number, workflow_name, feature_vector,"
                        "  raw_score, chosen_phases, phases_run, outcome_label)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                        (f"TK-{i:04d}", 72, "execute-phase", json.dumps({"i": i}),
                         10, ["R"], ["R"], "validator_pass"),
                    )
                cur.execute("SELECT count(*) FROM step_handoffs")
                handoff_rows = cur.fetchone()[0]
                cur.execute("SELECT count(*) FROM task_completions")
                completion_rows = cur.fetchone()[0]
        finally:
            conn.close()

        _measure(record_property, "rowcount.step_handoffs", handoff_rows)
        _measure(record_property, "rowcount.task_completions", completion_rows)

        duration_ms = _exec_file(migrated_dsn, MIGRATION_UP)
        _measure(record_property, "031-up.duration_ms", duration_ms)

        assert handoff_rows == 200
        assert completion_rows == 200
        assert _column_facts(migrated_dsn, "step_handoffs") == ("numeric", 10, 3)
        assert _column_facts(migrated_dsn, "task_completions") == ("numeric", 10, 3)
        # The rows survived the rewrite and the indexes came back with it.
        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM step_handoffs")
                assert cur.fetchone()[0] == 200
        finally:
            conn.close()
        assert "idx_handoffs_latest" in _index_names(migrated_dsn, "step_handoffs")


def _applied_rows(dsn):
    """``[(filename, ...)]`` from ``schema_migrations``."""
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT filename FROM schema_migrations ORDER BY filename")
            return cur.fetchall()
    finally:
        conn.close()


@requires_pg
class TestMigration031Down:
    """The DOWN is executed, not merely written, and its refusal rule is asserted."""

    def test_down_returns_the_type_to_integer_when_every_phase_is_integral(
        self, migrated_dsn, record_property
    ):
        _pg_handoff_insert(migrated_dsn, "execute-phase", Decimal("72"), "TK-INT", {"a": 1})
        ms = _exec_file(migrated_dsn, MIGRATION_DOWN)
        _measure(record_property, "031-down.duration_ms", ms)
        assert _column_facts(migrated_dsn, "step_handoffs")[0] == "integer"
        assert _column_facts(migrated_dsn, "task_completions")[0] == "integer"
        # The integral row survived exactly.
        row = _pg_handoff_latest(migrated_dsn, "execute-phase", 72)
        assert row is not None and row[3] == "TK-INT"

    def test_down_refuses_while_a_decimal_phase_exists_and_changes_nothing(
        self, migrated_dsn, record_property
    ):
        """Refuse, never round: rounding 72.1 to 72 is the collision 031 removed."""
        import psycopg2

        _pg_handoff_insert(migrated_dsn, "execute-phase", Decimal("72.1"), "TK-DEC", {"a": 1})
        with pytest.raises(psycopg2.Error) as excinfo:
            _exec_file(migrated_dsn, MIGRATION_DOWN)
        message = str(excinfo.value)
        _measure(record_property, "031-down.refusal", " ".join(message.split())[:400])
        assert "refuses" in message, message
        assert "72.1" in message, message
        # Nothing changed: the column is still NUMERIC and the row is still there.
        assert _column_facts(migrated_dsn, "step_handoffs") == ("numeric", 10, 3)
        row = _pg_handoff_latest(migrated_dsn, "execute-phase", Decimal("72.1"))
        assert row is not None and row[3] == "TK-DEC"

    def test_down_also_refuses_for_a_decimal_task_completion(self, migrated_dsn):
        """Both tables are checked, not only the first one."""
        import psycopg2

        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO task_completions"
                    " (task_id, phase_number, workflow_name, feature_vector,"
                    "  raw_score, chosen_phases, phases_run, outcome_label)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    ("TK-DEC-C", Decimal("7.25"), "execute-phase", json.dumps({}),
                     10, ["R"], ["R"], "validator_pass"),
                )
        finally:
            conn.close()
        with pytest.raises(psycopg2.Error) as excinfo:
            _exec_file(migrated_dsn, MIGRATION_DOWN)
        assert "7.25" in str(excinfo.value), str(excinfo.value)

    def test_up_after_down_restores_numeric(self, migrated_dsn):
        """UP -> DOWN -> UP is a cycle, not a one-way door."""
        _exec_file(migrated_dsn, MIGRATION_DOWN)
        assert _column_facts(migrated_dsn, "step_handoffs")[0] == "integer"
        _exec_file(migrated_dsn, MIGRATION_UP)
        assert _column_facts(migrated_dsn, "step_handoffs") == ("numeric", 10, 3)
        assert _column_facts(migrated_dsn, "task_completions") == ("numeric", 10, 3)


# ═════════════════════════════════════════════════════════════════════════════
# THE REFUSAL IS GONE, AND WHAT REPLACED IT — backend-neutral, so every cell
# runs these.
# ═════════════════════════════════════════════════════════════════════════════


class TestTheRefusalIsGone:
    """The PostgreSQL decimal-phase refusal was a placeholder; 031 removed its cause."""

    @pytest.mark.parametrize("raw", PHASE_CASES)
    def test_the_two_backends_parse_identically(self, daemon_mod, raw):
        sqlite_value, sqlite_err = daemon_mod._parse_phase_arg(raw, FakeSQLiteStore())
        pg_value, pg_err = daemon_mod._parse_phase_arg(raw, FakePGStore())
        assert sqlite_err is None, sqlite_err
        assert pg_err is None, pg_err
        assert sqlite_value == pg_value
        assert type(sqlite_value) is type(pg_value)

    def test_a_decimal_phase_is_no_longer_refused_on_postgres(self, daemon_mod):
        value, err = daemon_mod._parse_phase_arg("72.1", FakePGStore())
        assert err is None, err
        assert value == 72.1

    def test_a_non_number_is_still_a_typed_400_on_postgres(self, daemon_mod):
        value, err = daemon_mod._parse_phase_arg(NON_NUMBER, FakePGStore())
        assert value is None
        payload, status = err
        assert status == 400
        assert payload["error"] == "phase must be a number (e.g. 72 or 72.1)"

    def test_the_refusal_string_is_gone_from_the_module(self, daemon_mod):
        source = (_REPO / "services" / "amauta-daemon.py").read_text(encoding="utf-8")
        # The bare prefix: stricter than the full old error name, and it keeps the
        # tree free of the string so the plan's census grep really reads zero.
        assert "decimal_phase" not in source

    def test_the_normaliser_is_no_longer_named_for_one_backend(self, daemon_mod):
        source = (_REPO / "services" / "amauta-daemon.py").read_text(encoding="utf-8")
        assert "_sqlite_normalize_phase" not in source
        assert hasattr(daemon_mod, "_normalize_phase")

    def test_the_truncating_int_is_gone_from_both_complexity_endpoints(self):
        source = (_REPO / "services" / "amauta-daemon.py").read_text(encoding="utf-8")
        assert 'int(body.get("phase_number")' not in source


class TestPgPhaseWireType:
    """`_pg_phase` is the whole reason `= 72.1` stays exact on a NUMERIC column."""

    @pytest.mark.parametrize(
        "raw,expected",
        [(72, Decimal("72")), (72.0, Decimal("72")), (72.1, Decimal("72.1")),
         ("72.1", Decimal("72.1")), (7.25, Decimal("7.25")),
         (Decimal("72.1"), Decimal("72.1"))],
    )
    def test_every_input_becomes_an_exact_decimal(self, daemon_mod, raw, expected):
        got = daemon_mod._pg_phase(raw)
        assert isinstance(got, Decimal)
        assert got == expected

    def test_none_passes_through(self, daemon_mod):
        assert daemon_mod._pg_phase(None) is None

    def test_the_wire_representation_is_an_unquoted_decimal_literal(self):
        """The measurement, not the claim: what the adapter actually emits.

        psycopg2 interpolates client-side, so `psycopg2.extensions.adapt(x).getquoted()`
        IS the bytes the server parses. An UNQUOTED decimal literal is typed `numeric`
        by PostgreSQL's parser — never `double precision` — which is what keeps
        `phase_number = %s` exact and `idx_handoffs_latest` usable on NUMERIC(10,3).
        A quoted or `::float8`-cast literal would not be.
        """
        pytest.importorskip("psycopg2")
        from psycopg2.extensions import adapt

        assert adapt(Decimal("72.1")).getquoted() == b"72.1"
        assert adapt(Decimal("72")).getquoted() == b"72"
        assert adapt(Decimal("7.25")).getquoted() == b"7.25"

    def test_a_derived_float_would_carry_binary_noise_a_decimal_does_not(self):
        """Why the parameter is a Decimal even though a float also lands as `numeric`.

        A float reaches its literal through `repr()`. A value produced by arithmetic
        therefore emits up to seventeen significant digits, which NUMERIC(10,3) ROUNDS
        on INSERT while a predicate built the same way still carries all seventeen — the
        row becomes unfindable. `Decimal(str(normalised))` carries only the digits the
        caller wrote.
        """
        pytest.importorskip("psycopg2")
        from psycopg2.extensions import adapt

        derived = 0.1 + 0.2
        assert adapt(derived).getquoted() == b"0.30000000000000004", adapt(derived).getquoted()
        # The same number, normalised and then bound the way the product binds it.
        assert adapt(Decimal(str(round(derived, 3)))).getquoted() == b"0.3"


class TestPhaseOutShape:
    """A handoff read back on Postgres must have the shape SQLite returns."""

    @pytest.mark.parametrize(
        "raw,expected,expected_type",
        [(Decimal("72"), 72, int), (Decimal("72.000"), 72, int),
         (Decimal("72.100"), 72.1, float), (Decimal("7.250"), 7.25, float),
         ("72", 72, int), ("72.1", 72.1, float)],
    )
    def test_the_json_type_matches_the_sqlite_contract(self, daemon_mod, raw,
                                                       expected, expected_type):
        got = daemon_mod._phase_out(raw)
        assert got == expected
        assert isinstance(got, expected_type)

    def test_none_stays_none(self, daemon_mod):
        assert daemon_mod._phase_out(None) is None

    def test_a_decimal_survives_json_serialisation(self, daemon_mod):
        """psycopg2 returns Decimal; json.dumps raises on it unless it is converted."""
        payload = {"phase_number": daemon_mod._phase_out(Decimal("72.100"))}
        assert json.loads(json.dumps(payload))["phase_number"] == 72.1


class TestStepOrchestratorField:
    """The Pydantic field and its dataclass fallback both take a decimal, with gt=0."""

    def test_a_decimal_phase_is_accepted(self, orchestrator_mod):
        handoff = orchestrator_mod.StepHandoff(
            workflow_name="execute-phase", step_id="step-01-prepare",
            task_id="TK-8902", phase_number="72.1", context_snapshot={},
        )
        assert handoff.phase_number == Decimal("72.1")

    def test_a_whole_phase_is_accepted(self, orchestrator_mod):
        handoff = orchestrator_mod.StepHandoff(
            workflow_name="execute-phase", step_id="step-01-prepare",
            task_id="TK-8902", phase_number=72, context_snapshot={},
        )
        assert handoff.phase_number == Decimal("72")

    def test_the_bound_is_gt_0_not_ge_1(self, orchestrator_mod):
        """`ge=1` would have excluded 0.5 while calling itself a minimum."""
        pytest.importorskip("pydantic")
        handoff = orchestrator_mod.StepHandoff(
            workflow_name="execute-phase", step_id="step-01-prepare",
            task_id="TK-8902", phase_number="0.5", context_snapshot={},
        )
        assert handoff.phase_number == Decimal("0.5")
        with pytest.raises(Exception):
            orchestrator_mod.StepHandoff(
                workflow_name="execute-phase", step_id="step-01-prepare",
                task_id="TK-8902", phase_number=0, context_snapshot={},
            )

    def test_pg_phase_binds_a_decimal(self, orchestrator_mod):
        assert orchestrator_mod.pg_phase("72.1") == Decimal("72.1")
        assert isinstance(orchestrator_mod.pg_phase(72.1), Decimal)
        assert orchestrator_mod.pg_phase(None) is None
        with pytest.raises(ValueError):
            orchestrator_mod.pg_phase(NON_NUMBER)

    def test_the_declared_bound_is_in_the_source(self):
        source = (_REPO / "services" / "step-orchestrator.py").read_text(encoding="utf-8")
        assert "phase_number: Decimal = Field(..., gt=0," in source
        assert "ge=1" not in source


class TestComplexityScorerPhaseParameter:
    """`store_completion` writes task_completions.phase_number — NUMERIC(10,3) now."""

    def test_pg_phase_accepts_a_decimal_phase(self):
        import complexity_scorer as cs

        assert cs._pg_phase("72.1") == Decimal("72.1")
        assert isinstance(cs._pg_phase(72), Decimal)
        assert cs._pg_phase(None) is None

    def test_pg_phase_refuses_a_non_number_with_a_value_error(self):
        import complexity_scorer as cs

        with pytest.raises(ValueError):
            cs._pg_phase(NON_NUMBER)

    def test_the_declared_type_follows_the_column(self):
        source = (_REPO / "services" / "complexity_scorer.py").read_text(encoding="utf-8")
        assert "phase_number: Union[int, float, Decimal, str]" in source


# ═════════════════════════════════════════════════════════════════════════════
# THE PARAMETERISED BOTH-BACKENDS PROOF
#
# One test, parameterised over (backend, phase), writing a handoff and reading it
# back; plus the non-collision pair in both directions and the zero-scale
# equality on each backend. The PostgreSQL arm uses the EXACT statements the
# daemon's PG branch runs (_PG_HANDOFF_INSERT / _PG_HANDOFF_SELECT above), so it
# proves the data path the route uses rather than a paraphrase of it.
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def handoff_backend(request, tmp_path):
    """A `(write, read)` pair of callables for one backend.

    Parameterising on the BACKEND rather than writing two test classes is what makes
    "the same parameter set passes on both" an assertion instead of a convention.

    Args:
        request: pytest's request; ``request.param`` is ``"sqlite"`` or ``"postgres"``.

    Returns:
        tuple: ``(write(phase, task_id), read(phase) -> task_id | None)``.
    """
    if request.param == "sqlite":
        store = SQLiteStore(db_path=str(tmp_path / "gsd_amauta.db"))

        def write(phase, task_id):
            store.step_handoff_insert(
                "execute-phase", phase, step_id="step-01-prepare",
                task_id=task_id, context_snapshot={"phase": str(phase)},
            )

        def read(phase):
            row = store.step_handoff_latest("execute-phase", phase)
            return None if row is None else row["task_id"]

        return write, read

    dsn = request.getfixturevalue("migrated_dsn")

    def write(phase, task_id):
        _pg_handoff_insert(dsn, "execute-phase", _pg_param(phase), task_id,
                           {"phase": str(phase)})

    def read(phase):
        row = _pg_handoff_latest(dsn, "execute-phase", _pg_param(phase))
        return None if row is None else row[3]

    return write, read


def _pg_param(phase):
    """Normalise then bind, exactly as the daemon does before touching PostgreSQL."""
    return Decimal(str(normalize_phase_number(phase)))


#: `pytest.param` so the PostgreSQL arm skips with the one standard reason rather than
#: erroring when no disposable database exists.
BACKENDS = [
    pytest.param("sqlite", id="sqlite"),
    pytest.param("postgres", id="postgres",
                 marks=pytest.mark.skipif(TEST_DSN_ABSENT, reason=PG_SKIP_REASON)),
]


@pytest.mark.parametrize("handoff_backend", BACKENDS, indirect=True)
class TestHandoffRoundTripOnBothBackends:
    """FND-11's acceptance: the same parameter set, the same answers, either backend."""

    @pytest.mark.parametrize("raw", PHASE_CASES)
    def test_a_handoff_writes_and_reads_back(self, handoff_backend, raw):
        write, read = handoff_backend
        write(raw, f"TK-{raw}")
        assert read(raw) == f"TK-{raw}", f"phase {raw!r} did not read back"

    def test_a_72_handoff_is_not_read_back_by_a_lookup_for_72_1(self, handoff_backend):
        """The truncation bug the 400 was protecting against."""
        write, read = handoff_backend
        write("72", "TK-WHOLE")
        assert read("72.1") is None, "a lookup for 72.1 read back phase 72's handoff"
        assert read("72") == "TK-WHOLE"

    def test_a_72_1_handoff_is_not_read_back_by_a_lookup_for_72(self, handoff_backend):
        write, read = handoff_backend
        write("72.1", "TK-DECIMAL")
        assert read("72") is None, "a lookup for 72 read back phase 72.1's handoff"
        assert read("72.1") == "TK-DECIMAL"

    def test_72_and_72_0_do_read_each_other_back(self, handoff_backend):
        """`normalize_phase_number`'s contract: zero scale is not a different phase."""
        write, read = handoff_backend
        write("72.0", "TK-ZERO-SCALE")
        assert read("72") == "TK-ZERO-SCALE"
        assert read("72.000") == "TK-ZERO-SCALE"

    def test_7_25_is_its_own_phase(self, handoff_backend):
        """Three decimal places, the scale the column declares."""
        write, read = handoff_backend
        write("7.25", "TK-SEVEN-QUARTER")
        assert read("7.25") == "TK-SEVEN-QUARTER"
        assert read("7.2") is None
        assert read("7") is None

    def test_a_non_number_is_refused_before_any_write(self, handoff_backend):
        """ValueError specifically — `Exception` would pass on a connection error too."""
        write, read = handoff_backend
        with pytest.raises(ValueError):
            write(NON_NUMBER, "TK-GARBAGE")
        assert read("72") is None, "the refused write left a row behind"


@requires_pg
class TestPostgresWireTypeMeasuredOnTheServer:
    """`pg_typeof` of the bound parameter — the server's own answer, not an inference."""

    def test_the_bound_parameter_arrives_as_numeric_or_integer_never_a_float(
        self, scratch_dsn, record_property
    ):
        """What the SERVER says the parameter is. MEASURED, and it corrected the test.

        The first CI run on the disposable database answered `integer` for phase `'72'`,
        not `numeric` — and the server is right. `normalize_phase_number("72")` is the
        int `72`, so `Decimal(str(72))` is `Decimal("72")`, and psycopg2 emits the
        literal `72`, which PostgreSQL's parser types as `integer`. That is exactly as
        safe: `numeric = integer` promotes the integer to `numeric` EXACTLY and keeps
        the index usable. What must never appear is `double precision`, which would make
        `= 72.1` a binary-float comparison.

        So the assertion is: non-integral phases arrive as `numeric`, integral ones as
        `integer`, and nothing arrives as a float type.

        One node id, every value in the parameter set: parameterising this would add one
        listed skip entry per value on each of the two cells with no disposable
        database, for a measurement that is a loop either way. Every value is asserted
        and a failure names the one that broke.
        """
        measured = {}
        conn = _connect(scratch_dsn)
        try:
            with conn.cursor() as cur:
                for raw in PHASE_CASES:
                    cur.execute("SELECT pg_typeof(%s)", (_pg_param(raw),))
                    measured[raw] = cur.fetchone()[0]
        finally:
            conn.close()
        _measure(record_property, "pg_typeof", measured)
        for raw, wire_type in measured.items():
            expected = ("integer" if float(raw).is_integer() else "numeric")
            assert wire_type == expected, (
                f"phase {raw!r} arrived as {wire_type!r}, expected {expected!r}"
            )
            assert wire_type not in ("double precision", "real"), (
                f"phase {raw!r} arrived as {wire_type!r}; a binary-float parameter "
                "makes = 72.1 an inexact comparison against a NUMERIC column"
            )

    def test_an_integer_literal_compares_exactly_against_the_numeric_column(
        self, migrated_dsn
    ):
        """The consequence of the measurement above, asserted rather than argued.

        A whole phase arrives as an `integer` literal. `numeric = integer` must find the
        row written as `72.000`, and must NOT find `72.100`.
        """
        _pg_handoff_insert(migrated_dsn, "execute-phase", Decimal("72"), "TK-INT", {})
        _pg_handoff_insert(migrated_dsn, "execute-phase", Decimal("72.1"), "TK-DEC", {})
        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT task_id FROM step_handoffs WHERE phase_number = %s"
                    " ORDER BY task_id", (72,),
                )
                hits = [row[0] for row in cur.fetchall()]
        finally:
            conn.close()
        assert hits == ["TK-INT"], hits

    def test_the_stored_value_equals_the_bound_value_exactly(self, migrated_dsn,
                                                             record_property):
        """Round-trip equality IN the database, with the column's own comparison."""
        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                for raw in PHASE_CASES:
                    cur.execute(
                        _PG_HANDOFF_INSERT,
                        ("execute-phase", "step-01-prepare", f"TK-{raw}",
                         _pg_param(raw), [], json.dumps({}), json.dumps({}),
                         json.dumps([]), json.dumps([]), "step-02-route", []),
                    )
                cur.execute(
                    "SELECT task_id, phase_number, phase_number = %s AS exact"
                    " FROM step_handoffs WHERE task_id = %s",
                    (_pg_param("72.1"), "TK-72.1"),
                )
                row = cur.fetchone()
        finally:
            conn.close()
        _measure(record_property, "stored-72.1", f"{row[1]!r} exact={row[2]}")
        assert row[2] is True, f"phase_number = 72.1 did not match the stored {row[1]!r}"
        assert row[1] == Decimal("72.1")

    def test_an_index_scan_is_available_for_the_predicate(self, migrated_dsn,
                                                          record_property):
        """A numeric parameter keeps idx_handoffs_latest usable; a float cast would not.

        The plan asks only that the index survive; this goes one step further and asks
        the planner whether it CAN be used, which is the reason NUMERIC was chosen over
        TEXT in the first place.
        """
        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute("SET enable_seqscan = off")
                cur.execute(
                    "EXPLAIN " + _PG_HANDOFF_SELECT,
                    ("execute-phase", _pg_param("72.1")),
                )
                plan_text = " ".join(row[0] for row in cur.fetchall())
        finally:
            conn.close()
        _measure(record_property, "explain", plan_text)
        assert "Seq Scan" not in plan_text, (
            "the predicate fell back to a sequential scan even with enable_seqscan off; "
            f"a numeric parameter should be index-usable. plan: {plan_text}"
        )
        # Which of the two step_handoffs indexes the planner reaches for is its own
        # choice (both lead with workflow_name); the assertion is that it CAN reach one.
        assert "idx_handoffs" in plan_text, plan_text


@requires_pg
class TestStepOrchestratorOnPostgres:
    """The orchestrator's own PostgreSQL-only product code, with a decimal phase.

    `conftest.product_pg_dsn` is the sanctioned way to point the PRODUCT's PostgreSQL
    clients at a disposable database: the session scrub deletes `GSD_POSTGRES_URL` and
    `DATABASE_URL` so no test can inherit the operator's live DSN, and this puts one back
    deliberately, for one block, after the DSN has been checked against the live ports.
    It takes an explicit DSN, which is how the SCRATCH database (not the configured one)
    gets used.
    """

    def test_save_then_load_round_trips_a_decimal_phase(self, migrated_dsn,
                                                        orchestrator_mod):
        with product_pg_dsn(migrated_dsn):
            handoff = orchestrator_mod.StepHandoff(
                workflow_name="execute-phase", step_id="step-01-prepare",
                task_id="TK-ORCH-721", phase_number="72.1",
                context_snapshot={"phase": "72.1"}, next_step="step-02-route",
            )
            orchestrator_mod.save_handoff(handoff)

            loaded = orchestrator_mod.load_or_create_handoff(
                "execute-phase", "72.1", "TK-ORCH-721")

        assert loaded.id == handoff.id, "the decimal-phase handoff did not load back"
        assert loaded.phase_number == Decimal("72.1")
        assert loaded.step_id == "step-01-prepare"

    def test_a_lookup_for_72_does_not_find_the_72_1_handoff(self, migrated_dsn,
                                                            orchestrator_mod):
        with product_pg_dsn(migrated_dsn):
            orchestrator_mod.save_handoff(orchestrator_mod.StepHandoff(
                workflow_name="execute-phase", step_id="step-03-execute",
                task_id="TK-ORCH-NC", phase_number="72.1",
                context_snapshot={}, next_step="step-04-verify",
            ))
            fresh = orchestrator_mod.load_or_create_handoff(
                "execute-phase", 72, "TK-ORCH-NC")

        # No row for phase 72, so a FRESH handoff is created at the first step.
        assert fresh.step_id == "step-01-prepare", (
            f"a lookup for phase 72 loaded phase 72.1's handoff ({fresh.step_id})"
        )
        assert fresh.phase_number == Decimal("72")


@requires_pg
class TestComplexityScorerOnPostgres:
    """`store_completion` writes task_completions.phase_number — NUMERIC(10,3) now."""

    def test_a_decimal_phase_completion_is_stored_exactly(self, migrated_dsn):
        import complexity_scorer as cs

        with product_pg_dsn(migrated_dsn):
            row_id = cs.store_completion(
                task_id="TK-CS-721", phase_number="72.1",
                workflow_name="execute-phase", features={"files": 3},
                raw_score=42, calibrated_score=None,
                chosen_phases=["R", "E"], phases_run=["R", "E"],
                outcome_label="validator_pass", escalation_history=[],
                embedding=None,
            )
        assert row_id, "store_completion returned no id on the disposable database"

        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT phase_number FROM task_completions WHERE task_id = %s",
                    ("TK-CS-721",),
                )
                stored = cur.fetchone()[0]
        finally:
            conn.close()
        assert stored == Decimal("72.1"), stored


# ═════════════════════════════════════════════════════════════════════════════
# THE EXECUTE-PHASE LOOP, THROUGH THE DAEMON ROUTE IT ACTUALLY USES
#
# get-shit-done/workflows/execute-phase/workflow.md:78-142 posts a handoff after
# EVERY step and HALTs when `.step_id` of
#   GET /api/steps/execute-phase/${PHASE}
# is empty. ${PHASE} is substituted literally, so a decimal phase went through
# that URL and came back 400. These tests drive the two real routes over HTTP on
# the fixture daemon, so they run on every cell rather than only where a
# disposable Postgres exists.
# ═════════════════════════════════════════════════════════════════════════════

#: The two routes the sharded workflow uses, by name, so the record can quote them.
STEPS_GET = "/api/steps/{workflow}/{phase}"
STEPS_POST = "/api/steps/{workflow}/{phase}/handoff"


def _http(port, method, path, body=None):
    """One request to the fixture daemon on 127.0.0.1, returning ``(status, body)``."""
    import urllib.error
    import urllib.request

    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            raw = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        status = err.code
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


class TestExecutePhaseLoopThroughTheDaemonRoutes:
    """A decimal-phase handoff is readable back, so the HALT condition cannot fire."""

    @pytest.mark.parametrize("phase", ["77.1", "94.1", "99.1"])
    def test_the_phases_this_milestone_carries_round_trip(self, fixture_daemon, phase):
        """77.1, 94.1 and 99.1 are the inserted phases on this milestone."""
        status, created = _http(
            fixture_daemon.port,
            "POST", STEPS_POST.format(workflow="execute-phase", phase=phase),
            {
                "step_id": "step-01-prepare",
                "task_id": f"TK-{phase}",
                "completed_steps": [],
                "context_snapshot": {"phase": phase},
                "next_step": "step-02-route",
            },
        )
        assert status == 201, (status, created)

        status, handoff = _http(
            fixture_daemon.port,
            "GET", STEPS_GET.format(workflow="execute-phase", phase=phase),
        )
        assert status == 200, (status, handoff)
        # THE assertion the workflow's Layer 3 gate makes: `.step_id // empty`.
        assert handoff.get("step_id") == "step-01-prepare", (
            f"GET /api/steps/execute-phase/{phase} returned no step_id — the "
            "execute-phase workflow would HALT here"
        )
        assert handoff["phase_number"] == float(phase)
        assert handoff["task_id"] == f"TK-{phase}"

    def test_a_handoff_for_77_is_not_the_handoff_for_77_1(self, fixture_daemon):
        """Through the route, both directions, on the shape the gate reads."""
        for phase, step in (("77", "step-02-route"), ("77.1", "step-04-verify")):
            status, _ = _http(
                fixture_daemon.port,
                "POST", STEPS_POST.format(workflow="execute-phase", phase=phase),
                {"step_id": step, "task_id": f"TK-{phase}",
                 "context_snapshot": {}, "next_step": None},
            )
            assert status == 201, status

        _, whole = _http(fixture_daemon.port,
                         "GET", STEPS_GET.format(workflow="execute-phase", phase="77"))
        _, decimal = _http(fixture_daemon.port,
                           "GET", STEPS_GET.format(workflow="execute-phase", phase="77.1"))
        assert whole["step_id"] == "step-02-route", whole
        assert decimal["step_id"] == "step-04-verify", decimal
        assert whole["task_id"] == "TK-77" and decimal["task_id"] == "TK-77.1"

    def test_a_non_number_phase_is_a_typed_400_on_the_route(self, fixture_daemon):
        status, body = _http(
            fixture_daemon.port,
            "GET", STEPS_GET.format(workflow="execute-phase", phase=NON_NUMBER),
        )
        assert status == 400, (status, body)
        assert body["error"] == "phase must be a number (e.g. 72 or 72.1)", body

    def test_the_route_never_answers_the_removed_refusal(self, fixture_daemon):
        for phase in PHASE_CASES:
            status, body = _http(
                fixture_daemon.port,
                "GET", STEPS_GET.format(workflow="execute-phase", phase=phase),
            )
            assert status == 200, (phase, status, body)
            assert "decimal_phase" not in json.dumps(body), (phase, body)


class TestComplexityEndpointsAreTypedNotFiveHundred:
    """`/api/complexity/complete` and `/escalate` answered 500 on a decimal phase."""

    @pytest.mark.parametrize("route", ["/api/complexity/complete",
                                       "/api/complexity/escalate"])
    def test_a_non_number_is_a_400_and_not_a_500(self, fixture_daemon, route):
        status, body = _http(fixture_daemon.port, "POST", route, {
            "task_id": "TK-8902", "phase_number": NON_NUMBER,
            "workflow_name": "execute-phase", "outcome_label": "validator_pass",
            "raw_score": 10, "feature_vector": {}, "chosen_phases": [],
            "phases_run": [],
        })
        assert status == 400, (status, body)
        assert body["error"] == "phase must be a number (e.g. 72 or 72.1)", body
        assert body["field"] == "phase_number", body

    @pytest.mark.parametrize("route", ["/api/complexity/complete",
                                       "/api/complexity/escalate"])
    def test_a_decimal_phase_is_not_a_500(self, fixture_daemon, route):
        """`int("72.1")` raised here; the endpoint must now get past the parse.

        On the SQLite backend neither endpoint can write (`task_completions` is a
        PostgreSQL table and `/escalate` needs a handoff), so the assertion is about
        the STATUS CLASS: anything but a 5xx and anything but the parse error.
        """
        status, body = _http(fixture_daemon.port, "POST", route, {
            "task_id": "TK-8902", "phase_number": "72.1",
            "workflow_name": "execute-phase", "outcome_label": "validator_pass",
            "raw_score": 10, "feature_vector": {}, "chosen_phases": [],
            "phases_run": [],
        })
        assert status < 500, (status, body)
        assert json.dumps(body).find("phase must be a number") == -1, body

    def test_escalate_reads_the_decimal_phases_own_handoff(self, fixture_daemon):
        """The bug behind the SQLite re-normalise this plan deleted.

        A handoff exists for 72 and none for 72.1. With the old bare `int()` the
        escalate call for "72.1" looked up phase 72 and escalated the wrong phase's
        handoff; the SQLite branch patched it over by re-normalising. With one
        normaliser at the top, the answer for 72.1 is `no_handoff`.
        """
        status, _ = _http(
            fixture_daemon.port,
            "POST", STEPS_POST.format(workflow="execute-phase", phase="72"),
            {"step_id": "step-03-execute", "task_id": "TK-ESC-72",
             "context_snapshot": {"complexity_score": 50}, "next_step": None},
        )
        assert status == 201, status

        status, body = _http(fixture_daemon.port, "POST", "/api/complexity/escalate", {
            "task_id": "TK-ESC-72", "phase_number": "72.1",
            "workflow_name": "execute-phase",
        })
        assert status == 200, (status, body)
        assert body.get("reason") == "no_handoff", (
            f"escalate for 72.1 found something; it must not read phase 72's "
            f"handoff: {body}"
        )


# ═════════════════════════════════════════════════════════════════════════════
# The MIGRATION_SENTINELS entry 031 needs after all.
#
# The plan said a new migration needs none ("sentinels exist for files that
# predate schema_migrations tracking"). MEASURED: that is not the convention the
# repository enforces — tests/test_docker_pg_migration.py:1113-1118
# `TestSentinelsUnit::test_every_migration_has_a_sentinel` fails for ANY
# migration without an entry, and the full local pytest run reddened on exactly
# that assertion. The intent (do not collide with the plans that own
# services/migrate_runner.py in later waves) is kept by adding ONE additive dict
# entry at the END of the dict — far from 89-05's 024 key and 89-06's 025 key.
#
# A "column" sentinel would be useless here: both columns already existed as
# INTEGER, so only the TYPE distinguishes "031 ran" from "031 did not". These
# tests prove the two `format_type` strings in the entry are the strings the
# catalogue actually produces.
# ═════════════════════════════════════════════════════════════════════════════


class TestMigrationSentinelFor031:
    """The entry exists, is well-formed, and names the right kind."""

    def test_031_has_a_sentinel_entry(self):
        from services import migrate_runner

        assert "031-decimal-phase-number.sql" in migrate_runner.MIGRATION_SENTINELS

    def test_the_sentinel_is_a_coltype_on_both_columns(self):
        from services import migrate_runner

        entry = migrate_runner.MIGRATION_SENTINELS["031-decimal-phase-number.sql"]
        assert entry == [
            ("coltype", "step_handoffs", "phase_number", "numeric(10,3)"),
            ("coltype", "task_completions", "phase_number", "numeric(10,3)"),
        ], entry


@requires_pg
class TestMigrationSentinelFor031OnPostgres:
    """`format_type` is measured, so the sentinel string cannot be a guess."""

    def test_the_format_type_strings_match_the_catalogue(self, migrated_dsn,
                                                         record_property):
        conn = _connect(migrated_dsn)
        try:
            with conn.cursor() as cur:
                measured = {}
                for table in ("step_handoffs", "task_completions"):
                    cur.execute(
                        "SELECT format_type(a.atttypid, a.atttypmod)"
                        " FROM pg_attribute a"
                        " WHERE a.attrelid = to_regclass(%s) AND a.attname = %s"
                        "   AND a.attnum > 0 AND NOT a.attisdropped",
                        (table, "phase_number"),
                    )
                    measured[table] = cur.fetchone()[0]
        finally:
            conn.close()
        _measure(record_property, "format_type", measured)
        assert measured == {"step_handoffs": "numeric(10,3)",
                            "task_completions": "numeric(10,3)"}, measured

    def test_the_sentinel_recognises_031_as_applied(self, migrated_dsn):
        """What the entry is FOR: an untracked database must not re-run 031."""
        import psycopg2

        from services import migrate_runner

        conn = psycopg2.connect(migrated_dsn, connect_timeout=10)
        try:
            # (applied, unknown) — services/migrate_runner.py:206-232.
            applied, unknown = migrate_runner.detect_applied_by_schema(conn)
        finally:
            conn.close()
        assert "031-decimal-phase-number.sql" in applied, applied
        assert "031-decimal-phase-number.sql" not in unknown, unknown

    def test_the_sentinel_does_not_fire_before_031_ran(self, migrated_dsn):
        """Taking the column back to INTEGER must make 031 pending again."""
        import psycopg2

        from services import migrate_runner

        _exec_file(migrated_dsn, MIGRATION_DOWN)
        conn = psycopg2.connect(migrated_dsn, connect_timeout=10)
        try:
            applied, _unknown = migrate_runner.detect_applied_by_schema(conn)
        finally:
            conn.close()
        assert "031-decimal-phase-number.sql" not in applied, (
            "the sentinel reports 031 applied on an INTEGER column — it would be "
            "baselined away and never run"
        )
