#!/usr/bin/env python3
"""
services/a2a_registry_cli.py — Phase 55 A2A-02: CLI entry-point for A2A registry.

Subprocess entry-point invoked by the Node-side `gsd-tools a2a <action>` subcommands.
Mirrors services/party_session_cli.py argparse + exit-code discipline.

Usage:
    python3 services/a2a_registry_cli.py capabilities <agent_name> [--json]
    python3 services/a2a_registry_cli.py list [--json]

Exit codes (frozen — Phase 55):
    0 — success
    1 — AgentNotFoundError or validation error
    2 — RegistryError (schema/parse error) or unexpected exception
"""

import argparse
import json
import os
import sys

# ── Path setup: ensure repo root is on sys.path ──────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ── Import registry ───────────────────────────────────────────────────────────

try:
    from services.a2a_registry import (  # type: ignore
        get_capabilities,
        list_agents,
        all_capabilities,
        AgentNotFoundError,
        RegistryError,
    )
except Exception:
    try:
        from a2a_registry import (  # type: ignore
            get_capabilities,
            list_agents,
            all_capabilities,
            AgentNotFoundError,
            RegistryError,
        )
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
        prog="a2a_registry_cli",
        description=(
            "Phase 55 A2A-02: A2A capability registry CLI. "
            "Exit 0=success, 1=agent not found/validation, 2=registry/parse error."
        ),
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # capabilities <agent_name>
    p_caps = sub.add_parser("capabilities", help="List capabilities for an agent")
    p_caps.add_argument("agent_name", help="Agent identifier (e.g. gsd-reviewer)")
    p_caps.add_argument("--json", action="store_true", dest="json_mode")

    # list
    p_list = sub.add_parser("list", help="List all known agents with their capabilities")
    p_list.add_argument("--json", action="store_true", dest="json_mode")

    return parser


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.action == "capabilities":
            caps = get_capabilities(args.agent_name)
            result = {
                "schema_version": "1.0",
                "agent": args.agent_name,
                "capabilities": caps,
            }
            if args.json_mode:
                print(json.dumps(result))
            else:
                if caps:
                    for cap in caps:
                        print(cap)
                else:
                    print(f"(no capabilities declared for {args.agent_name})")
            sys.exit(0)

        elif args.action == "list":
            all_caps = all_capabilities()
            result = {
                "schema_version": "1.0",
                "agents": [
                    {"agent": name, "capabilities": caps}
                    for name, caps in sorted(all_caps.items())
                ],
            }
            if args.json_mode:
                print(json.dumps(result))
            else:
                for name, caps in sorted(all_caps.items()):
                    cap_str = ", ".join(caps) if caps else "(none)"
                    print(f"{name}: {cap_str}")
            sys.exit(0)

        else:
            parser.error(f"unknown action: {args.action}")

    except AgentNotFoundError as exc:
        if args.json_mode:
            print(json.dumps({
                "error": "AgentNotFoundError",
                "detail": str(exc),
                "schema_version": "1.0",
            }))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    except RegistryError as exc:
        err_class = type(exc).__name__
        if args.json_mode:
            print(json.dumps({
                "error": err_class,
                "detail": str(exc),
                "schema_version": "1.0",
            }))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)

    except Exception as exc:
        err_class = type(exc).__name__
        if args.json_mode:
            print(json.dumps({
                "error": err_class,
                "detail": str(exc),
                "schema_version": "1.0",
            }))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
