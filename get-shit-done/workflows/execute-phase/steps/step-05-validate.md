<purpose>
Step 05 of sharded execute-phase workflow: Mark phase complete, update ROADMAP.md, STATE.md, and
REQUIREMENTS.md, commit tracking files, and log D-phase RPETD entry with key learnings.

Part of Phase 41 SHARD-02 sharding of the 840-line execute-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/execute-phase/{PHASE} to load context from step-04-verify.
Required fields from prior handoff: phase_number, phase_name, phase_dir, amauta_ok, phase_task_id,
verification_status. Only advance here if verification_status = "passed" or "human_needed" (approved).
</step_context>

<process>

## 1. Update Roadmap

**Mark phase complete and update all tracking files:**

```bash
COMPLETION=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" phase complete "${PHASE_NUMBER}")
```

The CLI handles:
- Marking phase checkbox `[x]` with completion date
- Updating Progress table (Status → Complete, date)
- Updating plan count to final
- Advancing STATE.md to next phase
- Updating REQUIREMENTS.md traceability

Extract from result: `next_phase`, `next_phase_name`, `is_last_phase`.

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" commit "docs(phase-{X}): complete phase execution" --files .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md {phase_dir}/*-VERIFICATION.md
```

## 2. Amauta Integration

**RPETD: Log D-phase after roadmap update (if amauta available):**
```bash
if [ "$AMAUTA_OK" = "1" ] && [ -n "$PHASE_TASK_ID" ]; then
  $AMAUTA_CLI rpetd "$PHASE_TASK_ID" --phase D --content "Phase ${PHASE_NUMBER} complete. ${completed_count}/${total_count} plans. LEARNING: ${key_insight_from_phase}" 2>/dev/null || true
fi
```

**RPETD: Store phase learnings to memory (if daemon available):**
```bash
if [ "$AMAUTA_OK" = "1" ]; then
  node "$HOME/.claude/get-shit-done/bin/gsd-memory.cjs" learn "Phase ${PHASE_NUMBER} ${PHASE_NAME}: ${key_findings}" 2>/dev/null || true
fi
```

## 3. RPETD Integration Summary

When the Amauta daemon is available, this workflow logs RPETD phases automatically:

| Step | RPETD Phase | What's logged |
|------|-------------|---------------|
| step-02-route (discover + execute start) | R (Research) + P (Plan) | R: Plan inventory, wave grouping; P: Wave execution strategy, parallelism config |
| step-03-execute (wave complete) | E (Execute) | What was built per wave, deviations |
| step-04-verify (verify_phase_goal) | T (Test) | Verification status (passed/gaps/human_needed) |
| step-05-validate (update_roadmap) | D (Document) | Phase completion, key learnings |

**Graceful degradation:** All RPETD logging is wrapped in `2>/dev/null || true`. If the daemon is unavailable, execution proceeds normally without any impact.

**CLI tools used:**
- `amauta.cjs rpetd` — Log RPETD phase content
- `amauta.cjs health` — Check daemon availability
- `gsd-memory.cjs learn` — Store phase learnings to PG memory

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "execute-phase",
  "step_id": "step-05-validate",
  "task_id": "{PHASE}-execute-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-prepare", "step-02-route", "step-03-execute", "step-04-verify", "step-05-validate"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "amauta_ok": "{amauta_ok}",
    "phase_task_id": "{phase_task_id}"
  },
  "artifacts": {
    "next_phase": "{next_phase}",
    "is_last_phase": "{is_last_phase}",
    "completion_data": "{completion_json}"
  },
  "next_step": "step-06-close",
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
