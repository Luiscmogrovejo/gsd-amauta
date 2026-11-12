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

from conftest import PG_SKIP_REASON, postgres_dsn_or_none  # noqa: E402

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
