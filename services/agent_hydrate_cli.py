#!/usr/bin/env python3
"""
services/agent_hydrate_cli.py — Phase 47 HYDRA-02

Subprocess entry-point invoked by the Node-side `gsd-tools agent-hydrate`
subcommand. Calls services/agent_hydrator.py::hydrate() and either emits
the raw JSON payload or the rendered `## Current context` Markdown block.

Usage:
    python3 services/agent_hydrate_cli.py <agent_name>
        [--task-id TASK] [--render] [--budget N] [--terse]

Exit codes:
    0  — success
    1  — agent_not_found or runtime error
    2  — argument error (should not occur via CLI — argparse handles it)

Frozen Markdown template (load-bearing strings — grep-asserted by tests):
    ## Current context
    ### Recent memory for <agent_name>
    ### Blackboard findings
    ### Recent activity
    ### Security alerts (24h)
    ---

DO NOT MODIFY services/agent_hydrator.py — this file is the thin entry-point.
"""

import argparse
import asyncio
import json
import os
import sys

# ── Path setup: ensure repo root is on sys.path so services.agent_hydrator imports ──

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services.agent_hydrator import hydrate  # type: ignore
except Exception:
    # Fallback for direct invocation from repo root
    try:
        from agent_hydrator import hydrate  # type: ignore
    except Exception as _exc:
        print(json.dumps({
            "error": "import_failed",
            "detail": str(_exc),
            "schema_version": "1.0",
        }))
        sys.exit(1)


# ── Agent path resolution (mirrors _load_agent_role logic in agent_hydrator.py) ──

def _resolve_agent_path(agent_name: str):
    """Return the first-found path for agent_name among candidates, or None.

    Checks:
    1. agents/gsd-{stripped_name}.md  (canonical form)
    2. agents/{agent_name}.md          (verbatim fallback)
    3. agents/gsd-{agent_name}.md      (gsd-prefixed fallback)
    """
    base = agent_name[4:] if agent_name.startswith("gsd-") else agent_name
    candidates = [
        os.path.join(_REPO_ROOT, "agents", f"gsd-{base}.md"),
        os.path.join(_REPO_ROOT, "agents", f"{agent_name}.md"),
        os.path.join(_REPO_ROOT, "agents", f"gsd-{agent_name}.md"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


# ── Markdown renderer ──────────────────────────────────────────────────────────

def render_markdown(payload: dict, budget: int = 800, terse: bool = False) -> str:
    """Render the frozen ## Current context Markdown block from a hydration payload.

    Implements the verbatim frozen template from 47-CONTEXT.md §Area 4:

        ## Current context

        _Generated: <ISO8601> · Agent: <name> · Task: <task_id|"general"> · Sources: 4/4_

        ### Recent memory for <agent_name>
        - [<id>] <summary> _(score: <cosine>, age: <days>d)_
        - _(none if empty)_

        ### Blackboard findings
        - [<id>] <severity> · <finding_type> · <summary> _(<age>)_
        - _(none if empty)_

        ### Recent activity
        Last spawn: <timestamp> · Last task: <task_id> · Last verdict: <pass|fail|n/a>
        _(unavailable — Valkey not reachable)_

        ### Security alerts (24h)
        - [<id>] <severity> · <finding_type> · <summary>
        - _(no security alerts in last 24h)_

        ---

    Token budget enforcement (rough: chars/4 ≈ tokens):
    Truncation order: Security alerts first, then Recent activity, then Blackboard.
    NEVER truncate ## Current context heading or the header line.

    Args:
        payload: dict from hydrate() with schema_version "1.0".
        budget:  token budget (default 800; --terse implies 400).
        terse:   hint — used only if budget not explicitly overridden.

    Returns:
        Rendered Markdown string.
    """
    agent_name = payload.get("agent_name", "unknown")
    task_id = payload.get("task_id") or "general"
    generated_at = payload.get("generated_at", "")
    sources_status = payload.get("sources_status", {})
    memory_items = payload.get("memory", [])
    blackboard_items = payload.get("blackboard", [])
    recent_activity = payload.get("recent_activity")
    security_items = payload.get("security", [])

    # ── Header (NEVER truncated) ───────────────────────────────────────────────
    header_line = (
        f"_Generated: {generated_at} · Agent: {agent_name} "
        f"· Task: {task_id} · Sources: 4/4_"
    )

    # ── Section 1: Recent memory ───────────────────────────────────────────────
    mem_status = sources_status.get("memory", "unavailable")
    if mem_status == "unavailable":
        mem_body = "- _(unavailable — PG not reachable)_"
    elif not memory_items:
        mem_body = "- _(none if empty)_"
    else:
        lines = []
        for m in memory_items[:3]:
            cosine = m.get("cosine", 0.0)
            age_days = m.get("age_days", 0.0)
            summary = m.get("summary", "")
            mid = m.get("id", "?")
            lines.append(
                f"- [{mid}] {summary} _(score: {cosine:.2f}, age: {age_days:.0f}d)_"
            )
        mem_body = "\n".join(lines)

    # ── Section 2: Blackboard findings ────────────────────────────────────────
    bb_status = sources_status.get("blackboard", "unavailable")
    if bb_status == "unavailable":
        bb_body = "- _(unavailable — PG not reachable)_"
    elif not blackboard_items:
        bb_body = "- _(none if empty)_"
    else:
        lines = []
        for f in blackboard_items[:5]:
            fid = f.get("id", "?")
            severity = f.get("severity", "info")
            ftype = f.get("finding_type", "")
            summary = f.get("summary", "")
            age = f.get("age", "")
            lines.append(
                f"- [{fid}] {severity} · {ftype} · {summary} _({age})_"
            )
        bb_body = "\n".join(lines)

    # ── Section 3: Recent activity ─────────────────────────────────────────────
    vk_status = sources_status.get("valkey", "unavailable")
    if vk_status == "unavailable":
        activity_body = "_(unavailable — Valkey not reachable)_"
    elif recent_activity is None:
        activity_body = "_(none recorded yet)_"
    else:
        last_spawn = recent_activity.get("last_spawn", "n/a")
        last_task = recent_activity.get("last_task", "n/a")
        last_verdict = recent_activity.get("last_verdict", "n/a")
        activity_body = (
            f"Last spawn: {last_spawn} · Last task: {last_task} "
            f"· Last verdict: {last_verdict}"
        )

    # ── Section 4: Security alerts ─────────────────────────────────────────────
    sec_status = sources_status.get("security", "unavailable")
    if sec_status == "unavailable":
        sec_body = "- _(unavailable — PG not reachable)_"
    elif not security_items:
        sec_body = "- _(no security alerts in last 24h)_"
    else:
        lines = []
        for s in security_items[:3]:
            sid = s.get("id", "?")
            severity = s.get("severity", "info")
            ftype = s.get("finding_type", "")
            summary = s.get("summary", "")
            lines.append(f"- [{sid}] {severity} · {ftype} · {summary}")
        sec_body = "\n".join(lines)

    # ── Assemble full block ────────────────────────────────────────────────────
    def _build_block(include_security: bool, include_activity: bool, include_blackboard: bool) -> str:
        parts = ["## Current context", "", header_line, ""]
        parts += [f"### Recent memory for {agent_name}", mem_body, ""]
        if include_blackboard:
            parts += ["### Blackboard findings", bb_body, ""]
        if include_activity:
            parts += ["### Recent activity", activity_body, ""]
        if include_security:
            parts += ["### Security alerts (24h)", sec_body, ""]
        parts += ["---"]
        return "\n".join(parts)

    # Build full block first, then apply budget truncation
    full_block = _build_block(
        include_security=True,
        include_activity=True,
        include_blackboard=True,
    )

    # Token budget enforcement: chars/4 ≈ tokens (rough estimate)
    def _token_estimate(s: str) -> int:
        return len(s) // 4

    if _token_estimate(full_block) <= budget:
        return full_block

    # Truncate security first
    no_sec = _build_block(include_security=False, include_activity=True, include_blackboard=True)
    if _token_estimate(no_sec) <= budget:
        return no_sec

    # Truncate activity next
    no_sec_act = _build_block(include_security=False, include_activity=False, include_blackboard=True)
    if _token_estimate(no_sec_act) <= budget:
        return no_sec_act

    # Truncate blackboard last resort
    no_bb = _build_block(include_security=False, include_activity=False, include_blackboard=False)
    return no_bb


# ── Main entry-point ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="agent_hydrate_cli",
        description="Phase 47 HYDRA-02: agent context hydration CLI entry-point",
    )
    parser.add_argument("agent_name", help="Agent name (e.g. gsd-planner or planner)")
    parser.add_argument("--task-id", dest="task_id", default=None, help="Optional task ID for scoped findings")
    parser.add_argument(
        "--render",
        action="store_true",
        default=False,
        help="Render Markdown (default: emit JSON)",
    )
    parser.add_argument(
        "--budget",
        type=int,
        default=800,
        help="Token budget for Markdown render (default: 800)",
    )
    parser.add_argument(
        "--terse",
        action="store_true",
        default=False,
        help="Halve budget to 400 unless --budget is explicit",
    )

    args = parser.parse_args()

    # Resolve effective budget: --budget explicit wins; --terse halves default
    effective_budget = args.budget
    # Detect if --budget was explicitly passed (check if it differs from default AND
    # argparse doesn't distinguish; use sentinel approach via sys.argv scan)
    budget_explicitly_set = "--budget" in sys.argv
    if not budget_explicitly_set and args.terse:
        effective_budget = 400

    # ── Agent existence check (BEFORE calling hydrate) ──────────────────────
    agent_path = _resolve_agent_path(args.agent_name)
    if agent_path is None:
        print(json.dumps({
            "error": "agent_not_found",
            "detail": args.agent_name,
            "schema_version": "1.0",
        }))
        sys.exit(1)

    # ── Run hydration ────────────────────────────────────────────────────────
    try:
        result = asyncio.run(hydrate(args.agent_name, args.task_id))
    except Exception as exc:
        print(json.dumps({
            "error": "hydration_failed",
            "detail": str(exc),
            "schema_version": "1.0",
        }))
        sys.exit(1)

    # ── Emit output ──────────────────────────────────────────────────────────
    if args.render:
        md = render_markdown(result, budget=effective_budget, terse=args.terse)
        print(md)
    else:
        print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
