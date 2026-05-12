# Roadmap: GSD-Amauta v3.1 "The Gathering"

**Milestone:** v3.1 — The Gathering (BMAD Patterns + Amauta Infrastructure)
**Starting phase number:** 41 (v3.0 ended at Phase 40)
**Phases:** 7 (Phases 41..47)
**Requirements:** 25 total (v3.1 scope)
**Granularity:** coarse (per config.json; 7 phases justified by dependency chain — each category is a natural delivery boundary)
**Status:** Defined 2026-04-13

**Core value:** Every RPETD phase must see what the other phases have already learned — the brain synthesizes, not accumulates. The Gathering grafts BMAD-METHOD's best patterns (scale-adaptive intelligence, skills architecture, sharded workflows, cross-IDE installer) onto Amauta's infrastructure advantage (PG memory, hybrid retrieval, blackboard, security pipeline, agent lifecycle).

**Body-metaphor sequence:** brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → birth (v3.0) → **gathering (v3.1)**. The Gathering is when the organism joins a tribe: it gains the ability to adapt its behavior to task complexity (scale-adaptive), break monolithic workflows into resumable steps (sharded), package its capabilities as portable skills (skills architecture), install itself across IDEs (installer), help the user navigate (help routing), expose capabilities to any MCP client (MCP server), and hydrate agents with live operational context (dynamic hydration). BMAD is wide but stateless. Amauta is deep and persistent. The Gathering makes it both.

**Goal:** GSD-Amauta workflows are sharded into resumable micro-steps, agents adapt their RPETD depth to task complexity, capabilities are packaged as cross-IDE skills, and any MCP-compatible client can access Amauta's full intelligence stack. The system installs itself, helps users navigate, and hydrates agents with live context.

---

## Hard Constraints (apply to every phase)

1. **Scope ceilings are load-bearing.** Exceeding the declared LOC ceiling without a divergence report is a Phase 13 fingerprint and triggers halt-phase.
2. **HARDEN-01 manifest enforcement is active.** `files_expected` blocks are mandatory per task.
3. **`gsd-tools plan-to-tasks` auto-registration is mandatory** for every phase. Every PLAN.md must have `<story>` and `<task>` XML blocks.
4. **Divergence protocol v1.1.0 active.** Surface mismatches; never silently absorb them.
5. **Backward compatible.** All existing data, configs, and workflows must continue working after `npm install -g . && docker compose up`.
6. **Research-backed.** Every improvement must cite its source (research findings, academic papers, or prior research brief).
7. **Test coverage maintained.** `node --test tests/` and `pytest` must pass with 0 new failures before each phase is marked complete.
8. **No new runtimes.** Python + Node.js only.
9. **820 assertion baseline.** v3.0 shipped 820 assertions. v3.1 must maintain or exceed this.

---

## Phases

- [x] **Phase 41: Sharded Workflows** — Split 3 monolithic workflow files into micro-step files with RPETDContext handoffs; StepHandoff PG persistence; programmatic HALT enforcement (SHARD-01..05) (FOUNDATION — everything else benefits from reliable step execution)
  - [x] Plan 41-01: Foundation Infrastructure + plan-phase Sharding (migration 017, step-orchestrator.py, daemon endpoints, JSON schema, 5 step files, workflow.md router, legacy backup, redirect) — COMPLETE 2026-04-15
  - [x] Plan 41-02: execute-phase + discuss-phase Sharding + Legacy Fallback (6 execute steps, 4 discuss steps, routers, legacy backups, schema copies, gsd-tools step-handoff helpers) — COMPLETE 2026-04-13
  - [x] Plan 41-03: Integration Tests + Regression Suite (7 test files, 151 assertions, full regression 3635 passing) — COMPLETE 2026-04-16
- [x] **Phase 42: Scale-Adaptive Intelligence** — Continuous complexity classifier (0-100), phase selector, PG-backed learning from past tasks, divergence-triggered auto-escalation (SCALE-01..04) — depends on 41 — COMPLETE 2026-05-12
  - [x] Plan 42-01: Complexity Scorer Foundation + CLI + Config Schema (migration 018, complexity_scorer.py, config keys, --force-phases flag, pin-phases subcommand) — COMPLETE 2026-05-12
  - [x] Plan 42-02: Workflow Integration — Score at Entry, Write Completion at Close (daemon endpoints /api/complexity/score+complete, gsd-tools CLI, step files wired, step-orchestrator.py phase-routing with T-floor invariant) — COMPLETE 2026-05-12
  - [x] Plan 42-03: Divergence-Triggered Auto-Escalation — detect_escalation + apply_escalation, daemon /api/complexity/escalate, gsd-tools complexity-escalate, step-03-execute + step-04-verify wired, 2-cap enforced — COMPLETE 2026-05-12
  - [x] Plan 42-04: Logistic Regression Learning Loop + Cold Start + Test Suite — calibrate_score, _logistic_regression (in-house NumPy), cold-start conservative-high bias, daemon calibrated_score wiring, 5 test files (150 JS + 32 Python assertions, TEST-SCALE03 binding) — COMPLETE 2026-05-12
- [x] **Phase 42: Scale-Adaptive Intelligence** — Continuous complexity classifier (0-100), phase selector, PG-backed learning from past tasks, divergence-triggered auto-escalation (SCALE-01..04) — COMPLETE 2026-05-12
- [ ] **Phase 43: Skills Architecture** — Refactor workflows to SKILL.md format with YAML frontmatter; invocation memory with hybrid search; skill compiler for cross-IDE output; Semgrep tool enforcement (SKILL-01..04) — depends on 41
- [ ] **Phase 44: Cross-IDE Installer** — `npx gsd-amauta init` 6-step flow; IDE auto-detection; non-interactive CI mode; legacy migration (INST-01..04) — depends on 43
- [ ] **Phase 45: Intelligent Help Routing** — `/amauta:help` queries 4 sources deterministically; pattern learning from PG history; get-bearings integration (HELP-01..03) — depends on 43
- [ ] **Phase 46: Standalone MCP Server** — amauta-mcp.py as standalone with direct PG+Valkey; complexity-score tool; agent/findings resources (MCP-01..03) — depends on 43
- [ ] **Phase 47: Agent Dynamic Hydration** — Agent .md templates with dynamic sections; operator queries PG/blackboard/Valkey/security for agent-specific context injection (HYDRA-01..02) — depends on 42+43

---

## Phase Dependency Graph

```
Phase 41: Sharded Workflows (FOUNDATION)
    Split 3 monolithic workflow files; StepHandoff PG table; HALT enforcement
    Blocks: everything below
    |
    +---> Phase 42: Scale-Adaptive Intelligence  --- depends on 41
    |         |                                       (needs sharded steps to skip phases)
    |         |
    +---> Phase 43: Skills Architecture          --- depends on 41
    |         |                                       (skills ARE the sharded step files)
    |         |
    |         +---> Phase 44: Cross-IDE Installer  --- depends on 43
    |         |         (installs skill files)
    |         |
    |         +---> Phase 45: Help Routing         --- depends on 43
    |         |         (routes to skills/commands)
    |         |
    |         +---> Phase 46: MCP Server           --- depends on 43
    |                   (exposes skills as MCP tools)
    |
    +---> Phase 47: Agent Dynamic Hydration      --- depends on 42 + 43
              (needs scale scores + skills context)
```

**Recommended execution order:** 41 → 42 → 43 → 44 → 45 → 46 → 47

**Parallelizable blocks:**
- Block A (after 41): Phases 42 and 43 can run concurrently
- Block B (after 43): Phases 44, 45, 46 can run concurrently
- Phase 47 runs after both 42 and 43 complete

---

## Phase Details

### Phase 41: Sharded Workflows
**Goal:** Monolithic workflow files (plan-phase, execute-phase, discuss-phase) are replaced by micro-step files with validated RPETDContext handoffs. Workflow state persists to PG after each step, enabling deterministic resumption, step rollback, and cross-session continuity. HALT enforcement is programmatic, not prompt-based.
**Depends on:** Nothing (v3.0 complete; this is the foundation for all v3.1 phases)
**Requirements:** SHARD-01, SHARD-02, SHARD-03, SHARD-04, SHARD-05
**Success Criteria** (what must be TRUE):
  1. plan-phase.md is replaced by 5 micro-step files; each step receives a StepHandoff object and produces a validated StepHandoff object; the original 656-line monolith no longer exists as the active workflow.
  2. execute-phase.md is replaced by 5 micro-step files; after each step completes, the StepHandoff is persisted to the `step_handoffs` PG table; a step that fails can be re-run from its persisted handoff without re-running prior steps.
  3. discuss-phase.md is replaced by micro-step files with structured state passing; the discuss workflow can be interrupted and resumed from any step boundary.
  4. `step_handoffs` PG table exists with schema supporting task_id, step_name, handoff_data (JSONB), created_at, and workflow_type; rows are queryable for resumption.
  5. HALT enforcement is programmatic via operator hooks (not prompt text); attempting to auto-advance past a HALT boundary without user confirmation produces an error, not a warning.
**Plans:** 3/3 plans complete

Plans:
- [x] 41-01: Foundation Infrastructure + plan-phase Sharding (Wave 1, 8 tasks — migration 017, step-orchestrator.py, daemon endpoints, JSON schema, 5 plan-phase steps, workflow.md router, legacy backup)
- [x] 41-02: execute-phase + discuss-phase Sharding + Legacy Fallback (Wave 2, 6 tasks — 6 execute-phase steps, 4 discuss-phase steps, routers, legacy backups, gsd-tools.cjs helpers)
- [ ] 41-03: Integration Tests + Regression Suite (Wave 3, 8 tasks — orchestrator unit tests, daemon tests, schema tests, integration tests, HALT enforcement tests, legacy fallback tests, migration tests, 820+ regression)

### Phase 42: Scale-Adaptive Intelligence
**Goal:** The system automatically classifies task complexity and selects the minimum effective RPETD phase set. Simple tasks (rename a variable) skip Research and Plan phases. Complex tasks (new agent with migrations) get full RPETD plus security and architecture review. The classifier learns from past task outcomes stored in PG.
**Depends on:** Phase 41 (scale-adaptive needs sharded workflow steps to selectively skip phases)
**Requirements:** SCALE-01, SCALE-02, SCALE-03, SCALE-04
**Success Criteria** (what must be TRUE):
  1. A complexity classifier computes a 0-100 score from: files_expected count, estimated LOC, test_impact, dependency_depth, has_migration, has_api_change, security_sensitivity; the score is deterministic for the same inputs.
  2. Phase selector maps score to RPETD depth: 0-15 = Execute only, 16-35 = Plan+Execute+Test, 36-60 = R+P+E+T, 61-85 = full RPETD, 86-100 = full + security + architecture review; mapping is configurable.
  3. Past task outcomes are queried from PG using pgvector similarity on task metadata signatures; logistic regression calibration adjusts future predictions; accuracy improves measurably over 10+ tasks.
  4. An "Execute only" task that encounters unexpected complexity mid-execution triggers automatic re-scoring and phase escalation without user intervention; the escalation event is logged with before/after scores.
**Plans:** 4 plans shipped (Wave 1: foundation + migration; Wave 2a: workflow wiring; Wave 2b: escalation; Wave 3: logistic regression learning loop + cold-start + test suite). COMPLETE.

Plans:
- [x] 42-01: Migration 018 + complexity_scorer.py foundation (extract_features, score_features, select_phases, store_completion)
- [x] 42-02: Workflow wiring (daemon endpoints /api/complexity/{score,complete}, step wiring, config schema)
- [x] 42-03: Escalation triggers (detect_escalation, apply_escalation, /api/complexity/escalate, gsd-tools subcommand, step wiring)
- [x] 42-04: Logistic regression learning loop (calibrate_score, cold-start bias, daemon calibrated_score, 5 test files — 150 JS + 32 Python assertions)

### Phase 43: Skills Architecture
**Goal:** Workflow capabilities are packaged as SKILL.md files with YAML frontmatter declaring name, description, allowed-tools, and category. Every skill invocation is recorded in PG with context embeddings for semantic retrieval of similar past invocations. A skill compiler produces IDE-specific output. Tool enforcement is deterministic via Semgrep, not advisory.
**Depends on:** Phase 41 (skills ARE the sharded step files — the micro-steps from Phase 41 become the skill format)
**Requirements:** SKILL-01, SKILL-02, SKILL-03, SKILL-04
**Success Criteria** (what must be TRUE):
  1. Existing CJS workflow scripts are refactored to SKILL.md format with YAML frontmatter containing name, description, allowed-tools, and category fields; `ls .claude/skills/*.md` returns the refactored skill files.
  2. Each skill invocation creates a PG record with context_embedding; before execution, hybrid BM25 + pgvector query retrieves similar past invocations; retrieval returns relevant results within 200ms.
  3. Skill compiler (scripts/skill-compiler.cjs) reads workflow definitions and produces IDE-specific SKILL.md files for `.claude/skills/`, `.cursor/skills/`, and `.opencode/` directories; compiler output matches the target IDE's expected format.
  4. Skills declared read-only trigger Semgrep rules that fail the build if file writes are detected; enforcement is deterministic (Semgrep exit code), not advisory (prompt text).
**Plans:** TBD (estimated 2 plans: skill format + compiler, invocation memory + enforcement + tests)

Plans:
- [ ] 43-01: TBD
- [ ] 43-02: TBD

### Phase 44: Cross-IDE Installer
**Goal:** A single command (`npx gsd-amauta init`) detects installed IDEs, installs compiled skill files, starts infrastructure, runs migrations, verifies health, and runs assertions. Works non-interactively in CI. Migrates legacy directory structures.
**Depends on:** Phase 43 (installer installs the skill files produced by the skill compiler)
**Requirements:** INST-01, INST-02, INST-03, INST-04
**Success Criteria** (what must be TRUE):
  1. `npx gsd-amauta init` executes a 6-step flow: detect IDEs, install skills, start infrastructure, run migrations, verify health, run assertions; each step reports pass/fail; overall exit code reflects worst step.
  2. IDE auto-detection finds `.claude/`, `.cursor/`, `.opencode/` directories plus process list and CLI tool detection; detection correctly identifies at least 2 IDEs in a test environment with both present.
  3. Non-interactive mode (`--yes --tools claude-code,cursor`) completes without prompts; graceful degradation: no Docker = skills-only install, no PG = file-based fallback; CI exit codes are 0 (success) or 1 (failure), no interactive hangs.
  4. Legacy migration from `.claude/commands/` to `.claude/skills/` is automatic; `platform-codes.yaml` defines IDE target directories; old directory contents are preserved (moved, not deleted).
**Plans:** TBD (estimated 2 plans: installer implementation, tests + CI validation)

Plans:
- [ ] 44-01: TBD
- [ ] 44-02: TBD

### Phase 45: Intelligent Help Routing
**Goal:** `/amauta:help` provides deterministic, code-generated recommendations by querying STATE.md, PG task history, git log, and feature_list.json. Pattern learning surfaces session statistics. The help command IS the enhanced get-bearings ritual.
**Depends on:** Phase 43 (help routing routes users to skills/commands; needs skill registry to exist)
**Requirements:** HELP-01, HELP-02, HELP-03
**Success Criteria** (what must be TRUE):
  1. `/amauta:help` queries 4 sources (STATE.md, PG task history, git log, feature_list.json) and produces deterministic output — same project state always produces the same recommendations; no LLM interpretation in the output path.
  2. Pattern learning queries PG history and surfaces statistics: average session duration for phase type, similar-feature session count, commits since last test run; at least 3 pattern types are surfaced.
  3. Help routing integrates with get-bearings ritual (Phase 28); the help command output IS the bearings block; recommended next action includes reasoning derived from the 4 sources.
**Plans:** TBD (estimated 2 plans: help routing implementation, tests)

Plans:
- [ ] 45-01: TBD
- [ ] 45-02: TBD

### Phase 46: Standalone MCP Server
**Goal:** amauta-mcp.py operates as a standalone service with direct PG connection pool and Valkey client — no daemon dependency. Exposes search-code, memory operations, research, and complexity-score as MCP tools. Exposes RPETD context, agent definitions, and findings as MCP resources. Any MCP-compatible client gets full Amauta capabilities.
**Depends on:** Phase 43 (MCP server exposes skills as tools; needs skill registry) and Phase 42 (exposes complexity-score tool)
**Requirements:** MCP-01, MCP-02, MCP-03
**Success Criteria** (what must be TRUE):
  1. amauta-mcp.py runs as standalone service with direct PG connection pool and Valkey client; does NOT require daemon to be running; supports two modes: stdio (spawned by IDE) and SSE on :18800.
  2. MCP tools include: amauta/search-code (hybrid BM25+vector), amauta/memory-store, amauta/memory-search, amauta/memory-distill, amauta/research, amauta/complexity-score; each tool is callable from an MCP client and returns structured results.
  3. MCP resources include: amauta://context/{task_id}/{phase}, amauta://agent/{agent_name}, amauta://findings/{task_id}; resources are resolvable and return current data from PG.
**Plans:** TBD (estimated 2 plans: MCP server implementation, tests)

Plans:
- [ ] 46-01: TBD
- [ ] 46-02: TBD

### Phase 47: Agent Dynamic Hydration
**Goal:** Agent .md files become templates with dynamic sections. Before spawning an agent, the operator queries PG memory, blackboard findings, Valkey cache, and the security pipeline to build agent-specific operational context. This context is injected as a "## Current context" section, giving every agent a live briefing instead of static instructions.
**Depends on:** Phase 42 (needs complexity scores for context depth calibration) and Phase 43 (needs skill invocation history for agent context)
**Requirements:** HYDRA-01, HYDRA-02
**Success Criteria** (what must be TRUE):
  1. Agent .md files contain template markers for dynamic sections; before spawning, operator queries PG memory, blackboard, Valkey, and security pipeline for agent-specific context; the query completes within 500ms.
  2. Injected context appears as "## Current context" section prepended to the agent definition; content includes task-specific findings, recent memory entries, security alerts, and skill invocation history relevant to the target agent; content is verifiably different per agent and per task.
**Plans:** TBD (estimated 2 plans: hydration implementation, tests)

Plans:
- [ ] 47-01: TBD
- [ ] 47-02: TBD

---

## Progress

**Execution Order:** 41 → 42 → 43 → 44 → 45 → 46 → 47

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 41. Sharded Workflows | 0/3 | Complete    | 2026-04-16 |
| 42. Scale-Adaptive Intelligence | 4/4 | Complete    | 2026-05-12 |
| 43. Skills Architecture | 0/2 | Not started | - |
| 44. Cross-IDE Installer | 0/2 | Not started | - |
| 45. Intelligent Help Routing | 0/2 | Not started | - |
| 46. Standalone MCP Server | 0/2 | Not started | - |
| 47. Agent Dynamic Hydration | 0/2 | Not started | - |

---

*Roadmap created: 2026-04-13 for v3.1 "The Gathering" milestone.*
*Primary input: .planning/REQUIREMENTS.md (25 requirements across 7 phases), PROJECT.md (v3.1 goal)*
*Phase structure: user-specified dependency graph (41 serial foundation → 42+43 parallel → 44+45+46 parallel → 47 capstone)*
*Previous milestone (v3.0 The Birth): 10 phases shipped (31-40), 55 requirements, 820 assertions*
