<purpose>
Step 02 of sharded execute-phase workflow: Discover and group plans by wave, register plans as
Amauta tasks, route each plan to the appropriate executor agent via route-executor.

Part of Phase 41 SHARD-02 sharding of the 840-line execute-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/execute-phase/{PHASE} to load context from step-01-prepare.
Required fields from prior handoff: phase_dir, phase_number, phase_name, plan_count, incomplete_count,
executor_model, parallelization, amauta_ok, phase_task_id.
</step_context>

<process>

## 1. Discover and Group Plans

Load plan inventory with wave grouping in one call:

```bash
PLAN_INDEX=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" phase-plan-index "${PHASE_NUMBER}")
```

Parse JSON for: `phase`, `plans[]` (each with `id`, `wave`, `autonomous`, `objective`, `files_modified`, `task_count`, `has_summary`), `waves` (map of wave number → plan IDs), `incomplete`, `has_checkpoints`.

**Filtering:** Skip plans where `has_summary: true`. If `--gaps-only`: also skip non-gap_closure plans. If all filtered: "No matching incomplete plans" → exit.

Report:
```
## Execution Plan

**Phase {X}: {Name}** — {total_plans} plans across {wave_count} waves

| Wave | Plans | What it builds |
|------|-------|----------------|
| 1 | 01-01, 01-02 | {from plan objectives, 3-8 words} |
| 2 | 01-03 | ... |
```

## 2. Register Plans as Amauta Tasks (if daemon available)

# plan-to-tasks migration note (Phase 14):
# Phases 14+ use plan-to-tasks for full task registration.
# Phases 9-13 use the legacy thin registration loop.
# The phase number cutoff is authoritative — a <story> block in a
# Phase 12 plan does NOT trigger registration.
# Kill switch: GSD_P_AUTO_TASK=false disables plan-to-tasks everywhere.
# Default: plan-to-tasks is ON (runs automatically for phases >= 14 unless explicitly disabled).

```bash
# Phase-gated plan-to-tasks registration (Phase 14+)
# For phases >= 14, plan-to-tasks handles full task registration with metadata,
# dedup bypass, agent conflict detection, and dependency linking.
# For phases 9-13, the legacy thin registration loop below handles it.
PHASE_NUM_FLOAT=$(echo "$PHASE_NUMBER" | python3 -c "import sys; parts=sys.stdin.read().strip().split('.'); print(float(parts[0]))" 2>/dev/null || echo "0")

if python3 -c "exit(0 if ${PHASE_NUM_FLOAT} >= 14 else 1)" 2>/dev/null; then
  # Phase >= 14: use plan-to-tasks (or skip entirely if kill switch is active)
  if [ "${GSD_P_AUTO_TASK:-true}" = "false" ]; then
    echo "[plan-to-tasks] Phase ${PHASE_NUMBER} >= 14 but GSD_P_AUTO_TASK=false — skipping task registration entirely (no legacy loop fallback for phase 14+)"
  else
    echo "[plan-to-tasks] Phase ${PHASE_NUMBER} >= 14 — running plan-to-tasks for full registration"
    TOOLS="$HOME/.claude/get-shit-done/bin/gsd-tools.cjs"
    P2T_FAILURES=0

    for plan_file in ${PHASE_DIR}/*-PLAN.md; do
      [ -f "$plan_file" ] || continue
      # Skip plans that already have a SUMMARY.md (completed plans)
      PLAN_BASE=$(basename "$plan_file" -PLAN.md)
      [ -f "${PHASE_DIR}/${PLAN_BASE}-SUMMARY.md" ] && continue

      echo "[plan-to-tasks] Registering: $plan_file"
      P2T_RESULT=$(node "$TOOLS" plan-to-tasks "$plan_file" 2>&1) || {
        echo "[plan-to-tasks] FAILED: $plan_file"
        echo "$P2T_RESULT"
        P2T_FAILURES=$((P2T_FAILURES + 1))
        continue
      }

      # Extract story and task IDs from result for executor spawning
      P2T_STORY=$(echo "$P2T_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('story_id',''))" 2>/dev/null || echo "")
      P2T_TASKS=$(echo "$P2T_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(tid) for tid in d.get('tasks_created',[])]" 2>/dev/null || echo "")

      if [ -n "$P2T_STORY" ]; then
        PHASE_STORY="$P2T_STORY"
      fi

      # Store task IDs for executor spawning
      for tid in $P2T_TASKS; do
        eval "PLAN_TASK_${PLAN_BASE//-/_}=$tid"
      done
      echo "[plan-to-tasks] Registered: $plan_file -> Story: $P2T_STORY, Tasks: $(echo $P2T_TASKS | wc -w | tr -d ' ')"
    done

    if [ "$P2T_FAILURES" -gt 0 ]; then
      echo "[plan-to-tasks] WARNING: $P2T_FAILURES plan(s) failed registration. Review errors above."
    fi
  fi  # close GSD_P_AUTO_TASK inner guard
else
  # Legacy thin registration for phases 9-13 (grandfathered)
  if [ "$AMAUTA_OK" = "1" ]; then
    # Create a story for this phase execution (if not already existing)
    PHASE_STORY=$($AMAUTA_CLI exec add story "Phase ${PHASE_NUMBER}: ${PHASE_NAME}" --agent operator 2>/dev/null | grep -oE 'ST-[0-9]+' || echo "")

    # For each incomplete plan: create a task under the phase story
    for plan in ${incomplete_plans}; do
      PLAN_OBJECTIVE=$(echo "$PLAN_INDEX_JSON" | python3 -c "import sys,json; plans=json.load(sys.stdin)['plans']; [print(p['objective']) for p in plans if p['id']=='${plan}']" 2>/dev/null || echo "Execute plan ${plan}")

      # Route to executor by file patterns
      PLAN_FILES=$(echo "$PLAN_INDEX_JSON" | python3 -c "import sys,json; plans=json.load(sys.stdin)['plans']; [print(','.join(p.get('files_modified',[]))) for p in plans if p['id']=='${plan}']" 2>/dev/null || echo "")

      # Route to executor using shared helper (single source of truth)
      # gsd-tools.cjs routeExecutor: tightened infra regex eliminates false positives
      # (e.g., src/config.ts -> backend NOT infra; .github/ISSUE_TEMPLATE.md -> general NOT infra)
      # CONTRACT (TK-2384): route-executor takes a comma-separated FILE LIST, never a
      # task description. A description matches no file_pattern and comes back as
      # executor-general, indistinguishable from "no specialist owns these files".
      # The JSON carries input_kind (file-list | mixed | not-a-file-list | empty) and
      # reason; a non-file-list also warns on stderr, which this pipeline discards.
      # An EMPTY $PLAN_FILES is therefore a routing hole, not a routing answer.
      EXECUTOR=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" route-executor "$PLAN_FILES" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('executor','executor-general'))" 2>/dev/null || echo "executor-general")
      echo "[ROUTING] Plan ${plan}: files='${PLAN_FILES}' -> ${EXECUTOR}"

      # Performance tiebreaker: if chosen executor has low pass rate, consider fallback
      # NOTE (AGT-03 audit): Fallback is always executor-general.
      # If executor-general also has <70% pass rate, the primary executor is used (no further fallback).
      # This is by design -- a double-fallback chain risks infinite routing loops.
      if [ "$AMAUTA_OK" = "1" ]; then
        PERF_JSON=$(curl -s --max-time 2 "http://127.0.0.1:18799/api/agent-performance?agent_id=${EXECUTOR}" 2>/dev/null || echo '{}')
        # Normalize pass_rate: daemon may return 0.0-1.0 float or 0-100 integer.
        # Heuristic: values > 1 are already percentages; values <= 1 are ratios (multiply by 100).
        PASS_RATE=$(echo "$PERF_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); pr=d.get('pass_rate',100); print(int(pr) if pr > 1 else int(pr*100))" 2>/dev/null || echo "100")
        TOTAL_TASKS=$(echo "$PERF_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_tasks',0))" 2>/dev/null || echo "0")

        if [ "$TOTAL_TASKS" -ge 5 ] 2>/dev/null && [ "$PASS_RATE" -lt 70 ] 2>/dev/null; then
          # Check if executor-general has better track record
          ALT_JSON=$(curl -s --max-time 2 "http://127.0.0.1:18799/api/agent-performance?agent_id=executor-general" 2>/dev/null || echo '{}')
          ALT_RATE=$(echo "$ALT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); pr=d.get('pass_rate',0); print(int(pr) if pr > 1 else int(pr*100))" 2>/dev/null || echo "0")
          if [ "$ALT_RATE" -gt 85 ] 2>/dev/null; then
            echo "[PERF_ROUTING] ${EXECUTOR} pass rate ${PASS_RATE}% (${TOTAL_TASKS} tasks) < 70%. Routing to executor-general (${ALT_RATE}% pass rate) instead."
            EXECUTOR="executor-general"
            # Persist routing override decision to task notes for audit trail
            if [ -n "$TASK_ID" ] && [ "$AMAUTA_OK" = "1" ]; then
              $AMAUTA_CLI note "$TASK_ID" --text "PERF_ROUTING_OVERRIDE: ${EXECUTOR} replaced primary executor (pass_rate=${PASS_RATE}%, total=${TOTAL_TASKS}). Fallback pass_rate=${ALT_RATE}%." --agent operator 2>/dev/null || true
            fi
          fi
        fi
      fi

      TASK_ID=$($AMAUTA_CLI exec add task "$PLAN_OBJECTIVE" --parent "$PHASE_STORY" --agent "$EXECUTOR" --priority high 2>/dev/null | grep -oE 'TK-[0-9]+' || echo "")
      # Store task ID for executor spawning — associate plan ID to Amauta task ID
      if [ -n "$TASK_ID" ]; then
        eval "PLAN_TASK_${plan//-/_}=$TASK_ID"
      done
    done
  fi
fi  # close phase-number gate
```

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "execute-phase",
  "step_id": "step-02-route",
  "task_id": "{PHASE}-execute-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-prepare", "step-02-route"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "plan_count": "{plan_count}",
    "incomplete_count": "{incomplete_count}",
    "executor_model": "{executor_model}",
    "verifier_model": "{verifier_model}",
    "parallelization": "{parallelization}",
    "amauta_ok": "{amauta_ok}",
    "phase_task_id": "{phase_task_id}",
    "phase_req_ids": "{phase_req_ids}"
  },
  "artifacts": {
    "wave_groups": "{waves_json}",
    "plan_task_ids": "{plan_task_ids_json}",
    "executor_assignments": "{executor_assignments_json}"
  },
  "next_step": "step-03-execute",
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
