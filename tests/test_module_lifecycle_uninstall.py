#!/usr/bin/env python3
"""
tests/test_module_lifecycle_uninstall.py — Phase 49 MOD-03/MOD-04

Tests for services/module_lifecycle.uninstall() — 7-step orchestrator.

All tests use monkeypatch to force GSD_INSTALL_RECORD_BACKEND=sqlite and
point SQLITE_FALLBACK_PATH at a tmp_path file, so no real PG or real
~/.amauta/ is touched.

SC1 (install→uninstall round-trip empty diff) is tested by
test_uninstall_round_trip_filesystem_state_unchanged.
"""

import json
import os
import shutil

import pytest
from pathlib import Path

from services.module_lifecycle import (
    UNINSTALL_STEPS,
    SCHEMA_VERSION,
    install,
    uninstall,
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
    src_root = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "fixtures"
        / "modules"
        / "lifecycle-test"
    )
    dst_root = tmp_path / "lifecycle-test"
    shutil.copytree(str(src_root), str(dst_root))

    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(store, "SQLITE_FALLBACK_PATH", str(tmp_path / "module_installs.json"))

    monkeypatch.chdir(tmp_path)

    (tmp_path / "agents").mkdir(exist_ok=True)
    (tmp_path / "get-shit-done" / "skills").mkdir(parents=True, exist_ok=True)

    yield dst_root / "module.yaml"


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_uninstall_pass_path_after_install(hermetic_install, tmp_path):
    """Full uninstall pass: install then uninstall; all artifacts removed."""
    manifest_path = hermetic_install

    # Install first
    install_result = install(str(manifest_path))
    assert install_result.status == "pass"

    # Verify agent and skill exist after install
    agent_dest = tmp_path / "agents" / "test-agent.md"
    skill_dest = tmp_path / "get-shit-done" / "skills" / "test-skill" / "SKILL.md"
    assert agent_dest.exists(), "Agent file should exist after install"
    assert skill_dest.exists(), "Skill file should exist after install"

    # Uninstall
    result = uninstall("lifecycle-test")

    assert result.status == "pass", f"Expected pass, got {result.status}: {[s.message for s in result.steps]}"
    assert result.operation == "uninstall"
    assert result.module == "lifecycle-test"
    assert result.module_version == "0.1.0"

    # Exactly 7 steps
    assert len(result.steps) == 7

    # Step names in order match UNINSTALL_STEPS
    step_names = [s.name for s in result.steps]
    assert step_names == list(UNINSTALL_STEPS), f"Step names mismatch: {step_names}"

    # Files removed
    assert not agent_dest.exists(), "Agent file should be removed after uninstall"
    assert not skill_dest.exists(), "Skill file should be removed after uninstall"

    # Install record deleted
    record = store.get_install_record("lifecycle-test")
    assert record is None, "Install record should be deleted after uninstall"

    # No rollback (uninstall never rolls back per CONTEXT.md)
    assert result.rollback is None


def test_uninstall_absent_module_idempotent_skip(hermetic_install):
    """Uninstall of never-installed module → all-skip + overall skip."""
    result = uninstall("never-installed-mod")

    assert result.status == "skip", f"Expected skip, got {result.status}"

    # First step is read_install_record — should be skip
    step1 = result.steps[0]
    assert step1.name == "read_install_record"
    assert step1.status == "skip"

    # All 7 steps returned, all skip
    assert len(result.steps) == 7
    for step in result.steps:
        assert step.status == "skip", f"Step {step.name} expected skip, got {step.status}"


def test_uninstall_dry_run_preserves_files(hermetic_install, tmp_path):
    """Dry-run uninstall: state-modifying steps skip with would_apply; no files removed."""
    manifest_path = hermetic_install

    # Install first
    install_result = install(str(manifest_path))
    assert install_result.status == "pass"

    agent_dest = tmp_path / "agents" / "test-agent.md"
    skill_dest = tmp_path / "get-shit-done" / "skills" / "test-skill" / "SKILL.md"
    assert agent_dest.exists()
    assert skill_dest.exists()

    # Dry-run uninstall
    result = uninstall("lifecycle-test", dry_run=True)

    assert result.dry_run is True

    # State-modifying steps should skip with would_apply
    state_modifying = {"remove_skills", "remove_agents", "unregister_services", "revert_migrations", "clear_install_record"}
    step_map = {s.name: s for s in result.steps}

    for step_name in state_modifying:
        step = step_map.get(step_name)
        assert step is not None, f"Step {step_name} not in result"
        assert step.status == "skip", f"Step {step_name} expected skip, got {step.status}"
        assert step.details is not None, f"Step {step_name} has no details"
        assert "would_apply" in step.details, f"Step {step_name} missing would_apply"

    # Files still exist (dry-run did not remove them)
    assert agent_dest.exists(), "Dry-run should not remove agent file"
    assert skill_dest.exists(), "Dry-run should not remove skill file"

    # Install record still present
    record = store.get_install_record("lifecycle-test")
    assert record is not None, "Dry-run should not delete install record"


def test_uninstall_after_partial_removal_tolerates_missing(hermetic_install):
    """Manually remove agent before uninstall — uninstall should not fail."""
    manifest_path = hermetic_install

    install_result = install(str(manifest_path))
    assert install_result.status == "pass"

    # Manually remove agent file before uninstall
    record = store.get_install_record("lifecycle-test")
    assert record is not None
    for agent_path in record.get("installed_agents", []):
        if os.path.exists(agent_path):
            os.remove(agent_path)

    # Uninstall should tolerate the missing file
    result = uninstall("lifecycle-test")

    # Should be pass or warn, but NOT fail
    assert result.status in ("pass", "warn"), (
        f"Expected pass or warn on partial removal, got {result.status}: "
        f"{[s.message for s in result.steps]}"
    )


def test_uninstall_round_trip_filesystem_state_unchanged(hermetic_install, tmp_path):
    """SC1: filesystem snapshot before install == snapshot after uninstall (round-trip empty diff)."""
    manifest_path = hermetic_install

    # Capture pre-install snapshot (exclude lifecycle-test source fixture and backend store)
    EXCLUDE_PREFIXES = ("lifecycle-test/", "module_installs.json")

    def get_snapshot(root: Path) -> set:
        """Return set of relative paths under root, excluding backend store and fixture source."""
        result = set()
        for p in root.rglob("*"):
            if p.is_file():
                rel = str(p.relative_to(root))
                if not any(rel.startswith(ex) or rel == ex for ex in EXCLUDE_PREFIXES):
                    result.add(rel)
        return result

    pre_install_snapshot = get_snapshot(tmp_path)

    # Install
    install_result = install(str(manifest_path))
    assert install_result.status == "pass"

    # Post-install snapshot should differ (files were added)
    post_install_snapshot = get_snapshot(tmp_path)
    assert post_install_snapshot != pre_install_snapshot, "Install should add files"

    # Uninstall
    uninstall_result = uninstall("lifecycle-test")
    assert uninstall_result.status == "pass", (
        f"Uninstall failed: {[s.message for s in uninstall_result.steps]}"
    )

    # Post-uninstall snapshot should match pre-install (SC1)
    post_uninstall_snapshot = get_snapshot(tmp_path)
    diff = post_uninstall_snapshot.symmetric_difference(pre_install_snapshot)
    assert diff == set(), (
        f"SC1 FAILED: filesystem diff between pre-install and post-uninstall is not empty: {diff}"
    )


def test_uninstall_to_dict_serializable(hermetic_install):
    """to_dict() produces JSON-serializable output with exactly 8 keys."""
    manifest_path = hermetic_install

    install_result = install(str(manifest_path))
    assert install_result.status == "pass"

    result = uninstall("lifecycle-test")
    d = result.to_dict()

    # Must be JSON serializable
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
