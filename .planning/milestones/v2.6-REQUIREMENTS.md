# Requirements: GSD-Amauta v2.6 "Sight Beyond Sight"

**Defined:** 2026-04-09
**Core Value:** Every RPETD phase must see what other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats.

**Research inputs:**
- `.planning/research/v2.6/STACK.md` (stack additions)
- `.planning/research/v2.6/FEATURES.md` (table stakes vs differentiators)
- `.planning/research/v2.6/ARCHITECTURE.md` (integration points, build order)
- `.planning/research/v2.6/PITFALLS.md` (risks, anti-features, rollout)
- `.planning/research/v2.6/SUMMARY.md` (synthesis + 5 course corrections)
- `~/.claude/plans/reactive-watching-fountain.md` (original approved plan)

---

## v1 Requirements (v2.6 scope)

### Phase 0: Tech-Debt Sweep (prerequisite to all v2.6 work)

Research finding: baseline has 34 CJS fails + 6 pytest fails (confirmed 2026-04-09). Adding mandates on top of a flaky base amplifies flakes. Phase 0 gets baseline to green before any v2.6 upgrades land.

- [x] **TECH-01**: Fix `tests/test_daemon_integration.py::TestHealthResponseHasAllRequiredFields` — regex helper doesn't extract `oidc_enabled`/`oidc_issuer` fields even though they exist at `amauta-daemon.py:1031-1032`
- [x] **TECH-02**: Fix `tests/test_enrichment_memory.py` mock StopIteration — 3 tests fail because mock iterators are exhausted mid-test (fixture cleanup issue)
- [x] **TECH-03**: Fix `tests/test_gates.py::TestValidateAllGates::test_exactly_5_gates_returned` — gate-count assertion drifted
- [x] **TECH-04**: Fix `tests/test_pg_integration.py::TestRetentionMovesOldEntries` retention cleanup flake
- [x] **TECH-05**: Fix `tests/e2e-lifecycle.test.cjs` 15-second timeout flakes in claim/RPETD R-P-E-T phases (spawned-process subprocess timeout — likely daemon-busy race condition)
- [x] **TECH-06**: Fix `tests/gsd-amauta.test.cjs::12. task status after validate` — status stuck at "pending" after validate --pass

**Success:** `npm test && pytest` = 0 failures before Phase 1 starts. Agreed baseline.

---

### Phase 1: D-Phase Structured Learning + CLI Dedup

Research finding: D-phase ships FIRST because every other phase reads from its tag schema. Structured format is for HUMAN review and SKB promotion criteria, NOT for retrieval (free-text + embeddings still wins recall). Pair with `cli-variables.md` reference to dedupe boilerplate across all 11 agents (context rot defense).

- [ ] **LEARN-01**: `get-shit-done/references/learning-format.md` exists with WHAT/WHY/WHEN/TAGS template + examples per agent type
- [ ] **LEARN-02**: `gsd-memory.cjs learn --structured` flag accepts WHAT/WHY/WHEN/TAGS fields and stores as free-text in `text` column with parsed fields in existing `tags jsonb` column (NO new PG column)
- [ ] **LEARN-03**: `gsd-memory.cjs search` supports `--category` and `--tags` text filters against the existing `tags jsonb` column, with GIN index verified (add if missing)
- [ ] **LEARN-04**: Tag inflation defense — cap at 5 tags per learning; reject learnings with tags-only that match generic set ({"best-practice", "general", "lesson", "insight"})
- [ ] **LEARN-05**: Echo-chamber defense — `gsd_memory` gains an `applied_count int default 0` column; incremented when a learning is referenced via `APPLIED_LEARNING:` in task notes; learnings with applied_count > 10 require manual review before SKB promotion
- [ ] **LEARN-06**: All 11 agent definitions (`agents/*.md`) updated to emit structured LEARNING blocks in D-phase content per the template in learning-format.md
- [ ] **LEARN-07**: `get-shit-done/references/cli-variables.md` exists with the shared `CLI=`, `RLM=`, `MEM=`, `RESEARCH=` variable declarations; 11 agents reference it via runtime Read at start of RPETD protocol (NOT `@` include — that syntax doesn't work in agent files)

**Kill switch:** `GSD_D_STRUCTURED=false` disables structured learning parser (falls back to free-text storage)
**Measurement:** memory tag GIN index queries < 50ms; pytest + npm test green; no regression in auto-learning rate

---

### Phase 2: E-Phase Research-Informed Execution Mandate

Research finding: pre-execution mandates are theatre unless externally verifiable. Mandate is ADVISORY in v2.6 (warn + log), becomes a HARD GATE in v2.7. Uses runtime Read for shared reference, not `@` include syntax.

- [ ] **EXEC-01**: `get-shit-done/references/pre-execution-checklist.md` exists with failure-pattern query, SKB best-practice query, RLM style-match query, and 8-item security checklist (input validation, SQL injection, XSS, path traversal, auth check, secret leak, rate limiting, error-message info leaks)
- [ ] **EXEC-02**: All 4 executor agents (`executor-backend.md`, `executor-frontend.md`, `executor-infra.md`, `executor-general.md`) updated with 3-line `<pre_execution_mandate>` section that instructs the executor to Read the pre-execution-checklist.md reference before E-phase
- [ ] **EXEC-03**: E-phase RPETD content must include structured `PRE_EXECUTION_EVIDENCE:` block with 4 subfields: `failure_patterns_queried`, `best_practices_queried`, `existing_style_queried`, `security_checklist` (8 items with applied/n-a/skipped-because)
- [ ] **EXEC-04**: `gsd-validator` agent parses `PRE_EXECUTION_EVIDENCE:` block from E-phase content; logs WARNING (advisory) if missing or empty; does NOT fail validation in v2.6
- [ ] **EXEC-05**: `gsd-memory search --source auto_learning,lesson-learned --tags "failure,<domain>"` wired into executor pre-code workflow; result set counted and logged
- [ ] **EXEC-06**: `gsd-rlm query "<task title>" --path <target file or dir> --top-k 5` wired into executor pre-code workflow for style matching
- [ ] **EXEC-07**: Security checklist is not cargo-cult — each item must be `applied` (with brief note) or `n/a` (with brief reason) or `skipped because <reason>`. Empty checklist = advisory warning.
- [ ] **EXEC-08**: All 4 executors' D-phase learning output references at least one `APPLIED_LEARNING:` citation OR explicitly notes "no applicable prior learnings for this task"

**Kill switch:** `GSD_E_MANDATE=advisory` (default in v2.6) | `GSD_E_MANDATE=off` disables entirely
**Measurement:** Gate 6 evidence parse rate > 80% across v2.6 tasks; no increase in executor task failure rate

---

### Phase 3: T-Phase QA Department + Spec Inheritance

Research finding: blocked on missing `_inherit_parent_spec()` helper at `amauta.py:2218`. Ships as commit 1 of this phase. Back-testing RED-GREEN is MANDATORY for bug-fix tasks (per user decision).

- [ ] **QA-01**: `amauta.py` gains `_inherit_parent_spec(item)` helper that walks parent chain (task → story → epic) and extracts `success_criteria` field, appends to item context in `_enrich_task_context()` at line 2218
- [ ] **QA-02**: `amauta show TK-XXXX --json` output includes new field `inherited_success_criteria` containing merged parent G/W/T; `--no-inherit` flag to skip
- [ ] **QA-03**: `agents/gsd-checker.md` updated `<post_check_mode>` to pull parent story `success_criteria` via `amauta show --json`, verify each Given/When/Then explicitly, log pass/fail per criterion in T-phase RPETD content
- [ ] **QA-04**: `agents/gsd-validator.md` adds Gate 6 "Parent-story acceptance criteria individually verified" — validator MUST check that T-phase content references each G/W/T from `inherited_success_criteria` (advisory in v2.6.2, hard gate in v2.6.3)
- [ ] **QA-05**: Edge-case generation — checker prompt requires 2+ edge cases per happy-path criterion (null input, boundary values, concurrent access, timeout, malformed data); edge cases listed in T-phase content under `EDGE_CASES:` block
- [ ] **QA-06**: Regression sweep — `get-shit-done/workflows/test-phase.md` instructs executor/checker to run full `npm test && pytest` on code tasks and log pass/fail counts before/after in T-phase content under `REGRESSION:` block (e.g., `before: 2479p/6f, after: 2479p/6f, no regression`)
- [ ] **QA-07**: Adversarial testing for security-relevant code — `test-phase.md` adds checklist for path traversal, injection, oversized payload, missing auth; relevant tasks marked with `security-sensitive: true` metadata trigger adversarial checks
- [ ] **QA-08**: Back-testing RED-GREEN MANDATORY for bug-fix tasks — task type `bug` MUST have RED commit (reproducing the bug) before GREEN commit (fix); enforced by `checker` when reviewing E-phase commit graph; use `git log --grep="(<phase>)" --reverse` to verify RED appears before GREEN

**Kill switch:** `GSD_T_SPEC_INHERIT=false` disables spec inheritance walk (falls back to task-only success_criteria)
**Measurement:** parent-story spec inheritance rate > 90% on tasks with parent; edge-case generation present on all code tasks; regression sweep logged on every code task; RED-GREEN pattern verified on 100% of bug-type tasks

---

### Phase 4: R-Phase Creative Research (Narrowed)

Research finding: creative prompting is mostly snake oil for codebase-grounded tasks (JetBrains Junie Oct 2025: 3x rollback rate for novel suggestions). Narrowed to task-type gated (research/exploration tasks only, NOT implementation). Default opt-in per task.

- [ ] **CREATIVE-01**: `get-shit-done/references/creative-research.md` exists with 5 query transformation techniques documented: lateral/analogy, inversion ("why X fails"), constraint removal, cross-domain transfer, anti-pattern/worst-practice
- [ ] **CREATIVE-02**: `gsd-research.cjs --creative` flag accepts a topic and emits 3 variant queries per input following the creative-research.md techniques; runs each variant through the existing 5-step cascade; dedupes results via existing Jaccard threshold
- [ ] **CREATIVE-03**: Task-type gating — `gsd-research.cjs` auto-enables `--creative` ONLY when the caller task has `type in ("epic", "story")` OR `task_type in ("research", "exploration", "architecture-review", "pattern-search")`. Implementation tasks (type=task|bug with code file patterns) default to the current conservative single-query cascade.
- [ ] **CREATIVE-04**: `agents/gsd-researcher.md` updated with `<creative_protocol>` section documenting when to use `--creative` vs conservative cascade; researcher checks task metadata before invoking
- [ ] **CREATIVE-05**: Perplexity token budget monitoring — creative mode must log per-variant token usage; total Perplexity cost delta < 20% vs baseline measured on 10 comparable tasks

**Kill switch:** `GSD_R_CREATIVE=off` disables creative variants entirely (falls back to conservative cascade everywhere)
**Measurement:** creative mode only activates on research/exploration tasks; no regression on implementation tasks; Perplexity token cost delta < 20%; no new hallucinated API calls in creative-mode task output

---

### Phase 5: P-Phase Task-Management Integration (LAST — highest blast radius)

Research finding: highest blast radius on task topology, ships LAST. Uses structured XML in PLAN.md + workflow tool for 2-pass dep linking. All prior phases must be measured-stable before this ships.

- [ ] **PLAN-01**: `agents/gsd-planner.md` updated `<planning_protocol>` to emit structured XML plan block with `<task>` elements containing `id`, `title`, `agent`, `depends_on`, `success_criteria` fields (inherits from parent story via the Phase 3 helper)
- [ ] **PLAN-02**: `get-shit-done/bin/gsd-tools.cjs` gains new `plan-to-tasks <plan-file>` subcommand that parses the XML block, does a 2-pass walk (pass 1 creates tasks via `amauta add task --parent ST-XXXX`, pass 2 links deps via `amauta link`), and is idempotent on re-runs (skips already-existing tasks by stable ID)
- [ ] **PLAN-03**: Auto-agent-assignment — `plan-to-tasks` reads `get-shit-done/agent-capabilities.json` and assigns `--agent` to each task based on file-pattern matching of the task's target file paths. Tasks with no file-pattern match default to `executor-general`. Tasks with multiple matches use the performance tiebreaker (existing logic in `gsd-tools.cjs routeExecutor`).
- [ ] **PLAN-04**: ~~Auto-dep-linking — explicit `depends_on` field in XML creates `amauta link` edges; planner can also set implicit dependencies via task ordering (task N+1 depends on task N by default) with `parallel: true` to opt out~~

  Dependencies are **explicit-only**. Every dependency MUST appear in `<depends_on>`. Tasks without explicit dependencies are parallel-eligible by default. NO implicit N+1 ordering.

  *Errata (Phase 14): Original implicit-N+1 text struck per PITFALLS P8 ("reject spurious dependency inference"). See 14-CONTEXT.md Area 2.*
- [ ] **PLAN-05**: Runaway defense — `plan-to-tasks` caps sub-task creation at 10 per plan (from PITFALLS research). Plans exceeding 10 tasks must be split into multiple plans. Hard error with guidance message.
- [ ] **PLAN-06**: Task-creation exit criteria — `get-shit-done/workflows/plan-phase.md` fails plan review if any sub-task lacks `--agent`, if any dep cycle detected, or if task count > 10
- [ ] **PLAN-07**: P-phase RPETD content includes structured output: task IDs created, agent assignments with reasoning, dependency graph as DAG text, inherited success criteria per task

**Kill switch:** `GSD_P_AUTO_TASK=false` disables plan-to-tasks parser (falls back to manual task creation)
**Measurement:** task creation count per plan < 10; 100% of created tasks have --agent assigned; 0 circular dependencies; planner test pass rate unchanged

---

### Phase 6: End-to-End Dogfood Verification

Research finding: observational only, not a hard gate. Dedicated workflow + CLI tool for future regression detection.

- [x] **DOGFOOD-01**: ~~`get-shit-done/bin/gsd-tools.cjs audit-rpetd-intelligence <task_id>` subcommand~~ standalone binary `get-shit-done/bin/audit-rpetd-intelligence.cjs` parses a completed task's RPETD content and verifies: (a) D-phase has structured LEARNING with non-empty WHAT/WHY/WHEN/TAGS, (b) E-phase has non-empty `PRE_EXECUTION_EVIDENCE` block, (c) T-phase has `inherited_success_criteria` verification + EDGE_CASES + REGRESSION blocks
- [x] **DOGFOOD-02**: `get-shit-done/workflows/verify-rpetd-intelligence.md` workflow creates a sample story, claims it through all 5 phases, invokes `audit-rpetd-intelligence` at the end, reports per-phase compliance
- [x] **DOGFOOD-03**: ~~`scripts/verify-v26.sh` end-to-end shell script~~ `scripts/verify-v26.cjs` end-to-end Node script runs the full dogfood flow + `amauta health` + `npm test` + `pytest` and emits a PASS/FAIL report per capability
- [x] **DOGFOOD-04**: `commands/amauta/verify-v26.md` slash command exposes the verification flow to users
- [x] **DOGFOOD-05**: Post-v2.6 regression: ~~`verify-v26.sh`~~ `verify-v26.cjs` must pass 6/6 phases green before the milestone is considered shipped

> **Closeout errata (2026-04-10, Phase 15 closeout commit):** Two requirements changes locked during Phase 15 discuss-phase and applied here. **(a) DOGFOOD-01** subcommand → standalone binary: Q1 (no modifications to existing `.cjs` files during Phase 15) prevented adding a subcommand to `gsd-tools.cjs`; Q6 (`require()` over subprocess) applies — the binary direct-`require()`s gsd-tools.cjs exports for correctness. **(b) DOGFOOD-03/05** `.sh` → `.cjs`: same Q6 rationale — the script must `require()` gsd-tools.cjs exports (`manifestCheck`, `resolvePhaseDir`, `GLOBAL_ALLOWLIST`) to exercise the Phase 13.1 infrastructure directly, not via subprocess indirection. Full audit trail: `.planning/milestones/v2.2-phases/15-dogfood/15-CONTEXT.md` §Gap 1a/1c and `docs/v2.6-dogfood-ledger.md`.

**Kill switch:** none (observational only — doesn't affect running tasks)
**Measurement:** ~~verify-v26.sh~~ verify-v26.cjs reports 6/6 phases green; baseline regression tests unchanged

---

### Phase 13.1: Orchestrator Hardening & Divergence Protocol

Triggered by the Phase 13 silent scope-expansion incident. Five requirements hardening the execute/validate pipeline against drift. Scope is locked at 5; overflow goes to Phase 13.2.

- [x] **HARDEN-01**: Deterministic manifest check — `gsd-tools.cjs manifest-check` subcommand halts the wave when executor writes diverge from per-task `files_expected:` block; per-task check runs in `execute-phase.md` after each task with `git rev-parse HEAD` before/after; global allowlist for orchestrator-generated files; JSON violation reports at `.planning/milestones/<phase>/manifest-violation-<timestamp>.json`; `GSD_MANIFEST_CHECK=warn` override logged in `orchestrator_action`; orchestrator-owned files (`.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`) hard-halt regardless of override; phases 13.1+ mandatory, 9-13 grandfathered. — DONE 2026-04-10 (commits `484f525`, `bac096e`, `6f7a3ce`, fold-in extensions in `5bd25ce`)
- [x] **HARDEN-02**: Divergence protocol — `get-shit-done/references/divergence-protocol.md` with versioned decision tree (4 orchestrator options: re-route, re-plan, expand scope, halt phase), complete divergence_report JSON schema including mandatory `rationalization_check` field, `work_in_progress_state` sub-schema for mid-execution divergences, exit code 87 fallback for report-write failure, validator variant with `verdict_ambiguity` divergence_type, reports written to `.planning/milestones/<phase>/divergence-reports/<task_id>-<timestamp>.json`. — DONE 2026-04-10 (commit `a7032d6`, 414 lines, version 1.0.0)
- [x] **HARDEN-03**: Executor agent updates — mechanical @-reference addition of `get-shit-done/references/divergence-protocol.md` to all 4 executor .md files (`gsd-executor-backend.md`, `-frontend.md`, `-infra.md`, `-general.md`) plus hard rule "if prerequisites unmet, return error, don't implement". Validator (`gsd-validator.md`) gains vocabulary lock (`--pass`/`--fail`/`--gaps-found`), never-invent-req-IDs rule, and divergence report scanning before gate evaluation. — DONE 2026-04-10 (commits `fc9a735`, `421312e`, `a9ad0b5`, `82b0e6c`, `f41eb5a`)
- [x] **HARDEN-04**: Validator `--gaps-found` flag — `cmdValidate` in `get-shit-done/bin/gsd-amauta.cjs` gains `--gaps-found` (exit code 2); `gaps-report-<timestamp>.json` with every gap tied to `requirement_id`; `non_gaps_observations[]` pressure-release array; orchestrator routing: pass→advance, gaps_found→re-route to re-planning (no retry counter), fail→human escalation; `gaps_found` does NOT count toward the 3-consecutive-failure auto-escalation rule. — DONE 2026-04-10 (commits `708be5a`, `123fb71`)
- [x] **HARDEN-05**: Synthetic divergence test — `tests/13.1-manifest-check.test.cjs` (deterministic unit test, runs in `npm test`) + `tests/13.1-divergence-protocol.integration.test.cjs` (behavioral test: real LLM via Task tool, no mocking, assertions on filesystem effects, 3 scenarios × 5 runs = 15 invocations, preserves temp dir on failure); `scripts/run-behavioral-tests.cjs` runner + `test:behavioral` npm script; programmatic fixture functions `createStalePrerequisiteScenario()` / `createUnexpectedFileStateScenario()` / `createManifestViolationScenario()`; Phase 13 incident replay test named exactly `test('Phase 13 incident replay: silent re-implementation is now caught')`; CI auto-triggers `npm run test:behavioral` on PRs modifying `agents/**/*.md`, `get-shit-done/workflows/execute-phase.md`, or `get-shit-done/references/divergence-protocol.md`. — DONE 2026-04-10 (commits `71b8b17`, `aaf60d2`, `48865f5`, `93b9e7c`, `5bd25ce`; deterministic suite 13/13 pass, Phase 13 incident replay test verified in isolation)

**Kill switch:** `GSD_MANIFEST_CHECK=warn` (HARDEN-01 override; removed v2.7). No other overrides.
**Measurement:** deterministic manifest test 1/1 green; behavioral test 15/15 green; Phase 13 incident replay test PASS; `divergence-reports/` and `manifest-violation-*.json` artifacts generated on synthetic scenarios.

---

## v2 Requirements (deferred to v2.7)

### Graph-Ranked Repo Map
- **REPO-01**: Implement Aider-style PageRank-ranked repo map with `--map-tokens` budget
- **REPO-02**: Integrate repo map into RLM context selection as an alternative to raw BM25
- **REPO-03**: Measure retrieval quality delta vs pure BM25

**Deferred because:** algorithmic work, not prompt engineering. Doesn't fit v2.6 scope.

### E-Phase Mandate Hard Gate
- **EXEC-HARD-01**: Promote Gate 6 `PRE_EXECUTION_EVIDENCE` from advisory to hard gate
- **EXEC-HARD-02**: Define evidence-block minimum content thresholds for pass

**Deferred because:** solo-dev rollout risk. Measure v2.6 advisory compliance first.

### Dynamic Subagent Spawning
- **SUBAGENT-01**: Allow planner to dynamically spawn Task subagents for sub-plan execution
- **SUBAGENT-02**: Trajectory evaluation (Devin-style) as monitoring signal

**Deferred because:** Claude Code Task tool pattern needs more production use first.

### Sleep-Time Memory Refinement
- **MEM-SLEEP-01**: Background memory distillation based on usage patterns
- **MEM-SLEEP-02**: Applied_count-driven re-ranking of SKB entries

**Deferred because:** requires applied_count telemetry from v2.6 LEARN-05 to drive decisions.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Rewrite pg_store.py or rlm-service.py | v2.6 is prompt engineering, not platform rewrite — research unanimous on this |
| Add LangChain / CrewAI / AutoGen / DSPy / Instructor | Research explicitly rejected — complexity without value for our use case |
| New PG column for structured learning | Use existing `tags jsonb` — GIN index is sufficient |
| Mem0 / MemGPT / Zep as runtime dependency | Patterns inspire format only; no runtime dep added |
| pytest-bdd / fast-check / Hypothesis as core deps | Opt-in per-project, not core. Listed in STACK.md as available tools |
| Multi-Agent Debate for decision-making | Deferred to v2.7+ (research flagged it as immature for our use case) |
| Toolformer-style self-improving tool use | Out of scope, future research |
| Graph-ranked repo map (algorithmic repo context) | Deferred to v2.7 — see v2 requirements above |
| Redis pub/sub for agent coordination | Current daemon HTTP is sufficient, no coordination need yet |
| Creative research by default on all tasks | Research finding: 3x rollback rate on code tasks; task-type gated instead |
| E-phase hard gate in v2.6 | Advisory first, hard gate in v2.7 after measuring compliance |
| RED-GREEN back-testing for non-bug tasks | Only bug-type tasks require RED-GREEN; feature tasks use standard tests |
| Agent prompt files > 200 lines | Prompt-bloat cap per PITFALLS research; gsd-roadmapper.md (685 lines) is grandfathered |

---

## Traceability

v2.6 phase numbering continues from v2.5 (which ended at Phase 8). v2.6 uses Phase 9..15.

| Requirement | Phase | Category | Kill Switch | Status |
|-------------|-------|----------|-------------|--------|
| TECH-01 | Phase 9 | Tech-Debt Sweep | N/A | Pending |
| TECH-02 | Phase 9 | Tech-Debt Sweep | N/A | Pending |
| TECH-03 | Phase 9 | Tech-Debt Sweep | N/A | Pending |
| TECH-04 | Phase 9 | Tech-Debt Sweep | N/A | Pending |
| TECH-05 | Phase 9 | Tech-Debt Sweep | N/A | Pending |
| TECH-06 | Phase 9 | Tech-Debt Sweep | N/A | Pending |
| LEARN-01 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| LEARN-02 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| LEARN-03 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| LEARN-04 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| LEARN-05 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| LEARN-06 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| LEARN-07 | Phase 10 | D-Phase Structured Learning + CLI Dedup | `GSD_D_STRUCTURED` | Pending |
| EXEC-01 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-02 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-03 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-04 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-05 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-06 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-07 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| EXEC-08 | Phase 11 | E-Phase Research-Informed Execution Mandate | `GSD_E_MANDATE` | Pending |
| QA-01 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-02 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-03 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-04 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-05 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-06 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-07 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| QA-08 | Phase 12 | T-Phase QA Department + Spec Inheritance | `GSD_T_SPEC_INHERIT` | Done (4c57b53) |
| CREATIVE-01 | Phase 13 | R-Phase Creative Research (Narrowed) | `GSD_R_CREATIVE` | Done (27a9514) |
| CREATIVE-02 | Phase 13 | R-Phase Creative Research (Narrowed) | `GSD_R_CREATIVE` | Done (27a9514) |
| CREATIVE-03 | Phase 13 | R-Phase Creative Research (Narrowed) | `GSD_R_CREATIVE` | Done (27a9514) |
| CREATIVE-04 | Phase 13 | R-Phase Creative Research (Narrowed) | `GSD_R_CREATIVE` | Done (27a9514) |
| CREATIVE-05 | Phase 13 | R-Phase Creative Research (Narrowed) | `GSD_R_CREATIVE` | Done (27a9514) |
| HARDEN-01 | Phase 13.1 | Orchestrator Hardening & Divergence Protocol | `GSD_MANIFEST_CHECK` (01 only) | Done |
| HARDEN-02 | Phase 13.1 | Orchestrator Hardening & Divergence Protocol | `GSD_MANIFEST_CHECK` (01 only) | Done |
| HARDEN-03 | Phase 13.1 | Orchestrator Hardening & Divergence Protocol | `GSD_MANIFEST_CHECK` (01 only) | Done |
| HARDEN-04 | Phase 13.1 | Orchestrator Hardening & Divergence Protocol | `GSD_MANIFEST_CHECK` (01 only) | Done |
| HARDEN-05 | Phase 13.1 | Orchestrator Hardening & Divergence Protocol | `GSD_MANIFEST_CHECK` (01 only) | Done |
| PLAN-01 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| PLAN-02 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| PLAN-03 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| PLAN-04 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| PLAN-05 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| PLAN-06 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| PLAN-07 | Phase 14 | P-Phase Task-Management Integration | `GSD_P_AUTO_TASK` | Done (f9016bd) |
| DOGFOOD-01 | Phase 15 | End-to-End Dogfood Verification | N/A | Done (15-01, 16513ed, errata 2026-04-10) |
| DOGFOOD-02 | Phase 15 | End-to-End Dogfood Verification | N/A | Done (15-01, 26ae849) |
| DOGFOOD-03 | Phase 15 | End-to-End Dogfood Verification | N/A | Done (15-01, 36a2d2a, errata 2026-04-10) |
| DOGFOOD-04 | Phase 15 | End-to-End Dogfood Verification | N/A | Done (15-01, 447c9b5) |
| DOGFOOD-05 | Phase 15 | End-to-End Dogfood Verification | N/A | Done (15-02, 5d2f1f8, errata 2026-04-10) |

**Coverage:**
- v2.6 requirements: 46 total (6 + 7 + 8 + 8 + 5 + 7 + 5)
- Mapped to phases 9..15: 46
- Unmapped: 0 ✓
- Duplicates: 0 ✓

**Phase → Requirement Count:**
- Phase 9 (Tech-Debt Sweep): 6 requirements
- Phase 10 (D-Phase Structured Learning + CLI Dedup): 7 requirements
- Phase 11 (E-Phase Research-Informed Execution Mandate): 8 requirements
- Phase 12 (T-Phase QA Department + Spec Inheritance): 8 requirements
- Phase 13 (R-Phase Creative Research Narrowed): 5 requirements
- Phase 14 (P-Phase Task-Management Integration): 7 requirements
- Phase 15 (End-to-End Dogfood Verification): 5 requirements

---

*Requirements defined: 2026-04-09 after 4 parallel researcher agents (Stack, Features, Architecture, Pitfalls) validated the approved plan and flagged 5 course corrections.*
*Last updated: 2026-04-09 after course corrections adopted: ship-order reversed (D first, P last), R-phase narrowed to task-type gating, E-phase mandate advisory-in-v2.6/hard-in-v2.7, structured learning as human-review format (not retrieval optimizer), Phase 0 tech-debt sweep prerequisite.*
