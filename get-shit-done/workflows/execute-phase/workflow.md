<purpose>
Router for sharded execute-phase workflow. Loads step files sequentially with StepHandoff
validation between each step. Entry point for /amauta:execute-phase Skill.

Step sequence: step-01-prepare → step-02-route → step-03-execute → step-04-verify → step-05-validate → step-06-close

This file is Layer 3 of 3-layer HALT enforcement:
  Layer 1 — HALT instruction in each step file (executor instruction)
  Layer 2 — step-orchestrator.py validate_handoff (service validation)
  Layer 3 — this router verifying PG handoff before advancing (workflow gate)
</purpose>

## 1. Parse Arguments

Extract phase number from $ARGUMENTS (same as original execute-phase.md):

```bash
PHASE=$(echo "$ARGUMENTS" | grep -oP '(?<=^|\s)\d+(\.\d+)?' | head -1)
if [ -z "$PHASE" ]; then
  echo "Error: No phase number provided. Usage: /amauta:execute-phase <phase>"
  exit 1
fi
```

## 2. Legacy Fallback Check

Check if legacy workflows are enabled:

```bash
USE_LEGACY=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" config-get workflow.use_legacy_workflows 2>/dev/null || echo "false")
```

**If `USE_LEGACY` is "true":**

Read fully and follow: @/Users/luismogrovejo/.claude/get-shit-done/workflows/execute-phase-legacy.md

HALT — do not proceed to step 3 when legacy mode is active.

## 3. Load or Resume StepHandoff (Layer 3 HALT Enforcement)

Query the daemon for any existing handoff for this workflow+phase:

```bash
HANDOFF=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}" 2>/dev/null || echo '{}')
STEP_ID=$(echo "$HANDOFF" | jq -r '.step_id // empty')
NEXT_STEP=$(echo "$HANDOFF" | jq -r '.next_step // empty')
```

**If `STEP_ID` is non-empty and `NEXT_STEP` is non-empty:**
Resuming from existing handoff. Display:
```
Resuming execute-phase workflow at: ${NEXT_STEP}
Completed steps: $(echo "$HANDOFF" | jq -r '.completed_steps | join(", ")')
```
Set `CURRENT_STEP=${NEXT_STEP}`.

**If `STEP_ID` is empty (no handoff found):**
Starting fresh workflow. Set `CURRENT_STEP=step-01-prepare`.

**If `STEP_ID` is non-empty and `NEXT_STEP` is null or empty:**
Workflow was previously completed. Display:
```
Execute-phase workflow for phase ${PHASE} is already complete.
Run /amauta:progress to see phase status.
```
HALT — do not proceed.

## 4. Execute Steps Sequentially

Execute each step in order. After each step, verify a StepHandoff was saved.

### Step 01: Prepare

**If `CURRENT_STEP` is step-01-prepare or workflow is fresh:**

Read fully and follow: steps/step-01-prepare.md

**After step-01-prepare returns — verify handoff (Layer 3 gate):**

```bash
HANDOFF_01=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_01=$(echo "$HANDOFF_01" | jq -r '.step_id // empty')
```

If `SAVED_01` is empty:
```
HALT: step-01-prepare did not produce a valid StepHandoff. Cannot proceed to step-02-route.
Fix: Ensure step-01-prepare saves handoff via POST /api/steps/execute-phase/${PHASE}/handoff before returning.
```

### Step 02: Route

**If `CURRENT_STEP` is step-02-route or prior step produced next_step=step-02-route:**

Read fully and follow: steps/step-02-route.md

**After step-02-route returns — verify handoff:**

```bash
HANDOFF_02=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_02=$(echo "$HANDOFF_02" | jq -r '.step_id // empty')
```

If `SAVED_02` is empty or step_id is still step-01-prepare:
```
HALT: step-02-route did not produce a valid StepHandoff. Cannot proceed to step-03-execute.
```

### Step 03: Execute

**If `CURRENT_STEP` is step-03-execute or prior step produced next_step=step-03-execute:**

Read fully and follow: steps/step-03-execute.md

**After step-03-execute returns — verify handoff:**

```bash
HANDOFF_03=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_03=$(echo "$HANDOFF_03" | jq -r '.step_id // empty')
```

If `SAVED_03` is empty or step not advanced:
```
HALT: step-03-execute did not produce a valid StepHandoff. Cannot proceed to step-04-verify.
```

### Step 04: Verify

**If `CURRENT_STEP` is step-04-verify or prior step produced next_step=step-04-verify:**

Read fully and follow: steps/step-04-verify.md

**After step-04-verify returns — verify handoff:**

```bash
HANDOFF_04=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_04=$(echo "$HANDOFF_04" | jq -r '.step_id // empty')
```

If `SAVED_04` is empty or step not advanced:
```
HALT: step-04-verify did not produce a valid StepHandoff. Cannot proceed to step-05-validate.
```

### Step 05: Validate

**If `CURRENT_STEP` is step-05-validate or prior step produced next_step=step-05-validate:**

Read fully and follow: steps/step-05-validate.md

**After step-05-validate returns — verify handoff:**

```bash
HANDOFF_05=$(curl -s "http://127.0.0.1:18799/api/steps/execute-phase/${PHASE}" 2>/dev/null || echo '{}')
SAVED_05=$(echo "$HANDOFF_05" | jq -r '.step_id // empty')
```

If `SAVED_05` is empty or step not advanced:
```
HALT: step-05-validate did not produce a valid StepHandoff. Cannot proceed to step-06-close.
```

### Step 06: Close

**If `CURRENT_STEP` is step-06-close or prior step produced next_step=step-06-close:**

Read fully and follow: steps/step-06-close.md

**After step-06-close returns:**

Final step. Workflow complete when step-06-close saves a handoff with next_step=null.

## 5. Completion

When step-06-close completes successfully, the execute-phase workflow is done.

---

<!-- Step sequence reference:
     step-01-prepare → step-02-route → step-03-execute → step-04-verify → step-05-validate → step-06-close
     Legacy fallback: ../execute-phase-legacy.md (config: workflow.use_legacy_workflows = true)
     JSON schema: schema/step-handoff.json
     Daemon endpoint: GET/POST http://127.0.0.1:18799/api/steps/execute-phase/{phase}
-->
