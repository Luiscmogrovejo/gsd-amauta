#!/usr/bin/env python3
"""
tests/test_module_lifecycle_install.py — Phase 49 MOD-03/MOD-04

Tests for services/module_lifecycle.install() — 7-step orchestrator.

All tests use monkeypatch to force GSD_INSTALL_RECORD_BACKEND=sqlite and
point SQLITE_FALLBACK_PATH at a tmp_path file, so no real PG or real
~/.amauta/ is touched.

PG-required behavior (real apply_migrations with SQL execution) is deferred
to 49-04 E2E. The lifecycle-test fixture has migrations: [] so the migration
step runs the empty path.
"""

import json
import os
import shutil

import pytest
from pathlib import Path

from services.module_lifecycle import (
    INSTALL_STEPS,
    SCHEMA_VERSION,
    compute_manifest_hash,
    install,
)
import services.install_record_store as store


# ─── Shared fixture ───────────────────────────────────────────────────────────


@pytest.fixture
def hermetic_install(tmp_path, monkeypatch):
    """
    Set up a hermetic install environment:
    1. Copy lifecycle-test fixture into tmp_path
    2. Force SQLite backend at known path
    3. chdir to tmp_path so install writes relative dirs there
    4. Ensure dest dirs exist
    Yields the manifest_path (Path).
    """
    # 1. Copy fixture into tmp tree
    src_root = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "fixtures"
        / "modules"
        / "lifecycle-test"
    )
    dst_root = tmp_path / "lifecycle-test"
    shutil.copytree(str(src_root), str(dst_root))

    # 2. Force SQLite backend at known path
    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(store, "SQLITE_FALLBACK_PATH", str(tmp_path / "module_installs.json"))

    # 3. chdir into tmp_path so install writes to relative dirs there
    monkeypatch.chdir(tmp_path)

    # 4. Ensure dest dirs exist
    (tmp_path / "agents").mkdir(exist_ok=True)
    (tmp_path / "get-shit-done" / "skills").mkdir(parents=True, exist_ok=True)

    yield dst_root / "module.yaml"


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_install_pass_path_writes_record(hermetic_install):
    """Full pass path: all 7 steps pass, record written to store."""
    manifest_path = hermetic_install
    result = install(str(manifest_path))

    assert result.status == "pass", f"Expected pass, got {result.status}: {[s.message for s in result.steps]}"
    assert result.operation == "install"
    assert result.module == "lifecycle-test"
    assert result.module_version == "0.1.0"
    assert result.schema_version == SCHEMA_VERSION

    # Exactly 7 steps
    assert len(result.steps) == 7

    # Step names in order match INSTALL_STEPS
    step_names = [s.name for s in result.steps]
    assert step_names == list(INSTALL_STEPS), f"Step names mismatch: {step_names}"

    # Install record written
    record = store.get_install_record("lifecycle-test")
    assert record is not None, "Install record not written"

    # manifest_hash matches
    yaml_text = manifest_path.read_text(encoding="utf-8")
    expected_hash = compute_manifest_hash(yaml_text)
    assert record["manifest_hash"] == expected_hash


def test_install_dry_run_does_not_write_record(hermetic_install, tmp_path):
    """Dry-run: state-modifying steps skip with would_apply; no disk writes."""
    manifest_path = hermetic_install
    result = install(str(manifest_path), dry_run=True)

    assert result.dry_run is True

    # State-modifying steps that should be skip with would_apply
    state_modifying_steps = {"apply_migrations", "register_services", "copy_agents", "copy_skills"}
    step_map = {s.name: s for s in result.steps}

    for step_name in state_modifying_steps:
        step = step_map.get(step_name)
        assert step is not None, f"Step {step_name} not in result.steps"
        assert step.status == "skip", f"Step {step_name} expected skip, got {step.status}"
        assert step.details is not None, f"Step {step_name} has no details"
        assert "would_apply" in step.details, f"Step {step_name} missing would_apply in details"

    # No install record written
    record = store.get_install_record("lifecycle-test")
    assert record is None, "Dry-run should not write install record"

    # No agent file written
    agent_dest = tmp_path / "agents" / "test-agent.md"
    assert not agent_dest.exists(), "Dry-run should not copy agent file"


def test_install_idempotent_skip_on_second_call(hermetic_install):
    """Re-install with same hash → all-skip + overall skip + no rollback."""
    manifest_path = hermetic_install

    # First install
    result1 = install(str(manifest_path))
    assert result1.status == "pass"

    # Second install — should be idempotent skip
    result2 = install(str(manifest_path))
    assert result2.status == "skip", f"Expected skip on second call, got {result2.status}"

    # First step (validate_manifest) returns skip with "already installed"
    step1 = result2.steps[0]
    assert step1.name == "validate_manifest"
    assert step1.status == "skip"
    assert "already installed" in step1.message.lower(), f"Unexpected message: {step1.message}"

    # No rollback triggered
    assert result2.rollback is None


def test_install_force_reinstalls_even_with_matching_hash(hermetic_install):
    """--force re-runs all steps even on hash match."""
    manifest_path = hermetic_install

    result1 = install(str(manifest_path))
    assert result1.status == "pass"
    record1 = store.get_install_record("lifecycle-test")
    assert record1 is not None

    # Re-install with force=True
    result2 = install(str(manifest_path), force=True)
    assert result2.status == "pass", f"Force reinstall failed: {result2.status}"

    # Record still present and parseable
    record2 = store.get_install_record("lifecycle-test")
    assert record2 is not None
    # installed_at is present and is a string
    assert record2.get("installed_at") is not None


def test_install_missing_manifest_file_returns_fail():
    """Missing manifest file → validate_manifest step fails, no rollback."""
    result = install("/nonexistent/path/to/module.yaml")

    assert result.status == "fail"

    step1 = result.steps[0]
    assert step1.name == "validate_manifest"
    assert step1.status == "fail"

    # No prior pass steps → rollback has empty undo_actions (may be non-None dict)
    if result.rollback is not None:
        assert result.rollback.get("undo_actions") == [], (
            f"Expected empty undo_actions, got: {result.rollback}"
        )


def test_install_invalid_manifest_returns_fail(tmp_path, monkeypatch):
    """Malformed manifest → validate_manifest step fails."""
    # Write a YAML missing required 'version' field
    bad_yaml = tmp_path / "bad.yaml"
    bad_yaml.write_text("name: broken-module\n# missing version\n", encoding="utf-8")

    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(store, "SQLITE_FALLBACK_PATH", str(tmp_path / "module_installs.json"))

    result = install(str(bad_yaml))

    assert result.status == "fail"

    step1 = result.steps[0]
    assert step1.name == "validate_manifest"
    assert step1.status == "fail"


def test_install_lifecycle_result_to_dict_serializable(hermetic_install):
    """to_dict() produces JSON-serializable output with exactly 8 keys."""
    manifest_path = hermetic_install
    result = install(str(manifest_path))

    d = result.to_dict()

    # Must be JSON serializable (no datetime objects, etc.)
    serialized = json.dumps(d)
    assert serialized  # non-empty

    # Exactly 8 keys per CONTEXT.md §Area 2
    expected_keys = {
        "schema_version",
        "operation",
        "module",
        "module_version",
        "status",
        "steps",
        "rollback",
        "dry_run",
    }
    assert set(d.keys()) == expected_keys, f"Dict keys mismatch: {set(d.keys())}"
