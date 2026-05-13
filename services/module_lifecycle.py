#!/usr/bin/env python3
"""
services/module_lifecycle.py — Phase 49 MOD-03 + MOD-04

Module lifecycle engine: install, uninstall, upgrade with idempotency,
dry-run preview, automatic rollback on partial failure, and expand-and-contract
migration preservation across upgrades.

Schema version contract: "1.0" (FROZEN — referenced by 49-02/49-03/49-04 tests).

Step name vocabulary (22 names total — FROZEN):

  install (7):
    validate_manifest, resolve_dependencies, apply_migrations,
    register_services, copy_agents, copy_skills, post_install_verify

  uninstall (7):
    read_install_record, remove_skills, remove_agents,
    unregister_services, revert_migrations, clear_install_record,
    post_uninstall_verify

  upgrade (8):
    validate_new_manifest, read_install_record, compute_migration_delta,
    apply_expand_migrations, swap_services, apply_contract_migrations,
    update_install_record, post_upgrade_verify

Worst-of-status combinator: fail > warn > pass > skip.
Mirrors bin/init.cjs L1065-1076 semantics (Phase 44).

Plan 49-01 ships the skeleton (constants + dataclasses + helpers + stub bodies).
Plans 49-02 and 49-03 replace the stub bodies with real logic.
"""

import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ─── Import-safety: yaml ─────────────────────────────────────────────────────

try:
    import yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False
    yaml = None  # type: ignore[assignment]

# ─── Logger ──────────────────────────────────────────────────────────────────

log = logging.getLogger("amauta.module_lifecycle")

# ─── Frozen module-level constants ───────────────────────────────────────────

SCHEMA_VERSION = "1.0"

STATUS_RANK: Dict[str, int] = {"skip": 0, "pass": 1, "warn": 2, "fail": 3}

INSTALL_STEPS: Tuple[str, ...] = (
    "validate_manifest",
    "resolve_dependencies",
    "apply_migrations",
    "register_services",
    "copy_agents",
    "copy_skills",
    "post_install_verify",
)

UNINSTALL_STEPS: Tuple[str, ...] = (
    "read_install_record",
    "remove_skills",
    "remove_agents",
    "unregister_services",
    "revert_migrations",
    "clear_install_record",
    "post_uninstall_verify",
)

UPGRADE_STEPS: Tuple[str, ...] = (
    "validate_new_manifest",
    "read_install_record",
    "compute_migration_delta",
    "apply_expand_migrations",
    "swap_services",
    "apply_contract_migrations",
    "update_install_record",
    "post_upgrade_verify",
)

ROLLBACK_PREFIX = "rollback_"

EXIT_OK = 0
EXIT_LIFECYCLE_FAIL = 1
EXIT_IO_OR_PARTIAL_ROLLBACK = 2

SQLITE_FALLBACK_PATH = os.path.expanduser("~/.amauta/data/module_installs.json")

# ─── StepResult dataclass ─────────────────────────────────────────────────────


@dataclass
class StepResult:
    """Per-step result entry in LifecycleResult.steps[]."""

    name: str
    status: str  # "pass" | "fail" | "skip" | "warn"
    message: str
    duration_ms: int = 0
    details: Optional[Dict[str, Any]] = None


# ─── LifecycleResult dataclass ────────────────────────────────────────────────


@dataclass
class LifecycleResult:
    """
    Structured result for an install / uninstall / upgrade operation.

    JSON shape (FROZEN — CONTEXT.md §Area 2):
      schema_version, operation, module, module_version,
      status, steps, rollback, dry_run
    """

    schema_version: str
    operation: str        # "install" | "uninstall" | "upgrade"
    module: str
    module_version: str
    status: str           # worst-of all steps: "pass" | "fail" | "skip" | "warn"
    steps: List[StepResult] = field(default_factory=list)
    rollback: Optional[Dict[str, Any]] = None
    dry_run: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Hand-built serialization to control nested dataclass output."""
        return {
            "schema_version": self.schema_version,
            "operation": self.operation,
            "module": self.module,
            "module_version": self.module_version,
            "status": self.status,
            "steps": [asdict(s) for s in self.steps],
            "rollback": self.rollback,
            "dry_run": self.dry_run,
        }


# ─── Helper functions ─────────────────────────────────────────────────────────


def build_step_result(
    name: str,
    status: str,
    message: str,
    duration_ms: int = 0,
    details: Optional[Dict[str, Any]] = None,
) -> StepResult:
    """
    Build a StepResult with validation.

    Mirrors bin/init.cjs buildStepResult (Phase 44, L217).
    Raises ValueError if status is not one of {"pass","fail","skip","warn"}.
    """
    valid_statuses = {"pass", "fail", "skip", "warn"}
    if status not in valid_statuses:
        raise ValueError(
            f"Invalid step status {status!r}; must be one of {sorted(valid_statuses)}"
        )
    return StepResult(
        name=name,
        status=status,
        message=message,
        duration_ms=duration_ms,
        details=details,
    )


def worst_of_status(statuses: List[str]) -> str:
    """
    Return the worst status across a list of step statuses.

    Ranking: fail > warn > pass > skip.
    Returns "skip" if the list is empty OR every entry is "skip".
    Mirrors bin/init.cjs L1065-1076 worst-of combinator (Phase 44).
    """
    if not statuses:
        return "skip"
    best_rank = 0
    best_status = "skip"
    for s in statuses:
        rank = STATUS_RANK.get(s, 0)
        if rank > best_rank:
            best_rank = rank
            best_status = s
    return best_status


def compute_manifest_hash(yaml_text: str) -> str:
    """
    SHA-256 of canonicalized YAML.

    Canonicalization: yaml.safe_dump(yaml.safe_load(content), sort_keys=True).
    Produces a 64-character lowercase hex string matching CHAR(64) column type.
    Stable across YAML key reordering (sort_keys=True).

    Raises RuntimeError if PyYAML is not installed.
    """
    if not _HAS_YAML:
        raise RuntimeError("compute_manifest_hash requires PyYAML (pip install pyyaml)")
    parsed = yaml.safe_load(yaml_text)
    canonical = yaml.safe_dump(parsed, sort_keys=True).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


# ─── Stub lifecycle functions (bodies filled in 49-02 / 49-03) ───────────────


def install(
    manifest_path: str,
    *,
    dry_run: bool = False,
    force: bool = False,
    json_output: bool = False,
) -> LifecycleResult:
    """
    Install a module from the given manifest YAML path.

    STUB — Plan 49-01 skeleton only. Plan 49-02 replaces this body
    with real install logic: validate_manifest, resolve_dependencies,
    apply_migrations, register_services, copy_agents, copy_skills,
    post_install_verify.

    Returns a skip result until 49-02 is applied.
    """
    return LifecycleResult(
        schema_version=SCHEMA_VERSION,
        operation="install",
        module="<unimplemented>",
        module_version="<unimplemented>",
        status="skip",
        steps=[],
        rollback=None,
        dry_run=dry_run,
    )


def uninstall(
    module_name: str,
    *,
    dry_run: bool = False,
    json_output: bool = False,
) -> LifecycleResult:
    """
    Uninstall the named module.

    STUB — Plan 49-01 skeleton only. Plan 49-02 replaces this body
    with real uninstall logic: read_install_record, remove_skills,
    remove_agents, unregister_services, revert_migrations,
    clear_install_record, post_uninstall_verify.

    Returns a skip result until 49-02 is applied.
    """
    return LifecycleResult(
        schema_version=SCHEMA_VERSION,
        operation="uninstall",
        module="<unimplemented>",
        module_version="<unimplemented>",
        status="skip",
        steps=[],
        rollback=None,
        dry_run=dry_run,
    )


def upgrade(
    new_manifest_path: str,
    *,
    dry_run: bool = False,
    force: bool = False,
    json_output: bool = False,
) -> LifecycleResult:
    """
    Upgrade a module using the given new manifest YAML path.

    STUB — Plan 49-01 skeleton only. Plan 49-03 replaces this body
    with real upgrade logic: validate_new_manifest, read_install_record,
    compute_migration_delta, apply_expand_migrations, swap_services,
    apply_contract_migrations, update_install_record, post_upgrade_verify.

    Returns a skip result until 49-03 is applied.
    """
    return LifecycleResult(
        schema_version=SCHEMA_VERSION,
        operation="upgrade",
        module="<unimplemented>",
        module_version="<unimplemented>",
        status="skip",
        steps=[],
        rollback=None,
        dry_run=dry_run,
    )
