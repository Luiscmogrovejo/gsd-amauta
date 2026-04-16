<purpose>
Step 03 of sharded discuss-phase workflow: Interactive Q&A loop — discuss each selected gray area
with the user, accumulate canonical refs during discussion, handle scope creep, and run the
"explore more" loop after initially selected areas complete.

Part of Phase 41 SHARD-03 sharding of the 732-line discuss-phase.md monolith.
</purpose>

<step_context>
Read the current StepHandoff via GET /api/steps/discuss-phase/{PHASE} to load context from step-02-analyze.
Required fields from prior handoff: phase_number, phase_name, phase_dir, selected_areas,
domain_boundary, canonical_refs accumulator.
</step_context>

<process>

## 1. Discuss Areas

For each selected area, conduct a focused discussion loop.

**Batch mode support:** Parse optional `--batch` from `$ARGUMENTS`.
- Accept `--batch`, `--batch=N`, or `--batch N`
- Default to 4 questions per batch when no number is provided
- Clamp explicit sizes to 2-5 so a batch stays answerable
- If `--batch` is absent, keep the existing one-question-at-a-time flow

**Philosophy:** stay adaptive, but let the user choose the pacing.
- Default mode: 4 single-question turns, then check whether to continue
- `--batch` mode: 1 grouped turn with 2-5 numbered questions, then check whether to continue

Each answer (or answer set, in batch mode) should reveal the next question or next batch.

**For each area:**

1. **Announce the area:**
   ```
   Let's talk about [Area].
   ```

2. **Ask questions using the selected pacing:**

   **Default (no `--batch`): Ask 4 questions using AskUserQuestion**
   - header: "[Area]" (max 12 chars — abbreviate if needed)
   - question: Specific decision for this area
   - options: 2-3 concrete choices (AskUserQuestion adds "Other" automatically), with the recommended choice highlighted and brief explanation why
   - **Annotate options with code context** when relevant:
     ```
     "How should posts be displayed?"
     - Cards (reuses existing Card component — consistent with Messages)
     - List (simpler, would be a new pattern)
     - Timeline (needs new Timeline component — none exists yet)
     ```
   - Include "You decide" as an option when reasonable — captures Claude discretion
   - **Context7 for library choices:** When a gray area involves library selection (e.g., "magic links" → query next-auth docs) or API approach decisions, use `mcp__context7__*` tools to fetch current documentation and inform the options. Don't use Context7 for every question — only when library-specific knowledge improves the options.

   **Batch mode (`--batch`): Ask 2-5 numbered questions in one plain-text turn**
   - Group closely related questions for the current area into a single message
   - Keep each question concrete and answerable in one reply
   - When options are helpful, include short inline choices per question rather than a separate AskUserQuestion for every item
   - After the user replies, reflect back the captured decisions, note any unanswered items, and ask only the minimum follow-up needed before moving on
   - Preserve adaptiveness between batches: use the full set of answers to decide the next batch or whether the area is sufficiently clear

3. **After the current set of questions, check:**
   - header: "[Area]" (max 12 chars)
   - question: "More questions about [area], or move to next?"
   - options: "More questions" / "Next area"

   If "More questions" → ask another 4 single questions, or another 2-5 question batch when `--batch` is active, then check again
   If "Next area" → proceed to next selected area
   If "Other" (free text) → interpret intent: continuation phrases ("chat more", "keep going", "yes", "more") map to "More questions"; advancement phrases ("done", "move on", "next", "skip") map to "Next area". If ambiguous, ask: "Continue with more questions about [area], or move to the next area?"

4. **After all initially-selected areas complete:**
   - Summarize what was captured from the discussion so far
   - AskUserQuestion:
     - header: "Done"
     - question: "We've discussed [list areas]. Which gray areas remain unclear?"
     - options: "Explore more gray areas" / "I'm ready for context"
   - If "Explore more gray areas":
     - Identify 2-4 additional gray areas based on what was learned
     - Return to present_gray_areas logic with these new areas
     - Loop: discuss new areas, then prompt again
   - If "I'm ready for context": Proceed to write_context (step-04-commit)

## 2. Canonical Ref Accumulation During Discussion

When the user references a doc, spec, or ADR during any answer — e.g., "read adr-014", "check the MCP spec", "per browse-spec.md" — immediately:
1. Read the referenced doc (or confirm it exists)
2. Add it to the canonical refs accumulator with full relative path (Source 4)
3. Use what you learned from the doc to inform subsequent questions

These user-referenced docs are often MORE important than ROADMAP.md refs because they represent docs the user specifically wants downstream agents to follow. Never drop them.

## 3. Question Design

- Options should be concrete, not abstract ("Cards" not "Option A")
- Each answer should inform the next question or next batch
- If user picks "Other" to provide freeform input (e.g., "let me describe it", "something else", or an open-ended reply), ask your follow-up as plain text — NOT another AskUserQuestion. Wait for them to type at the normal prompt, then reflect their input back and confirm before resuming AskUserQuestion or the next numbered batch.

## 4. Scope Creep Handling

If user mentions something outside the phase domain:
```
"[Feature] sounds like a new capability — that belongs in its own phase.
I'll note it as a deferred idea.

Back to [current area]: [return to current question]"
```

Track deferred ideas internally.

</process>

<step_output>
## Produce StepHandoff

At the end of this step, save a StepHandoff via POST /api/steps/discuss-phase/{PHASE}/handoff with:

```json
{
  "workflow_name": "discuss-phase",
  "step_id": "step-03-discuss",
  "task_id": "{PHASE}-discuss-phase",
  "phase_number": "{PHASE}",
  "completed_steps": ["step-01-scout", "step-02-analyze", "step-03-discuss"],
  "context_snapshot": {
    "phase_number": "{phase_number}",
    "phase_name": "{phase_name}",
    "phase_dir": "{phase_dir}",
    "padded_phase": "{padded_phase}",
    "phase_slug": "{phase_slug}",
    "domain_boundary": "{domain_boundary}"
  },
  "artifacts": {
    "decisions": "{decisions_array_from_discussion}",
    "user_inputs": "{user_inputs_array}",
    "canonical_refs": "{canonical_refs_finalized_json}",
    "deferred_ideas": "{deferred_ideas_array}"
  },
  "next_step": "step-04-commit",
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
