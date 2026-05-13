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
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
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


# ─── install() private step helpers ──────────────────────────────────────────


def _install_validate_manifest(ctx: Dict[str, Any]) -> StepResult:
    """Step 1: Read + validate manifest YAML; probe idempotency."""
    from services.install_record_store import get_install_record
    from services.module_schema import load_module_manifest

    manifest_path = ctx["manifest_path"]

    # Read raw YAML text
    try:
        with open(manifest_path, "r", encoding="utf-8") as fh:
            yaml_text = fh.read()
    except (FileNotFoundError, PermissionError) as exc:
        return build_step_result("validate_manifest", "fail", str(exc))

    ctx["manifest_yaml_text"] = yaml_text

    # Validate manifest structure
    try:
        manifest = load_module_manifest(manifest_path)
    except Exception as exc:
        return build_step_result(
            "validate_manifest", "fail",
            f"manifest validation failed: {exc}"
        )

    ctx["manifest"] = manifest

    # Compute hash
    try:
        manifest_hash = compute_manifest_hash(yaml_text)
    except Exception as exc:
        return build_step_result(
            "validate_manifest", "fail",
            f"manifest hash computation failed: {exc}"
        )

    ctx["manifest_hash"] = manifest_hash

    # Idempotency probe
    if not ctx["force"]:
        try:
            existing = get_install_record(manifest.name)
        except Exception:
            existing = None

        if existing and existing.get("manifest_hash") == manifest_hash:
            ctx["existing_record"] = existing
            return build_step_result(
                "validate_manifest", "skip",
                f"module {manifest.name}@{manifest.version} already installed (manifest_hash match)"
            )

    return build_step_result(
        "validate_manifest", "pass",
        f"manifest valid: {manifest.name}@{manifest.version}"
    )


def _install_resolve_dependencies(ctx: Dict[str, Any]) -> StepResult:
    """Step 2: Resolve module dependencies via module_resolver."""
    from services.module_resolver import resolve

    if ctx.get("existing_record") is not None:
        return build_step_result(
            "resolve_dependencies", "skip", "module already installed"
        )

    try:
        result = resolve([ctx["manifest"]])
    except Exception as exc:
        return build_step_result(
            "resolve_dependencies", "fail",
            f"resolver raised: {exc}"
        )

    if not result.get("ok", False):
        conflicts = result.get("conflicts", [])
        missing = result.get("missing", [])
        cycle = result.get("cycle")
        parts = []
        if conflicts:
            parts.append(f"conflicts: {conflicts}")
        if missing:
            parts.append(f"missing: {missing}")
        if cycle:
            parts.append(f"cycle: {cycle}")
        summary = "; ".join(parts) if parts else "resolution failed"
        return build_step_result(
            "resolve_dependencies", "fail",
            summary,
            details={"resolver": result}
        )

    return build_step_result(
        "resolve_dependencies", "pass",
        "dependencies resolved",
        details={"install_order": result.get("install_order")}
    )


def _install_apply_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Step 3: Apply migration SQL files."""
    if ctx.get("existing_record") is not None:
        return build_step_result("apply_migrations", "skip", "module already installed")

    manifest = ctx["manifest"]
    migrations = list(manifest.migrations) if manifest.migrations else []

    if ctx["dry_run"]:
        return build_step_result(
            "apply_migrations", "skip",
            f"dry_run: would apply {len(migrations)} migration(s)",
            details={"would_apply": migrations}
        )

    module_dir = ctx["module_dir"]

    for mig_rel_path in migrations:
        abs_path = os.path.join(module_dir, mig_rel_path)
        if not os.path.exists(abs_path):
            return build_step_result(
                "apply_migrations", "fail",
                f"migration file not found: {mig_rel_path}"
            )

        # Try to apply via PG; best-effort — fall back to recording on PG unavailable
        try:
            from services import pg_store
            conn = pg_store._get_conn()
            with open(abs_path, "r", encoding="utf-8") as fh:
                sql = fh.read()
            with conn:
                with conn.cursor() as cur:
                    cur.execute(sql)
            conn.close()
        except ImportError:
            # pg_store not available — record path without execution (SQLite-fallback)
            pass
        except Exception as exc:
            return build_step_result(
                "apply_migrations", "fail",
                f"migration {mig_rel_path} failed: {exc}"
            )

        ctx["applied_migrations"].append(mig_rel_path)

    return build_step_result(
        "apply_migrations", "pass",
        f"applied {len(ctx['applied_migrations'])} migration(s)",
        details={"applied": list(ctx["applied_migrations"])}
    )


def _install_register_services(ctx: Dict[str, Any]) -> StepResult:
    """Step 4: Register module services via filesystem stub."""
    if ctx.get("existing_record") is not None:
        return build_step_result("register_services", "skip", "module already installed")

    manifest = ctx["manifest"]
    # services may be a dict (pydantic) or list (raw)
    if isinstance(manifest.services, dict):
        service_names = list(manifest.services.keys())
    elif isinstance(manifest.services, list):
        service_names = list(manifest.services)
    else:
        service_names = []

    if ctx["dry_run"]:
        return build_step_result(
            "register_services", "skip",
            f"dry_run: would register {len(service_names)} service(s)",
            details={"would_apply": service_names}
        )

    if not service_names:
        return build_step_result(
            "register_services", "pass",
            "no services to register"
        )

    reg_dir = os.path.expanduser("~/.amauta/data/registered_services")
    try:
        os.makedirs(reg_dir, exist_ok=True)
        stub_path = os.path.join(reg_dir, f"{manifest.name}.json")
        with open(stub_path, "w", encoding="utf-8") as fh:
            json.dump({"module_name": manifest.name, "services": service_names}, fh, indent=2)
        ctx["registered_services"].extend(service_names)
    except (OSError, PermissionError) as exc:
        return build_step_result(
            "register_services", "fail",
            f"service registration failed: {exc}"
        )

    return build_step_result(
        "register_services", "pass",
        f"registered {len(ctx['registered_services'])} service(s)"
    )


def _install_copy_agents(ctx: Dict[str, Any]) -> StepResult:
    """Step 5: Copy agent files into agents/ directory."""
    if ctx.get("existing_record") is not None:
        return build_step_result("copy_agents", "skip", "module already installed")

    manifest = ctx["manifest"]
    agents = list(manifest.agents) if manifest.agents else []

    if ctx["dry_run"]:
        return build_step_result(
            "copy_agents", "skip",
            f"dry_run: would copy {len(agents)} agent(s)",
            details={"would_apply": agents}
        )

    module_dir = ctx["module_dir"]

    for agent_rel_path in agents:
        src = os.path.join(module_dir, agent_rel_path)
        dest = os.path.join("agents", os.path.basename(agent_rel_path))

        if os.path.exists(dest) and not ctx["force"]:
            return build_step_result(
                "copy_agents", "fail",
                f"agent destination exists: {dest}"
            )

        try:
            os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
            shutil.copy2(src, dest)
            ctx["installed_agents"].append(dest)
        except Exception as exc:
            return build_step_result(
                "copy_agents", "fail",
                f"failed to copy agent {agent_rel_path}: {exc}"
            )

    return build_step_result(
        "copy_agents", "pass",
        f"copied {len(ctx['installed_agents'])} agent(s)"
    )


def _install_copy_skills(ctx: Dict[str, Any]) -> StepResult:
    """Step 6: Copy skill files into get-shit-done/skills/ directory."""
    if ctx.get("existing_record") is not None:
        return build_step_result("copy_skills", "skip", "module already installed")

    manifest = ctx["manifest"]
    skills = list(manifest.skills) if manifest.skills else []

    if ctx["dry_run"]:
        return build_step_result(
            "copy_skills", "skip",
            f"dry_run: would copy {len(skills)} skill(s)",
            details={"would_apply": skills}
        )

    module_dir = ctx["module_dir"]

    for skill_rel_path in skills:
        src = os.path.join(module_dir, skill_rel_path)
        # Determine skill name from path
        # skill_rel_path is e.g. "skills/test-skill/SKILL.md"
        # skill name = parent directory of the SKILL.md file
        skill_name = os.path.basename(os.path.dirname(skill_rel_path))
        if not skill_name or skill_name == ".":
            skill_name = os.path.splitext(os.path.basename(skill_rel_path))[0]

        dest = os.path.join("get-shit-done", "skills", skill_name, "SKILL.md")

        if os.path.exists(dest) and not ctx["force"]:
            return build_step_result(
                "copy_skills", "fail",
                f"skill destination exists: {dest}"
            )

        try:
            os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
            shutil.copy2(src, dest)
            ctx["installed_skills"].append(dest)
        except Exception as exc:
            return build_step_result(
                "copy_skills", "fail",
                f"failed to copy skill {skill_rel_path}: {exc}"
            )

    return build_step_result(
        "copy_skills", "pass",
        f"copied {len(ctx['installed_skills'])} skill(s)"
    )


def _install_post_install_verify(ctx: Dict[str, Any]) -> StepResult:
    """Step 7: Confirm installed files exist; write install record."""
    from services.install_record_store import put_install_record

    if ctx["dry_run"]:
        return build_step_result(
            "post_install_verify", "skip",
            "dry_run: skipped verify",
            details={"reason": "dry_run"}
        )

    if ctx.get("existing_record") is not None:
        return build_step_result("post_install_verify", "skip", "module already installed")

    manifest = ctx["manifest"]

    # Verify all installed agents exist on disk
    missing: List[str] = []
    for agent_path in ctx["installed_agents"]:
        if not os.path.exists(agent_path):
            missing.append(agent_path)

    # Verify all installed skills exist on disk
    for skill_path in ctx["installed_skills"]:
        if not os.path.exists(skill_path):
            missing.append(skill_path)

    if missing:
        return build_step_result(
            "post_install_verify", "fail",
            f"post-install verification failed: missing files {missing}",
            details={"missing": missing}
        )

    # Write install record
    record = {
        "module_name": manifest.name,
        "version": manifest.version,
        "manifest_hash": ctx["manifest_hash"],
        "installed_at": datetime.now(timezone.utc).isoformat(),
        "upgraded_at": None,
        "applied_migrations": list(ctx["applied_migrations"]),
        "registered_services": list(ctx["registered_services"]),
        "installed_agents": list(ctx["installed_agents"]),
        "installed_skills": list(ctx["installed_skills"]),
    }
    try:
        put_install_record(record)
    except Exception as exc:
        return build_step_result(
            "post_install_verify", "fail",
            f"failed to write install record: {exc}"
        )

    return build_step_result(
        "post_install_verify", "pass",
        f"install record written for {manifest.name}@{manifest.version}"
    )


# ─── Rollback inverse helpers ─────────────────────────────────────────────────


def _rollback_apply_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Rollback: revert applied migrations in LIFO order via DOWN files."""
    applied = list(ctx.get("applied_migrations", []))
    module_dir = ctx.get("module_dir", "")

    reverted = []
    missing_down = []

    for mig_rel_path in reversed(applied):
        # Build DOWN file path: replace .sql suffix with -DOWN.sql
        if mig_rel_path.endswith(".sql"):
            down_rel = mig_rel_path[:-4] + "-DOWN.sql"
        else:
            down_rel = mig_rel_path + "-DOWN.sql"

        down_abs = os.path.join(module_dir, down_rel)

        if not os.path.exists(down_abs):
            missing_down.append(down_rel)
            continue

        try:
            from services import pg_store
            conn = pg_store._get_conn()
            with open(down_abs, "r", encoding="utf-8") as fh:
                sql = fh.read()
            with conn:
                with conn.cursor() as cur:
                    cur.execute(sql)
            conn.close()
            reverted.append(mig_rel_path)
        except ImportError:
            # PG unavailable — record as reverted (SQLite fallback)
            reverted.append(mig_rel_path)
        except Exception as exc:
            return build_step_result(
                ROLLBACK_PREFIX + "apply_migrations", "fail",
                f"rollback migration {mig_rel_path} failed: {exc}",
                details={"partial_rollback": True}
            )

    if missing_down:
        return build_step_result(
            ROLLBACK_PREFIX + "apply_migrations",
            "warn" if reverted else "pass",
            f"{len(reverted)} migration(s) reverted, {len(missing_down)} DOWN files missing",
            details={"reverted": reverted, "missing_down": missing_down}
        )

    return build_step_result(
        ROLLBACK_PREFIX + "apply_migrations",
        "pass",
        f"reverted {len(reverted)} migration(s)",
        details={"reverted": reverted}
    )


def _rollback_register_services(ctx: Dict[str, Any]) -> StepResult:
    """Rollback: remove registered_services stub file."""
    manifest = ctx.get("manifest")
    if not manifest:
        return build_step_result(
            ROLLBACK_PREFIX + "register_services", "skip",
            "no manifest in context — skipping service deregistration"
        )

    stub_path = os.path.expanduser(
        f"~/.amauta/data/registered_services/{manifest.name}.json"
    )
    try:
        if os.path.exists(stub_path):
            os.remove(stub_path)
    except OSError:
        pass  # missing file is tolerated — goal state is achieved

    return build_step_result(
        ROLLBACK_PREFIX + "register_services", "pass",
        "registered_services stub removed (or was already absent)"
    )


def _rollback_copy_agents(ctx: Dict[str, Any]) -> StepResult:
    """Rollback: remove installed agent files."""
    installed_agents = list(ctx.get("installed_agents", []))
    removed = []
    errors = []

    for agent_path in installed_agents:
        try:
            if os.path.exists(agent_path):
                os.remove(agent_path)
            removed.append(agent_path)
        except OSError as exc:
            errors.append(f"{agent_path}: {exc}")

    if errors:
        return build_step_result(
            ROLLBACK_PREFIX + "copy_agents", "fail",
            f"failed to remove {len(errors)} agent(s): {errors}",
            details={"partial_rollback": True, "errors": errors}
        )

    return build_step_result(
        ROLLBACK_PREFIX + "copy_agents", "pass",
        f"removed {len(removed)} agent(s)"
    )


def _rollback_copy_skills(ctx: Dict[str, Any]) -> StepResult:
    """Rollback: remove installed skill files and prune empty parent dirs."""
    installed_skills = list(ctx.get("installed_skills", []))
    removed = []
    errors = []

    for skill_path in installed_skills:
        try:
            if os.path.exists(skill_path):
                os.remove(skill_path)
            removed.append(skill_path)
            # Prune empty parent directory
            parent = os.path.dirname(skill_path)
            if os.path.isdir(parent) and not os.listdir(parent):
                os.rmdir(parent)
        except OSError as exc:
            errors.append(f"{skill_path}: {exc}")

    if errors:
        return build_step_result(
            ROLLBACK_PREFIX + "copy_skills", "fail",
            f"failed to remove {len(errors)} skill(s): {errors}",
            details={"partial_rollback": True, "errors": errors}
        )

    return build_step_result(
        ROLLBACK_PREFIX + "copy_skills", "pass",
        f"removed {len(removed)} skill(s)"
    )


def _rollback_post_install_verify(ctx: Dict[str, Any]) -> StepResult:
    """Rollback: delete install record (post_install_verify wrote it)."""
    from services.install_record_store import delete_install_record

    if ctx.get("manifest"):
        delete_install_record(ctx["manifest"].name)

    return build_step_result(
        ROLLBACK_PREFIX + "post_install_verify",
        "pass",
        "install record removed",
        duration_ms=0,
        details=None,
    )


# ─── Shared SQL helper ────────────────────────────────────────────────────────


def _apply_sql_file(
    ctx: Dict[str, Any],
    rel_path: str,
    *,
    raise_on_missing: bool = False,
) -> None:
    """Apply a single SQL file via pg_store._get_conn().

    On PG unavailable: log a warning and return (best-effort) — does
    NOT raise. On PG present but SQL exec fails: raises the exception
    (caller wraps in StepResult).

    Args:
        ctx: install/upgrade context (carries module_dir).
        rel_path: migration path relative to module_dir.
        raise_on_missing: if True, FileNotFoundError raised; else missing
            files become a no-op log.

    Raises:
        FileNotFoundError (only if raise_on_missing=True).
        psycopg2.Error / generic Exception on PG SQL failure.
    """
    abs_path = os.path.join(ctx["module_dir"], rel_path)
    if not os.path.isfile(abs_path):
        if raise_on_missing:
            raise FileNotFoundError(abs_path)
        log.warning("migration file missing: %s", abs_path)
        return
    with open(abs_path, "r", encoding="utf-8") as f:
        sql_text = f.read()
    try:
        from services.pg_store import _get_conn
        conn = _get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql_text)
            conn.commit()
        finally:
            conn.close()
    except ImportError:
        # PG client unavailable — best-effort no-op (Phase 44 fallback)
        log.warning(
            "pg_store unavailable; recording migration without execution: %s",
            rel_path,
        )
    except Exception:
        raise


# ─── compute_migration_delta helper ──────────────────────────────────────────


def compute_migration_delta(
    new_migrations: List[str],
    applied_migrations: List[str],
) -> Dict[str, List[str]]:
    """Compute expand and contract migration lists from manifest delta.

    Frozen suffix conventions (Phase 49 / Phase 36 inheritance):
        - "<name>-expand.sql"   -> additive (run BEFORE service swap)
        - "<name>-contract.sql" -> destructive (run AFTER service swap)
        - "<name>.sql" (plain)  -> treated as expand by default

    Args:
        new_migrations: manifest.migrations from the upgrade target.
        applied_migrations: install_record.applied_migrations from the
            current install (already-applied set).

    Returns:
        {
            "expand_migrations": list[str],     # to apply, in declared order
            "contract_migrations": list[str],   # to apply, in declared order
            "already_applied_skipped": list[str],  # set intersection
        }
    """
    applied_set = set(applied_migrations)
    expand_list: List[str] = []
    contract_list: List[str] = []
    skipped: List[str] = []
    for mig in new_migrations:
        if mig in applied_set:
            skipped.append(mig)
            continue
        if mig.endswith("-contract.sql"):
            contract_list.append(mig)
        else:
            # both -expand.sql AND plain .sql go to expand bucket
            expand_list.append(mig)
    return {
        "expand_migrations": expand_list,
        "contract_migrations": contract_list,
        "already_applied_skipped": skipped,
    }


# ─── Upgrade-side inverse-op helpers ─────────────────────────────────────────


def _rollback_apply_expand_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Reverse expand migrations using matching -DOWN.sql files in REVERSE order.

    Mirrors _rollback_apply_migrations semantics.
    """
    ran: List[str] = []
    missing_down: List[str] = []
    applied = ctx.get("expand_applied", [])
    for mig_rel in reversed(applied):
        # Convert "001-add-column-expand.sql" -> "001-add-column-expand-DOWN.sql"
        down = mig_rel.replace(".sql", "-DOWN.sql")
        try:
            _apply_sql_file(ctx, down, raise_on_missing=True)
            ran.append(down)
        except FileNotFoundError:
            missing_down.append(down)
    if missing_down:
        return build_step_result(
            ROLLBACK_PREFIX + "apply_expand_migrations",
            "warn",
            f"{len(ran)} reverted; {len(missing_down)} DOWN missing",
            details={"reverted": ran, "missing_down": missing_down},
        )
    return build_step_result(
        ROLLBACK_PREFIX + "apply_expand_migrations",
        "pass",
        f"reverted {len(ran)} expand migration(s)",
        details={"reverted": ran},
    )


def _rollback_swap_services(ctx: Dict[str, Any]) -> StepResult:
    """Restore previous service list from pre_upgrade_record."""
    prev = (ctx.get("pre_upgrade_record") or {}).get("registered_services", [])
    manifest = ctx.get("manifest") or ctx.get("new_manifest")
    if manifest is None:
        return build_step_result(
            ROLLBACK_PREFIX + "swap_services",
            "warn",
            "no manifest in context — cannot restore services",
            details={"partial_rollback": True},
        )
    path = os.path.expanduser(
        f"~/.amauta/data/registered_services/{manifest.name}.json"
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"services": list(prev)}, f)
    return build_step_result(
        ROLLBACK_PREFIX + "swap_services",
        "pass",
        f"restored {len(prev)} previous service(s)",
        details={"restored": list(prev)},
    )


def _rollback_apply_contract_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Contract migrations are destructive; rollback is NOT available.

    Emits status="skip" with partial_rollback=True so the overall
    result inherits the failure exit code (2 — partial rollback).
    """
    return build_step_result(
        ROLLBACK_PREFIX + "apply_contract_migrations",
        "skip",
        "contract migrations are not reversible; operator action required",
        details={"partial_rollback": True},
    )


def _rollback_update_install_record(ctx: Dict[str, Any]) -> StepResult:
    """Restore the previous install record (pre-upgrade snapshot)."""
    from services.install_record_store import put_install_record
    prev = ctx.get("pre_upgrade_record")
    if prev is None:
        return build_step_result(
            ROLLBACK_PREFIX + "update_install_record",
            "warn",
            "no pre-upgrade record snapshot available",
            details={"partial_rollback": True},
        )
    put_install_record(prev)
    return build_step_result(
        ROLLBACK_PREFIX + "update_install_record",
        "pass",
        f"restored install record for {prev.get('module_name')}@{prev.get('version')}",
        details={"restored_version": prev.get("version")},
    )


# ─── _run_rollback engine ─────────────────────────────────────────────────────


def _run_rollback(
    failed_step: str,
    results: List[StepResult],
    ctx: Dict[str, Any],
) -> Dict[str, Any]:
    """Run inverse of each preceding pass step in reverse order.

    Args:
        failed_step: name of the step that returned status="fail".
        results: forward-step list (mutated by appending rollback_* entries).
        ctx: install context with accumulated state (applied_migrations etc).

    Returns:
        {"triggered_by_step": failed_step, "undo_actions": list[str], "partial_rollback": bool}
    """
    # Steps that ran with status="pass" BEFORE the failure
    forward_pass_steps = [r.name for r in results if r.status == "pass"]

    # Frozen inverse mapping for state-changing install + upgrade steps.
    # validate_manifest + resolve_dependencies are read-only → not rolled back.
    INVERSE_OPS: Dict[str, Any] = {
        "apply_migrations": _rollback_apply_migrations,
        "register_services": _rollback_register_services,
        "copy_agents": _rollback_copy_agents,
        "copy_skills": _rollback_copy_skills,
        "post_install_verify": _rollback_post_install_verify,
        # Upgrade-side inverse helpers (Phase 49-03)
        "apply_expand_migrations": _rollback_apply_expand_migrations,
        "swap_services": _rollback_swap_services,
        "apply_contract_migrations": _rollback_apply_contract_migrations,
        "update_install_record": _rollback_update_install_record,
    }

    undo_actions: List[str] = []
    partial_rollback = False

    for step_name in reversed(forward_pass_steps):
        if step_name not in INVERSE_OPS:
            # No-op rollback for read-only steps; surface as skip.
            results.append(build_step_result(
                ROLLBACK_PREFIX + step_name,
                "skip",
                f"no inverse defined for {step_name} (read-only step)",
                duration_ms=0,
                details=None,
            ))
            continue

        t0 = time.time()
        try:
            rb = INVERSE_OPS[step_name](ctx)
        except Exception as exc:
            rb = build_step_result(
                ROLLBACK_PREFIX + step_name, "fail",
                f"rollback raised: {exc}",
                duration_ms=0,
                details={"partial_rollback": True}
            )
            partial_rollback = True

        rb.duration_ms = int((time.time() - t0) * 1000)

        # Re-stamp the name to ensure rollback_<step> prefix
        if not rb.name.startswith(ROLLBACK_PREFIX):
            rb = build_step_result(
                ROLLBACK_PREFIX + step_name,
                rb.status, rb.message,
                rb.duration_ms, rb.details
            )

        if rb.status == "fail":
            partial_rollback = True
            merged = dict(rb.details or {})
            merged["partial_rollback"] = True
            rb = build_step_result(
                rb.name, "fail", rb.message,
                rb.duration_ms, merged
            )

        # A rollback step may return skip with partial_rollback=True in details
        # (e.g. _rollback_apply_contract_migrations — contract not reversible).
        # Bubble up the partial_rollback flag to the rollback summary.
        if (rb.details or {}).get("partial_rollback"):
            partial_rollback = True

        results.append(rb)
        undo_actions.append(ROLLBACK_PREFIX + step_name)

    # Also run the rollback for the failed step itself if it has an INVERSE_OPS
    # entry. This surfaces signals like _rollback_apply_contract_migrations
    # (which returns skip + partial_rollback=True when a destructive migration
    # fails mid-execution — "contract not reversible; operator action required").
    if failed_step in INVERSE_OPS and (ROLLBACK_PREFIX + failed_step) not in undo_actions:
        t0 = time.time()
        try:
            rb_self = INVERSE_OPS[failed_step](ctx)
        except Exception as exc:
            rb_self = build_step_result(
                ROLLBACK_PREFIX + failed_step, "fail",
                f"rollback raised: {exc}",
                details={"partial_rollback": True},
            )
            partial_rollback = True
        rb_self.duration_ms = int((time.time() - t0) * 1000)
        if not rb_self.name.startswith(ROLLBACK_PREFIX):
            rb_self = build_step_result(
                ROLLBACK_PREFIX + failed_step,
                rb_self.status, rb_self.message,
                rb_self.duration_ms, rb_self.details,
            )
        if (rb_self.details or {}).get("partial_rollback"):
            partial_rollback = True
        if rb_self.status == "fail":
            partial_rollback = True
        results.append(rb_self)
        undo_actions.append(ROLLBACK_PREFIX + failed_step)

    return {
        "triggered_by_step": failed_step,
        "undo_actions": undo_actions,
        "partial_rollback": partial_rollback,
    }


# ─── install() orchestrator ───────────────────────────────────────────────────


def install(
    manifest_path: str,
    *,
    dry_run: bool = False,
    force: bool = False,
    json_output: bool = False,
) -> LifecycleResult:
    """
    Install a module from the given manifest YAML path.

    Implements the 7 frozen INSTALL_STEPS in order:
      validate_manifest → resolve_dependencies → apply_migrations →
      register_services → copy_agents → copy_skills → post_install_verify

    Idempotency: if module is already installed with same manifest_hash AND
    force=False, all steps return status="skip", overall status="skip".

    Rollback: if any step fails, inverse of prior pass steps runs in reverse.

    Dry-run: state-modifying steps return status="skip" with would_apply details.
    """
    ctx: Dict[str, Any] = {
        "manifest_path": manifest_path,
        "manifest_yaml_text": "",
        "manifest": None,
        "manifest_hash": "",
        "dry_run": dry_run,
        "force": force,
        "module_dir": os.path.dirname(os.path.abspath(manifest_path)),
        "applied_migrations": [],
        "registered_services": [],
        "installed_agents": [],
        "installed_skills": [],
        "existing_record": None,
    }

    steps_to_run = [
        ("validate_manifest", _install_validate_manifest),
        ("resolve_dependencies", _install_resolve_dependencies),
        ("apply_migrations", _install_apply_migrations),
        ("register_services", _install_register_services),
        ("copy_agents", _install_copy_agents),
        ("copy_skills", _install_copy_skills),
        ("post_install_verify", _install_post_install_verify),
    ]

    results: List[StepResult] = []
    failed_step = None

    for name, fn in steps_to_run:
        t0 = time.time()
        try:
            r = fn(ctx)
        except Exception as exc:
            r = build_step_result(name, "fail", f"unhandled exception: {exc}")
        r.duration_ms = int((time.time() - t0) * 1000)
        # Defensive: ensure step name matches expected
        if r.name != name:
            r = build_step_result(name, r.status, r.message, r.duration_ms, r.details)
        results.append(r)
        if r.status == "fail":
            failed_step = name
            break

    rollback_info = None
    if failed_step is not None and not dry_run:
        rollback_info = _run_rollback(failed_step, results, ctx)

    module_name = ctx["manifest"].name if ctx["manifest"] else "<unknown>"
    module_version = ctx["manifest"].version if ctx["manifest"] else "<unknown>"
    overall = worst_of_status([r.status for r in results])

    return LifecycleResult(
        schema_version=SCHEMA_VERSION,
        operation="install",
        module=module_name,
        module_version=module_version,
        status=overall,
        steps=results,
        rollback=rollback_info,
        dry_run=dry_run,
    )


# ─── uninstall() private step helpers ────────────────────────────────────────


def _uninstall_read_install_record(ctx: Dict[str, Any]) -> StepResult:
    """Step 1: Load install record; gate absent-module idempotency."""
    from services.install_record_store import get_install_record

    module_name = ctx["module_name"]
    try:
        record = get_install_record(module_name)
    except Exception as exc:
        return build_step_result(
            "read_install_record", "fail",
            f"failed to read install record: {exc}"
        )

    if record is None:
        ctx["absent"] = True
        return build_step_result(
            "read_install_record", "skip",
            f"module {module_name} is not installed"
        )

    ctx["record"] = record
    version = record.get("version", "<unknown>")
    return build_step_result(
        "read_install_record", "pass",
        f"loaded install record for {module_name}@{version}",
        details={"version": version}
    )


def _uninstall_remove_skills(ctx: Dict[str, Any]) -> StepResult:
    """Step 2: Remove installed skill files."""
    if ctx.get("absent"):
        return build_step_result("remove_skills", "skip", "module not installed")

    if ctx["dry_run"]:
        skill_paths = ctx["record"].get("installed_skills", [])
        return build_step_result(
            "remove_skills", "skip",
            "dry_run: would remove skills",
            details={"would_apply": skill_paths}
        )

    skill_paths = ctx["record"].get("installed_skills", [])
    for path in skill_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
            # Best-effort prune empty parent dir
            parent = os.path.dirname(path)
            if parent and os.path.isdir(parent) and not os.listdir(parent):
                os.rmdir(parent)
        except OSError:
            pass  # missing files tolerated

    return build_step_result(
        "remove_skills", "pass",
        f"removed {len(skill_paths)} skill file(s) (missing files tolerated)"
    )


def _uninstall_remove_agents(ctx: Dict[str, Any]) -> StepResult:
    """Step 3: Remove installed agent files."""
    if ctx.get("absent"):
        return build_step_result("remove_agents", "skip", "module not installed")

    if ctx["dry_run"]:
        agent_paths = ctx["record"].get("installed_agents", [])
        return build_step_result(
            "remove_agents", "skip",
            "dry_run: would remove agents",
            details={"would_apply": agent_paths}
        )

    agent_paths = ctx["record"].get("installed_agents", [])
    for path in agent_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass  # missing files tolerated

    return build_step_result(
        "remove_agents", "pass",
        f"removed {len(agent_paths)} agent file(s) (missing files tolerated)"
    )


def _uninstall_unregister_services(ctx: Dict[str, Any]) -> StepResult:
    """Step 4: Remove registered_services stub file."""
    if ctx.get("absent"):
        return build_step_result("unregister_services", "skip", "module not installed")

    if ctx["dry_run"]:
        return build_step_result(
            "unregister_services", "skip",
            "dry_run: would unregister services",
            details={"would_apply": ctx["record"].get("registered_services", [])}
        )

    module_name = ctx["module_name"]
    stub_path = os.path.expanduser(
        f"~/.amauta/data/registered_services/{module_name}.json"
    )
    try:
        if os.path.exists(stub_path):
            os.remove(stub_path)
    except OSError:
        pass  # missing stub is tolerated

    return build_step_result(
        "unregister_services", "pass",
        "registered_services stub removed (or was already absent)"
    )


def _uninstall_revert_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Step 5: Revert applied migrations in LIFO order via DOWN files."""
    if ctx.get("absent"):
        return build_step_result("revert_migrations", "skip", "module not installed")

    if ctx["dry_run"]:
        migrations = ctx["record"].get("applied_migrations", [])
        return build_step_result(
            "revert_migrations", "skip",
            "dry_run: would revert migrations",
            details={"would_apply": list(reversed(migrations))}
        )

    applied = ctx["record"].get("applied_migrations", [])
    reverted = []
    missing_down = []

    for mig_rel_path in reversed(applied):
        if mig_rel_path.endswith(".sql"):
            down_path = mig_rel_path[:-4] + "-DOWN.sql"
        else:
            down_path = mig_rel_path + "-DOWN.sql"

        if not os.path.exists(down_path):
            missing_down.append(down_path)
            continue

        try:
            from services import pg_store
            conn = pg_store._get_conn()
            with open(down_path, "r", encoding="utf-8") as fh:
                sql = fh.read()
            with conn:
                with conn.cursor() as cur:
                    cur.execute(sql)
            conn.close()
            reverted.append(mig_rel_path)
        except ImportError:
            reverted.append(mig_rel_path)
        except Exception as exc:
            return build_step_result(
                "revert_migrations", "fail",
                f"revert migration {mig_rel_path} failed: {exc}"
            )

    if missing_down:
        return build_step_result(
            "revert_migrations",
            "warn",
            f"{len(reverted)} migration(s) reverted, {len(missing_down)} DOWN files missing",
            details={"reverted": reverted, "missing_down": missing_down}
        )

    return build_step_result(
        "revert_migrations", "pass",
        f"reverted {len(reverted)} migration(s)",
        details={"reverted": reverted}
    )


def _uninstall_clear_install_record(ctx: Dict[str, Any]) -> StepResult:
    """Step 6: Delete the install record."""
    from services.install_record_store import delete_install_record

    if ctx.get("absent"):
        return build_step_result("clear_install_record", "skip", "module not installed")

    if ctx["dry_run"]:
        return build_step_result(
            "clear_install_record", "skip",
            "dry_run: would delete install record",
            details={"would_apply": f"delete record for {ctx['module_name']}"}
        )

    try:
        delete_install_record(ctx["module_name"])
    except Exception as exc:
        return build_step_result(
            "clear_install_record", "fail",
            f"failed to delete install record: {exc}"
        )

    return build_step_result(
        "clear_install_record", "pass",
        f"install record deleted for {ctx['module_name']}"
    )


def _uninstall_post_uninstall_verify(ctx: Dict[str, Any]) -> StepResult:
    """Step 7: Confirm all installed artifacts are gone."""
    from services.install_record_store import get_install_record

    if ctx.get("absent") or ctx["dry_run"]:
        return build_step_result("post_uninstall_verify", "skip", "skipped (absent or dry_run)")

    record = ctx["record"]
    module_name = ctx["module_name"]
    leftovers: List[str] = []

    # Check skill files are gone
    for path in record.get("installed_skills", []):
        if os.path.exists(path):
            leftovers.append(path)

    # Check agent files are gone
    for path in record.get("installed_agents", []):
        if os.path.exists(path):
            leftovers.append(path)

    # Check registered_services stub is gone
    stub_path = os.path.expanduser(
        f"~/.amauta/data/registered_services/{module_name}.json"
    )
    if os.path.exists(stub_path):
        leftovers.append(stub_path)

    # Check install record is gone
    try:
        remaining = get_install_record(module_name)
        if remaining is not None:
            leftovers.append(f"install_record:{module_name}")
    except Exception:
        pass

    if leftovers:
        return build_step_result(
            "post_uninstall_verify", "fail",
            f"uninstall verification failed: {len(leftovers)} artifact(s) still present",
            details={"leftovers": leftovers}
        )

    return build_step_result(
        "post_uninstall_verify", "pass",
        f"all artifacts for {module_name} confirmed removed"
    )


# ─── uninstall() orchestrator ─────────────────────────────────────────────────


def uninstall(
    module_name: str,
    *,
    dry_run: bool = False,
    json_output: bool = False,
) -> LifecycleResult:
    """
    Uninstall the named module.

    Implements the 7 frozen UNINSTALL_STEPS in order:
      read_install_record → remove_skills → remove_agents →
      unregister_services → revert_migrations → clear_install_record →
      post_uninstall_verify

    Idempotency: if module is absent, all steps return status="skip".
    No rollback on failure (uninstall failures surface to operator).
    """
    ctx: Dict[str, Any] = {
        "module_name": module_name,
        "dry_run": dry_run,
        "record": None,
        "absent": False,
    }

    steps_to_run = [
        ("read_install_record", _uninstall_read_install_record),
        ("remove_skills", _uninstall_remove_skills),
        ("remove_agents", _uninstall_remove_agents),
        ("unregister_services", _uninstall_unregister_services),
        ("revert_migrations", _uninstall_revert_migrations),
        ("clear_install_record", _uninstall_clear_install_record),
        ("post_uninstall_verify", _uninstall_post_uninstall_verify),
    ]

    results: List[StepResult] = []

    for name, fn in steps_to_run:
        t0 = time.time()
        try:
            r = fn(ctx)
        except Exception as exc:
            r = build_step_result(name, "fail", f"unhandled exception: {exc}")
        r.duration_ms = int((time.time() - t0) * 1000)
        if r.name != name:
            r = build_step_result(name, r.status, r.message, r.duration_ms, r.details)
        results.append(r)
        # uninstall does NOT rollback — failures surface to operator (per CONTEXT.md)
        if r.status == "fail":
            break  # stop forward progress; no auto-undo

    version = ctx["record"]["version"] if ctx["record"] else "<absent>"
    overall = worst_of_status([r.status for r in results])

    return LifecycleResult(
        schema_version=SCHEMA_VERSION,
        operation="uninstall",
        module=module_name,
        module_version=version,
        status=overall,
        steps=results,
        rollback=None,  # uninstall has no rollback per CONTEXT.md Area 6
        dry_run=dry_run,
    )


# ─── upgrade() private step helpers ──────────────────────────────────────────


def _upgrade_validate_new_manifest(ctx: Dict[str, Any]) -> StepResult:
    """Step 1: Read + validate new manifest YAML; compute hash; probe idempotency.

    Idempotency probe is done here (same as _install_validate_manifest) so that
    when the manifest_hash already matches the installed record, all 8 steps
    return skip and overall status is "skip".
    """
    from services.module_schema import load_module_manifest
    from services.install_record_store import get_install_record

    manifest_path = ctx["new_manifest_path"]
    try:
        with open(manifest_path, "r", encoding="utf-8") as fh:
            yaml_text = fh.read()
    except (FileNotFoundError, PermissionError) as exc:
        return build_step_result("validate_new_manifest", "fail", str(exc))

    ctx["new_manifest_yaml_text"] = yaml_text

    try:
        manifest = load_module_manifest(manifest_path)
    except Exception as exc:
        return build_step_result(
            "validate_new_manifest", "fail",
            f"manifest validation failed: {exc}"
        )

    ctx["new_manifest"] = manifest
    ctx["manifest"] = manifest  # alias for shared rollback engine

    try:
        manifest_hash = compute_manifest_hash(yaml_text)
    except Exception as exc:
        return build_step_result(
            "validate_new_manifest", "fail",
            f"manifest hash computation failed: {exc}"
        )

    ctx["new_manifest_hash"] = manifest_hash

    # Idempotency probe: peek at existing record; if hash already matches + no force → skip
    if not ctx["force"]:
        try:
            existing = get_install_record(manifest.name)
        except Exception:
            existing = None
        if existing and existing.get("manifest_hash") == manifest_hash:
            ctx["idempotent_skip"] = True
            return build_step_result(
                "validate_new_manifest", "skip",
                f"already at {existing['version']} with matching manifest_hash"
            )

    return build_step_result(
        "validate_new_manifest", "pass",
        f"manifest valid: {manifest.name}@{manifest.version}"
    )


def _upgrade_read_install_record(ctx: Dict[str, Any]) -> StepResult:
    """Step 2: Load existing install record; probe idempotency."""
    from services.install_record_store import get_install_record
    import copy

    manifest = ctx["new_manifest"]

    try:
        record = get_install_record(manifest.name)
    except Exception as exc:
        return build_step_result(
            "read_install_record", "fail",
            f"failed to read install record: {exc}"
        )

    if record is None:
        return build_step_result(
            "read_install_record", "fail",
            f"module {manifest.name} not installed; use install instead"
        )

    # Snapshot before mutation (for rollback)
    ctx["pre_upgrade_record"] = copy.deepcopy(record)

    # Idempotency probe: same manifest_hash + no force → all-skip
    if record.get("manifest_hash") == ctx["new_manifest_hash"] and not ctx["force"]:
        ctx["idempotent_skip"] = True
        return build_step_result(
            "read_install_record", "skip",
            f"already at {record['version']} with matching manifest_hash"
        )

    return build_step_result(
        "read_install_record", "pass",
        f"loaded install record for {manifest.name}@{record['version']}",
        details={
            "current_version": record["version"],
            "target_version": manifest.version,
        }
    )


def _upgrade_compute_migration_delta(ctx: Dict[str, Any]) -> StepResult:
    """Step 3: Compute expand and contract migration delta."""
    if ctx.get("idempotent_skip"):
        return build_step_result(
            "compute_migration_delta", "skip",
            "idempotent_skip: already at target version with matching manifest_hash"
        )

    manifest = ctx["new_manifest"]
    pre = ctx["pre_upgrade_record"]
    new_migrations = list(manifest.migrations) if manifest.migrations else []
    applied = list(pre.get("applied_migrations", []))

    delta = compute_migration_delta(new_migrations, applied)
    ctx["expand_migrations"] = delta["expand_migrations"]
    ctx["contract_migrations"] = delta["contract_migrations"]

    return build_step_result(
        "compute_migration_delta", "pass",
        f"delta: {len(delta['expand_migrations'])} expand, {len(delta['contract_migrations'])} contract",
        details={
            "expand": delta["expand_migrations"],
            "contract": delta["contract_migrations"],
            "already_applied_skipped": delta["already_applied_skipped"],
        }
    )


def _upgrade_apply_expand_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Step 4: Apply expand (additive) migrations BEFORE service swap."""
    if ctx.get("idempotent_skip"):
        return build_step_result(
            "apply_expand_migrations", "skip",
            "idempotent_skip"
        )

    if ctx["dry_run"]:
        return build_step_result(
            "apply_expand_migrations", "skip",
            f"dry_run: would apply {len(ctx['expand_migrations'])} expand migration(s)",
            details={"would_apply": ctx["expand_migrations"]}
        )

    for path in ctx["expand_migrations"]:
        try:
            _apply_sql_file(ctx, path)
        except Exception as exc:
            return build_step_result(
                "apply_expand_migrations", "fail",
                f"expand migration failed: {path}: {exc}"
            )
        ctx["expand_applied"].append(path)

    return build_step_result(
        "apply_expand_migrations", "pass",
        f"applied {len(ctx['expand_applied'])} expand migration(s)",
        details={"applied": list(ctx["expand_applied"])}
    )


def _upgrade_swap_services(ctx: Dict[str, Any]) -> StepResult:
    """Step 5: Write new service list, overwriting previous registration."""
    if ctx.get("idempotent_skip"):
        return build_step_result(
            "swap_services", "skip",
            "idempotent_skip"
        )

    manifest = ctx["new_manifest"]
    pre = ctx["pre_upgrade_record"]

    # Normalize services: may be dict (Phase 48 pydantic) or list
    if isinstance(manifest.services, dict):
        new_service_names = list(manifest.services.keys())
    elif isinstance(manifest.services, list):
        new_service_names = list(manifest.services)
    else:
        new_service_names = []

    if ctx["dry_run"]:
        return build_step_result(
            "swap_services", "skip",
            f"dry_run: would register {len(new_service_names)} service(s)",
            details={"would_apply": new_service_names}
        )

    prev_services = set(pre.get("registered_services", []))
    new_services = set(new_service_names)
    added = new_services - prev_services
    removed = prev_services - new_services

    reg_dir = os.path.expanduser("~/.amauta/data/registered_services")
    path = os.path.join(reg_dir, f"{manifest.name}.json")
    try:
        os.makedirs(reg_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"module_name": manifest.name, "services": new_service_names}, f)
    except OSError as exc:
        return build_step_result(
            "swap_services", "fail",
            f"service swap failed: {exc}"
        )

    return build_step_result(
        "swap_services", "pass",
        f"swapped services: +{len(added)} added, -{len(removed)} removed",
        details={"added": sorted(added), "removed": sorted(removed)}
    )


def _upgrade_apply_contract_migrations(ctx: Dict[str, Any]) -> StepResult:
    """Step 6: Apply contract (destructive) migrations AFTER service swap."""
    if ctx.get("idempotent_skip"):
        return build_step_result(
            "apply_contract_migrations", "skip",
            "idempotent_skip"
        )

    if ctx["dry_run"]:
        return build_step_result(
            "apply_contract_migrations", "skip",
            f"dry_run: would apply {len(ctx['contract_migrations'])} contract migration(s)",
            details={"would_apply": ctx["contract_migrations"]}
        )

    for path in ctx["contract_migrations"]:
        try:
            _apply_sql_file(ctx, path)
        except Exception as exc:
            return build_step_result(
                "apply_contract_migrations", "fail",
                f"contract migration failed: {path}: {exc}"
            )
        ctx["contract_applied"].append(path)

    return build_step_result(
        "apply_contract_migrations", "pass",
        f"applied {len(ctx['contract_applied'])} contract migration(s)",
        details={"applied": list(ctx["contract_applied"])}
    )


def _upgrade_update_install_record(ctx: Dict[str, Any]) -> StepResult:
    """Step 7: Write updated install record with new version + hash + applied_migrations."""
    from services.install_record_store import put_install_record

    if ctx.get("idempotent_skip"):
        return build_step_result(
            "update_install_record", "skip",
            "idempotent_skip"
        )

    manifest = ctx["new_manifest"]
    pre = ctx["pre_upgrade_record"]

    if ctx["dry_run"]:
        return build_step_result(
            "update_install_record", "skip",
            "dry_run: would update install record",
            details={"would_apply": {"new_version": manifest.version}}
        )

    # Normalize new services
    if isinstance(manifest.services, dict):
        new_service_names = list(manifest.services.keys())
    elif isinstance(manifest.services, list):
        new_service_names = list(manifest.services)
    else:
        new_service_names = []

    record = {
        "module_name": manifest.name,
        "version": manifest.version,
        "manifest_hash": ctx["new_manifest_hash"],
        "installed_at": pre.get("installed_at"),  # preserved from v1 install
        "upgraded_at": datetime.now(timezone.utc).isoformat(),
        "applied_migrations": (
            list(pre.get("applied_migrations", []))
            + list(ctx.get("expand_applied", []))
            + list(ctx.get("contract_applied", []))
        ),
        "registered_services": new_service_names,
        "installed_agents": list(manifest.agents) if manifest.agents else [],
        "installed_skills": list(manifest.skills) if manifest.skills else [],
    }
    try:
        put_install_record(record)
    except Exception as exc:
        return build_step_result(
            "update_install_record", "fail",
            f"failed to write upgraded install record: {exc}"
        )

    return build_step_result(
        "update_install_record", "pass",
        f"install record updated: {manifest.name}@{manifest.version}",
        details={"upgraded_at": record["upgraded_at"]}
    )


def _upgrade_post_upgrade_verify(ctx: Dict[str, Any]) -> StepResult:
    """Step 8: Reload install record and confirm version + hash + upgraded_at."""
    from services.install_record_store import get_install_record

    if ctx.get("idempotent_skip") or ctx["dry_run"]:
        return build_step_result(
            "post_upgrade_verify", "skip",
            "skipped (idempotent_skip or dry_run)"
        )

    manifest = ctx["new_manifest"]
    try:
        record = get_install_record(manifest.name)
    except Exception as exc:
        return build_step_result(
            "post_upgrade_verify", "fail",
            f"failed to reload install record: {exc}"
        )

    if record is None:
        return build_step_result(
            "post_upgrade_verify", "fail",
            "install record missing after update"
        )

    mismatches = []
    if record.get("version") != manifest.version:
        mismatches.append(
            f"version: expected {manifest.version!r}, got {record.get('version')!r}"
        )
    if record.get("manifest_hash") != ctx["new_manifest_hash"]:
        mismatches.append("manifest_hash mismatch")
    if record.get("upgraded_at") is None:
        mismatches.append("upgraded_at is None")

    if mismatches:
        return build_step_result(
            "post_upgrade_verify", "fail",
            f"post-upgrade verification failed: {'; '.join(mismatches)}"
        )

    return build_step_result(
        "post_upgrade_verify", "pass",
        f"verified {manifest.name}@{manifest.version} at upgraded_at={record.get('upgraded_at')}"
    )


# ─── upgrade() orchestrator ───────────────────────────────────────────────────


def upgrade(
    new_manifest_path: str,
    *,
    dry_run: bool = False,
    force: bool = False,
    json_output: bool = False,
) -> LifecycleResult:
    """
    Upgrade a module using the given new manifest YAML path.

    Implements the 8 frozen UPGRADE_STEPS in order:
      validate_new_manifest → read_install_record → compute_migration_delta →
      apply_expand_migrations → swap_services → apply_contract_migrations →
      update_install_record → post_upgrade_verify

    Idempotency: if target manifest_hash matches installed_manifest_hash AND
    force=False, read_install_record returns skip, overall status="skip".

    Rollback: if any step fails, inverse of prior pass steps runs in reverse.
    Contract migrations are NOT reversible (partial_rollback=True on failure).

    Dry-run: state-modifying steps return status="skip" with would_apply details.
    """
    from services.install_record_store import get_install_record, put_install_record

    ctx: Dict[str, Any] = {
        "new_manifest_path": new_manifest_path,
        "new_manifest_yaml_text": "",
        "new_manifest": None,
        "new_manifest_hash": "",
        "pre_upgrade_record": None,
        "dry_run": dry_run,
        "force": force,
        "module_dir": os.path.dirname(os.path.abspath(new_manifest_path)),
        "expand_migrations": [],
        "contract_migrations": [],
        "expand_applied": [],
        "contract_applied": [],
        "idempotent_skip": False,
        # NOTE: rollback engine reads ctx["manifest"] for module name;
        # alias new_manifest so the shared engine works unchanged.
        "manifest": None,
    }

    steps_to_run = [
        ("validate_new_manifest", _upgrade_validate_new_manifest),
        ("read_install_record", _upgrade_read_install_record),
        ("compute_migration_delta", _upgrade_compute_migration_delta),
        ("apply_expand_migrations", _upgrade_apply_expand_migrations),
        ("swap_services", _upgrade_swap_services),
        ("apply_contract_migrations", _upgrade_apply_contract_migrations),
        ("update_install_record", _upgrade_update_install_record),
        ("post_upgrade_verify", _upgrade_post_upgrade_verify),
    ]

    results: List[StepResult] = []
    failed_step = None

    for name, fn in steps_to_run:
        t0 = time.time()
        try:
            r = fn(ctx)
        except Exception as exc:
            r = build_step_result(name, "fail", f"unhandled exception: {exc}")
        r.duration_ms = int((time.time() - t0) * 1000)
        if r.name != name:
            r = build_step_result(name, r.status, r.message, r.duration_ms, r.details)
        results.append(r)
        if r.status == "fail":
            failed_step = name
            break

    rollback_info = None
    if failed_step is not None and not dry_run and not ctx.get("idempotent_skip"):
        rollback_info = _run_rollback(failed_step, results, ctx)

    module_name = (
        ctx["new_manifest"].name if ctx["new_manifest"] else "<unknown>"
    )
    module_version = (
        ctx["new_manifest"].version if ctx["new_manifest"] else "<unknown>"
    )
    overall = worst_of_status([r.status for r in results])

    return LifecycleResult(
        schema_version=SCHEMA_VERSION,
        operation="upgrade",
        module=module_name,
        module_version=module_version,
        status=overall,
        steps=results,
        rollback=rollback_info,
        dry_run=dry_run,
    )
