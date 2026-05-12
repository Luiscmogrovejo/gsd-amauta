<purpose>
Step 01 of sharded plan-phase workflow: Initialize phase context, validate phase against roadmap,
parse arguments, handle PRD express path, and load CONTEXT.md. Entry point for a fresh workflow run.

Part of Phase 41 SHARD-01 sharding of the 656-line plan-phase.md monolith.
</purpose>

<step_context>
This is the FIRST step. No prior StepHandoff exists. Read $ARGUMENTS from the workflow router context.
Required fields for this step: phase number from $ARGUMENTS, all init JSON fields.
</step_context>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@/Users/luismogrovejo/.claude/get-shit-done/references/ui-brand.md
</required_reading>

<process>

## 1. Initialize

Load all context in one call (paths only to minimize orchestrator context):

```bash
INIT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" init plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `researcher_model`, `planner_model`, `checker_model`, `research_enabled`, `plan_checker_enabled`, `nyquist_validation_enabled`, `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`, `has_plans`, `plan_count`, `planning_exists`, `roadmap_exists`, `phase_req_ids`.

**File paths (for <files_to_read> blocks):** `state_path`, `roadmap_path`, `requirements_path`, `context_path`, `research_path`, `verification_path`, `uat_path`. These are null if files don't exist.

**If `planning_exists` is false:** Error — run `/amauta:new-project` first.

## 2. Parse and Normalize Arguments

Extract from $ARGUMENTS: phase number (integer or decimal like `2.1`), flags (`--research`, `--skip-research`, `--gaps`, `--skip-verify`, `--prd <filepath>`).

Extract `--prd <filepath>` from $ARGUMENTS. If present, set PRD_FILE to the filepath.

**If no phase number:** Detect next unplanned phase from roadmap.

**If `phase_found` is false:** Validate phase exists in ROADMAP.md. If valid, create the directory using `phase_slug` and `padded_phase` from init:
```bash
mkdir -p ".planning/phases/${padded_phase}-${phase_slug}"
```

**Existing artifacts from init:** `has_research`, `has_plans`, `plan_count`.

## 2.5. Compute Complexity Score (Phase 42 / SCALE-01)

Before any plan-checker or research, compute the complexity score for this phase.

```bash
PLAN_PATH=""  # plans don't exist yet at step-01-init for fresh runs
SCORE_JSON=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" complexity-score "" \
  --task-id "${PHASE}-plan-phase" \
  --phase "${PHASE}" \
  --workflow plan-phase 2>/dev/null || echo '{"score":0,"chosen_phases":["R","P","E","T"],"override_source":"fallback","banner":"Phase 42 scorer unavailable; defaulting to R,P,E,T."}')

COMPLEXITY_SCORE=$(echo "$SCORE_JSON" | jq -r '.score // 0')
CHOSEN_PHASES=$(echo "$SCORE_JSON" | jq -c '.chosen_phases // ["R","P","E","T"]')
OVERRIDE_SOURCE=$(echo "$SCORE_JSON" | jq -r '.override_source // "auto"')
BANNER=$(echo "$SCORE_JSON" | jq -r '.banner // ""')
echo "$BANNER"
```

Persist `COMPLEXITY_SCORE`, `CHOSEN_PHASES`, and `OVERRIDE_SOURCE` for inclusion in the StepHandoff (step_output below).

## 3. Validate Phase

```bash
PHASE_INFO=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" roadmap get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases. **If `found` is true:** Extract `phase_number`, `phase_name`, `goal` from JSON.

## 3.5. Handle PRD Express Path

**Skip if:** No `--prd` flag in arguments.

**If `--prd <filepath>` provided:**

1. Read the PRD file:
```bash
PRD_CONTENT=$(cat "$PRD_FILE" 2>/dev/null)
if [ -z "$PRD_CONTENT" ]; then
  echo "Error: PRD file not found: $PRD_FILE"
  exit 1
fi
```

2. Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AMAUTA ► PRD EXPRESS PATH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Using PRD: {PRD_FILE}
Generating CONTEXT.md from requirements...
```

3. Parse the PRD content and generate CONTEXT.md. The orchestrator should:
   - Extract all requirements, user stories, acceptance criteria, and constraints from the PRD
   - Map each to a locked decision (everything in the PRD is treated as a locked decision)
   - Identify any areas the PRD doesn't cover and mark as "Claude's Discretion"
   - **Extract canonical refs** from ROADMAP.md for this phase, plus any specs/ADRs referenced in the PRD — expand to full file paths (MANDATORY)
   - Create CONTEXT.md in the phase directory

4. Write CONTEXT.md:
```markdown
# Phase [X]: [Name] - Context

**Gathered:** [date]
**Status:** Ready for planning
**Source:** PRD Express Path ({PRD_FILE})

<domain>
## Phase Boundary

[Extracted from PRD — what this phase delivers]

</domain>

<decisions>
## Implementation Decisions

{For each requirement/story/criterion in the PRD:}
### [Category derived from content]
- [Requirement as locked decision]

### Claude's Discretion
[Areas not covered by PRD — implementation details, technical choices]

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

[MANDATORY. Extract from ROADMAP.md and any docs referenced in the PRD.
Use full relative paths. Group by topic area.]

### [Topic area]
- `path/to/spec-or-adr.md` — [What it decides/defines]

[If no external specs: "No external specs — requirements fully captured in decisions above"]

</canonical_refs>

<specifics>
## Specific Ideas

[Any specific references, examples, or concrete requirements from PRD]

</specifics>

<deferred>
## Deferred Ideas

[Items in PRD explicitly marked as future/v2/out-of-scope]
[If none: "None — PRD covers phase scope"]

</deferred>

---

*Phase: XX-name*
*Context gathered: [date] via PRD Express Path*
```

5. Commit:
```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" commit "docs(${padded_phase}): generate context from PRD" --files "${phase_dir}/${padded_phase}-CONTEXT.md"
```

6. Set `context_content` to the generated CONTEXT.md content and continue to step 4 (Load CONTEXT.md is skipped — CONTEXT.md was just created).

**Effect:** This completely bypasses step 4 (Load CONTEXT.md) since we just created it. The rest of the workflow (research, planning, verification) proceeds normally with the PRD-derived context.

## 4. Load CONTEXT.md

**Skip if:** PRD express path was used (CONTEXT.md already created in step 3.5).

Check `context_path` from init JSON.

If `context_path` is not null, display: `Using phase context from: ${context_path}`

**If `context_path` is null (no CONTEXT.md exists):**

Use AskUserQuestion:
- header: "No context"
- question: "No CONTEXT.md found for Phase {X}. Plans will use research and requirements only — your design preferences won't be included. Continue or capture context first?"
- options:
  - "Continue without context" — Plan using research + requirements only
  - "Run discuss-phase first" — Capture design decisions before planning

If "Continue without context": Proceed to step_output block.
If "Run discuss-phase first": Display `/amauta:discuss-phase {X}` and exit workflow.

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/plan-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "plan-phase",
  "step_id": "step-01-init",
  "task_id": "{PHASE}-plan-phase",
  "phase_number": {PHASE},
  "completed_steps": ["step-01-init"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "context_path": "{context_path}",
    "research_enabled": "{research_enabled}",
    "plan_checker_enabled": "{plan_checker_enabled}",
    "nyquist_validation_enabled": "{nyquist_validation_enabled}",
    "phase_req_ids": "{phase_req_ids}",
    "complexity_score": "{COMPLEXITY_SCORE}",
    "chosen_phases": "{CHOSEN_PHASES}",
    "override_source": "{OVERRIDE_SOURCE}",
    "state_path": "{state_path}",
    "roadmap_path": "{roadmap_path}",
    "requirements_path": "{requirements_path}",
    "research_path": "{research_path}",
    "verification_path": "{verification_path}",
    "uat_path": "{uat_path}",
    "padded_phase": "{padded_phase}",
    "researcher_model": "{researcher_model}",
    "planner_model": "{planner_model}",
    "checker_model": "{checker_model}",
    "commit_docs": "{commit_docs}"
  },
  "next_step": "step-02-research",
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
