#!/usr/bin/env python3
"""tests/test_capability_access.py — Phase 60 TOOL-02/TOOL-03

Tests for services/capability_access.py: enforce-mode matrix (warn/block/off,
the Phase 67 contract), the SENTINEL_TASK_ID='SYSTEM' out-of-task convention,
fail-open audit logging, the JSONL PG-down buffer + flush_buffer(), the
audit_diff() declared-vs-actual engine (dynamic gsd-executor-* enumeration,
declared-unused-is-informational / actual-but-undeclared-is-drift semantics,
catalog-schema-drift-as-drift), and the cross-runtime buffer-path identity
guarantee (Python _data_dir() == Node DATA_DIR default).

Fixture idioms mirror tests/test_capability_schema.py: monkeypatch.setenv +
tmp_path + load_capability_catalog(force_reload=True).

Run: pytest tests/test_capability_access.py -v
"""

import glob
import json
import os
import subprocess
import sys

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest

from services.capability_schema import load_capability_catalog
from services.capability_access import (
    SENTINEL_TASK_ID,
    check_access,
    log_access,
    flush_buffer,
    get_enforce_mode,
    buffer_path,
    _data_dir,
    audit_diff,
)


def _base_entry(**overrides):
    """Return a minimal valid CapabilityEntry kwargs dict."""
    base = {
        "name": "test-entry",
        "kind": "curl-endpoint",
        "target": "http://127.0.0.1:9999",
        "auth": {"method": "none"},
        "security_class": "read-only",
        "owner": "operator",
        "grants": [],
        "added_at": "2026-07-03",
        "notes": "",
    }
    base.update(overrides)
    return base


class FakeStore:
    """Records audit_log(**kwargs) calls; serves canned audit_query results."""

    def __init__(self, access_rows=None, unlisted_rows=None):
        self.calls = []
        self._access_rows = access_rows or []
        self._unlisted_rows = unlisted_rows or []

    def audit_log(self, task_id=None, event_type=None, agent_id=None, metadata=None, **kwargs):
        row = {
            "task_id": task_id,
            "event_type": event_type,
            "agent_id": agent_id,
            "metadata": metadata,
        }
        self.calls.append(row)
        return len(self.calls)

    def audit_query(self, event_type=None, limit=100, **kwargs):
        if event_type == "capability_access":
            return self._access_rows
        if event_type == "capability_unlisted":
            return self._unlisted_rows
        return []


@pytest.fixture
def tmp_catalog(tmp_path, monkeypatch):
    """Write a tmp catalog to disk + point GSD_CAPABILITY_CATALOG_PATH there.
    Returns a builder function; also returns the loaded dict for callers that
    want to pass catalog=... directly (avoiding the module cache entirely)."""
    def _write(entries):
        path = tmp_path / "catalog.json"
        data = {"catalog_version": "1.0", "entries": entries}
        path.write_text(json.dumps(data))
        monkeypatch.setenv("GSD_CAPABILITY_CATALOG_PATH", str(path))
        return load_capability_catalog(force_reload=True)
    yield _write
    monkeypatch.delenv("GSD_CAPABILITY_CATALOG_PATH", raising=False)
    load_capability_catalog(force_reload=True)


@pytest.fixture
def tmp_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path))
    yield tmp_path
    monkeypatch.delenv("AMAUTA_DATA_DIR", raising=False)


@pytest.fixture
def tmp_agents_root(tmp_path):
    root = tmp_path / "agents"
    root.mkdir()
    (root / "gsd-executor-a").mkdir()
    (root / "gsd-executor-b").mkdir()
    (root / "gsd-checker").mkdir()  # non-executor agent — must be excluded
    return str(root)


# ═══════════════════════════ Enforce-mode matrix (Phase 67 contract) ═══════

def test_warn_unlisted_allowed_with_warning(tmp_catalog, monkeypatch):
    catalog = tmp_catalog([])
    monkeypatch.delenv("GSD_CAPABILITY_ENFORCE", raising=False)  # default == warn
    r = check_access("nope", "gsd-executor-backend", catalog=catalog)
    assert r["allowed"] is True
    assert r["outcome"] == "unlisted_warn"
    assert r["warning"] is not None

    monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", "warn")
    r2 = check_access("nope", "gsd-executor-backend", catalog=catalog)
    assert r2["allowed"] is True
    assert r2["outcome"] == "unlisted_warn"


def test_block_unlisted_refused(tmp_catalog, monkeypatch):
    catalog = tmp_catalog([])
    monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", "block")
    r = check_access("nope", "gsd-executor-backend", catalog=catalog)
    assert r["allowed"] is False
    assert r["code"] == "capability_unlisted_blocked"


def test_off_skips_checks(tmp_catalog, monkeypatch):
    catalog = tmp_catalog([])
    monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", "off")
    r = check_access("nope", "gsd-executor-backend", catalog=catalog)
    assert r["allowed"] is True
    assert r["outcome"] == "skipped_off"


def test_invalid_mode_falls_back_to_warn(monkeypatch):
    monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", "bogus")
    assert get_enforce_mode() == "warn"


def test_destructive_requires_confirm_in_all_modes(tmp_catalog, monkeypatch):
    catalog = tmp_catalog([_base_entry(name="d-entry", security_class="destructive")])
    for mode in ("warn", "block", "off"):
        monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", mode)
        r = check_access("d-entry", "gsd-executor-backend", confirm=False, catalog=catalog)
        assert r["allowed"] is False
        assert r["code"] == "capability_destructive_unconfirmed"

    monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", "warn")
    r2 = check_access("d-entry", "gsd-executor-backend", confirm=True, catalog=catalog)
    assert r2["allowed"] is True


def test_auth_missing_env_structured_error(tmp_catalog, monkeypatch):
    catalog = tmp_catalog([
        _base_entry(name="auth-entry", auth={"method": "bearer-env", "env": "SOME_TEST_TOKEN_XYZ"}),
    ])
    monkeypatch.delenv("SOME_TEST_TOKEN_XYZ", raising=False)
    monkeypatch.setenv("GSD_CAPABILITY_ENFORCE", "warn")
    r = check_access("auth-entry", "gsd-executor-backend", catalog=catalog)
    assert r["allowed"] is False
    assert r["code"] == "capability_auth_missing"
    assert r["env"] == "SOME_TEST_TOKEN_XYZ"


# ═══════════════════════════ Sentinel + logging ════════════════════════════

def test_sentinel_task_id_used_when_out_of_task():
    store = FakeStore()
    log_access(store, "gsd-executor-backend", "x", "target", "read-only", "allowed", task_id=None)
    task_id = store.calls[0]["task_id"]
    assert task_id == "SYSTEM"
    assert SENTINEL_TASK_ID == "SYSTEM"


def test_real_task_id_passes_through():
    store = FakeStore()
    log_access(store, "gsd-executor-backend", "x", "target", "read-only", "allowed", task_id="TK-1234")
    assert store.calls[0]["task_id"] == "TK-1234"


def test_metadata_carries_target_and_class():
    store = FakeStore()
    log_access(store, "gsd-executor-backend", "x", "the-target", "secret-bearing", "allowed", enforce_mode="warn")
    meta = store.calls[0]["metadata"]
    assert meta["target"] == "the-target"
    assert meta["security_class"] == "secret-bearing"
    assert meta["outcome"] == "allowed"
    assert meta["enforce_mode"] == "warn"
    assert meta["catalog_entry"] == "x"


# ═══════════════════════════ JSONL buffer (degraded mode) ══════════════════

def test_pg_down_buffers_jsonl(tmp_data_dir):
    result = log_access(None, "gsd-executor-backend", "x", "the-target", "read-only", "allowed")
    assert result == {"logged": False, "buffered": True}
    path = buffer_path()
    assert os.path.isfile(path)
    with open(path) as f:
        record = json.loads(f.readline())
    assert "ts" in record
    assert record["agent_id"] == "gsd-executor-backend"
    assert record["target"] == "the-target"


def test_buffer_write_failure_fails_open(tmp_path, monkeypatch):
    file_as_dir = tmp_path / "not-a-dir"
    file_as_dir.write_text("i am a file, not a directory")
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(file_as_dir))
    result = log_access(None, "gsd-executor-backend", "x", "the-target", "read-only", "allowed")
    assert result["logged"] is False
    assert result["buffered"] is False


def test_flush_buffer_drains_to_store(tmp_data_dir):
    for i in range(3):
        log_access(None, "gsd-executor-backend", f"entry-{i}", "t", "read-only", "allowed")
    store = FakeStore()
    result = flush_buffer(store)
    assert result["flushed"] == 3
    assert len(store.calls) == 3
    path = buffer_path()
    assert os.path.getsize(path) == 0


# ═══════════════════════════ audit_diff (60-RESEARCH fixtures) ═════════════

def test_declared_unused_is_informational_not_drift(tmp_agents_root):
    catalog = {
        "catalog_version": "1.0",
        "entries": [
            _base_entry(name="entry-x", grants=["gsd-executor-a"]),
            _base_entry(name="entry-y", grants=["gsd-executor-a"]),
        ],
    }
    store = FakeStore(access_rows=[{"agent_id": "gsd-executor-a", "metadata": {"catalog_entry": "entry-x"}}])
    result = audit_diff(store=store, agents_root=tmp_agents_root, catalog=catalog)
    a = next(r for r in result["agents"] if r["agent"] == "gsd-executor-a")
    assert a["declared_unused"] == ["entry-y"]
    assert a["unexplained"] == []
    assert result["drift"] is False


def test_undeclared_access_is_unexplained_gap(tmp_agents_root):
    catalog = {"catalog_version": "1.0", "entries": []}
    store = FakeStore(access_rows=[{"agent_id": "gsd-executor-b", "metadata": {"catalog_entry": "z"}}])
    result = audit_diff(store=store, agents_root=tmp_agents_root, catalog=catalog)
    b = next(r for r in result["agents"] if r["agent"] == "gsd-executor-b")
    assert b["unexplained"] == ["z"]
    assert result["unexplained_total"] == 1
    assert result["drift"] is True


def test_store_none_declared_only(tmp_agents_root):
    catalog = {"catalog_version": "1.0", "entries": []}
    result = audit_diff(store=None, agents_root=tmp_agents_root, catalog=catalog)
    assert result["actual_available"] is False
    assert result["drift"] is False


def test_catalog_schema_errors_count_as_drift(tmp_agents_root):
    bad_entry = _base_entry()
    del bad_entry["security_class"]
    catalog = {"catalog_version": "1.0", "entries": [bad_entry]}
    result = audit_diff(store=None, agents_root=tmp_agents_root, catalog=catalog)
    assert result["catalog_schema_errors"]
    assert result["drift"] is True
    # gsd-executor-a + gsd-executor-b only (gsd-checker excluded) — the walk
    # completes despite the schema-invalid catalog (dict-access normalization).
    assert len(result["agents"]) == 2
    for row in result["agents"]:
        assert set(row.keys()) >= {"declared", "used", "declared_unused", "unexplained"}


# ═══════════════════════════ Dynamic enumeration (coverage floor) ══════════

def test_enumeration_matches_glob(tmp_agents_root):
    result = audit_diff(store=None, agents_root=tmp_agents_root, catalog={"catalog_version": "1.0", "entries": []})
    assert len(result["agents"]) == 2


def test_new_executor_dir_appears_without_code_change(tmp_agents_root):
    result = audit_diff(store=None, agents_root=tmp_agents_root, catalog={"catalog_version": "1.0", "entries": []})
    assert len(result["agents"]) == 2

    os.makedirs(os.path.join(tmp_agents_root, "gsd-executor-c"))

    result2 = audit_diff(store=None, agents_root=tmp_agents_root, catalog={"catalog_version": "1.0", "entries": []})
    assert len(result2["agents"]) == 3


def test_live_repo_floor():
    live_root = os.path.join(_ROOT, "get-shit-done", "agents")
    expected = len(glob.glob(os.path.join(live_root, "gsd-executor-*")))
    result = audit_diff(store=None)
    assert len(result["agents"]) == expected


# ═══════════════════════════ Cross-runtime buffer-path identity ════════════

def test_buffer_dir_identical_across_runtimes(tmp_path, monkeypatch):
    # (a) default path: no override — must equal <repo_root>/data, the live
    # Node-side DATA_DIR (proof: tasks.json actually lives there).
    monkeypatch.delenv("AMAUTA_DATA_DIR", raising=False)
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"]).decode().strip()
    assert os.path.normpath(os.path.abspath(_data_dir())) == os.path.join(repo, "data")
    assert os.path.isfile(os.path.join(repo, "data", "tasks.json"))

    # (b) override honored by BOTH runtimes — the shared seam.
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path))
    assert _data_dir() == str(tmp_path)
    proc = subprocess.run(
        ["node", "-e", "console.log(process.env.AMAUTA_DATA_DIR || 'UNSET')"],
        env={**os.environ},
        capture_output=True, text=True,
    )
    assert proc.stdout.strip() == str(tmp_path)
