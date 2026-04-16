<purpose>
Step 02 of sharded discuss-phase workflow: Analyze the phase to identify gray areas, check prior
decisions, initialize canonical refs accumulator, and present gray areas to the user for selection.

Part of Phase 41 SHARD-03 sharding of the 732-line discuss-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/discuss-phase/{PHASE} to load context from step-01-scout.
Required fields from prior handoff: phase_number, phase_name, phase_dir, padded_phase, phase_slug,
prior_decisions_summary, codebase_context_summary, has_context, has_plans.
</step_context>

<gray_area_identification>
Gray areas are **implementation decisions the user cares about** — things that could go multiple ways and would change the result.

**How to identify gray areas:**

1. **Read the phase goal** from ROADMAP.md
2. **Understand the domain** — What kind of thing is being built?
   - Something users SEE → visual presentation, interactions, states matter
   - Something users CALL → interface contracts, responses, errors matter
   - Something users RUN → invocation, output, behavior modes matter
   - Something users READ → structure, tone, depth, flow matter
   - Something being ORGANIZED → criteria, grouping, handling exceptions matter
3. **Generate phase-specific gray areas** — Not generic categories, but concrete decisions for THIS phase

**Don't use generic category labels** (UI, UX, Behavior). Generate specific gray areas:

```
Phase: "User authentication"
→ Session handling, Error responses, Multi-device policy, Recovery flow

Phase: "Organize photo library"
→ Grouping criteria, Duplicate handling, Naming convention, Folder structure

Phase: "CLI for database backups"
→ Output format, Flag design, Progress reporting, Error recovery

Phase: "API documentation"
→ Structure/navigation, Code examples depth, Versioning approach, Interactive elements
```

**The key question:** What decisions would change the outcome that the user should weigh in on?

**Claude handles these (don't ask):**
- Technical implementation details
- Architecture patterns
- Performance optimization
- Scope (roadmap defines this)
</gray_area_identification>

<process>

## 1. Analyze Phase

Analyze the phase to identify gray areas worth discussing. **Use both `prior_decisions` and `codebase_context` to ground the analysis.**

**Read the phase description from ROADMAP.md and determine:**

1. **Domain boundary** — What capability is this phase delivering? State it clearly.

1b. **Initialize canonical refs accumulator** — Start building the `<canonical_refs>` list for CONTEXT.md. This accumulates throughout the entire discussion, not just this step.

   **Source 1 (now):** Copy `Canonical refs:` from ROADMAP.md for this phase. Expand each to a full relative path.
   **Source 2 (now):** Check REQUIREMENTS.md and PROJECT.md for any specs/ADRs referenced for this phase.
   **Source 3 (scout_codebase):** If existing code references docs (e.g., comments citing ADRs), add those.
   **Source 4 (discuss_areas):** When the user says "read X", "check Y", or references any doc/spec/ADR during discussion — add it immediately. These are often the MOST important refs because they represent docs the user specifically wants followed.

   This list is MANDATORY in CONTEXT.md. Every ref must have a full relative path so downstream agents can read it directly. If no external docs exist, note that explicitly.

2. **Check prior decisions** — Before generating gray areas, check if any were already decided:
   - Scan `<prior_decisions>` for relevant choices (e.g., "Ctrl+C only, no single-key shortcuts")
   - These are **pre-answered** — don't re-ask unless this phase has conflicting needs
   - Note applicable prior decisions for use in presentation

3. **Gray areas by category** — For each relevant category (UI, UX, Behavior, Empty States, Content), identify 1-2 specific ambiguities that would change implementation. **Annotate with code context where relevant** (e.g., "You already have a Card component" or "No existing pattern for this").

4. **Skip assessment** — If no meaningful gray areas exist (pure infrastructure, clear-cut implementation, or all already decided in prior phases), the phase may not need discussion.

**Output your analysis internally, then present to user.**

Example analysis for "Post Feed" phase (with code and prior context):
```
Domain: Displaying posts from followed users
Existing: Card component (src/components/ui/Card.tsx), useInfiniteQuery hook, Tailwind CSS
Prior decisions: "Minimal UI preferred" (Phase 2), "No pagination — always infinite scroll" (Phase 4)
Gray areas:
- UI: Layout style (cards vs timeline vs grid) — Card component exists with shadow/rounded variants
- UI: Information density (full posts vs previews) — no existing density patterns
- Behavior: Loading pattern — ALREADY DECIDED: infinite scroll (Phase 4)
- Empty State: What shows when no posts exist — EmptyState component exists in ui/
- Content: What metadata displays (time, author, reactions count)
```

## 2. Present Gray Areas

Present the domain boundary, prior decisions, and gray areas to user.

**First, state the boundary and any prior decisions that apply:**
```
Phase [X]: [Name]
Domain: [What this phase delivers — from your analysis]

We'll clarify HOW to implement this.
(New capabilities belong in other phases.)

[If prior decisions apply:]
**Carrying forward from earlier phases:**
- [Decision from Phase N that applies here]
- [Decision from Phase M that applies here]
```

**Then use AskUserQuestion (multiSelect: true):**
- header: "Discuss"
- question: "Which areas do you want to discuss for [phase name]?"
- options: Generate 3-4 phase-specific gray areas, each with:
  - "[Specific area]" (label) — concrete, not generic
  - [1-2 questions this covers + code context annotation] (description)
  - **Highlight the recommended choice with brief explanation why**

**Prior decision annotations:** When a gray area was already decided in a prior phase, annotate it:
```
☐ Exit shortcuts — How should users quit?
  (You decided "Ctrl+C only, no single-key shortcuts" in Phase 5 — revisit or keep?)
```

**Code context annotations:** When the scout found relevant existing code, annotate the gray area description:
```
☐ Layout style — Cards vs list vs timeline?
  (You already have a Card component with shadow/rounded variants. Reusing it keeps the app consistent.)
```

**Combining both:** When both prior decisions and code context apply:
```
☐ Loading behavior — Infinite scroll or pagination?
  (You chose infinite scroll in Phase 4. useInfiniteQuery hook already set up.)
```

**Do NOT include a "skip" or "you decide" option.** User ran this command to discuss — give them real choices.

**Examples by domain (with code context):**

For "Post Feed" (visual feature):
```
☐ Layout style — Cards vs list vs timeline? (Card component exists with variants)
☐ Loading behavior — Infinite scroll or pagination? (useInfiniteQuery hook available)
☐ Content ordering — Chronological, algorithmic, or user choice?
☐ Post metadata — What info per post? Timestamps, reactions, author?
```

For "Database backup CLI" (command-line tool):
```
☐ Output format — JSON, table, or plain text? Verbosity levels?
☐ Flag design — Short flags, long flags, or both? Required vs optional?
☐ Progress reporting — Silent, progress bar, or verbose logging?
☐ Error recovery — Fail fast, retry, or prompt for action?
```

For "Organize photo library" (organization task):
```
☐ Grouping criteria — By date, location, faces, or events?
☐ Duplicate handling — Keep best, keep all, or prompt each time?
☐ Naming convention — Original names, dates, or descriptive?
☐ Folder structure — Flat, nested by year, or by category?
```

Continue to discuss_areas (step-03-discuss) with selected areas.

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/discuss-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "discuss-phase",
  "step_id": "step-02-analyze",
  "task_id": "{PHASE}-discuss-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-scout", "step-02-analyze"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "padded_phase": "{padded_phase}",
    "phase_slug": "{phase_slug}",
    "selected_areas": "{selected_gray_areas_array}",
    "domain_boundary": "{domain_boundary_statement}"
  },
  "artifacts": {
    "canonical_refs": "{canonical_refs_accumulator_json}"
  },
  "next_step": "step-03-discuss",
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
