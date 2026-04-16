<purpose>
Step 01 of sharded execute-phase workflow: Initialize phase context, load all execution context,
handle branching strategy, and validate plan count. Entry point for a fresh execute-phase run.

Part of Phase 41 SHARD-02 sharding of the 840-line execute-phase.md monolith.
</purpose>

<step_context>
This is the FIRST step. No prior StepHandoff exists. Read $ARGUMENTS from the workflow router context.
Required fields for this step: phase number from $ARGUMENTS, all init JSON fields.
</step_context>

## Tool Paths (Phase 10 LEARN-07 — runtime Read dedup)

At the start of any bash invocation in this workflow, Read the shared CLI variable file and paste the shell block into your bash session:

1. Use the Read tool: `/Users/luismogrovejo/.claude/get-shit-done/references/cli-variables.md`
2. Copy the "Shell Variable Block" section into the current bash session
3. If the Read fails, fall back to these hardcoded paths (one-line per variable):

```bash
# Fallback (if Read of cli-variables.md fails — uncomment to activate)
# CLI="node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs"        # fallback: task CLI
# RLM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-rlm.cjs"        # fallback: codebase search
# MEM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs"     # fallback: memory/learnings
# RESEARCH="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-research.cjs"  # fallback: research chain
# TOOLS="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-tools.cjs"    # fallback: tools/audit
# LEARNING_FORMAT="/Users/luismogrovejo/.claude/get-shit-done/references/learning-format.md"  # fallback: D-phase template
# TAG_RULES="/Users/luismogrovejo/.claude/get-shit-done/config/tag-rules.json"                # fallback: tag governance
```

<core_principle>
Orchestrator coordinates, not executes. Each subagent loads the full execute-plan context. Orchestrator: discover plans → analyze deps → group waves → spawn agents → handle checkpoints → collect results.
</core_principle>

<required_reading>
Read STATE.md before any operation to load project context.
</required_reading>

<process>

## 1. Initialize

Load all context in one call:

```bash
INIT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" init execute-phase "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `executor_model`, `verifier_model`, `commit_docs`, `parallelization`, `branching_strategy`, `branch_name`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `plans`, `incomplete_plans`, `plan_count`, `incomplete_count`, `state_exists`, `roadmap_exists`, `phase_req_ids`.

**If `phase_found` is false:** Error — phase directory not found.
**If `plan_count` is 0:** Error — no plans found in phase.
**If `state_exists` is false but `.planning/` exists:** Offer reconstruct or continue.

When `parallelization` is false, plans within a wave execute sequentially.

**Sync chain flag with intent** — if user invoked manually (no `--auto`), clear the ephemeral chain flag from any previous interrupted `--auto` chain. This does NOT touch `workflow.auto_advance` (the user's persistent settings preference). Must happen before any config reads (checkpoint handling also reads auto-advance flags):
```bash
if [[ ! "$ARGUMENTS" =~ --auto ]]; then
  node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-set workflow._auto_chain_active false 2>/dev/null
fi
```

**Amauta integration (optional — skip if daemon unavailable):**
```bash
# Check if amauta daemon is available
AMAUTA_CLI="node $HOME/.claude/get-shit-done/bin/amauta.cjs"
AMAUTA_OK=$($AMAUTA_CLI health --json 2>/dev/null | grep -c '"status":"ok"' || echo "0")

# If available, create a tracking task for this phase execution
# Note: We CREATE a new task rather than search (search results are non-deterministic
# and could match unrelated tasks that mention "phase N" in their description).
if [ "$AMAUTA_OK" = "1" ]; then
  PHASE_TASK_ID=$($AMAUTA_CLI exec add task "Execute Phase ${PHASE_NUMBER}: ${PHASE_NAME}" \
    --agent operator --priority high 2>/dev/null | grep -oE 'TK-[0-9]+' | head -1 || echo "")
fi
```

## 2. Handle Branching

Check `branching_strategy` from init:

**"none":** Skip, continue on current branch.

**"phase" or "milestone":** Use pre-computed `branch_name` from init:
```bash
git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
```

All subsequent commits go to this branch. User handles merging.

## 3. Validate Phase

From init JSON: `phase_dir`, `plan_count`, `incomplete_count`.

Report: "Found {plan_count} plans in {phase_dir} ({incomplete_count} incomplete)"

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "execute-phase",
  "step_id": "step-01-prepare",
  "task_id": "{PHASE}-execute-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-prepare"],
  "context_snapshot": {
    "executor_model": "{executor_model}",
    "verifier_model": "{verifier_model}",
    "parallelization": "{parallelization}",
    "branch_name": "{branch_name}",
    "phase_dir": "{phase_dir}",
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "plan_count": "{plan_count}",
    "incomplete_count": "{incomplete_count}",
    "plan_index_data": null,
    "phase_req_ids": "{phase_req_ids}",
    "amauta_ok": "{amauta_ok}",
    "phase_task_id": "{phase_task_id}"
  },
  "next_step": "step-02-route",
  "escalation_flags": []
}
```

```bash
curl -s -X POST "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}/handoff" \
  -H "Content-Type: application/json" \
  -d "$HANDOFF_JSON"
```
</step_output>

---

STOP. Do not proceed to the next step. Save StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff and return control to the workflow router.
