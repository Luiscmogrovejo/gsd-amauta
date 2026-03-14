<purpose>
Execute all plans in a phase using wave-based parallel execution. Orchestrator stays lean — delegates plan execution to subagents.
</purpose>

<core_principle>
Orchestrator coordinates, not executes. Each subagent loads the full execute-plan context. Orchestrator: discover plans → analyze deps → group waves → spawn agents → handle checkpoints → collect results.
</core_principle>

<required_reading>
Read STATE.md before any operation to load project context.
</required_reading>

<process>

<step name="initialize" priority="first">
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
AMAUTA_CLI="node $HOME/.claude/get-shit-done/bin/gsd-amauta.cjs"
AMAUTA_OK=$($AMAUTA_CLI health --json 2>/dev/null | grep -c '"status":"ok"' || echo "0")

# If available, look up or create a task for this phase execution
if [ "$AMAUTA_OK" = "1" ]; then
  # Search for existing task matching this phase
  PHASE_TASK_ID=$($AMAUTA_CLI exec search "phase ${PHASE_NUMBER}" --json 2>/dev/null | grep -oE 'TK-[0-9]+' | head -1 || echo "")
fi
```
</step>

<step name="handle_branching">
Check `branching_strategy` from init:

**"none":** Skip, continue on current branch.

**"phase" or "milestone":** Use pre-computed `branch_name` from init:
```bash
git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
```

All subsequent commits go to this branch. User handles merging.
</step>

<step name="validate_phase">
From init JSON: `phase_dir`, `plan_count`, `incomplete_count`.

Report: "Found {plan_count} plans in {phase_dir} ({incomplete_count} incomplete)"
</step>

<step name="discover_and_group_plans">
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

**Amauta: Register plans as tasks (if daemon available):**

For each incomplete plan, create an amauta task so progress is tracked in the task manager:

```bash
if [ "$AMAUTA_OK" = "1" ]; then
  # Create a story for this phase execution (if not already existing)
  PHASE_STORY=$($AMAUTA_CLI exec add story "Phase ${PHASE_NUMBER}: ${PHASE_NAME}" --agent operator 2>/dev/null | grep -oE 'ST-[0-9]+' || echo "")

  # For each incomplete plan: create a task under the phase story
  for plan in ${incomplete_plans}; do
    PLAN_OBJECTIVE=$(echo "$PLAN_INDEX_JSON" | python3 -c "import sys,json; plans=json.load(sys.stdin)['plans']; [print(p['objective']) for p in plans if p['id']=='${plan}']" 2>/dev/null || echo "Execute plan ${plan}")

    # Route to executor by file patterns
    PLAN_FILES=$(echo "$PLAN_INDEX_JSON" | python3 -c "import sys,json; plans=json.load(sys.stdin)['plans']; [print(','.join(p.get('files_modified',[]))) for p in plans if p['id']=='${plan}']" 2>/dev/null || echo "")

    # Determine executor: frontend if .tsx/.css/.html, infra if Dockerfile/docker/ci, backend otherwise
    EXECUTOR="executor-general"
    if echo "$PLAN_FILES" | grep -qiE '\.(tsx|jsx|css|scss|html|vue|svelte)'; then
      EXECUTOR="executor-frontend"
    elif echo "$PLAN_FILES" | grep -qiE '(docker|ci|deploy|infra|nginx|terraform)'; then
      EXECUTOR="executor-infra"
    elif echo "$PLAN_FILES" | grep -qiE '\.(py|js|ts|go|rs|java|sql)'; then
      EXECUTOR="executor-backend"
    fi

    TASK_ID=$($AMAUTA_CLI exec add task "$PLAN_OBJECTIVE" --parent "$PHASE_STORY" --agent "$EXECUTOR" --priority high 2>/dev/null | grep -oE 'TK-[0-9]+' || echo "")
    # Store task ID for executor spawning — associate plan ID to Amauta task ID
    if [ -n "$TASK_ID" ]; then
      eval "PLAN_TASK_${plan//-/_}=$TASK_ID"
    fi
  done
fi
```
</step>

<step name="execute_waves">
Execute each wave in sequence. Within a wave: parallel if `PARALLELIZATION=true`, sequential if `false`.

**RPETD: Log R-phase before execution begins (if amauta available):**
```bash
if [ "$AMAUTA_OK" = "1" ] && [ -n "$PHASE_TASK_ID" ]; then
  $AMAUTA_CLI rpetd "$PHASE_TASK_ID" --phase R --content "Phase ${PHASE_NUMBER}: ${incomplete_count} incomplete plans across ${wave_count} waves. Dependencies analyzed, wave grouping determined." 2>/dev/null || true
fi
```

**For each wave:**

1. **Describe what's being built (BEFORE spawning):**

   Read each plan's `<objective>`. Extract what's being built and why.

   ```
   ---
   ## Wave {N}

   **{Plan ID}: {Plan Name}**
   {2-3 sentences: what this builds, technical approach, why it matters}

   Spawning {count} agent(s)...
   ---
   ```

   - Bad: "Executing terrain generation plan"
   - Good: "Procedural terrain generator using Perlin noise — creates height maps, biome zones, and collision meshes. Required before vehicle physics can interact with ground."

2. **Spawn executor agents:**

   Pass paths only — executors read files themselves with their fresh 200k context.
   This keeps orchestrator context lean (~10-15%).

    **Route to specialist executor** based on the plan's file patterns:
    - `.tsx/.jsx/.css/.html/.vue/.svelte` → `gsd-executor-frontend`
    - `.py/.js/.ts/.go/.rs/.java/.sql` → `gsd-executor-backend`
    - `Dockerfile/docker/ci/deploy/terraform` → `gsd-executor-infra`
    - Everything else → `gsd-executor-general`

    **Resolve values before spawning** (substitute these in the actual prompt):
    - `{plan_number}` = the plan ID (e.g. `01-03`)
    - `{phase_number}-{phase_name}` = e.g. `01-setup`
    - `{plan_objective}` = extracted from PLAN_INDEX_JSON for this plan (3-8 words describing what it builds)
    - `{routed_executor}` = one of: `gsd-executor-frontend`, `gsd-executor-backend`, `gsd-executor-infra`, `gsd-executor-general`
    - `{executor_model}` = from init JSON
    - `{plan_task_id}` = the Amauta TK-XXXX assigned to this plan (from PLAN_TASK_* var captured above), or empty string if Amauta unavailable
    - `{phase_dir}` = phase directory path (e.g. `.planning/phases/01-setup/`)
    - `{plan_file}` = plan filename (e.g. `01-03-PLAN.md`)

    ```
     Task(
       subagent_type="{routed_executor}",
       model="{executor_model}",
       prompt="
         <objective>
         Execute plan {plan_number} of phase {phase_number}-{phase_name}.
         Objective: {plan_objective}
         Commit each task atomically. Create SUMMARY.md. Update STATE.md and ROADMAP.md.
         </objective>

         <execution_context>
         @~/.claude/get-shit-done/workflows/execute-plan.md
         @~/.claude/get-shit-done/templates/summary.md
         @~/.claude/get-shit-done/references/checkpoints.md
         @~/.claude/get-shit-done/references/tdd.md
         </execution_context>

         <amauta_enrichment>
         BEFORE starting any work, run these context-enrichment commands (all wrapped in || true):

         1. RLM — find relevant existing code for '{plan_objective}':
            node ~/.claude/get-shit-done/bin/gsd-rlm.cjs query '{plan_objective}' --dir . --top-k 5 --compact 2>/dev/null || true

         2. Memory — find past learnings for '{plan_objective}':
            node ~/.claude/get-shit-done/bin/gsd-memory.cjs search '{plan_objective}' 2>/dev/null || true

         3. Amauta task ID for this plan: {plan_task_id}
            If non-empty, claim and log RPETD phases:
            CLI='node ~/.claude/get-shit-done/bin/amauta.cjs'
         $CLI claim {plan_task_id} --agent {routed_executor} 2>/dev/null || true
         # Read back enriched context (Layer 1 injects dependency/sibling/memory/SKB context at claim time)
         $CLI show {plan_task_id} 2>/dev/null || true
         # Log each phase as you complete it:
            $CLI rpetd {plan_task_id} --phase R --content 'R: [RLM findings + memory matches]' 2>/dev/null || true
            $CLI rpetd {plan_task_id} --phase P --content 'P: [approach, files to change]' 2>/dev/null || true
            $CLI rpetd {plan_task_id} --phase E --content 'E: [what was built, files changed, branch name]' 2>/dev/null || true
            $CLI rpetd {plan_task_id} --phase T --content 'T: [paste actual test/build output here]' 2>/dev/null || true
            $CLI rpetd {plan_task_id} --phase D --content 'D: [delivery summary]. LEARNING: [reusable insight]' 2>/dev/null || true

         4. After ALL work is done, store the key learning to memory:
            node ~/.claude/get-shit-done/bin/gsd-memory.cjs learn '[one sentence: what you learned that future agents should know]' 2>/dev/null || true
         </amauta_enrichment>

         <files_to_read>
         Read these files at execution start using the Read tool:
         - {phase_dir}/{plan_file} (Plan — this IS your execution instructions)
         - .planning/STATE.md (Project state)
         - .planning/config.json (Config, if exists)
         - ./CLAUDE.md (Project instructions, if exists — follow all project-specific guidelines)
         - .claude/skills/ or .agents/skills/ (Project skills, if either path exists — list then read each SKILL.md)
         </files_to_read>

         <success_criteria>
         - [ ] All plan tasks executed
         - [ ] Each task committed individually with meaningful message
         - [ ] SUMMARY.md created in plan directory
         - [ ] STATE.md updated with position and decisions
         - [ ] ROADMAP.md updated with plan progress
         - [ ] RLM queried for '{plan_objective}' before execution
         - [ ] Memory searched for '{plan_objective}' before execution
         - [ ] RPETD R/P/E/T/D phases logged to {plan_task_id} (if non-empty)
         - [ ] Key learning stored to memory after completion
         </success_criteria>
       "
     )
     ```

3. **Wait for all agents in wave to complete.**

4. **Report completion — spot-check claims first:**

   For each SUMMARY.md:
   - Verify first 2 files from `key-files.created` exist on disk
   - Check `git log --oneline --all --grep="{phase}-{plan}"` returns ≥1 commit
   - Check for `## Self-Check: FAILED` marker

   If ANY spot-check fails: report which plan failed, route to failure handler — ask "Retry plan?" or "Continue with remaining waves?"

   If pass:
   ```
   ---
   ## Wave {N} Complete

   **{Plan ID}: {Plan Name}**
   {What was built — from SUMMARY.md}
   {Notable deviations, if any}

   {If more waves: what this enables for next wave}
   ---
   ```

   **RPETD: Log E-phase after each successful wave (if amauta available):**
   ```bash
   if [ "$AMAUTA_OK" = "1" ] && [ -n "$PHASE_TASK_ID" ]; then
     $AMAUTA_CLI rpetd "$PHASE_TASK_ID" --phase E --content "Wave ${N}: ${plan_count} plans completed. ${summary_of_what_was_built}" 2>/dev/null || true
   fi
   ```

   - Bad: "Wave 2 complete. Proceeding to Wave 3."
   - Good: "Terrain system complete — 3 biome types, height-based texturing, physics collision meshes. Vehicle physics (Wave 3) can now reference ground surfaces."

5. **Handle failures:**

   **Known Claude Code bug (classifyHandoffIfNeeded):** If an agent reports "failed" with error containing `classifyHandoffIfNeeded is not defined`, this is a Claude Code runtime bug — not a GSD or agent issue. The error fires in the completion handler AFTER all tool calls finish. In this case: run the same spot-checks as step 4 (SUMMARY.md exists, git commits present, no Self-Check: FAILED). If spot-checks PASS → treat as **successful**. If spot-checks FAIL → treat as real failure below.

   For real failures: report which plan failed → ask "Continue?" or "Stop?" → if continue, dependent plans may also fail. If stop, partial completion report.

6. **Execute checkpoint plans between waves** — see `<checkpoint_handling>`.

7. **Proceed to next wave.**
</step>

<step name="checkpoint_handling">
Plans with `autonomous: false` require user interaction.

**Auto-mode checkpoint handling:**

Read auto-advance config (chain flag + user preference):
```bash
AUTO_CHAIN=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-get workflow._auto_chain_active 2>/dev/null || echo "false")
AUTO_CFG=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-get workflow.auto_advance 2>/dev/null || echo "false")
```

When executor returns a checkpoint AND (`AUTO_CHAIN` is `"true"` OR `AUTO_CFG` is `"true"`):
- **human-verify** → Auto-spawn continuation agent with `{user_response}` = `"approved"`. Log `⚡ Auto-approved checkpoint`.
- **decision** → Auto-spawn continuation agent with `{user_response}` = first option from checkpoint details. Log `⚡ Auto-selected: [option]`.
- **human-action** → Present to user (existing behavior below). Auth gates cannot be automated.

**Standard flow (not auto-mode, or human-action type):**

1. Spawn agent for checkpoint plan
2. Agent runs until checkpoint task or auth gate → returns structured state
3. Agent return includes: completed tasks table, current task + blocker, checkpoint type/details, what's awaited
4. **Present to user:**
   ```
   ## Checkpoint: [Type]

   **Plan:** 03-03 Dashboard Layout
   **Progress:** 2/3 tasks complete

   [Checkpoint Details from agent return]
   [Awaiting section from agent return]
   ```
5. User responds: "approved"/"done" | issue description | decision selection
6. **Spawn continuation agent (NOT resume)** using continuation-prompt.md template:
   - `{completed_tasks_table}`: From checkpoint return
   - `{resume_task_number}` + `{resume_task_name}`: Current task
   - `{user_response}`: What user provided
   - `{resume_instructions}`: Based on checkpoint type
7. Continuation agent verifies previous commits, continues from resume point
8. Repeat until plan completes or user stops

**Why fresh agent, not resume:** Resume relies on internal serialization that breaks with parallel tool calls. Fresh agents with explicit state are more reliable.

**Checkpoints in parallel waves:** Agent pauses and returns while other parallel agents may complete. Present checkpoint, spawn continuation, wait for all before next wave.
</step>

<step name="aggregate_results">
After all waves:

```markdown
## Phase {X}: {Name} Execution Complete

**Waves:** {N} | **Plans:** {M}/{total} complete

| Wave | Plans | Status |
|------|-------|--------|
| 1 | plan-01, plan-02 | ✓ Complete |
| CP | plan-03 | ✓ Verified |
| 2 | plan-04 | ✓ Complete |

### Plan Details
1. **03-01**: [one-liner from SUMMARY.md]
2. **03-02**: [one-liner from SUMMARY.md]

### Issues Encountered
[Aggregate from SUMMARYs, or "None"]
```
</step>

<step name="auto_validate_tasks">
**Amauta: Auto-spawn validators for completed tasks (if daemon available).**

After all waves complete, check if any amauta tasks moved through RPETD and need validation. The executor must NOT validate their own work.

```bash
if [ "$AMAUTA_OK" = "1" ]; then
  # List tasks in validation status
  VALIDATION_QUEUE=$($AMAUTA_CLI exec list --status validation --json 2>/dev/null || echo "")
fi
```

**For each task in validation status, spawn a validator agent:**

```
Task(
  subagent_type="gsd-validator",
  prompt="You are gsd-validator. Validate task {TASK_ID}.

  Read the validator protocol:
  @~/.claude/agents/gsd-validator.md

  Steps:
  1. Review task: node ~/.claude/get-shit-done/bin/gsd-amauta.cjs show {TASK_ID}
  2. Check all 5 RPETD phases have meaningful content
  3. Verify T-phase has actual test output (not placeholder)
  4. Verify D-phase has LEARNING: block
  5. Verify success criteria against artifacts (files, git commits, test output)
  6. Check git: git log --oneline --grep='{TASK_ID}'

  If ALL criteria met:
    node ~/.claude/get-shit-done/bin/gsd-amauta.cjs validate {TASK_ID} --pass --validator validator --notes 'PASS: <evidence>'
  If criteria NOT met:
    node ~/.claude/get-shit-done/bin/gsd-amauta.cjs validate {TASK_ID} --fail --validator validator --notes 'FAIL: <reason>' --subtasks '<fix1>|<fix2>'

  Return: task ID, pass/fail, and notes."
)
```

**Parallel validation:** If multiple tasks are in validation status, spawn all validators in parallel (one Task call per task in a single message).

**Skip if:** No amauta daemon, or no tasks in validation status.
</step>

<step name="close_parent_artifacts">
**For decimal/polish phases only (X.Y pattern):** Close the feedback loop by resolving parent UAT and debug artifacts.

**Skip if** phase number has no decimal (e.g., `3`, `04`) — only applies to gap-closure phases like `4.1`, `03.1`.

**1. Detect decimal phase and derive parent:**
```bash
# Check if phase_number contains a decimal
if [[ "$PHASE_NUMBER" == *.* ]]; then
  PARENT_PHASE="${PHASE_NUMBER%%.*}"
fi
```

**2. Find parent UAT file:**
```bash
PARENT_INFO=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" find-phase "${PARENT_PHASE}" --raw)
# Extract directory from PARENT_INFO JSON, then find UAT file in that directory
```

**If no parent UAT found:** Skip this step (gap-closure may have been triggered by VERIFICATION.md instead).

**3. Update UAT gap statuses:**

Read the parent UAT file's `## Gaps` section. For each gap entry with `status: failed`:
- Update to `status: resolved`

**4. Update UAT frontmatter:**

If all gaps now have `status: resolved`:
- Update frontmatter `status: diagnosed` → `status: resolved`
- Update frontmatter `updated:` timestamp

**5. Resolve referenced debug sessions:**

For each gap that has a `debug_session:` field:
- Read the debug session file
- Update frontmatter `status:` → `resolved`
- Update frontmatter `updated:` timestamp
- Move to resolved directory:
```bash
mkdir -p .planning/debug/resolved
mv .planning/debug/{slug}.md .planning/debug/resolved/
```

**6. Commit updated artifacts:**
```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" commit "docs(phase-${PARENT_PHASE}): resolve UAT gaps and debug sessions after ${PHASE_NUMBER} gap closure" --files .planning/phases/*${PARENT_PHASE}*/*-UAT.md .planning/debug/resolved/*.md
```
</step>

<step name="verify_phase_goal">
Verify phase achieved its GOAL, not just completed tasks.

```
Task(
  prompt="Verify phase {phase_number} goal achievement.
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
| `passed` | → update_roadmap |
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
</step>

<step name="update_roadmap">
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
</step>

<step name="offer_next">

**Exception:** If `gaps_found`, the `verify_phase_goal` step already presents the gap-closure path (`/amauta:plan-phase {X} --gaps`). No additional routing needed — skip auto-advance.

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

Read and follow `~/.claude/get-shit-done/workflows/transition.md`, passing through the `--auto` flag so it propagates to the next phase invocation.

**If neither `--auto` nor `AUTO_CFG` is true:**

The workflow ends. The user runs `/amauta:progress` or invokes the transition workflow manually.
</step>

</process>

<context_efficiency>
Orchestrator: ~10-15% context. Subagents: fresh 200k each. No polling (Task blocks). No context bleed.
</context_efficiency>

<failure_handling>
- **classifyHandoffIfNeeded false failure:** Agent reports "failed" but error is `classifyHandoffIfNeeded is not defined` → Claude Code bug, not GSD. Spot-check (SUMMARY exists, commits present) → if pass, treat as success
- **Agent fails mid-plan:** Missing SUMMARY.md → report, ask user how to proceed
- **Dependency chain breaks:** Wave 1 fails → Wave 2 dependents likely fail → user chooses attempt or skip
- **All agents in wave fail:** Systemic issue → stop, report for investigation
- **Checkpoint unresolvable:** "Skip this plan?" or "Abort phase execution?" → record partial progress in STATE.md
</failure_handling>

<resumption>
Re-run `/amauta:execute-phase {phase}` → discover_plans finds completed SUMMARYs → skips them → resumes from first incomplete plan → continues wave execution.

STATE.md tracks: last completed plan, current wave, pending checkpoints.
</resumption>

<amauta_integration>
## Amauta RPETD Integration

When the Amauta daemon is available, this workflow logs RPETD phases automatically:

| Step | RPETD Phase | What's logged |
|------|-------------|---------------|
| discover_plans | R (Research) | Plan inventory, wave grouping, dependencies |
| execute_waves start | P (Plan) | Wave execution strategy, parallelism config |
| wave complete | E (Execute) | What was built per wave, deviations |
| verify_phase_goal | T (Test) | Verification status (passed/gaps/human_needed) |
| update_roadmap | D (Document) | Phase completion, key learnings |

**Graceful degradation:** All RPETD logging is wrapped in `2>/dev/null || true`. If the daemon is unavailable, execution proceeds normally without any impact.

**CLI tools used:**
- `gsd-amauta.cjs rpetd` — Log RPETD phase content
- `gsd-amauta.cjs health` — Check daemon availability
- `gsd-memory.cjs learn` — Store phase learnings to PG memory
</amauta_integration>
