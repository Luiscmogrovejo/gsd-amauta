<purpose>
Step 02 of sharded plan-phase workflow: Run gsd-researcher (if enabled), create validation strategy
(Nyquist artifacts), check existing plans, and extract context paths from the init StepHandoff.

Part of Phase 41 SHARD-01 sharding of the 656-line plan-phase.md monolith.
</purpose>

<step_context>
Read the StepHandoff passed by the workflow router. Extract from context_snapshot:
- phase_number, phase_name, phase_dir, padded_phase
- context_path, research_path, verification_path, uat_path, state_path, roadmap_path, requirements_path
- research_enabled, nyquist_validation_enabled, commit_docs
- researcher_model, phase_req_ids
</step_context>

<process>

## 5. Handle Research

**Skip if:** `--gaps` flag, `--skip-research` flag, or `research_enabled` is false (from init) without `--research` override.

**If `has_research` is true (from init) AND no `--research` flag:** Use existing, skip to step 6.

**Phase context gate:**
<if mode="interactive" OR="custom with gates.confirm_phases true">
Display the phase context summary (phase name, requirement IDs, description) and ask:
Use AskUserQuestion:
- header: "Phase Context"
- question: "Phase {X}: {name} — context loaded. Proceed to research and planning?"
- options:
  - "Proceed" — Start research
  - "Adjust context" — I want to update the context first
If "Adjust context" → let user update CONTEXT.md, then re-read.
</if>

**If RESEARCH.md missing OR `--research` flag:**

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AMAUTA ► RESEARCHING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning researcher...
```

### Spawn gsd-researcher

```bash
PHASE_DESC=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" roadmap get-phase "${PHASE}" | jq -r '.section')
```

Research prompt:

```markdown
<objective>
Research how to implement Phase {phase_number}: {phase_name}
Answer: "What do I need to know to PLAN this phase well?"
</objective>

<files_to_read>
- {context_path} (USER DECISIONS from /amauta:discuss-phase)
- {requirements_path} (Project requirements)
- {state_path} (Project decisions and history)
</files_to_read>

<additional_context>
**Phase description:** {phase_description}
**Phase requirement IDs (MUST address):** {phase_req_ids}

**Project instructions:** Read ./CLAUDE.md if exists — follow project-specific guidelines
**Project skills:** Check .claude/skills/ or .agents/skills/ directory (if either exists) — read SKILL.md files, research should account for project skill patterns
</additional_context>

<output>
Write to: {phase_dir}/{phase_num}-RESEARCH.md
</output>
```

```
Task(
  prompt=research_prompt,
  subagent_type="gsd-researcher",
  model="{researcher_model}",
  description="Research Phase {phase}"
)
```

### Handle Researcher Return

- **`## RESEARCH COMPLETE`:** Display confirmation, continue to step 5.5
- **`## RESEARCH BLOCKED`:** Display blocker, offer: 1) Provide context, 2) Skip research, 3) Abort

## 5.5. Create Validation Strategy

Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false.

If `research_enabled` is false and `nyquist_validation_enabled` is true: warn "Nyquist validation enabled but research disabled — VALIDATION.md cannot be created without RESEARCH.md. Plans will lack validation requirements (Dimension 8)." Continue to step 6.

```bash
grep -l "## Validation Architecture" "${PHASE_DIR}"/*-RESEARCH.md 2>/dev/null
```

**If found:**
1. Read template: `/Users/luismogrovejo/.claude/get-shit-done/templates/VALIDATION.md`
2. Write to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md` (use Write tool)
3. Fill frontmatter: `{N}` → phase number, `{phase-slug}` → slug, `{date}` → current date
4. Verify:
```bash
test -f "${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md" && echo "VALIDATION_CREATED=true" || echo "VALIDATION_CREATED=false"
```
5. If `VALIDATION_CREATED=false`: STOP — do not proceed to Step 6
6. If `commit_docs`: `commit-docs "docs(phase-${PHASE}): add validation strategy"`

**If not found:** Warn and continue — plans may fail Dimension 8.

## 6. Check Existing Plans

```bash
ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null
```

**If exists:** Offer: 1) Add more plans, 2) View existing, 3) Replan from scratch.

## 7. Use Context Paths from INIT

Extract from INIT JSON (these were stored in the step-01-init StepHandoff context_snapshot):

```bash
STATE_PATH=$(printf '%s\n' "$INIT" | jq -r '.state_path // empty')
ROADMAP_PATH=$(printf '%s\n' "$INIT" | jq -r '.roadmap_path // empty')
REQUIREMENTS_PATH=$(printf '%s\n' "$INIT" | jq -r '.requirements_path // empty')
RESEARCH_PATH=$(printf '%s\n' "$INIT" | jq -r '.research_path // empty')
VERIFICATION_PATH=$(printf '%s\n' "$INIT" | jq -r '.verification_path // empty')
UAT_PATH=$(printf '%s\n' "$INIT" | jq -r '.uat_path // empty')
CONTEXT_PATH=$(printf '%s\n' "$INIT" | jq -r '.context_path // empty')
```

## 7.5. Verify Nyquist Artifacts

Skip if `nyquist_validation_enabled` is false OR `research_enabled` is false.

```bash
VALIDATION_EXISTS=$(ls "${PHASE_DIR}"/*-VALIDATION.md 2>/dev/null | head -1)
```

If missing and Nyquist enabled — ask user:
1. Re-run with research: `/amauta:plan-phase {PHASE} --research`
2. Disable Nyquist: `node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-set workflow.nyquist_validation false`
3. Continue anyway (plans fail Dimension 8)

Proceed to step_output only if user selects 2 or 3.

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/plan-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "plan-phase",
  "step_id": "step-02-research",
  "task_id": "{PHASE}-plan-phase",
  "phase_number": {PHASE},
  "completed_steps": ["step-01-init", "step-02-research"],
  "context_snapshot": "{same context_snapshot from step-01-init, pass through unchanged}",
  "artifacts": {
    "research_path": "{research_path or null}",
    "validation_path": "{validation_path or null}",
    "existing_plans": "{existing plan files or []}"
  },
  "next_step": "step-03-plan",
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
