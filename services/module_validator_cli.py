#!/usr/bin/env python3
"""
services/module_validator_cli.py — Phase 48 MOD-01 / MOD-02

Subprocess entry-point invoked by the Node-side `gsd-tools module validate`
subcommand (Plan 48-02). Parses and validates one or more module.yaml manifests,
then resolves them as a set.

Mirrors services/agent_hydrate_cli.py (Phase 47 HYDRA-02) structure.

Usage:
    python3 services/module_validator_cli.py <manifest.yaml> [<manifest.yaml> ...] [--json]

Exit codes (frozen — Phase 48 MOD-01/MOD-02 contract):
    0 — all manifests valid AND resolver returns ok=True
    1 — one or more manifests invalid (ValidationError) OR resolver returns ok=False
    2 — file I/O error (missing or unreadable manifest)
"""

import argparse
import json
import os
import sys

# ── Path setup: ensure repo root is on sys.path ──────────────────────────────
# (mirrors services/agent_hydrate_cli.py L37-40)

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ── Import services (mirrors agent_hydrate_cli.py L42-54) ────────────────────

try:
    from services.module_schema import load_module_manifest, ModuleManifest  # type: ignore
    from services.module_resolver import resolve  # type: ignore
except Exception:
    # Fallback for direct invocation when cwd != repo root
    try:
        from module_schema import load_module_manifest, ModuleManifest  # type: ignore
        from module_resolver import resolve  # type: ignore
    except Exception as _exc:
        print(json.dumps({
            "error": "import_failed",
            "detail": str(_exc),
            "schema_version": "1.0",
        }))
        sys.exit(1)


# ── Main entry-point ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="module_validator_cli",
        description=(
            "Phase 48 MOD-01/MOD-02: validate module manifest(s) and resolve dependencies. "
            "Exit 0=ok, 1=invalid/conflict, 2=I/O error."
        ),
    )
    parser.add_argument(
        "manifests",
        nargs='+',
        help="One or more paths to module.yaml manifest files",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        default=False,
        dest="json_mode",
        help="Emit structured JSON output to stdout",
    )

    args = parser.parse_args()

    # ── Step a: File existence check ─────────────────────────────────────────
    io_errors = [p for p in args.manifests if not os.path.isfile(p)]

    if io_errors:
        if args.json_mode:
            print(json.dumps({
                "schema_version": "1.0",
                "ok": False,
                "io_errors": io_errors,
                "validation_errors": [],
                "resolver": None,
            }))
        else:
            for p in io_errors:
                print(f"ERROR: file not found: {p}", file=sys.stderr)
        sys.exit(2)

    # ── Step b: Parse and validate each manifest ─────────────────────────────
    loaded_manifests = []
    validation_errors = []

    for path in args.manifests:
        try:
            manifest = load_module_manifest(path)
            loaded_manifests.append(manifest)
        except Exception as exc:
            validation_errors.append({
                "path": path,
                "detail": str(exc),
            })

    if validation_errors:
        if args.json_mode:
            print(json.dumps({
                "schema_version": "1.0",
                "ok": False,
                "io_errors": [],
                "validation_errors": validation_errors,
                "resolver": None,
            }))
        else:
            for err in validation_errors:
                print(
                    f"INVALID: {err['path']}: {err['detail']}",
                    file=sys.stderr,
                )
        sys.exit(1)

    # ── Step c: Resolve the validated manifest set ───────────────────────────
    resolver_result = resolve(loaded_manifests)

    response = {
        "schema_version": "1.0",
        "ok": resolver_result["ok"],
        "io_errors": [],
        "validation_errors": [],
        "resolver": resolver_result,
    }

    if args.json_mode:
        # ── JSON mode output ─────────────────────────────────────────────────
        print(json.dumps(response, default=str))
    else:
        # ── Human-readable summary ───────────────────────────────────────────
        if resolver_result["ok"]:
            order = resolver_result.get("install_order") or []
            order_str = ", ".join(order) if order else "(none)"
            n = len(loaded_manifests)
            print(f"OK: {n} manifest(s) valid; install order: {order_str}")
        else:
            # Conflicts
            for conflict in resolver_result.get("conflicts", []):
                ma = conflict.get("module_a", "?")
                ra = conflict.get("range_a", "?")
                mb = conflict.get("module_b", "?")
                rb = conflict.get("range_b", "?")
                rm = conflict.get("requested_module", "?")
                print(
                    f"CONFLICT: {ma} requires {rm}@{ra} but {mb} requires {rm}@{rb}"
                )
            # Missing
            for m in resolver_result.get("missing", []):
                print(f"MISSING: {m}")
            # Cycle
            cycle = resolver_result.get("cycle")
            if cycle:
                cycle_str = " -> ".join(cycle)
                print(f"CYCLE: {cycle_str}")

    sys.exit(0) if resolver_result["ok"] else sys.exit(1)


if __name__ == "__main__":
    main()
