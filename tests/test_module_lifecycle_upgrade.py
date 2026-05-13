#!/usr/bin/env python3
"""
tests/test_module_lifecycle_upgrade.py — Phase 49 MOD-03/MOD-04

Tests for services/module_lifecycle.upgrade() — 8-step expand-and-contract
orchestrator.

All tests use monkeypatch to force GSD_INSTALL_RECORD_BACKEND=sqlite and
point SQLITE_FALLBACK_PATH at a tmp_path file, so no real PG or real
~/.amauta/ is touched.

SC3 expand-and-contract preserves user data: expand migration (additive) runs
BEFORE swap_services; contract migration (destructive) runs AFTER swap_services.
The upgrade orchestrator preserves install_record.installed_at from v1.

SC4 rollback: swap_services fail → rollback_apply_expand_migrations runs;
contract migration fail → partial_rollback=True (contract not reversible).

MOD-03 idempotency: same manifest_hash + no force → read_install_record returns
skip, overall=skip, no mutation.

MOD-04 reproducibility: manifest_hash deterministic; idempotency probe locks it.
"""

import copy
import json
import os
import shutil

import pytest
from pathlib import Path

from services.module_lifecycle import (
    UPGRADE_STEPS,
    SCHEMA_VERSION,
    compute_manifest_hash,
    install,
    upgrade,
)
import services.install_record_store as store
import services.module_lifecycle as lifecycle_module


# ─── Fixture helpers ──────────────────────────────────────────────────────────


FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "modules"


@pytest.fixture
def hermetic_install(tmp_path, monkeypatch):
    """
    Set up a hermetic install environment with the v1 lifecycle-test fixture.
    Yields the v1 manifest_path (Path).
    """
    src_root = FIXTURE_ROOT / "lifecycle-test"
    dst_root = tmp_path / "lifecycle-test"
    shutil.copytree(str(src_root), str(dst_root))

    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(store, "SQLITE_FALLBACK_PATH", str(tmp_path / "module_installs.json"))

    monkeypatch.chdir(tmp_path)

    (tmp_path / "agents").mkdir(exist_ok=True)
    (tmp_path / "get-shit-done" / "skills").mkdir(parents=True, exist_ok=True)

    yield dst_root / "module.yaml"


@pytest.fixture
def hermetic_upgrade(tmp_path, monkeypatch):
    """
    Set up a hermetic upgrade environment:
    1. Copy both v1 (lifecycle-test) and v2 (lifecycle-test-v2) fixtures into tmp tree.
    2. Force SQLite backend.
    3. chdir to tmp_path.
    4. Pre-install v1 so v2 upgrade has a target.
    Yields (v1_manifest_path, v2_manifest_path).
    """
    # Copy v1 fixture
    src_v1 = FIXTURE_ROOT / "lifecycle-test"
    dst_v1 = tmp_path / "lifecycle-test"
    shutil.copytree(str(src_v1), str(dst_v1))

    # Copy v2 fixture
    src_v2 = FIXTURE_ROOT / "lifecycle-test-v2"
    dst_v2 = tmp_path / "lifecycle-test-v2"
    shutil.copytree(str(src_v2), str(dst_v2))

    # Force SQLite backend
    monkeypatch.setenv("GSD_INSTALL_RECORD_BACKEND", "sqlite")
    monkeypatch.setattr(store, "SQLITE_FALLBACK_PATH", str(tmp_path / "module_installs.json"))

    monkeypatch.chdir(tmp_path)

    # Ensure destination dirs exist
    (tmp_path / "agents").mkdir(exist_ok=True)
    (tmp_path / "get-shit-done" / "skills").mkdir(parents=True, exist_ok=True)

    # Pre-install v1
    v1_manifest = dst_v1 / "module.yaml"
    result = install(str(v1_manifest))
    assert result.status == "pass", (
        f"Pre-install v1 failed: {result.status} | {[s.message for s in result.steps]}"
    )

    v2_manifest = dst_v2 / "module.yaml"
    yield v1_manifest, v2_manifest


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_upgrade_pass_path_writes_record(hermetic_upgrade):
    """Full pass path: all 8 steps, record updated to v0.2.0, installed_at preserved."""
    v1_manifest, v2_manifest = hermetic_upgrade

    # Snapshot pre-upgrade installed_at from v1
    v1_record = store.get_install_record("lifecycle-test")
    assert v1_record is not None
    v1_installed_at = v1_record["installed_at"]

    result = upgrade(str(v2_manifest))

    assert result.status == "pass", (
        f"Expected pass, got {result.status}: {[s.message for s in result.steps]}"
    )
    assert result.operation == "upgrade"
    assert result.module == "lifecycle-test"
    assert result.module_version == "0.2.0"
    assert result.schema_version == SCHEMA_VERSION

    # Exactly 8 steps
    assert len(result.steps) == 8

    # Step names match UPGRADE_STEPS in order
    step_names = [s.name for s in result.steps]
    assert step_names == list(UPGRADE_STEPS), f"Step names mismatch: {step_names}"

    # Reload install record
    record = store.get_install_record("lifecycle-test")
    assert record is not None
    assert record["version"] == "0.2.0"

    # manifest_hash matches v2
    yaml_text = v2_manifest.read_text(encoding="utf-8")
    expected_hash = compute_manifest_hash(yaml_text)
    assert record["manifest_hash"] == expected_hash

    # upgraded_at is set
    assert record.get("upgraded_at") is not None

    # installed_at is preserved from v1 (SC3 data preservation)
    assert record["installed_at"] == v1_installed_at


def test_upgrade_idempotent_skip_on_matching_hash(hermetic_upgrade):
    """Second upgrade with same manifest → overall skip, read_install_record skip with matching_hash msg."""
    v1_manifest, v2_manifest = hermetic_upgrade

    # First upgrade
    result1 = upgrade(str(v2_manifest))
    assert result1.status == "pass"

    # Second upgrade — same manifest_hash
    result2 = upgrade(str(v2_manifest))
    assert result2.status == "skip", (
        f"Expected skip on second upgrade, got {result2.status}"
    )

    step_map = {s.name: s for s in result2.steps}
    read_step = step_map.get("read_install_record")
    assert read_step is not None
    assert read_step.status == "skip"
    assert "matching manifest_hash" in read_step.message.lower(), (
        f"Unexpected message: {read_step.message}"
    )


def test_upgrade_to_same_version_force_runs_full_orchestrator(hermetic_upgrade):
    """force=True after v2 upgrade re-runs all 8 steps as pass (not skip)."""
    v1_manifest, v2_manifest = hermetic_upgrade

    # First upgrade
    result1 = upgrade(str(v2_manifest))
    assert result1.status == "pass"

    # Force re-run
    result2 = upgrade(str(v2_manifest), force=True)
    assert result2.status == "pass", (
        f"Expected pass with force=True, got {result2.status}"
    )

    # All 8 steps should be pass (not skip); skip only on dry_run or idempotent
    for step in result2.steps:
        assert step.status == "pass", (
            f"Step {step.name} expected pass with force=True, got {step.status}: {step.message}"
        )


def test_upgrade_dry_run_preserves_record(hermetic_upgrade):
    """dry_run=True: state-modifying steps skip with would_apply; record stays at v0.1.0."""
    v1_manifest, v2_manifest = hermetic_upgrade

    result = upgrade(str(v2_manifest), dry_run=True)
    assert result.dry_run is True

    # State-modifying steps should be skip with would_apply details
    state_modifying = {
        "apply_expand_migrations",
        "swap_services",
        "apply_contract_migrations",
        "update_install_record",
    }
    step_map = {s.name: s for s in result.steps}

    for step_name in state_modifying:
        step = step_map.get(step_name)
        assert step is not None, f"Step {step_name} not in result.steps"
        assert step.status == "skip", (
            f"Step {step_name} expected skip in dry_run, got {step.status}"
        )
        assert step.details is not None, f"Step {step_name} missing details"
        assert "would_apply" in step.details, (
            f"Step {step_name} missing would_apply in details"
        )

    # Install record unchanged — still v0.1.0
    record = store.get_install_record("lifecycle-test")
    assert record is not None
    assert record["version"] == "0.1.0", (
        f"dry_run should not mutate record; got version={record['version']}"
    )


def test_upgrade_runs_expand_before_swap_before_contract(hermetic_upgrade):
    """Ordering: apply_expand_migrations < swap_services < apply_contract_migrations."""
    v1_manifest, v2_manifest = hermetic_upgrade

    result = upgrade(str(v2_manifest))
    assert result.status == "pass"

    step_names = [s.name for s in result.steps]
    idx_expand = step_names.index("apply_expand_migrations")
    idx_swap = step_names.index("swap_services")
    idx_contract = step_names.index("apply_contract_migrations")

    assert idx_expand < idx_swap < idx_contract, (
        f"Ordering violated: expand={idx_expand}, swap={idx_swap}, contract={idx_contract}"
    )


def test_upgrade_compute_delta_step_returns_correct_partition(hermetic_upgrade):
    """compute_migration_delta step details show correct expand/contract split for v2 manifest."""
    v1_manifest, v2_manifest = hermetic_upgrade

    result = upgrade(str(v2_manifest))
    assert result.status == "pass"

    step_map = {s.name: s for s in result.steps}
    delta_step = step_map.get("compute_migration_delta")
    assert delta_step is not None
    assert delta_step.details is not None

    # v2 manifest has: migrations/001-add-column-expand.sql (expand) + migrations/001-add-column-contract.sql (contract)
    assert delta_step.details.get("expand") == ["migrations/001-add-column-expand.sql"], (
        f"Unexpected expand: {delta_step.details.get('expand')}"
    )
    assert delta_step.details.get("contract") == ["migrations/001-add-column-contract.sql"], (
        f"Unexpected contract: {delta_step.details.get('contract')}"
    )
    assert delta_step.details.get("already_applied_skipped") == [], (
        f"Unexpected skipped: {delta_step.details.get('already_applied_skipped')}"
    )


def test_upgrade_swap_services_records_added_removed_diff(hermetic_upgrade, tmp_path, monkeypatch):
    """swap_services details reflect added/removed service diff."""
    v1_manifest, v2_manifest = hermetic_upgrade

    # v1 and v2 both have test-service → no diff
    result = upgrade(str(v2_manifest))
    assert result.status == "pass"

    step_map = {s.name: s for s in result.steps}
    swap_step = step_map.get("swap_services")
    assert swap_step is not None
    assert swap_step.details is not None
    assert swap_step.details.get("added") == []
    assert swap_step.details.get("removed") == []

    # Parametrized case: v2-prime manifest with extra service
    v2_prime_text = v2_manifest.read_text(encoding="utf-8")
    # Modify services inline via text replacement
    v2_prime_text_modified = v2_prime_text.replace(
        "services:\n  test-service: {}",
        "services:\n  test-service: {}\n  test-service-2: {}"
    )
    v2_prime_path = tmp_path / "lifecycle-test-v2-prime" / "module.yaml"
    v2_prime_path.parent.mkdir(parents=True, exist_ok=True)
    # Also copy migrations + agents + skills so the manifest resolves relative paths
    shutil.copytree(
        str(v2_manifest.parent),
        str(v2_prime_path.parent),
        dirs_exist_ok=True,
    )
    v2_prime_path.write_text(v2_prime_text_modified, encoding="utf-8")

    # Run upgrade to v2 (already at v2 from above), then again to v2-prime with force
    result_prime = upgrade(str(v2_prime_path), force=True)
    assert result_prime.status == "pass", (
        f"v2-prime upgrade failed: {result_prime.status}: "
        f"{[s.message for s in result_prime.steps]}"
    )

    step_map_prime = {s.name: s for s in result_prime.steps}
    swap_step_prime = step_map_prime.get("swap_services")
    assert swap_step_prime is not None
    assert swap_step_prime.details is not None
    assert "test-service-2" in swap_step_prime.details.get("added", []), (
        f"Expected test-service-2 in added: {swap_step_prime.details}"
    )


def test_upgrade_target_module_not_installed_returns_fail(hermetic_install, tmp_path, monkeypatch):
    """Upgrade when module not installed → read_install_record fail, message contains 'not installed'."""
    # hermetic_install does NOT pre-install v1 — just sets up the env
    # Copy v2 fixture into tmp tree
    src_v2 = FIXTURE_ROOT / "lifecycle-test-v2"
    dst_v2 = tmp_path / "lifecycle-test-v2"
    if not dst_v2.exists():
        shutil.copytree(str(src_v2), str(dst_v2))

    v2_manifest = dst_v2 / "module.yaml"
    result = upgrade(str(v2_manifest))

    assert result.status == "fail", (
        f"Expected fail for uninstalled module, got {result.status}"
    )

    step_map = {s.name: s for s in result.steps}
    read_step = step_map.get("read_install_record")
    assert read_step is not None
    assert read_step.status == "fail"
    assert "not installed" in read_step.message.lower(), (
        f"Expected 'not installed' in message: {read_step.message}"
    )


def test_upgrade_swap_services_fail_triggers_rollback(hermetic_upgrade, monkeypatch):
    """swap_services fail → rollback triggered; rollback_apply_expand_migrations present."""
    v1_manifest, v2_manifest = hermetic_upgrade

    # Monkeypatch _upgrade_swap_services to return fail
    original_swap = lifecycle_module._upgrade_swap_services

    def failing_swap(ctx):
        from services.module_lifecycle import build_step_result
        return build_step_result("swap_services", "fail", "simulated swap failure")

    monkeypatch.setattr(lifecycle_module, "_upgrade_swap_services", failing_swap)

    result = upgrade(str(v2_manifest))

    assert result.status == "fail", f"Expected fail, got {result.status}"
    assert result.rollback is not None, "Expected rollback info"
    assert result.rollback["triggered_by_step"] == "swap_services"

    # rollback_apply_expand_migrations should appear in undo_actions
    undo_actions = result.rollback.get("undo_actions", [])
    assert "rollback_apply_expand_migrations" in undo_actions, (
        f"rollback_apply_expand_migrations not in undo_actions: {undo_actions}"
    )

    # Find the rollback step entry in steps
    rollback_steps = [
        s for s in result.steps if s.name == "rollback_apply_expand_migrations"
    ]
    assert len(rollback_steps) >= 1, (
        "Expected at least one rollback_apply_expand_migrations step entry"
    )


def test_upgrade_contract_migration_fail_marks_partial_rollback(hermetic_upgrade, monkeypatch):
    """contract_migrations fail → partial_rollback=True; rollback_apply_contract_migrations is skip."""
    v1_manifest, v2_manifest = hermetic_upgrade

    # Monkeypatch _upgrade_apply_contract_migrations to return fail
    original_contract = lifecycle_module._upgrade_apply_contract_migrations

    def failing_contract(ctx):
        from services.module_lifecycle import build_step_result
        return build_step_result(
            "apply_contract_migrations", "fail",
            "simulated contract migration failure"
        )

    monkeypatch.setattr(
        lifecycle_module, "_upgrade_apply_contract_migrations", failing_contract
    )

    result = upgrade(str(v2_manifest))

    assert result.status == "fail", f"Expected fail, got {result.status}"
    assert result.rollback is not None, "Expected rollback info"

    # partial_rollback should be True
    assert result.rollback.get("partial_rollback") is True, (
        f"Expected partial_rollback=True; rollback={result.rollback}"
    )

    # Find rollback_apply_contract_migrations entry
    contract_rollback_steps = [
        s for s in result.steps
        if s.name == "rollback_apply_contract_migrations"
    ]
    assert len(contract_rollback_steps) >= 1, (
        "Expected rollback_apply_contract_migrations step"
    )
    crb = contract_rollback_steps[0]
    assert crb.status == "skip", (
        f"Expected rollback_apply_contract_migrations status=skip, got {crb.status}"
    )
    assert crb.details is not None
    assert crb.details.get("partial_rollback") is True, (
        f"Expected partial_rollback=True in details: {crb.details}"
    )
