<purpose>
Step 04 of sharded plan-phase workflow: Spawn gsd-checker agent, handle checker return
(VERIFICATION PASSED, ISSUES FOUND), and run revision loop (max 3 iterations).

Part of Phase 41 SHARD-01 sharding of the 656-line plan-phase.md monolith.
</purpose>

<step_context>
Read the StepHandoff passed by the workflow router. Extract from context_snapshot and artifacts:
- phase_number, phase_name, phase_dir
- context_path, research_path, roadmap_path, requirements_path
- checker_model, planner_model, phase_req_ids
- artifacts.plan_files (list of PLAN.md files created in step-03-plan)
</step_context>

<process>

## 10. Spawn gsd-checker Agent

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AMAUTA ► VERIFYING PLANS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning plan checker...
```

Checker prompt:

```markdown
<verification_context>
**Phase:** {phase_number}
**Phase Goal:** {goal from ROADMAP}

<files_to_read>
- {PHASE_DIR}/*-PLAN.md (Plans to verify)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /amauta:discuss-phase)
- {research_path} (Technical Research — includes Validation Architecture)
</files_to_read>

**Phase requirement IDs (MUST ALL be covered):** {phase_req_ids}

**Project instructions:** Read ./CLAUDE.md if exists — verify plans honor project guidelines
**Project skills:** Check .claude/skills/ or .agents/skills/ directory (if either exists) — verify plans account for project skill rules
</verification_context>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

```
Task(
  prompt=checker_prompt,
  subagent_type="gsd-checker",
  model="{checker_model}",
  description="Verify Phase {phase} plans"
)
```

## 11. Handle Checker Return

- **`## VERIFICATION PASSED`:**
  <if mode="interactive" OR="custom with gates.confirm_plan true">
  Display plan summary and ask for confirmation:
  Use AskUserQuestion:
  - header: "Plan Ready"
  - question: "Plans verified by checker. Approve to continue, or request changes?"
  - options:
    - "Approve plans" — Continue to commit
    - "Request changes" — I want to adjust the plans
  If "Request changes" → go to step 12 (revision loop).
  </if>
  Proceed to step_output.
- **`## ISSUES FOUND`:** Display issues, check iteration count, proceed to step 12.

## 12. Revision Loop (Max 3 Iterations)

Track `iteration_count` (starts at 1 after initial plan + check).

**If iteration_count < 3:**

Display: `Sending back to planner for revision... (iteration {N}/3)`

Revision prompt:

```markdown
<revision_context>
**Phase:** {phase_number}
**Mode:** revision

<files_to_read>
- {PHASE_DIR}/*-PLAN.md (Existing plans)
- {context_path} (USER DECISIONS from /amauta:discuss-phase)
</files_to_read>

**Checker issues:** {structured_issues_from_checker}
</revision_context>

<instructions>
Make targeted updates to address checker issues.
Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

```
Task(
  prompt=revision_prompt,
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Revise Phase {phase} plans"
)
```

After planner returns -> spawn checker again (step 10), increment iteration_count.

**If iteration_count >= 3:**

Display: `Max iterations reached. {N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Provide guidance and retry, 3) Abandon

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/plan-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "plan-phase",
  "step_id": "step-04-check",
  "task_id": "{PHASE}-plan-phase",
  "phase_number": {PHASE},
  "completed_steps": ["step-01-init", "step-02-research", "step-03-plan", "step-04-check"],
  "context_snapshot": "{same context_snapshot from step-01-init, pass through unchanged}",
  "artifacts": {
    "plan_files": ["{list of final PLAN.md files}"],
    "plan_count": "{number of plans}",
    "checker_result": "VERIFICATION PASSED | ISSUES FOUND | forced_proceed",
    "iteration_count": "{N}"
  },
  "next_step": "step-05-approve",
  "escalation_flags": []
}
```

```bash
curl -s -X POST "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}/handoff" \
  -H "Content-Type: application/json" \
  -d "$HANDOFF_JSON"
```
</step_output>

---

STOP. Do not proceed to the next step. Save StepHandoff via POST /api/steps/plan-phase/{PHASE}/handoff and return control to the workflow router.
