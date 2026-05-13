"""
tests/test_install_record_store.py — Phase 49-01-04

SQLite-fallback CRUD tests for services/install_record_store.py.

All tests force GSD_INSTALL_RECORD_BACKEND=sqlite via monkeypatch.setenv
and override SQLITE_FALLBACK_PATH to a tmp_path directory so they never
touch ~/.amauta/data/ and never hit a live PG instance.

Coverage:
  1. test_get_missing_returns_none           — fresh store, absent key → None
  2. test_put_then_get_roundtrip             — put all 9 keys, get returns matching dict
  3. test_put_upserts_on_existing_module_name — same module_name, v2 overwrites v1
  4. test_delete_returns_true_when_present   — delete existing record → True + get → None
  5. test_delete_returns_false_when_absent   — delete missing record → False
  6. test_list_orders_by_installed_at_desc   — 3 records with distinct dates → [Mar, Feb, Jan]
  7. test_put_validates_required_keys        — empty dict → ValueError
  8. test_atomic_write_does_not_leave_temp_file — after put, only .json file, no .tmp
  9. test_row_columns_constant_has_9_entries — ROW_COLUMNS tuple has exactly 9 entries in order
  10. test_detect_backend_respects_env_override — GSD_INSTALL_RECORD_BACKEND=sqlite → "sqlite"
"""

import os
import sys

import pytest

# Ensure repo root is on the path (monorepo layout)
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.install_record_store import (  # noqa: E402
    ROW_COLUMNS,
    _detect_backend,
    delete_install_record,
    get_install_record,
    list_install_records,
    put_install_record,
)
import services.install_record_store as _store_mod  # noqa: E402

# ─── Helpers ─────────────────────────────────────────────────────────────────

_HASH_64 = "a" * 64  # valid CHAR(64) placeholder


def _make_record(
    module_name: str = "foo",
    version: str = "1.0.0",
    installed_at: str = "2026-01-01T00:00:00Z",
    upgraded_at=None,
) -> dict:
    """Build a minimal valid install record with all 9 required keys."""
    return {
        "module_name": module_name,
        "version": version,
        "manifest_hash": _HASH_64,
        "installed_at": installed_at,
        "upgraded_at": upgraded_at,
        "applied_migrations": [],
        "registered_services": [],
        "installed_agents": [],
        "installed_skills": [],
    }


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _sqlite_env(monkeypatch, tmp_path):
    """
    Force SQLite backend + redirect SQLITE_FALLBACK_PATH to tmp_path.

    Applied to every test in this file (autouse=True).
    """
    json_path = str(tmp_path / "module_installs.json")
    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(_store_mod, "SQLITE_FALLBACK_PATH", json_path)


# ─── Tests ───────────────────────────────────────────────────────────────────


def test_get_missing_returns_none():
    """Fresh store with no file — get returns None for any key."""
    result = get_install_record("does-not-exist")
    assert result is None


def test_put_then_get_roundtrip():
    """put then get returns matching dict (all 9 keys preserved)."""
    record = _make_record(module_name="foo", version="1.0.0")
    put_install_record(record)

    got = get_install_record("foo")
    assert got is not None
    assert got["module_name"] == "foo"
    assert got["version"] == "1.0.0"
    assert got["manifest_hash"] == _HASH_64
    assert got["installed_at"] == "2026-01-01T00:00:00Z"
    assert got["upgraded_at"] is None
    assert got["applied_migrations"] == []
    assert got["registered_services"] == []
    assert got["installed_agents"] == []
    assert got["installed_skills"] == []


def test_put_upserts_on_existing_module_name():
    """Second put with same module_name overwrites the first (UPSERT semantics)."""
    record_v1 = _make_record(module_name="foo", version="1.0.0")
    put_install_record(record_v1)

    record_v2 = _make_record(module_name="foo", version="2.0.0")
    put_install_record(record_v2)

    got = get_install_record("foo")
    assert got is not None
    assert got["version"] == "2.0.0", "UPSERT must overwrite with v2"


def test_delete_returns_true_when_present():
    """delete of existing record returns True; subsequent get returns None."""
    record = _make_record(module_name="foo")
    put_install_record(record)

    deleted = delete_install_record("foo")
    assert deleted is True

    got = get_install_record("foo")
    assert got is None


def test_delete_returns_false_when_absent():
    """delete of a never-inserted module_name returns False (no-op)."""
    result = delete_install_record("nothing")
    assert result is False


def test_list_orders_by_installed_at_desc():
    """list_install_records returns records sorted by installed_at descending."""
    rec_jan = _make_record(module_name="jan", installed_at="2026-01-01T00:00:00Z")
    rec_mar = _make_record(module_name="mar", installed_at="2026-03-01T00:00:00Z")
    rec_feb = _make_record(module_name="feb", installed_at="2026-02-01T00:00:00Z")

    put_install_record(rec_jan)
    put_install_record(rec_mar)
    put_install_record(rec_feb)

    result = list_install_records()
    assert len(result) == 3

    names = [r["module_name"] for r in result]
    assert names == ["mar", "feb", "jan"], (
        f"Expected [mar, feb, jan] DESC order; got {names}"
    )


def test_put_validates_required_keys():
    """put_install_record with empty dict raises ValueError (missing required keys)."""
    with pytest.raises(ValueError):
        put_install_record({})


def test_atomic_write_does_not_leave_temp_file(tmp_path):
    """After put, tmp_path contains exactly one file (module_installs.json), no .tmp orphans."""
    record = _make_record(module_name="foo")
    put_install_record(record)

    all_files = list(tmp_path.iterdir())
    assert len(all_files) == 1, f"Expected exactly 1 file; found {[f.name for f in all_files]}"
    assert all_files[0].name == "module_installs.json", (
        f"Expected module_installs.json; found {all_files[0].name}"
    )


def test_row_columns_constant_has_9_entries():
    """ROW_COLUMNS is a tuple of exactly 9 entries in the exact migration-022 order."""
    expected = (
        "module_name",
        "version",
        "manifest_hash",
        "installed_at",
        "upgraded_at",
        "applied_migrations",
        "registered_services",
        "installed_agents",
        "installed_skills",
    )
    assert len(ROW_COLUMNS) == 9, f"Expected 9 columns; got {len(ROW_COLUMNS)}"
    assert ROW_COLUMNS == expected, (
        f"ROW_COLUMNS order mismatch:\n  expected: {expected}\n  got:      {ROW_COLUMNS}"
    )


def test_detect_backend_respects_env_override():
    """GSD_INSTALL_RECORD_BACKEND=sqlite forces sqlite regardless of PG availability."""
    # The autouse fixture already set GSD_INSTALL_RECORD_BACKEND=sqlite
    backend = _detect_backend()
    assert backend == "sqlite", f"Expected 'sqlite'; got {backend!r}"
