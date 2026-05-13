#!/usr/bin/env python3
"""
services/module_lifecycle_cli.py — Phase 49 MOD-03 / MOD-04

Subprocess entry-point invoked by the Node-side `gsd-tools module
install|uninstall|upgrade` subcommands. Mirrors
services/module_validator_cli.py argparse + exit-code discipline.

Usage:
    python3 services/module_lifecycle_cli.py install <manifest.yaml> [--dry-run] [--json] [--force]
    python3 services/module_lifecycle_cli.py uninstall <module-name> [--dry-run] [--json]
    python3 services/module_lifecycle_cli.py upgrade <new-manifest.yaml> [--dry-run] [--json] [--force]

Exit codes (frozen — Phase 49 MOD-03/MOD-04 contract):
    0 — LifecycleResult.status in ("pass", "skip")
    1 — LifecycleResult.status == "fail" AND rollback present with no partial_rollback
    2 — file I/O error OR partial_rollback flag set on rollback or any rollback step
"""

import argparse
import json
import os
import sys

# ── Path setup: ensure repo root is on sys.path ──────────────────────────────
# (mirrors services/module_validator_cli.py L25-32)

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ── Import services ───────────────────────────────────────────────────────────

try:
    from services.module_lifecycle import install, uninstall, upgrade  # type: ignore
except Exception:
    try:
        from module_lifecycle import install, uninstall, upgrade  # type: ignore
    except Exception as _exc:
        print(json.dumps({
            "error": "import_failed",
            "detail": str(_exc),
            "schema_version": "1.0",
        }))
        sys.exit(2)


# ── Argparse layout ───────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(
        prog="module_lifecycle_cli",
        description=(
            "Phase 49 MOD-03/MOD-04: install/uninstall/upgrade modules. "
            "Exit 0=ok/skip, 1=fail (clean rollback), 2=I/O error or partial rollback."
        ),
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # install
    p_install = sub.add_parser("install", help="Install a module from a manifest")
    p_install.add_argument("manifest_path", help="Path to module.yaml")
    p_install.add_argument("--dry-run", action="store_true", dest="dry_run")
    p_install.add_argument("--force", action="store_true")
    p_install.add_argument("--json", action="store_true", dest="json_mode")

    # uninstall
    p_uninstall = sub.add_parser("uninstall", help="Uninstall a module by name")
    p_uninstall.add_argument("module_name", help="Module name to uninstall")
    p_uninstall.add_argument("--dry-run", action="store_true", dest="dry_run")
    p_uninstall.add_argument("--json", action="store_true", dest="json_mode")

    # upgrade
    p_upgrade = sub.add_parser("upgrade", help="Upgrade a module to a new manifest version")
    p_upgrade.add_argument("new_manifest_path", help="Path to new module.yaml")
    p_upgrade.add_argument("--dry-run", action="store_true", dest="dry_run")
    p_upgrade.add_argument("--force", action="store_true")
    p_upgrade.add_argument("--json", action="store_true", dest="json_mode")

    return parser


# ── Exit-code derivation ──────────────────────────────────────────────────────

def derive_exit_code(result_dict: dict) -> int:
    """Map LifecycleResult.to_dict() to the frozen 0/1/2 exit code.

    Rules (CONTEXT §Area 9, mirrors Phase 48):
        - status in ("pass", "skip")            -> 0
        - status == "warn"                       -> 0 (non-blocking warning)
        - status == "fail" AND rollback exists AND no partial_rollback -> 1
        - status == "fail" AND (no rollback OR partial_rollback set)   -> 2
    """
    status = result_dict.get("status")
    rollback = result_dict.get("rollback")
    if status in ("pass", "skip", "warn"):
        return 0
    # status == "fail"
    if rollback is None:
        return 2
    if rollback.get("partial_rollback") is True:
        return 2
    # Also check per-step partial_rollback flags
    for step in result_dict.get("steps", []):
        details = step.get("details") or {}
        if details.get("partial_rollback") is True:
            return 2
    return 1


# ── Human-readable output (non-JSON mode) ────────────────────────────────────

def render_human(result_dict: dict) -> None:
    status = result_dict.get("status", "?").upper()
    op = result_dict.get("operation", "?")
    module = result_dict.get("module", "?")
    version = result_dict.get("module_version", "?")
    print(f"{status}: {op} {module}@{version}")
    # Per-step lines
    for step in result_dict.get("steps", []):
        duration = step.get("duration_ms", 0)
        print(f"  {step['name']}: {step['status']} ({duration}ms) {step.get('message', '')}")
    # Dry-run would_apply blocks
    if result_dict.get("dry_run"):
        wa_lines = []
        for step in result_dict.get("steps", []):
            details = step.get("details") or {}
            wa = details.get("would_apply")
            if wa is not None:
                wa_lines.append(f"  {step['name']}: {wa}")
        if wa_lines:
            print("would_apply:")
            for ln in wa_lines:
                print(ln)
    # Rollback summary
    if result_dict.get("rollback"):
        rb = result_dict["rollback"]
        print(f"rollback: triggered_by={rb.get('triggered_by_step')} "
              f"undo_actions={rb.get('undo_actions')} "
              f"partial={rb.get('partial_rollback', False)}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = build_parser()
    args = parser.parse_args()

    # File-existence preflight for manifest-bearing actions
    if args.action == "install":
        if not os.path.isfile(args.manifest_path):
            msg = f"manifest not found: {args.manifest_path}"
            if args.json_mode:
                print(json.dumps({
                    "schema_version": "1.0",
                    "error": "io_error",
                    "detail": msg,
                }))
            else:
                print(f"ERROR: {msg}", file=sys.stderr)
            sys.exit(2)
        result = install(args.manifest_path,
                         dry_run=args.dry_run,
                         force=args.force,
                         json_output=args.json_mode)
    elif args.action == "uninstall":
        result = uninstall(args.module_name,
                           dry_run=args.dry_run,
                           json_output=args.json_mode)
    elif args.action == "upgrade":
        if not os.path.isfile(args.new_manifest_path):
            msg = f"new manifest not found: {args.new_manifest_path}"
            if args.json_mode:
                print(json.dumps({
                    "schema_version": "1.0",
                    "error": "io_error",
                    "detail": msg,
                }))
            else:
                print(f"ERROR: {msg}", file=sys.stderr)
            sys.exit(2)
        result = upgrade(args.new_manifest_path,
                         dry_run=args.dry_run,
                         force=args.force,
                         json_output=args.json_mode)
    else:
        parser.error(f"unknown action: {args.action}")
        return  # unreachable

    result_dict = result.to_dict()
    if args.json_mode:
        print(json.dumps(result_dict, default=str))
    else:
        render_human(result_dict)

    sys.exit(derive_exit_code(result_dict))


if __name__ == "__main__":
    main()
