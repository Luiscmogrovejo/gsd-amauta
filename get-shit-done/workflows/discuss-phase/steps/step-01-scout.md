<purpose>
Step 01 of sharded discuss-phase workflow: Initialize phase context, check existing CONTEXT.md,
load prior decisions from project files and prior phases, and scout the codebase for reusable
assets and integration points.

Part of Phase 41 SHARD-03 sharding of the 732-line discuss-phase.md monolith.
</purpose>

<step_context>
This is the FIRST step. No prior StepHandoff exists. Read $ARGUMENTS from the workflow router context.
Required fields: phase number from $ARGUMENTS, all init JSON fields.
</step_context>

<downstream_awareness>
**CONTEXT.md feeds into:**

1. **gsd-researcher** — Reads CONTEXT.md to know WHAT to research
   - "User wants card-based layout" → researcher investigates card component patterns
   - "Infinite scroll decided" → researcher looks into virtualization libraries

2. **gsd-planner** — Reads CONTEXT.md to know WHAT decisions are locked
   - "Pull-to-refresh on mobile" → planner includes that in task specs
   - "Claude's Discretion: loading skeleton" → planner can decide approach

**Your job:** Capture decisions clearly enough that downstream agents can act on them without asking the user again.

**Not your job:** Figure out HOW to implement. That's what research and planning do with the decisions you capture.
</downstream_awareness>

<philosophy>
**User = founder/visionary. Claude = builder.**

The user knows:
- How they imagine it working
- What it should look/feel like
- What's essential vs nice-to-have
- Specific behaviors or references they have in mind

The user doesn't know (and shouldn't be asked):
- Codebase patterns (researcher reads the code)
- Technical risks (researcher identifies these)
- Implementation approach (planner figures this out)
- Success metrics (inferred from the work)

Ask about vision and implementation choices. Capture decisions for downstream agents.
</philosophy>

<scope_guardrail>
**CRITICAL: No scope creep.**

The phase boundary comes from ROADMAP.md and is FIXED. Discussion clarifies HOW to implement what's scoped, never WHETHER to add new capabilities.

**Allowed (clarifying ambiguity):**
- "How should posts be displayed?" (layout, density, info shown)
- "What happens on empty state?" (within the feature)
- "Pull to refresh or manual?" (behavior choice)

**Not allowed (scope creep):**
- "Should we also add comments?" (new capability)
- "What about search/filtering?" (new capability)
- "Maybe include bookmarking?" (new capability)

**The heuristic:** Does this clarify how we implement what's already in the phase, or does it add a new capability that could be its own phase?

**When user suggests scope creep:**
```
"[Feature X] would be a new capability — that's its own phase.
Want me to note it for the roadmap backlog?

For now, let's focus on [phase domain]."
```

Capture the idea in a "Deferred Ideas" section. Don't lose it, don't act on it.
</scope_guardrail>

<process>

**Express path available:** If you already have a PRD or acceptance criteria document, use `/amauta:plan-phase {phase} --prd path/to/prd.md` to skip this discussion and go straight to planning.

## 1. Initialize

Phase number from argument (required).

```bash
INIT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" init phase-op "${PHASE}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `commit_docs`, `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_research`, `has_context`, `has_plans`, `has_verification`, `plan_count`, `roadmap_exists`, `planning_exists`.

**If `phase_found` is false:**
```
Phase [X] not found in roadmap.

Use /amauta:progress to see available phases.
```
Exit workflow.

**If `phase_found` is true:** Continue to check_existing.

## 2. Check Existing

Check if CONTEXT.md already exists using `has_context` from init.

```bash
ls ${phase_dir}/*-CONTEXT.md 2>/dev/null
```

**If exists:**
Use AskUserQuestion:
- header: "Context"
- question: "Phase [X] already has context. What do you want to do?"
- options:
  - "Update it" — Review and revise existing context
  - "View it" — Show me what's there
  - "Skip" — Use existing context as-is

If "Update": Load existing, continue to analyze_phase
If "View": Display CONTEXT.md, then offer update/skip
If "Skip": Exit workflow

**If doesn't exist:**

Check `has_plans` and `plan_count` from init. **If `has_plans` is true:**

Use AskUserQuestion:
- header: "Plans exist"
- question: "Phase [X] already has {plan_count} plan(s) created without user context. Your decisions here won't affect existing plans unless you replan."
- options:
  - "Continue and replan after" — Capture context, then run /amauta:plan-phase {X} to replan
  - "View existing plans" — Show plans before deciding
  - "Cancel" — Skip discuss-phase

If "Continue and replan after": Continue to analyze_phase.
If "View existing plans": Display plan files, then offer "Continue" / "Cancel".
If "Cancel": Exit workflow.

**If `has_plans` is false:** Continue to load_prior_context.

## 3. Load Prior Context

Read project-level and prior phase context to avoid re-asking decided questions and maintain consistency.

**Step 1: Read project-level files**
```bash
# Core project files
cat .planning/PROJECT.md 2>/dev/null
cat .planning/REQUIREMENTS.md 2>/dev/null
cat .planning/STATE.md 2>/dev/null
```

Extract from these:
- **PROJECT.md** — Vision, principles, non-negotiables, user preferences
- **REQUIREMENTS.md** — Acceptance criteria, constraints, must-haves vs nice-to-haves
- **STATE.md** — Current progress, any flags or session notes

**Step 2: Read all prior CONTEXT.md files**
```bash
# Find all CONTEXT.md files from phases before current
find .planning/phases -name "*-CONTEXT.md" 2>/dev/null | sort
```

For each CONTEXT.md where phase number < current phase:
- Read the `<decisions>` section — these are locked preferences
- Read `<specifics>` — particular references or "I want it like X" moments
- Note any patterns (e.g., "user consistently prefers minimal UI", "user rejected single-key shortcuts")

**Step 3: Build internal `<prior_decisions>` context**

Structure the extracted information:
```
<prior_decisions>
## Project-Level
- [Key principle or constraint from PROJECT.md]
- [Requirement that affects this phase from REQUIREMENTS.md]

## From Prior Phases
### Phase N: [Name]
- [Decision that may be relevant to current phase]
- [Preference that establishes a pattern]

### Phase M: [Name]
- [Another relevant decision]
</prior_decisions>
```

**Usage in subsequent steps:**
- `analyze_phase`: Skip gray areas already decided in prior phases
- `present_gray_areas`: Annotate options with prior decisions ("You chose X in Phase 5")
- `discuss_areas`: Pre-fill answers or flag conflicts ("This contradicts Phase 3 — same here or different?")

**If no prior context exists:** Continue without — this is expected for early phases.

## 4. Scout Codebase

Lightweight scan of existing code to inform gray area identification and discussion. Uses ~10% context — acceptable for an interactive session.

**Step 1: Check for existing codebase maps**
```bash
ls .planning/codebase/*.md 2>/dev/null
```

**If codebase maps exist:** Read the most relevant ones (CONVENTIONS.md, STRUCTURE.md, STACK.md based on phase type). Extract:
- Reusable components/hooks/utilities
- Established patterns (state management, styling, data fetching)
- Integration points (where new code would connect)

Skip to Step 3 below.

**Step 2: If no codebase maps, do targeted grep**

Extract key terms from the phase goal (e.g., "feed" → "post", "card", "list"; "auth" → "login", "session", "token").

```bash
# Find files related to phase goal terms
grep -rl "{term1}\|{term2}" src/ app/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" 2>/dev/null | head -10

# Find existing components/hooks
ls src/components/ 2>/dev/null
ls src/hooks/ 2>/dev/null
ls src/lib/ src/utils/ 2>/dev/null
```

Read the 3-5 most relevant files to understand existing patterns.

**Step 3: Build internal codebase_context**

From the scan, identify:
- **Reusable assets** — existing components, hooks, utilities that could be used in this phase
- **Established patterns** — how the codebase does state management, styling, data fetching
- **Integration points** — where new code would connect (routes, nav, providers)
- **Creative options** — approaches the existing architecture enables or constrains

Store as internal `<codebase_context>` for use in analyze_phase and present_gray_areas. This is NOT written to a file — it's used within this session only.

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/discuss-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "discuss-phase",
  "step_id": "step-01-scout",
  "task_id": "{PHASE}-discuss-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-scout"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "padded_phase": "{padded_phase}",
    "phase_slug": "{phase_slug}",
    "prior_decisions_summary": "{summary_of_prior_decisions}",
    "codebase_context_summary": "{summary_of_codebase_context}",
    "has_context": "{has_context}",
    "has_plans": "{has_plans}"
  },
  "next_step": "step-02-analyze",
  "escalation_flags": []
}
```

```bash
curl -s -X POST "http://127.0.0.1:18799/api/steps/discuss-phase/${PHASE}/handoff" \
  -H "Content-Type: application/json" \
  -d "$HANDOFF_JSON"
```
</step_output>

---

STOP. Do not proceed to the next step. Save StepHandoff via POST /api/steps/discuss-phase/{PHASE}/handoff and return control to the workflow router.
