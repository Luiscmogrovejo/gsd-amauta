<purpose>
Step 04 of sharded execute-phase workflow: Verify the phase achieved its GOAL (not just completed tasks)
by spawning gsd-validator, reading verification status, handling human_needed and gaps_found flows,
and logging the T-phase RPETD entry.

Part of Phase 41 SHARD-02 sharding of the 840-line execute-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/execute-phase/{PHASE} to load context from step-03-execute.
Required fields from prior handoff: phase_dir, phase_number, phase_name, phase_req_ids,
verifier_model, amauta_ok, phase_task_id, completed_plans, wave_results.
</step_context>

<process>

## 1. Verify Phase Goal

**MANDATORY — DO NOT SKIP.** External validation is a core RPETD principle: no agent marks its own work done. This step MUST run after every phase execution, regardless of time pressure, auto-advance flags, or orchestrator context. Skipping this step violates the quality pipeline.

Verify phase achieved its GOAL, not just completed tasks.

```bash
# Phase 53 POLISH-05 hydration hook
# Phase 53 POLISH-05: hydration hook (honors GSD_HYDRATE_TASKS=off kill switch)
if [ "${GSD_HYDRATE_TASKS:-on}" != "off" ]; then
  HYDRATION=$($HYDRATE_CMD "gsd-validator" --task-id "" --terse 2>/dev/null || echo "")
else
  HYDRATION=""
fi
```

```
Task(
  prompt="<current_context>${HYDRATION}</current_context>

Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.
Create VERIFICATION.md.",
  subagent_type="gsd-validator",
  model="{verifier_model}"
)
```

Read status:
```bash
grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' '
```

| Status | Action |
|--------|--------|
| `passed` | → update_roadmap (step-05-validate) |
| `human_needed` | Present items for human testing, get approval or feedback |
| `gaps_found` | Present gap summary, offer `/amauta:plan-phase {phase} --gaps` |

**If human_needed:**
```
## ✓ Phase {X}: {Name} — Human Verification Required

All automated checks passed. {N} items need human testing:

{From VERIFICATION.md human_verification section}

"approved" → continue | Report issues → gap closure
```

**If gaps_found:**
```
## ⚠ Phase {X}: {Name} — Gaps Found

**Score:** {N}/{M} must-haves verified
**Report:** {phase_dir}/{phase_num}-VERIFICATION.md

### What's Missing
{Gap summaries from VERIFICATION.md}

---
## ▶ Next Up

`/amauta:plan-phase {X} --gaps`

<sub>`/clear` first → fresh context window</sub>

Also: `cat {phase_dir}/{phase_num}-VERIFICATION.md` — full report
Also: `/amauta:verify-work {X}` — manual testing first
```

Gap closure cycle: `/amauta:plan-phase {X} --gaps` reads VERIFICATION.md → creates gap plans with `gap_closure: true` → user runs `/amauta:execute-phase {X} --gaps-only` → verifier re-runs.

**RPETD: Log T-phase after verification (if amauta available):**
```bash
if [ "$AMAUTA_OK" = "1" ] && [ -n "$PHASE_TASK_ID" ]; then
  VERIFY_STATUS=$(grep "^status:" "$PHASE_DIR"/*-VERIFICATION.md | cut -d: -f2 | tr -d ' ')
  $AMAUTA_CLI rpetd "$PHASE_TASK_ID" --phase T --content "Verification: ${VERIFY_STATUS}. Phase ${PHASE_NUMBER} goal check complete." 2>/dev/null || true
fi
```

## 1.5. Detect Validator-Triggered Escalation (Phase 42 / SCALE-04)

After gsd-validator returns its verdict but BEFORE applying the verdict routing in §1's table, check for retro-escalation triggers.

```bash
# Read VERIFICATION.md for verdict + any manifest violations.
VERIFICATION_PATH=$(ls "$PHASE_DIR"/*-VERIFICATION.md 2>/dev/null | head -1)
VERDICT=$(grep "^status:" "$VERIFICATION_PATH" 2>/dev/null | cut -d: -f2 | tr -d ' ')

# Manifest violations: gsd-validator records them under a "violations:" YAML block
# or in the gaps section. Look for the literal pattern "manifest_violation" anywhere
# in the VERIFICATION.md body.
VIOLATIONS_JSON="[]"
if grep -q "manifest_violation" "$VERIFICATION_PATH" 2>/dev/null; then
  VIOLATIONS_JSON='["manifest_violation"]'
fi

VALIDATOR_REPORT=$(mktemp --suffix=.json)
cat <<EOF > "$VALIDATOR_REPORT"
{
  "verdict": "${VERDICT:-unknown}",
  "violations": ${VIOLATIONS_JSON}
}
EOF

ESCALATION_RESULT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" complexity-escalate \
  "${PHASE_NUMBER}-execute-phase" \
  --phase "${PHASE_NUMBER}" \
  --workflow execute-phase \
  --validator-report @"$VALIDATOR_REPORT" 2>/dev/null || echo '{"escalated":false}')

rm -f "$VALIDATOR_REPORT"

if [ "$(echo "$ESCALATION_RESULT" | jq -r '.escalated')" = "true" ]; then
  echo "$ESCALATION_RESULT" | jq -r '.banner'
  NEW_PHASES=$(echo "$ESCALATION_RESULT" | jq -c '.new_chosen_phases')
  echo "ESCALATION: Validator triggered retro-escalation. New chosen_phases=${NEW_PHASES}."
  # The workflow router (workflow.md) reads the updated step_handoffs row and inserts
  # additional R/P/D/S/A phases before close per the SCALE-04 spec.
fi
```

Then proceed to the existing `## 2. Validation Enforcement` section unchanged.

## 2. Validation Enforcement

**MANDATORY: External Validation Gate**

**The verify_phase_goal step is NON-NEGOTIABLE.** It must run after every phase execution completes. This is a hard architectural constraint, not a suggestion.

**Why:** The entire RPETD quality pipeline is built on the principle that NO agent validates its own work. If the orchestrator skips the validator, the quality gate collapses and bugs ship undetected.

**Rules:**
1. The orchestrator MUST spawn `gsd-validator` after all waves complete — even if all plans reported success
2. The orchestrator MUST NOT mark a phase as complete until the validator returns `status: passed`
3. If the validator finds gaps, the orchestrator MUST present them and route to gap closure
4. Time pressure, context limits, or auto-advance flags do NOT exempt the validation step
5. If the orchestrator runs out of context before validation, it MUST note "VALIDATION PENDING" in STATE.md so the next session runs it

**Enforcement:** Any phase marked complete without a VERIFICATION.md file in its directory is considered UNVALIDATED and should be flagged on next `/amauta:progress` check.

## 3. Validator Verdict Routing (HARDEN-04)

After `gsd-validator` completes for a phase, it exits with one of three codes. The orchestrator routes based on exit code, not on verdict prose:

| Exit | Verdict | Routing |
|------|---------|---------|
| 0 | `pass` | Phase advances. Roadmap updated. STATE.md progress bumped. |
| 2 | `gaps_found` | Phase does NOT advance. Read `.planning/phases/<phase>/gaps-report-<timestamp>.json`. For each gap, route the owning `requirement_id` back to `gsd-planner` for a delta plan. Run a mini-wave of the new plan(s). Re-invoke `gsd-validator`. **No retry counter** — gaps_found is not a failure. Repeat until `pass` or `fail`. |
| 1 | `fail` | Phase does NOT advance. FATAL. Invoke `gsd-roadmapper` for escalation. Human review required. **No auto-retry.** |

**Auto-escalation separation:** `gaps_found` does NOT count toward the 3-consecutive-failures auto-escalation rule. Only `fail` (exit 1) counts. Track `gaps_rate_per_phase` as a separate signal — high gaps rate is a planner signal, not a failure signal.

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "execute-phase",
  "step_id": "step-04-verify",
  "task_id": "{PHASE}-execute-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-prepare", "step-02-route", "step-03-execute", "step-04-verify"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "amauta_ok": "{amauta_ok}",
    "phase_task_id": "{phase_task_id}"
  },
  "artifacts": {
    "verification_status": "{passed|human_needed|gaps_found}",
    "gaps_list": "{gaps_array_if_any}"
  },
  "next_step": "step-05-validate",
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
