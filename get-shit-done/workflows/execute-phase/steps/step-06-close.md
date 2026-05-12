<purpose>
Step 06 of sharded execute-phase workflow: Handle the offer_next step — check for gap exceptions,
no-transition flag, auto-advance detection, and transition workflow execution or manual next-step offer.
Final step of the execute-phase sharded workflow.

Part of Phase 41 SHARD-02 sharding of the 840-line execute-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/execute-phase/{PHASE} to load context from step-05-validate.
Required fields from prior handoff: phase_number, phase_name, next_phase, is_last_phase,
verification_status, amauta_ok, completion_data.
</step_context>

<process>

## 0. Write Task Completion (Phase 42 / SCALE-03)

Load the carried-forward complexity context from the StepHandoff:

```bash
HANDOFF=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE_NUMBER}" 2>/dev/null || echo '{}')
COMPLEXITY_SCORE=$(echo "$HANDOFF" | jq -r '.context_snapshot.complexity_score // 0')
CHOSEN_PHASES=$(echo "$HANDOFF" | jq -c '.context_snapshot.chosen_phases // []')
FEATURE_VECTOR=$(echo "$HANDOFF" | jq -c '.context_snapshot.feature_vector // {}')
ESCALATION_FLAGS=$(echo "$HANDOFF" | jq -c '.escalation_flags // []')
VERIFICATION_STATUS=$(echo "$HANDOFF" | jq -r '.context_snapshot.verification_status // "unknown"')
```

Derive the outcome label using this precedence (first match wins):
- If `ESCALATION_FLAGS` contains "manifest_violation" → `manifest_overshoot`
- Else if `ESCALATION_FLAGS` length > 0 → `escalation_fired`
- Else if `VERIFICATION_STATUS` == "passed" → `validator_pass`
- Else if `VERIFICATION_STATUS` == "gaps_found" → `gaps_found`
- Else if `VERIFICATION_STATUS` == "failed" → `task_fail`
- Else → `task_fail` (fallback for unknown state)

```bash
if echo "$ESCALATION_FLAGS" | jq -e 'map(select(. == "manifest_violation")) | length > 0' >/dev/null 2>&1; then
  OUTCOME_LABEL="manifest_overshoot"
elif [ "$(echo "$ESCALATION_FLAGS" | jq 'length')" -gt 0 ]; then
  OUTCOME_LABEL="escalation_fired"
elif [ "$VERIFICATION_STATUS" = "passed" ]; then
  OUTCOME_LABEL="validator_pass"
elif [ "$VERIFICATION_STATUS" = "gaps_found" ]; then
  OUTCOME_LABEL="gaps_found"
elif [ "$VERIFICATION_STATUS" = "failed" ]; then
  OUTCOME_LABEL="task_fail"
else
  OUTCOME_LABEL="task_fail"
fi

PHASES_RUN=$(echo "$CHOSEN_PHASES")  # PHASES_RUN reads chosen_phases from the latest handoff, which reflects any escalation that occurred during execution.
FV_FILE=$(mktemp)
echo "$FEATURE_VECTOR" > "$FV_FILE"

node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" complexity-complete "${PHASE_NUMBER}-execute-phase" \
  --phase "${PHASE_NUMBER}" \
  --workflow execute-phase \
  --outcome "$OUTCOME_LABEL" \
  --phases-run "$(echo $CHOSEN_PHASES | jq -r 'join(",")')" \
  --feature-vector @"$FV_FILE" \
  --raw-score "$COMPLEXITY_SCORE" \
  --escalation-history "$ESCALATION_FLAGS" 2>/dev/null || \
  echo "[warn] complexity-complete failed; task_completions not written"

rm -f "$FV_FILE"
```

This write is best-effort; failures do NOT block workflow close.

## 1. Offer Next / Auto-Advance

**Exception:** If `gaps_found`, the `verify_phase_goal` step (step-04-verify) already presents the gap-closure path (`/amauta:plan-phase {X} --gaps`). No additional routing needed — skip auto-advance.

**No-transition check (spawned by auto-advance chain):**

Parse `--no-transition` flag from $ARGUMENTS.

**If `--no-transition` flag present:**

Execute-phase was spawned by plan-phase's auto-advance. Do NOT run transition.md.
After verification passes and roadmap is updated, return completion status to parent:

```
## PHASE COMPLETE

Phase: ${PHASE_NUMBER} - ${PHASE_NAME}
Plans: ${completed_count}/${total_count}
Verification: {Passed | Gaps Found}

[Include aggregate_results output]
```

STOP. Do not proceed to auto-advance or transition.

**If `--no-transition` flag is NOT present:**

**Auto-advance detection:**

1. Parse `--auto` flag from $ARGUMENTS
2. Read both the chain flag and user preference (chain flag already synced in init step):
   ```bash
   AUTO_CHAIN=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-get workflow._auto_chain_active 2>/dev/null || echo "false")
   AUTO_CFG=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-get workflow.auto_advance 2>/dev/null || echo "false")
   ```

**If `--auto` flag present OR `AUTO_CHAIN` is true OR `AUTO_CFG` is true (AND verification passed with no gaps):**

```
╔══════════════════════════════════════════╗
║  AUTO-ADVANCING → TRANSITION             ║
║  Phase {X} verified, continuing chain    ║
╚══════════════════════════════════════════╝
```

Execute the transition workflow inline (do NOT use Task — orchestrator context is ~10-15%, transition needs phase completion data already in context):

Read and follow `/Users/luismogrovejo/.claude/get-shit-done/workflows/transition.md`, passing through the `--auto` flag so it propagates to the next phase invocation.

**If neither `--auto` nor `AUTO_CFG` is true:**

The workflow ends. The user runs `/amauta:progress` or invokes the transition workflow manually.

</process>

<step_output>
## Produce Final StepHandoff

At the end of this step, save the final StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff with next_step=null to signal workflow completion:

```json
{
  "workflow_name": "execute-phase",
  "step_id": "step-06-close",
  "task_id": "{PHASE}-execute-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-prepare", "step-02-route", "step-03-execute", "step-04-verify", "step-05-validate", "step-06-close"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}"
  },
  "artifacts": {
    "transition_triggered": "{true|false}",
    "next_phase": "{next_phase_or_null}"
  },
  "next_step": null,
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

STOP. Do not proceed to the next step. Save final StepHandoff with next_step=null via POST /api/steps/execute-phase/{PHASE}/handoff and return control to the workflow router. This is the final step — workflow complete.
