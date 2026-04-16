<purpose>
Router for sharded plan-phase workflow. Loads step files sequentially with StepHandoff
validation between each step. Entry point for /amauta:plan-phase Skill.

Step sequence: step-01-init → step-02-research → step-03-plan → step-04-check → step-05-approve

This file is Layer 3 of 3-layer HALT enforcement:
  Layer 1 — HALT instruction in each step file (executor instruction)
  Layer 2 — step-orchestrator.py validate_handoff (service validation)
  Layer 3 — this router verifying PG handoff before advancing (workflow gate)
</purpose>

## 1. Parse Arguments

Extract phase number from $ARGUMENTS (same as original plan-phase.md sections 1-2):

```bash
PHASE=$(echo "$ARGUMENTS" | grep -oP '(?<=^|\s)\d+(\.\d+)?' | head -1)
if [ -z "$PHASE" ]; then
  echo "Error: No phase number provided. Usage: /amauta:plan-phase <phase>"
  exit 1
fi
```

## 2. Legacy Fallback Check

Check if legacy workflows are enabled:

```bash
USE_LEGACY=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-get workflow.use_legacy_workflows 2>/dev/null || echo "false")
```

**If `USE_LEGACY` is "true":**

Read fully and follow: @/Users/luismogrovejo/.claude/get-shit-done/workflows/plan-phase-legacy.md

HALT — do not proceed to step 3 when legacy mode is active.

## 3. Load or Resume StepHandoff (Layer 3 HALT Enforcement)

Query the daemon for any existing handoff for this workflow+phase:

```bash
HANDOFF=$(curl -s "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}" 2>/dev/null || echo '{}')
STEP_ID=$(echo "$HANDOFF" | jq -r '.step_id // empty')
NEXT_STEP=$(echo "$HANDOFF" | jq -r '.next_step // empty')
```

**If `STEP_ID` is non-empty and `NEXT_STEP` is non-empty:**
Resuming from existing handoff. Display:
```
Resuming plan-phase workflow at: ${NEXT_STEP}
Completed steps: $(echo "$HANDOFF" | jq -r '.completed_steps | join(", ")')
```
Set `CURRENT_STEP=${NEXT_STEP}`.

**If `STEP_ID` is empty (no handoff found):**
Starting fresh workflow. Set `CURRENT_STEP=step-01-init`.

**If `STEP_ID` is non-empty and `NEXT_STEP` is null or empty:**
Workflow was previously completed. Display:
```
Plan-phase workflow for phase ${PHASE} is already complete.
Run /amauta:execute-phase ${PHASE} to execute the plans.
```
HALT — do not proceed.

## 4. Execute Steps Sequentially

Execute each step in order. After each step, verify a StepHandoff was saved.

### Step 01: Init

**If `CURRENT_STEP` is step-01-init or workflow is fresh:**

Read fully and follow: steps/step-01-init.md

**After step-01-init returns — verify handoff (Layer 3 gate):**

```bash
HANDOFF_01=$(curl -s "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_01=$(echo "$HANDOFF_01" | jq -r '.step_id // empty')
```

If `SAVED_01` is empty:
```
HALT: step-01-init did not produce a valid StepHandoff. Cannot proceed to step-02-research.
Fix: Ensure step-01-init saves handoff via POST /api/steps/plan-phase/${PHASE}/handoff before returning.
```

### Step 02: Research

**If `CURRENT_STEP` is step-02-research or prior step produced next_step=step-02-research:**

Read fully and follow: steps/step-02-research.md

**After step-02-research returns — verify handoff:**

```bash
HANDOFF_02=$(curl -s "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_02=$(echo "$HANDOFF_02" | jq -r '.step_id // empty')
```

If `SAVED_02` is empty or step_id is still step-01-init:
```
HALT: step-02-research did not produce a valid StepHandoff. Cannot proceed to step-03-plan.
```

### Step 03: Plan

**If `CURRENT_STEP` is step-03-plan or prior step produced next_step=step-03-plan:**

Read fully and follow: steps/step-03-plan.md

**After step-03-plan returns — verify handoff:**

```bash
HANDOFF_03=$(curl -s "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_03=$(echo "$HANDOFF_03" | jq -r '.step_id // empty')
```

If `SAVED_03` is empty or step not advanced:
```
HALT: step-03-plan did not produce a valid StepHandoff. Cannot proceed to step-04-check.
```

### Step 04: Check

**If `CURRENT_STEP` is step-04-check or prior step produced next_step=step-04-check:**

Read fully and follow: steps/step-04-check.md

**After step-04-check returns — verify handoff:**

```bash
HANDOFF_04=$(curl -s "http://127.0.0.1:18799/api/steps/plan-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_04=$(echo "$HANDOFF_04" | jq -r '.step_id // empty')
```

If `SAVED_04` is empty or step not advanced:
```
HALT: step-04-check did not produce a valid StepHandoff. Cannot proceed to step-05-approve.
```

### Step 05: Approve

**If `CURRENT_STEP` is step-05-approve or prior step produced next_step=step-05-approve:**

Read fully and follow: steps/step-05-approve.md

**After step-05-approve returns:**

Final step. Workflow complete when step-05-approve saves a handoff with next_step=null.

## 5. Completion

When step-05-approve completes successfully, route to offer_next (defined in step-05-approve.md).

---

<!-- Step sequence reference:
     step-01-init → step-02-research → step-03-plan → step-04-check → step-05-approve
     Legacy fallback: ../plan-phase-legacy.md (config: workflow.use_legacy_workflows = true)
     JSON schema: schema/step-handoff.json
     Daemon endpoint: GET/POST http://127.0.0.1:18799/api/steps/plan-phase/{phase}
-->
