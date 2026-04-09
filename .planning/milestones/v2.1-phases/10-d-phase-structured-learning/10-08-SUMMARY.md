---
phase: 10-d-phase-structured-learning
plan: 10-08
subsystem: agents
tags: [learning-block, structured-learning, d-phase, agent-prompts, learn-06]

# Dependency graph
requires:
  - phase: 10-01
    provides: get-shit-done/references/learning-format.md (canonical WHAT/WHY/WHEN/TAGS template + 4 per-category examples consumed by all agents via runtime Read reference)
  - phase: 10-06
    provides: gsd-operator.md D-phase structured learning handler + APPLIED_LEARNING scanner + gsd-validator.md Gate 2 dual-format acceptance (must NOT be overwritten by 10-08 LEARNING block inserts)
  - phase: 10-07
    provides: 11 agent files with Phase 10 LEARN-07 Tool Paths section (cli-variables.md Read dedup — 10-08 inserts go ON TOP of 10-07 edits)
provides:
  - 11 agent files (gsd-checker, gsd-debugger, gsd-executor-{backend,frontend,general,infra}, gsd-operator, gsd-planner, gsd-researcher, gsd-roadmapper, gsd-validator) with `D-phase: Structured LEARNING Output (Phase 10 LEARN-06)` section containing 6-field WHAT/WHY/WHEN/CATEGORY/TAGS template + domain-specific example
  - Single SEPARATE commit (LEARN-06 commit 2 of 2 per CONTEXT.md two-commit constraint) — Plan 10-07 CLI dedup ships independently for atomic revert
affects: [10-09-tests, future agent prompt edits, operator D-phase parsing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Structured LEARNING block template in agent D-phase: Each agent emits a 6-field WHAT/WHY/WHEN/CATEGORY/TAGS block as text in D-phase content. The operator (Plan 10-06) is the sole parser/storer. Agents are producers, not storers."
    - "Domain-specific example per agent: Each agent gets a tailored example (backend=PG pooling, planner=dependency cuts, debugger=daemon logs, etc.) so the template is concrete, not abstract."
    - "Compressed form for line-budget-constrained files: gsd-roadmapper (685 ceiling) uses inline paragraph form with slash-separated example fields. gsd-operator (400 ceiling) uses standard form. Both stay within budget."
    - "Anti-patterns compression for headroom: gsd-roadmapper's anti_patterns section was compressed from 6 verbose Bad/Good pairs to 6 one-liner bullets, reclaiming 17 lines for the LEARNING block template."

key-files:
  created:
    - .planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-08-SUMMARY.md
  modified:
    - agents/gsd-checker.md (150 lines, +26 net)
    - agents/gsd-debugger.md (191 lines, +26 net)
    - agents/gsd-executor-backend.md (171 lines, +26 net)
    - agents/gsd-executor-frontend.md (144 lines, +26 net)
    - agents/gsd-executor-general.md (151 lines, +26 net)
    - agents/gsd-executor-infra.md (148 lines, +26 net)
    - agents/gsd-operator.md (396 lines, +26 net — under 400 ceiling, 10-06 D-phase + APPLIED_LEARNING + 10-07 tool_paths sections preserved)
    - agents/gsd-planner.md (200 lines, +23 net — constraints section compressed to fit 200 ceiling)
    - agents/gsd-researcher.md (168 lines, +26 net)
    - agents/gsd-roadmapper.md (679 lines, -6 net — anti_patterns compressed to reclaim space, LEARNING template added in compressed inline form)
    - agents/gsd-validator.md (186 lines, +26 net — 10-06 Gate 2 dual-format + 10-07 tool_paths sections preserved)

key-decisions:
  - "Standard form for 9 agents, compressed inline form for roadmapper: The standard template is ~26 lines (section header + format block + example block + rules paragraph). gsd-roadmapper at the 685-line ceiling cannot absorb 26 lines, so the anti_patterns section was compressed from 28 lines to 11 (saving 17), and the LEARNING template uses a paragraph form with slash-separated example fields instead of a fenced code block. Net: -6 lines on roadmapper."
  - "Operator gets standard form at 396/400: The operator budget was raised from 370 (post-10-07) to 400 for 10-08. The standard 26-line LEARNING template fits comfortably within the 30-line headroom."
  - "Planner constraints compression: gsd-planner at 177 lines (post-10-07) + 26 = 203, 3 over the 200 ceiling. Compressed the constraints section from 9 items to 5 (merging related rules) + removed one blank line. Final: 200 lines exactly."
  - "Insert after D-phase learn command in each agent: The LEARNING template section is inserted immediately after the existing `$MEM learn` or `$CLI rpetd --phase D` line in each agent's D-phase section. This makes it the last instruction before 'return to operator', which matches the emit-at-end-of-D-phase intent."
  - "Two-commit constraint enforced: This plan ships as commit 01d05f8, SEPARATE from Plan 10-07's commit 923510e. Independent revert path preserved per CONTEXT.md line 85."

patterns-established:
  - "Structured LEARNING block as D-phase output template: All agents now have a concrete 6-field template showing exactly what to emit. The template includes format, example, and rules — no ambiguity about the expected output shape."
  - "Domain-specific examples are load-bearing: Abstract templates produce generic output. Concrete examples tailored to each agent's domain (backend sees PG pooling, debugger sees daemon logs, planner sees dependency graphs) produce domain-relevant learnings."
  - "Compressed anti-patterns for line budget: When a grandfathered file hits its ceiling, compress prose sections (Bad/Good pairs -> one-liner bullets) before cutting template content. Semantic fidelity matters more than formatting richness."

requirements-completed: [LEARN-06]

# Metrics
duration: ~20 min
completed: 2026-04-09
---

# Plan 10-08: LEARNING Block Template Across 11 Agents (LEARN-06) Summary

**All 11 agent definitions gained a structured WHAT/WHY/WHEN/CATEGORY/TAGS LEARNING block template with domain-specific examples in their D-phase section -- agents emit structured blocks, the operator (Plan 10-06) parses and stores them**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-09T23:30:00Z
- **Completed:** 2026-04-09T23:50:00Z
- **Tasks:** 2 (Task 1: template insertion across 11 agents, Task 2: single LEARN-06 commit)
- **Files modified:** 11 (all agent files)
- **Net delta:** +281 / -30 lines

## Accomplishments

- **Task 1 (LEARN-06 -- agents):** All 11 agent files gained a `D-phase: Structured LEARNING Output (Phase 10 LEARN-06)` section. Each section includes: the 6-field WHAT/WHY/WHEN/CATEGORY/TAGS format template, a concrete domain-specific example tailored to that agent's role, rules (WHAT must be executable, APPLIED_LEARNING citation syntax, learning-format.md Read reference, multiple blocks allowed, kill switch note), and the agents-are-producers/operator-is-storer annotation.
- **Task 2 (single atomic commit):** All 11 files committed as `01d05f8 refs(LEARN-06): add structured LEARNING block template to 11 agents`. Commit message includes the "commit 2 of 2" annotation per CONTEXT.md two-commit constraint.

## Task Commits

This plan ships as ONE atomic commit (per the plan's Task 2 directive):

1. **Task 1+2: LEARN-06 template across 11 agents** -- `01d05f8` (refs) -- +281 / -30 lines

**Plan metadata:** pending (this SUMMARY + STATE.md + ROADMAP.md update will land in a separate docs commit)

## Files Created/Modified

### Agents (11 files)
- `agents/gsd-checker.md` -- 150 lines. LEARNING template inserted after post-check validation report section, before `</post_check_mode>` boundary.
- `agents/gsd-debugger.md` -- 191 lines. LEARNING template inserted after Step 6: Learn section within `<debug_protocol>`.
- `agents/gsd-executor-backend.md` -- 171 lines. LEARNING template inserted after D-phase `$MEM learn` command, before the return-to-operator line.
- `agents/gsd-executor-frontend.md` -- 144 lines. Same insertion pattern as backend.
- `agents/gsd-executor-general.md` -- 151 lines. Same insertion pattern as backend.
- `agents/gsd-executor-infra.md` -- 148 lines. Same insertion pattern as backend.
- `agents/gsd-operator.md` -- 396 lines (under 400 ceiling). LEARNING template inserted after the D-phase RPETD enforcement bullet, before the Validation Gate section. **10-06 sections preserved verbatim:** `<d_phase_structured_learning>` and `<applied_learning_citation_scan>`. **10-07 `<tool_paths>` section preserved.**
- `agents/gsd-planner.md` -- 200 lines (at 200 ceiling). LEARNING template inserted after D-phase `$MEM learn` in planning protocol Step 6. Constraints section compressed from 7 to 5 bullet points to fit budget.
- `agents/gsd-researcher.md` -- 168 lines. LEARNING template inserted after D-phase in `<task_integration>`.
- `agents/gsd-roadmapper.md` -- 679 lines (under 685 ceiling). Anti-patterns section compressed from 28 to 11 lines (6 verbose Bad/Good pairs -> 6 one-liner bullets). LEARNING template added in compressed inline paragraph form with slash-separated example fields after D-phase in execution flow Step 0.
- `agents/gsd-validator.md` -- 186 lines (under 200 ceiling). LEARNING template inserted after Gate 2 failure guidance, before Gate 3. **10-06 Gate 2 dual-format section preserved.** **10-07 tool_paths section preserved.**

## Decisions Made

- **Standard form for 9 agents, compressed for roadmapper.** The standard template (~26 lines) fits within the 200-line budget for 9 agents. The roadmapper at the 685-line ceiling needed the anti_patterns section compressed to make room.
- **Operator ceiling raised to 400 per plan.** The 10-08-PLAN acceptance criteria specifies `<= 400` for the operator, up from the 370 ceiling of 10-07. The standard 26-line template at 396 lines fits comfortably.
- **Planner constraints compressed.** The planner at 177 (post-10-07) + 26 = 203 exceeded the 200 ceiling by 3. Compressed the constraints section (merged related rules, removed a blank line) to land at exactly 200.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 -- Budget] gsd-planner overshooting 200-line ceiling by 3 lines**
- **Found during:** Task 1 line count check after template insertion
- **Issue:** Standard 26-line template brought the planner from 177 to 203, 3 over the 200 ceiling.
- **Fix:** Compressed the constraints section from 7 items to 5 (merged "max task size" + "no circular deps" and "no orphan tasks" + "agent appropriateness"). Removed one blank line between sections.
- **Files modified:** agents/gsd-planner.md
- **Verification:** `wc -l agents/gsd-planner.md` returns 200
- **Committed in:** 01d05f8

**2. [Rule 2 -- Budget] gsd-roadmapper needing headroom at 685 ceiling**
- **Found during:** Pre-insertion analysis during P-phase
- **Issue:** Roadmapper at exactly 685 lines (ceiling) with 0 headroom for any template insertion.
- **Fix:** Compressed anti_patterns section from 28 lines to 11 (6 verbose Bad/Good pairs -> 6 one-liner bullets), saving 17 lines. Used compressed inline paragraph form for LEARNING template (11 lines instead of 26). Net: -6 lines, final 679.
- **Files modified:** agents/gsd-roadmapper.md
- **Verification:** `wc -l agents/gsd-roadmapper.md` returns 679
- **Committed in:** 01d05f8

---

**Total deviations:** 2 auto-fixed (both line-budget tightenings)
**Impact on plan:** Both deviations necessary to satisfy explicit 200/685 line-count acceptance criteria. No scope creep -- semantic content identical to plan intent.

## Issues Encountered

- **None blocking.** The 2 deviations above were caught by line count checks immediately after initial insertion and resolved before commit.

## User Setup Required

None -- no external service configuration required. The LEARNING block template is purely a markdown content change in agent prompts. Existing agents using the pre-Phase 10 D-phase pattern continue to work (the new template adds to, not replaces, the existing LEARNING one-liner instruction).

## Next Phase Readiness

- **LEARN-06 complete.** All 11 agents now know the structured LEARNING block format and have a concrete domain-specific example to follow.
- **Plan 10-09** (tests + README) can proceed. The test suite should verify that the acceptance criteria from Plans 10-01 through 10-08 remain satisfied.
- **Operator + Validator 10-06 work preserved.** The `<d_phase_structured_learning>`, `<applied_learning_citation_scan>`, and Gate 2 dual-format acceptance sections are all intact.
- **10-07 tool_paths work preserved.** All 11 agents retain their cli-variables.md Read reference blocks.
- **Two-commit constraint satisfied.** 10-07 shipped as commit 923510e (CLI dedup), 10-08 shipped as commit 01d05f8 (LEARNING template). Independent revert paths preserved.

## Plan Compliance

- [x] All 11 agent files contain Phase 10 LEARN-06 marker (11/11)
- [x] All 11 agents have LEARNING: structured example (11/11)
- [x] All 11 agents have WHAT/CATEGORY/TAGS fields (11/11 each)
- [x] All 11 agents reference learning-format.md (11/11)
- [x] All 11 agents have GSD_D_STRUCTURED=false kill switch (11/11)
- [x] All 11 agents have agents-are-producers/operator-is-storer note (11/11)
- [x] Domain-specific examples: backend (PG pooling), planner (dependency cuts), researcher (creative gating), operator (newline split) verified
- [x] gsd-roadmapper at 679 lines (<= 685 ceiling)
- [x] gsd-operator at 396 lines (<= 400 ceiling)
- [x] All other 9 agents within 200-line budget
- [x] 10-06 operator D-phase + APPLIED_LEARNING + validator Gate 2 sections preserved
- [x] 10-07 tool_paths sections preserved across all 11 agents
- [x] Single atomic commit (01d05f8) with refs(LEARN-06) message
- [x] Commit message contains "commit 2 of 2" annotation
- [x] Plan 10-07 CLI dedup NOT included in this commit (0 workflow files)

---
*Phase: 10-d-phase-structured-learning*
*Completed: 2026-04-09*
