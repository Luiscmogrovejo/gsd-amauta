#!/usr/bin/env python3
"""tests/test_capability_schema.py — Phase 60 TOOL-01

Tests for services/capability_schema.py: CapabilityCatalog / CapabilityEntry /
CapabilityAuth Pydantic model validation, load_capability_catalog() dual-path
loader (env-override seam, empty-catalog fallback, version-mismatch warning),
and validate_catalog() error-shape contract.

Loader tests use monkeypatch.setenv("GSD_CAPABILITY_CATALOG_PATH", ...) +
tmp_path fixtures + load_capability_catalog(force_reload=True), mirroring the
tests/test_install_record_store.py env-override convention.

Run: pytest tests/test_capability_schema.py -v
"""

import json
import os
import sys

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest

from services.capability_schema import (
    CapabilityAuth,
    KIND_VALUES,
    SECURITY_CLASS_VALUES,
    load_capability_catalog,
    validate_catalog,
)
import services.capability_schema as capability_schema_module


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


@pytest.fixture(autouse=True)
def _reset_catalog_cache():
    """Ensure module-level cache/warn-once flags don't leak state across tests."""
    yield
    os.environ.pop("GSD_CAPABILITY_CATALOG_PATH", None)
    load_capability_catalog(force_reload=True)


def test_seeded_catalog_validates():
    """load_capability_catalog(force_reload=True) (no env override) +
    validate_catalog passes; exactly 7 entries (3 Phase 60 seed entries +
    4 Phase 68 mobile-tool entries added by 68-03-02); every entry has
    non-empty auth.method, security_class, target (the Nyquist 'zero
    entries missing any of the three fields' floor)."""
    os.environ.pop("GSD_CAPABILITY_CATALOG_PATH", None)
    data = load_capability_catalog(force_reload=True)
    catalog = validate_catalog(data)

    assert len(catalog.entries) == 7

    for entry in catalog.entries:
        assert entry.auth.method, f"entry {entry.name} missing auth.method"
        assert entry.security_class, f"entry {entry.name} missing security_class"
        assert entry.target, f"entry {entry.name} missing target"


def test_all_kind_and_class_values_accepted():
    """Synthetic catalog with 6 entries spanning all 6 kind values
    (including the Phase 68 additive 'local-tool' kind) and (across them)
    all 4 security_class values validates cleanly."""
    assert len(KIND_VALUES) == 6
    assert "local-tool" in KIND_VALUES
    assert len(SECURITY_CLASS_VALUES) == 4

    entries = [
        _base_entry(
            name=f"synthetic-{i}",
            kind=kind,
            security_class=SECURITY_CLASS_VALUES[i % len(SECURITY_CLASS_VALUES)],
        )
        for i, kind in enumerate(KIND_VALUES)
    ]

    data = {"catalog_version": "1.1", "entries": entries}
    catalog = validate_catalog(data)
    assert len(catalog.entries) == 6

    seen_kinds = {e.kind for e in catalog.entries}
    seen_classes = {e.security_class for e in catalog.entries}
    assert seen_kinds == set(KIND_VALUES)
    assert seen_classes == set(SECURITY_CLASS_VALUES)


def test_local_tool_kind_accepted():
    """kind: 'local-tool' validates OK (Phase 68 additive kind)."""
    entry = _base_entry(name="local-tool-entry", kind="local-tool")
    data = {"catalog_version": "1.1", "entries": [entry]}
    catalog = validate_catalog(data)
    assert len(catalog.entries) == 1
    assert catalog.entries[0].kind == "local-tool"


def test_unknown_kind_still_rejected():
    """kind: 'gradle-mcp' (an unenumerated kind) still raises — additive
    extension does not open the enum to arbitrary values (fail-closed
    preserved)."""
    bad_entry = _base_entry(kind="gradle-mcp")
    data = {"catalog_version": "1.1", "entries": [bad_entry]}
    with pytest.raises((ValueError, Exception)):
        validate_catalog(data)


def test_unknown_field_rejected():
    """An entry with extra key 'token': 'x' raises (extra=forbid — the
    no-secret-values guarantee)."""
    bad_entry = _base_entry()
    bad_entry["token"] = "x"
    data = {"catalog_version": "1.1", "entries": [bad_entry]}
    with pytest.raises((ValueError, Exception)):
        validate_catalog(data)


def test_missing_security_class_rejected():
    """Entry without security_class raises ValueError containing
    'capability_catalog_invalid'."""
    bad_entry = _base_entry()
    del bad_entry["security_class"]
    data = {"catalog_version": "1.1", "entries": [bad_entry]}
    with pytest.raises(ValueError, match="capability_catalog_invalid"):
        validate_catalog(data)


def test_bad_kind_rejected():
    """kind: 'http' raises."""
    bad_entry = _base_entry(kind="http")
    data = {"catalog_version": "1.1", "entries": [bad_entry]}
    with pytest.raises((ValueError, Exception)):
        validate_catalog(data)


def test_duplicate_names_rejected():
    """Two entries named 'dup-entry' raise with message containing
    'dup-entry'."""
    data = {
        "catalog_version": "1.1",
        "entries": [_base_entry(name="dup-entry"), _base_entry(name="dup-entry")],
    }
    with pytest.raises(ValueError, match="dup-entry"):
        validate_catalog(data)


def test_auth_env_required_for_bearer_env():
    """{'method': 'bearer-env'} without env raises; {'method': 'ssh-key'}
    without key_ref raises; {'method': 'none'} alone passes."""
    with pytest.raises((ValueError, Exception)):
        CapabilityAuth(method="bearer-env")

    with pytest.raises((ValueError, Exception)):
        CapabilityAuth(method="ssh-key")

    auth = CapabilityAuth(method="none")
    assert auth.method == "none"


def test_missing_file_empty_fallback(monkeypatch):
    """env override to nonexistent path -> result equals
    {'catalog_version': '1.1', 'entries': []} and no exception."""
    monkeypatch.setenv("GSD_CAPABILITY_CATALOG_PATH", "/nonexistent/never-here-capability.json")
    data = load_capability_catalog(force_reload=True)
    assert data == {"catalog_version": "1.1", "entries": []}


def test_malformed_json_falls_through_to_empty(monkeypatch, tmp_path):
    """env override to a tmp_path file containing 'not-json{' -> empty-catalog
    fallback, no raise."""
    bad_file = tmp_path / "malformed-catalog.json"
    bad_file.write_text("not-json{")
    monkeypatch.setenv("GSD_CAPABILITY_CATALOG_PATH", str(bad_file))

    data = load_capability_catalog(force_reload=True)
    assert data == {"catalog_version": "1.1", "entries": []}


def test_version_mismatch_warns_but_loads(monkeypatch, tmp_path, capsys):
    """tmp_path catalog with catalog_version '9.9' and valid empty entries
    loads (returns the data); stderr contains '9.9'."""
    mismatched_file = tmp_path / "mismatched-catalog.json"
    mismatched_file.write_text(json.dumps({"catalog_version": "9.9", "entries": []}))
    monkeypatch.setenv("GSD_CAPABILITY_CATALOG_PATH", str(mismatched_file))

    # Reset the module-level warn-once flag so this test observes the warning
    # regardless of test execution order.
    monkeypatch.setattr(capability_schema_module, "_CATALOG_VERSION_WARNED", False)

    data = load_capability_catalog(force_reload=True)

    assert data == {"catalog_version": "9.9", "entries": []}
    captured = capsys.readouterr()
    assert "9.9" in captured.err
