#!/usr/bin/env python3
"""
tests/test_module_lifecycle_rollback.py — Phase 49 MOD-03/MOD-04

Tests for services/module_lifecycle._run_rollback() — reverse-order undo engine.

Tests monkeypatch per-step helpers to simulate mid-install failures, then
verify rollback entries are appended in REVERSE order with rollback_<step>
prefix and LifecycleResult.rollback is populated.

SC4 (mid-install fail → automatic rollback) is tested by
test_rollback_fires_when_register_services_fails and
test_rollback_fires_when_copy_skills_fails_undoes_copy_agents.
"""

import os
import shutil

import pytest
from pathlib import Path

from services.module_lifecycle import (
    ROLLBACK_PREFIX,
    StepResult,
    _rollback_post_install_verify,
    _run_rollback,
    build_step_result,
    install,
)
import services.install_record_store as store
import services.module_lifecycle as lifecycle_mod


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


def test_rollback_fires_when_register_services_fails(hermetic_install, monkeypatch):
    """
    SC4: register_services fails → rollback fires for prior pass steps.
    register_services runs AFTER apply_migrations + resolve_dependencies in INSTALL_STEPS.
    """
    manifest_path = hermetic_install

    # Monkeypatch _install_register_services to return fail
    monkeypatch.setattr(
        lifecycle_mod,
        "_install_register_services",
        lambda ctx: build_step_result("register_services", "fail", "simulated register_services failure"),
    )

    result = install(str(manifest_path))

    assert result.status == "fail"
    assert result.rollback is not None
    assert result.rollback["triggered_by_step"] == "register_services"

    # Rollback entries should appear after the failing step
    step_names = [s.name for s in result.steps]
    fail_idx = step_names.index("register_services")
    rollback_entries = [s for s in result.steps[fail_idx + 1:] if s.name.startswith("rollback_")]
    assert len(rollback_entries) > 0, "Expected rollback entries after failing step"

    # All rollback entry names start with rollback_
    for rb in rollback_entries:
        assert rb.name.startswith("rollback_"), f"Rollback entry has wrong prefix: {rb.name}"

    # undo_actions contains what was actually rolled back
    undo_actions = result.rollback["undo_actions"]
    # validate_manifest and resolve_dependencies ran with pass before register_services
    # apply_migrations also ran (with pass, since migrations=[] returns pass)
    # rollback_apply_migrations should be in undo_actions
    # (validate_manifest + resolve_dependencies are read-only → skip rollback, not in undo_actions)
    assert any("apply_migrations" in a for a in undo_actions), (
        f"Expected rollback_apply_migrations in undo_actions: {undo_actions}"
    )


def test_rollback_fires_when_copy_skills_fails_undoes_copy_agents(hermetic_install, monkeypatch, tmp_path):
    """
    SC4: copy_skills fails → rollback undoes copy_agents, register_services, apply_migrations.
    Asserts reverse order: rollback entries are in reverse of forward execution.
    """
    manifest_path = hermetic_install

    # Force copy_skills to fail
    monkeypatch.setattr(
        lifecycle_mod,
        "_install_copy_skills",
        lambda ctx: build_step_result("copy_skills", "fail", "simulated copy_skills failure"),
    )

    result = install(str(manifest_path))

    assert result.status == "fail"
    assert result.rollback is not None
    assert result.rollback["triggered_by_step"] == "copy_skills"

    # copy_agents should have run with pass before copy_skills
    step_map = {s.name: s for s in result.steps}
    copy_agents_step = step_map.get("copy_agents")
    assert copy_agents_step is not None
    assert copy_agents_step.status == "pass"

    # Rollback entries: look for rollback_copy_agents, rollback_register_services, rollback_apply_migrations
    rollback_entries = [s for s in result.steps if s.name.startswith("rollback_")]
    rb_names = [s.name for s in rollback_entries]

    assert "rollback_copy_agents" in rb_names, f"rollback_copy_agents missing from: {rb_names}"
    assert "rollback_register_services" in rb_names, f"rollback_register_services missing from: {rb_names}"
    assert "rollback_apply_migrations" in rb_names, f"rollback_apply_migrations missing from: {rb_names}"

    # Verify reverse order: rollback_copy_agents must appear before rollback_register_services
    # which must appear before rollback_apply_migrations
    rb_order = {name: i for i, name in enumerate(rb_names)}
    assert rb_order["rollback_copy_agents"] < rb_order["rollback_register_services"], (
        f"rollback_copy_agents should precede rollback_register_services in: {rb_names}"
    )

    # Agent file should have been removed by rollback_copy_agents
    agent_dest = tmp_path / "agents" / "test-agent.md"
    assert not agent_dest.exists(), "Rollback should have removed agent file"


def test_rollback_does_not_fire_on_validate_manifest_fail(hermetic_install):
    """validate_manifest fails first → no prior pass steps → rollback has empty undo_actions."""
    result = install("/nonexistent/path/to/module.yaml")

    assert result.status == "fail"

    # validate_manifest is the first step; no prior pass steps
    # _run_rollback fires but with empty undo_actions
    if result.rollback is not None:
        assert result.rollback.get("undo_actions") == [], (
            f"Expected empty undo_actions, got: {result.rollback}"
        )


def test_rollback_does_not_fire_in_dry_run_mode(hermetic_install, monkeypatch):
    """
    Dry-run: register_services forced to fail, but prior steps are skip (not pass).
    No pass steps to undo → rollback is None.
    """
    manifest_path = hermetic_install

    # Force register_services to fail
    monkeypatch.setattr(
        lifecycle_mod,
        "_install_register_services",
        lambda ctx: build_step_result("register_services", "fail", "simulated failure in dry_run"),
    )

    result = install(str(manifest_path), dry_run=True)

    # In dry_run mode, rollback never fires (per CONTEXT §Area 6)
    # The install orchestrator checks `if failed_step is not None and not dry_run`
    assert result.rollback is None, (
        f"Rollback should not fire in dry_run mode, got: {result.rollback}"
    )


def test_rollback_appends_partial_rollback_flag_when_undo_fails(hermetic_install, monkeypatch):
    """
    copy_skills fails → rollback fires; if rollback_copy_agents raises, partial_rollback=True.
    """
    manifest_path = hermetic_install

    # Force copy_skills to fail
    monkeypatch.setattr(
        lifecycle_mod,
        "_install_copy_skills",
        lambda ctx: build_step_result("copy_skills", "fail", "simulated copy_skills failure"),
    )

    # Force _rollback_copy_agents to raise
    def fail_rollback_copy_agents(ctx):
        raise RuntimeError("simulated rollback failure")

    monkeypatch.setattr(lifecycle_mod, "_rollback_copy_agents", fail_rollback_copy_agents)

    result = install(str(manifest_path))

    assert result.status == "fail"
    assert result.rollback is not None

    # At least one rollback entry should have status=fail with partial_rollback=True
    failing_rollbacks = [
        s for s in result.steps
        if s.name.startswith("rollback_") and s.status == "fail"
    ]
    assert len(failing_rollbacks) > 0, "Expected at least one failed rollback step"

    for rb in failing_rollbacks:
        assert rb.details is not None
        assert rb.details.get("partial_rollback") is True, (
            f"Expected partial_rollback=True in {rb.name}.details: {rb.details}"
        )

    assert result.rollback.get("partial_rollback") is True, (
        f"Expected rollback.partial_rollback=True, got: {result.rollback}"
    )


def test_rollback_step_names_use_rollback_prefix(hermetic_install, monkeypatch):
    """Every rollback entry starts with 'rollback_'; no non-rollback step has the prefix."""
    manifest_path = hermetic_install

    # Force copy_agents to fail (mid-install)
    monkeypatch.setattr(
        lifecycle_mod,
        "_install_copy_agents",
        lambda ctx: build_step_result("copy_agents", "fail", "simulated failure"),
    )

    result = install(str(manifest_path))

    assert result.status == "fail"

    rollback_entries = [s for s in result.steps if s.name.startswith(ROLLBACK_PREFIX)]
    non_rollback_entries = [s for s in result.steps if not s.name.startswith(ROLLBACK_PREFIX)]

    # Every rollback entry has the prefix (trivially true by filter, but validate count > 0)
    assert len(rollback_entries) > 0, "Expected at least one rollback entry"
    for rb in rollback_entries:
        assert rb.name.startswith(ROLLBACK_PREFIX)

    # No non-rollback forward step has the prefix
    for fwd in non_rollback_entries:
        assert not fwd.name.startswith(ROLLBACK_PREFIX), (
            f"Forward step {fwd.name} should not have rollback prefix"
        )


def test_rollback_post_install_verify_removes_install_record(tmp_path, monkeypatch):
    """
    Unit test: _rollback_post_install_verify calls delete_install_record with manifest name.
    Spy on delete_install_record to confirm it's called.
    """
    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(store, "SQLITE_FALLBACK_PATH", str(tmp_path / "module_installs.json"))

    # Create a fake manifest with a name attribute
    class FakeManifest:
        name = "fake-module"

    ctx = {"manifest": FakeManifest()}

    # Spy on delete_install_record
    deleted_names = []

    def spy_delete(module_name: str) -> bool:
        deleted_names.append(module_name)
        return True

    monkeypatch.setattr(store, "delete_install_record", spy_delete)

    # Also patch the import inside _rollback_post_install_verify
    import services.install_record_store as store_mod
    monkeypatch.setattr(store_mod, "delete_install_record", spy_delete)

    result = _rollback_post_install_verify(ctx)

    assert result.status == "pass"
    assert result.name == ROLLBACK_PREFIX + "post_install_verify"
    assert deleted_names == ["fake-module"], (
        f"Expected delete_install_record called with 'fake-module', got: {deleted_names}"
    )
