<purpose>
Step 03 of sharded plan-phase workflow: Spawn gsd-planner agent with full planning context,
handle planner return (PLANNING COMPLETE, CHECKPOINT, INCONCLUSIVE).

Part of Phase 41 SHARD-01 sharding of the 656-line plan-phase.md monolith.
</purpose>

<step_context>
Read the StepHandoff passed by the workflow router. Extract from context_snapshot and artifacts:
- phase_number, phase_name, phase_dir, padded_phase
- state_path, roadmap_path, requirements_path, context_path
- research_path (from artifacts.research_path)
- verification_path, uat_path
- planner_model, phase_req_ids
- plan_checker_enabled (if false, skip step-04-check)
- Flags from prior steps: --gaps, --skip-verify
</step_context>

<process>

## 8. Spawn gsd-planner Agent

Display banner:
**Task breakdown confirmation gate:**
<if mode="interactive" OR="custom with gates.confirm_breakdown true">
Display the research findings summary and planned approach, then ask:
Use AskUserQuestion:
- header: "Ready to Plan"
- question: "Research complete. Ready to break this phase into tasks?"
- options:
  - "Create plans" — Generate task plans from research
  - "Review research first" — Show me the research findings before planning
If "Review research first" → display RESEARCH.md content, then re-ask.
</if>

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AMAUTA ► PLANNING PHASE {X}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning planner...
```

Planner prompt:

```markdown
<planning_context>
**Phase:** {phase_number}
**Mode:** {standard | gap_closure}

<files_to_read>
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /amauta:discuss-phase)
- {research_path} (Technical Research)
- {verification_path} (Verification Gaps - if --gaps)
- {uat_path} (UAT Gaps - if --gaps)
</files_to_read>

**Phase requirement IDs (every ID MUST appear in a plan's `requirements` field):** {phase_req_ids}

**Project instructions:** Read ./CLAUDE.md if exists — follow project-specific guidelines
**Project skills:** Check .claude/skills/ or .agents/skills/ directory (if either exists) — read SKILL.md files, plans should account for project skill rules
</planning_context>

<downstream_consumer>
Output consumed by /amauta:execute-phase. Plans need:
- Frontmatter (wave, depends_on, files_modified, autonomous)
- Tasks in XML format with read_first and acceptance_criteria fields (MANDATORY on every task)
- Verification criteria
- must_haves for goal-backward verification
</downstream_consumer>

<deep_work_rules>
## Anti-Shallow Execution Rules (MANDATORY)

Every task MUST include these fields — they are NOT optional:

1. **`<read_first>`** — Files the executor MUST read before touching anything. Always include:
   - The file being modified (so executor sees current state, not assumptions)
   - Any "source of truth" file referenced in CONTEXT.md (reference implementations, existing patterns, config files, schemas)
   - Any file whose patterns, signatures, types, or conventions must be replicated or respected

2. **`<acceptance_criteria>`** — Verifiable conditions that prove the task was done correctly. Rules:
   - Every criterion must be checkable with grep, file read, test command, or CLI output
   - NEVER use subjective language ("looks correct", "properly configured", "consistent with")
   - ALWAYS include exact strings, patterns, values, or command outputs that must be present
   - Examples:
     - Code: `auth.py contains def verify_token(` / `test_auth.py exits 0`
     - Config: `.env.example contains DATABASE_URL=` / `Dockerfile contains HEALTHCHECK`
     - Docs: `README.md contains '## Installation'` / `API.md lists all endpoints`
     - Infra: `deploy.yml has rollback step` / `docker-compose.yml has healthcheck for db`

3. **`<action>`** — Must include CONCRETE values, not references. Rules:
   - NEVER say "align X with Y", "match X to Y", "update to be consistent" without specifying the exact target state
   - ALWAYS include the actual values: config keys, function signatures, SQL statements, class names, import paths, env vars, etc.
   - If CONTEXT.md has a comparison table or expected values, copy them into the action verbatim
   - The executor should be able to complete the task from the action text alone, without needing to read CONTEXT.md or reference files (read_first is for verification, not discovery)

**Why this matters:** Executor agents work from the plan text. Vague instructions like "update the config to match production" produce shallow one-line changes. Concrete instructions like "add DATABASE_URL=postgresql://... , set POOL_SIZE=20, add REDIS_URL=redis://..." produce complete work. The cost of verbose plans is far less than the cost of re-doing shallow execution.
</deep_work_rules>

<quality_gate>
- [ ] PLAN.md files created in phase directory
- [ ] Each plan has valid frontmatter
- [ ] Tasks are specific and actionable
- [ ] Every task has `<read_first>` with at least the file being modified
- [ ] Every task has `<acceptance_criteria>` with grep-verifiable conditions
- [ ] Every `<action>` contains concrete values (no "align X with Y" without specifying what)
- [ ] Dependencies correctly identified
- [ ] Waves assigned for parallel execution
- [ ] must_haves derived from phase goal
- [ ] `<story>` block present at top of plan (mandatory for phases >= 14, per plan-task-xml-schema.md)
- [ ] Every `<task>` has a non-empty `<agent>` field (executor-backend, executor-frontend, executor-infra, or executor-general)
- [ ] Every `<task>` has a `<files_expected>` block with modify/create/delete sublists (HARDEN-01 mandate)
- [ ] Task count per plan does not exceed 10 (PLAN-05 cap)
- [ ] Each plan has `requirements` field in frontmatter listing covered PLAN-XX IDs

**Advisory: Zero-dependency warning (Phase 14+):**
If a wave contains more than 2 tasks and NONE of them declare `<depends_on>` edges (all are `[]`), emit an advisory warning: "Wave N has {count} tasks with zero explicit dependencies — verify that all tasks are truly parallel-eligible (PITFALLS P8)." This is an advisory, not a hard gate — genuinely parallel tasks are valid.

**NOTE:** The plan-checker does NOT validate DAG cycles or run the cap-overflow split algorithm — those belong to `plan-to-tasks` Pass 0 (runtime validation, not plan-time). The checker focuses on content quality: read_first completeness, action concreteness, acceptance criteria verifiability, schema compliance.
</quality_gate>
```

```
Task(
  prompt=filled_prompt,
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Plan Phase {phase}"
)
```

## 9. Handle Planner Return

- **`## PLANNING COMPLETE`:** Display plan count. If `--skip-verify` or `plan_checker_enabled` is false (from init): set next_step to "step-05-approve" (skip checker). Otherwise: set next_step to "step-04-check".
- **`## CHECKPOINT REACHED`:** Present to user, get response, spawn continuation
- **`## PLANNING INCONCLUSIVE`:** Show attempts, offer: Add context / Retry / Manual

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/plan-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "plan-phase",
  "step_id": "step-03-plan",
  "task_id": "{PHASE}-plan-phase",
  "phase_number": {PHASE},
  "completed_steps": ["step-01-init", "step-02-research", "step-03-plan"],
  "context_snapshot": "{same context_snapshot from step-01-init, pass through unchanged}",
  "artifacts": {
    "plan_files": ["{list of PLAN.md files created}"],
    "plan_count": "{number of plans}"
  },
  "next_step": "step-04-check",
  "escalation_flags": []
}
```

Note: If `--skip-verify` or `plan_checker_enabled` is false, set `next_step` to `"step-05-approve"`.

```bash
curl -s -X POST "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}/handoff" \
  -H "Content-Type: application/json" \
  -d "$HANDOFF_JSON"
```
</step_output>

---

STOP. Do not proceed to the next step. Save StepHandoff via POST /api/steps/plan-phase/{PHASE}/handoff and return control to the workflow router.
