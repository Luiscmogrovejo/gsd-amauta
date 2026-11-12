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
import uuid
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
