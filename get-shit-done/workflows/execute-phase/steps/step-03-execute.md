<purpose>
Step 03 of sharded execute-phase workflow: Execute all waves by spawning executor agents, running
manifest checks (HARDEN-01), handling checkpoints, aggregating results, auto-validating tasks,
and closing parent artifacts for decimal phases.

Part of Phase 41 SHARD-02 sharding of the 840-line execute-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/execute-phase/{PHASE} to load context from step-02-route.
Required fields from prior handoff: wave_groups, plan_task_ids, executor_assignments,
phase_dir, phase_number, phase_name, executor_model, verifier_model, parallelization,
amauta_ok, phase_task_id, phase_req_ids.
</step_context>

<process>

## 1. Execute Waves

Execute each wave in sequence. Within a wave: parallel if `PARALLELIZATION=true`, sequential if `false`.

**RPETD: Log R-phase and P-phase before execution begins (if amauta available):**
```bash
if [ "$AMAUTA_OK" = "1" ] && [ -n "$PHASE_TASK_ID" ]; then
  $AMAUTA_CLI rpetd "$PHASE_TASK_ID" --phase R --content "Phase ${PHASE_NUMBER}: ${incomplete_count} incomplete plans across ${wave_count} waves. Dependencies analyzed, wave grouping determined." 2>/dev/null || true
  $AMAUTA_CLI rpetd "$PHASE_TASK_ID" --phase P --content "P: Wave execution strategy — ${wave_count} waves, parallelization=${PARALLELIZATION}. Plan order: ${incomplete_plans}" 2>/dev/null || true
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

    **Route to specialist executor** via `gsd-tools.cjs route-executor` (single source of truth):
    - `.tsx/.jsx/.css/.scss/.html/.vue/.svelte` → `gsd-executor-frontend`
    - `Dockerfile/docker-compose/.github/workflows/terraform/k8s/nginx.conf` → `gsd-executor-infra`
    - `.py/.js/.cjs/.mjs/.ts/.go/.rs/.java/.sql` → `gsd-executor-backend`
    - Everything else → `gsd-executor-general`
    - Performance data: If primary executor has <70% pass rate (5+ tasks), falls back to executor-general

    **Resolve values before spawning** (substitute these in the actual prompt):
    - `{plan_number}` = the plan ID (e.g. `01-03`)
    - `{phase_number}-{phase_name}` = e.g. `01-setup`
    - `{plan_objective}` = extracted from PLAN_INDEX_JSON for this plan (3-8 words describing what it builds)
    - `{routed_executor}` = one of: `gsd-executor-frontend`, `gsd-executor-backend`, `gsd-executor-infra`, `gsd-executor-general`
    - `{executor_model}` = from init JSON
    - `{plan_task_id}` = the Amauta TK-XXXX assigned to this plan (from PLAN_TASK_* var captured above), or empty string if Amauta unavailable
    - `{phase_dir}` = phase directory path (e.g. `.planning/phases/01-setup/`)
    - `{plan_file}` = plan filename (e.g. `01-03-PLAN.md`)

    ```bash
    # Phase 53 POLISH-05 hydration hook
    # Phase 53 POLISH-05: hydration hook (honors GSD_HYDRATE_TASKS=off kill switch)
    if [ "${GSD_HYDRATE_TASKS:-on}" != "off" ]; then
      HYDRATION=$($HYDRATE_CMD "${AGENT_NAME}" --task-id "${TASK_ID:-}" --terse 2>/dev/null || echo "")
    else
      HYDRATION=""
    fi
    ```

    ```
     Task(
       subagent_type="{routed_executor}",
       model="{executor_model}",
       prompt="
         <current_context>${HYDRATION}</current_context>

         <objective>
         Execute plan {plan_number} of phase {phase_number}-{phase_name}.
         Objective: {plan_objective}
         Commit each task atomically. Create SUMMARY.md. Update STATE.md and ROADMAP.md.
         </objective>

         <execution_context>
         @/Users/luismogrovejo/.claude/get-shit-done/workflows/execute-plan.md
         @/Users/luismogrovejo/.claude/get-shit-done/templates/summary.md
         @/Users/luismogrovejo/.claude/get-shit-done/references/checkpoints.md
         @/Users/luismogrovejo/.claude/get-shit-done/references/tdd.md
         </execution_context>

         <amauta_enrichment>
         BEFORE starting any work, run these context-enrichment commands (all wrapped in || true):

         1. RLM — find relevant existing code for '{plan_objective}':
            node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-rlm.cjs query '{plan_objective}' --dir . --top-k 5 --compact 2>/dev/null || true

         2. Memory — find past learnings for '{plan_objective}':
            node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs search '{plan_objective}' 2>/dev/null || true

         2b. Research chain — get current info (memory -> SKB -> Context7 -> Perplexity -> WebFetch):
             # Phase 13: --creative + --task-type enable creative query variants for research/exploration tasks
             # Creative is gated by task type -- implementation/bug-fix tasks use conservative cascade
             # Kill switch: GSD_R_CREATIVE=off disables creative entirely
             node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-research.cjs search '{plan_objective}' --creative --task-type {execution_type} 2>/dev/null || true

         3. Amauta task ID for this plan: {plan_task_id}
            If non-empty, claim and log RPETD phases:
            CLI='node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs'
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
            node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs learn '[one sentence: what you learned that future agents should know]' 2>/dev/null || true
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

   #### Per-task manifest check (HARDEN-01)

   The `manifest-check` subcommand from `get-shit-done/bin/gsd-tools.cjs` runs once per task and compares the git diff between the before/after shas against the task's declared `files_expected:` block.

   For each task in the wave:

   1. **Before dispatching the executor**, capture the baseline sha:
      ```
      GIT_SHA_BEFORE=$(git rev-parse HEAD)
      ```
   2. **After the executor returns**, capture the post sha:
      ```
      GIT_SHA_AFTER=$(git rev-parse HEAD)
      ```
   3. **Staging `.planning/` files declared in `files_expected:`** — there are two cases:
      - **already-tracked `.planning/` files** (e.g. `.planning/STATE.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md` — all tracked despite the `.planning/` gitignore rule because they were force-added once at project init): stage with `git add -u <path>`. The `-u` flag updates tracked files only and bypasses the gitignore rule without forcing. Both the orchestrator AND executors may use `-u` for paths declared in `files_expected:` — it is not a privileged operation. This is the common case.
      - **Newly created `.planning/` files** (a path that is gitignored and not yet tracked — e.g. first-time creation of a new artifact under `.planning/`): only the orchestrator uses `git add -f <path>`. Executors are FORBIDDEN from using `git add -f` under any circumstance. An executor that encounters this case MUST surface a divergence via `get-shit-done/references/divergence-protocol.md` and return control to the orchestrator — do NOT force-add and do NOT silently skip.
   4. **Run the manifest check**:
      ```
      node get-shit-done/bin/gsd-tools.cjs manifest-check \
        --phase <phase> --wave <wave> --task-id <task_id> \
        --files-expected <path-to-task-manifest-yaml> \
        --before "$GIT_SHA_BEFORE" --after "$GIT_SHA_AFTER"
      ```
   5. **Exit handling**:
      - Exit 0 → task passed manifest check, proceed.
      - Exit 1 with `orchestrator_action: "halt"` → HARD HALT the wave. Read the violation report and surface it. Do not continue to the next task.
      - Exit 1 with `orchestrator_action: "halt_orchestrator_owned"` → HARD HALT always. This override ignores `GSD_MANIFEST_CHECK=warn`.
      - `GSD_MANIFEST_CHECK=warn` → exit 0, but the violation report is still written with `orchestrator_action: "warn"`. Log the warning inline. This override is removed in v2.7.

   #### Migration note

   The `manifest-check` step is MANDATORY for phases 13.1 and later. Phases 9-13 are grandfathered; the orchestrator skips `manifest-check` if the PLAN.md lacks a `files_expected:` block. See `.planning/STATE.md` for the migration cutoff note.

   ### Validator verdict routing (HARDEN-04)

   After `gsd-validator` completes for a phase, it exits with one of three codes. The orchestrator routes based on exit code, not on verdict prose:

   | Exit | Verdict | Routing |
   |------|---------|---------|
   | 0 | `pass` | Phase advances. Roadmap updated. STATE.md progress bumped. |
   | 2 | `gaps_found` | Phase does NOT advance. Read `.planning/phases/<phase>/gaps-report-<timestamp>.json`. For each gap, route the owning `requirement_id` back to `gsd-planner` for a delta plan. Run a mini-wave of the new plan(s). Re-invoke `gsd-validator`. **No retry counter** — gaps_found is not a failure. Repeat until `pass` or `fail`. |
   | 1 | `fail` | Phase does NOT advance. FATAL. Invoke `gsd-roadmapper` for escalation. Human review required. **No auto-retry.** |

   **Auto-escalation separation:** `gaps_found` does NOT count toward the 3-consecutive-failures auto-escalation rule. Only `fail` (exit 1) counts. Track `gaps_rate_per_phase` as a separate signal — high gaps rate is a planner signal, not a failure signal.

   **Pressure-release valve:** Genuinely cosmetic findings go into `non_gaps_observations[]` in the gaps report, not into the `gaps[]` array. The orchestrator ignores `non_gaps_observations[]` for routing (it is advisory to the planner only).

   **No severity tagging:** All entries in `gaps[]` are equal. The orchestrator does not prioritize one gap over another; the planner handles priority in the delta plan.

   **Validator pre-gate scan interlock:** If the validator finds unresolved divergence reports in `.planning/phases/<phase>/divergence-reports/`, it floors the verdict at `gaps_found`. See `get-shit-done/references/divergence-protocol.md` for the scan protocol.

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

6. **Execute checkpoint plans between waves** — see checkpoint handling below.

7. **Proceed to next wave.**

## 2. Checkpoint Handling

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

## 3. Aggregate Results

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

## 3.5. Detect Escalation (Phase 42 / SCALE-04)

After all waves complete, check for divergence triggers that warrant escalation BEFORE handing off to step-04-verify.

```bash
# Build an executor_report.json with files_touched count + complexity_surprise flag.
# files_touched: count distinct files appearing in any task's files_expected modify+create.
# complexity_surprise: true if any task's executor summary contains "COMPLEXITY_SURPRISE" marker.
EXECUTOR_REPORT=$(mktemp --suffix=.json)
cat <<EOF > "$EXECUTOR_REPORT"
{
  "files_touched": ${TOTAL_FILES_TOUCHED:-0},
  "complexity_surprise": ${COMPLEXITY_SURPRISE_FLAG:-false},
  "manifest_violation": ${MANIFEST_VIOLATION_FLAG:-false}
}
EOF

ESCALATION_RESULT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" complexity-escalate \
  "${PHASE_NUMBER}-execute-phase" \
  --phase "${PHASE_NUMBER}" \
  --workflow execute-phase \
  --executor-report @"$EXECUTOR_REPORT" 2>/dev/null || echo '{"escalated":false}')

rm -f "$EXECUTOR_REPORT"

if [ "$(echo "$ESCALATION_RESULT" | jq -r '.escalated')" = "true" ]; then
  echo "$ESCALATION_RESULT" | jq -r '.banner'
  # The daemon already saved the escalated handoff; the workflow router will see the new chosen_phases.
fi
```

The TOTAL_FILES_TOUCHED, COMPLEXITY_SURPRISE_FLAG, and MANIFEST_VIOLATION_FLAG variables must be populated from the wave-results aggregation already in this step file (executor agents return a summary block per Phase 13 patterns). If those variables aren't already set in the aggregation, add lines to extract them with the same `jq` patterns used for other result fields.

<!-- aggregate_wave_results / Uses services/complexity_scorer.py via the daemon endpoint (gsd-tools complexity-escalate) -->

## 4. Auto-Validate Tasks

**Amauta: Auto-spawn validators for completed tasks (if daemon available).**

After all waves complete, check if any amauta tasks moved through RPETD and need validation. The executor must NOT validate their own work.

```bash
if [ "$AMAUTA_OK" = "1" ]; then
  # List tasks in validation status
  VALIDATION_QUEUE=$($AMAUTA_CLI exec list --status validation --json 2>/dev/null || echo "")
fi
```

**For each task in validation status, spawn a validator agent:**

```bash
# Phase 53 POLISH-05 hydration hook
# Phase 53 POLISH-05: hydration hook (honors GSD_HYDRATE_TASKS=off kill switch)
if [ "${GSD_HYDRATE_TASKS:-on}" != "off" ]; then
  HYDRATION=$($HYDRATE_CMD "gsd-validator" --task-id "${TASK_ID:-}" --terse 2>/dev/null || echo "")
else
  HYDRATION=""
fi
```

```
Task(
  subagent_type="gsd-validator",
  prompt="<current_context>${HYDRATION}</current_context>

You are gsd-validator. Validate task {TASK_ID}.

  Read the validator protocol:
  @/Users/luismogrovejo/.claude/agents/gsd-validator.md

  Steps:
  1. Review task: node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs show {TASK_ID}
  2. Check all 5 RPETD phases have meaningful content
  3. Verify T-phase has actual test output (not placeholder)
  4. Verify D-phase has LEARNING: block
  5. Verify success criteria against artifacts (files, git commits, test output)
  6. Check git: git log --oneline --grep='{TASK_ID}'

  If ALL criteria met:
    node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs validate {TASK_ID} --pass --validator validator --notes 'PASS: <evidence>'
  If criteria NOT met:
    node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs validate {TASK_ID} --fail --validator validator --notes 'FAIL: <reason>' --subtasks '<fix1>|<fix2>'

  Return: task ID, pass/fail, and notes."
)
```

**Parallel validation:** If multiple tasks are in validation status, spawn all validators in parallel (one Task call per task in a single message).

**Skip if:** No amauta daemon, or no tasks in validation status.

## 5. Close Parent Artifacts (decimal phases only)

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
- **Recovery classification (AGT-06):** When a task is validated as failed, it is automatically classified:
  - TRANSIENT: retry the task (same agent) — environmental/timing issue
  - GATE_FAIL: return to executor to fix specific RPETD gate failures (most common)
  - CAPABILITY_MISMATCH: reroute to executor-general or a different specialist
  - SYSTEMIC: auto-escalated after 3 failures — requires operator investigation
  Check task notes for `FAILURE_CLASSIFIED:` and `AUTO_ESCALATED:` entries.
  After 3 failures, the task status becomes `escalated` (not `pending`).
</failure_handling>

<resumption>
Re-run `/amauta:execute-phase {phase}` → discover_plans finds completed SUMMARYs → skips them → resumes from first incomplete plan → continues wave execution.

STATE.md tracks: last completed plan, current wave, pending checkpoints.
</resumption>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/execute-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "execute-phase",
  "step_id": "step-03-execute",
  "task_id": "{PHASE}-execute-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-prepare", "step-02-route", "step-03-execute"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "amauta_ok": "{amauta_ok}",
    "phase_task_id": "{phase_task_id}",
    "phase_req_ids": "{phase_req_ids}",
    "verifier_model": "{verifier_model}"
  },
  "artifacts": {
    "wave_results": "{wave_results_json}",
    "completed_plans": "{completed_plans_array}",
    "failed_plans": "{failed_plans_array}",
    "checkpoint_resolutions": "{checkpoint_resolutions_json}"
  },
  "next_step": "step-04-verify",
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
