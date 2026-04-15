# Phase 41: Sharded Workflows (FOUNDATION) - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace 3 monolithic workflow files (~2,227 lines total) with micro-step files connected by validated StepHandoff objects persisted to PG. Add programmatic HALT enforcement via 3-layer system (architectural + prompt + operator verification). New PG migration, daemon endpoints, and step orchestrator. This is the v3.1 foundation — every subsequent phase benefits from reliable, resumable workflow execution.

</domain>

<decisions>
## Implementation Decisions

### Step Decomposition (SHARD-01, SHARD-02, SHARD-03)
Each workflow gets the number of steps IT NEEDS:

**plan-phase.md (656 lines) → 5 steps:**
- `step-01-init.md`: Load phase context, check CONTEXT.md, validate phase in ROADMAP (~80 LOC)
- `step-02-research.md`: Run researcher if enabled, produce RESEARCH.md (~100 LOC)
- `step-03-plan.md`: Spawn gsd-planner, produce PLAN.md files (~150 LOC)
- `step-04-check.md`: Spawn gsd-checker, verify plans, iterate revisions up to 3x (~120 LOC)
- `step-05-approve.md`: Present plans for user approval, commit (~80 LOC)

**execute-phase.md (840 lines) → 6 steps:**
- `step-01-prepare.md`: Load plans, get-bearings, assemble context (~100 LOC)
- `step-02-route.md`: Select executor agent(s) by file patterns (~80 LOC)
- `step-03-execute.md`: Spawn executor(s), monitor, collect summaries (~150 LOC)
- `step-04-verify.md`: Manifest check, spot-checks, run tests (~120 LOC)
- `step-05-validate.md`: Spawn gsd-validator for goal verification (~80 LOC)
- `step-06-close.md`: Update STATE.md, ROADMAP.md, commit, present results (~80 LOC)

**discuss-phase.md (733 lines) → 4 steps:**
- `step-01-scout.md`: Load phase info, read prior context, scout codebase (~120 LOC)
- `step-02-analyze.md`: Identify gray areas, present discussion menu (~100 LOC)
- `step-03-discuss.md`: Interactive Q&A loop with user (~200 LOC)
- `step-04-commit.md`: Write CONTEXT.md, commit, present next steps (~80 LOC)

Step boundary criteria: (a) user input/approval needed, (b) natural phase transition, (c) different agent spawned. Steps within a workflow are SEQUENTIAL, never parallel.

### StepHandoff Schema and Persistence (SHARD-04)
```json
{
  "id": "UUID",
  "workflow_name": "plan-phase | execute-phase | discuss-phase",
  "step_id": "step-01-init | step-02-research | etc",
  "task_id": "string (links to RPETD task)",
  "phase_number": "integer",
  "completed_steps": ["string[]"],
  "context_snapshot": "JSONB (RPETDContext ≤600 tokens)",
  "artifacts": "JSONB ({plan_files: [], summaries: [], commits: []})",
  "decisions": "JSONB ([{decision, rationale, agent}])",
  "user_inputs": "JSONB ([{step, question, answer}])",
  "next_step": "string | null (null = complete)",
  "escalation_flags": ["string[]"],
  "created_at": "TIMESTAMPTZ"
}
```
- Persistence AFTER EVERY STEP completes — not just at boundaries
- Rollback granularity: step-level only (a step is atomic — completes fully or rolls back to previous)
- Token budget: `context_snapshot` is ≤600 tokens (injected into next step prompt). Full StepHandoff up to ~2000 tokens (stored in PG, not in LLM context).

### Directory Structure
```
workflows/plan-phase/
├── workflow.md           # Entry point (~50 LOC) — THIS is what Skill loads
├── steps/
│   ├── step-01-init.md
│   ├── step-02-research.md
│   ├── step-03-plan.md
│   ├── step-04-check.md
│   └── step-05-approve.md
└── schema/
    └── step-handoff.json  # JSON schema for validation
```

### Backward Compatibility
- `/amauta:plan-phase` and `/amauta:execute-phase` MUST STILL WORK identically
- Entry point does NOT change — `workflow.md` is the router that the Skill tool loads
- `workflow.md` reads StepHandoff from PG (if resuming) or creates fresh (if starting), then loads appropriate step file
- Steps loaded via "Read fully and follow: steps/step-0X-name.md" (BMAD's proven progressive disclosure)
- OLD monolithic files preserved as `*-legacy.md` for one version cycle (config flag for fallback)
- After v3.2, legacy files removed

### HALT Enforcement (SHARD-05)
Three layers:
1. **Architectural:** Next step's content NOT in context window. LLM cannot execute step-04 while running step-03.
2. **Prompt-based:** Each step ends with explicit HALT: "STOP. Do not proceed to the next step. Return control to the workflow orchestrator."
3. **Operator verification:** `workflow.md` checks StepHandoff was written to PG before loading next step. No handoff = no advance. This is what BMAD lacks.

For user approval steps: AskUserQuestion pattern (same as today). Orchestrator waits for response before proceeding.

### Step Orchestrator
`services/step-orchestrator.py` (~200 LOC) provides:
- `load_or_create_handoff(workflow, phase, task_id)` → StepHandoff
- `save_handoff(handoff)` → persists to PG
- `get_next_step(handoff)` → step file path or None
- `rollback_step(handoff, target_step)` → reverts to previous state
- `validate_handoff(handoff)` → Pydantic validation

Two new daemon endpoints:
- `GET /api/steps/:workflow/:phase` → current step state
- `POST /api/steps/:workflow/:phase/handoff` → save step handoff

### Migration
```sql
CREATE TABLE step_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(32) NOT NULL,
  step_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  phase_number INTEGER NOT NULL,
  completed_steps TEXT[] DEFAULT '{}',
  context_snapshot JSONB NOT NULL,
  artifacts JSONB DEFAULT '{}',
  decisions JSONB DEFAULT '[]',
  user_inputs JSONB DEFAULT '[]',
  next_step VARCHAR(64),
  escalation_flags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_handoffs_task ON step_handoffs(task_id, workflow_name);
CREATE INDEX idx_handoffs_latest ON step_handoffs(workflow_name, phase_number, created_at DESC);
```

### Wave Structure
- Wave 1: Migration + step-orchestrator.py + daemon endpoints + StepHandoff schema + shard plan-phase.md into 5 steps + workflow.md router
- Wave 2: Shard execute-phase.md into 6 steps + shard discuss-phase.md into 4 steps + legacy fallback mechanism
- Wave 3: Integration tests (full workflow via steps, resumption, rollback) + regression suite (820+ assertions)

### Claude's Discretion
- Exact wording within each step file (logic must be preserved from monolith)
- Step orchestrator internal implementation details
- JSON schema validation strictness level
- Legacy fallback config flag name

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Current Workflow Files (being sharded)
- `~/.claude/get-shit-done/workflows/plan-phase.md` — 656 lines, being split into 5 steps
- `~/.claude/get-shit-done/workflows/execute-phase.md` — 840 lines, being split into 6 steps
- `~/.claude/get-shit-done/workflows/discuss-phase.md` — 733 lines, being split into 4 steps

### Infrastructure
- `services/amauta-daemon.py` — Add step endpoints alongside existing findings/messages/metrics
- `migrations/` — Next migration is 017 (after Phase 39's 016)

### Prior Art
- `.planning/phases/38-blackboard-communication/38-CONTEXT.md` — Phase 38 daemon endpoint + migration pattern
- BMAD-METHOD competitive intelligence report — sharded workflows section (progressive disclosure, HALT enforcement patterns)

### Requirements
- `.planning/REQUIREMENTS.md` — SHARD-01 through SHARD-05 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `services/amauta-daemon.py` — Daemon with existing endpoint patterns (findings, messages, metrics)
- `get-shit-done/bin/gsd-tools.cjs` — Already handles daemon HTTP calls; step endpoints follow same pattern
- RPETDContext — Existing ≤600 token context object, reused as `context_snapshot` in StepHandoff

### Established Patterns
- Phase 38: Daemon endpoint addition pattern (POST/GET with PG persistence)
- Phase 38: Migration pattern (017 follows 016)
- BMAD: Progressive disclosure via "Read fully and follow:" instruction — proven to work
- Current workflow: `@-reference` loading via Skill tool — entry point stays the same

### Integration Points
- Skill tool loads `workflow.md` as entry point (replaces current monolith reference)
- `gsd-tools.cjs` calls daemon `/api/steps/` endpoints for handoff persistence
- Existing test suite (820+ assertions) must continue passing — workflow sharding is transparent to tests

</code_context>

<specifics>
## Specific Ideas

- This is the most architecturally significant change since v2.5 — it touches the core execution engine
- The 3-layer HALT enforcement (architectural + prompt + operator) is the key innovation vs BMAD's prompt-only approach
- Step-level atomicity (not checkpoint-within-step) keeps the system simple and debuggable
- Legacy fallback ensures zero risk during transition — if anything breaks, config flag reverts to monolith
- The StepHandoff JSONB is intentionally rich (artifacts, decisions, user_inputs) to support future features (Phase 42 complexity scoring, Phase 43 skill memory) without schema changes

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 41-sharded-workflows*
*Context gathered: 2026-04-14*
