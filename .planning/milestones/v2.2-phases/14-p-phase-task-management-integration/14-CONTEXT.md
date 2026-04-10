# Phase 14: P-Phase Task-Management Integration - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Close the loop between PLAN.md and the amauta task registry. Today the planner emits `<task>` XML inside PLAN.md and `execute-phase.md` runs it directly — but tasks are NOT registered in amauta with full metadata, which is exactly the gap Phase 13.1 post-mortem flagged as item #1. Phase 14 adds `gsd-tools.cjs plan-to-tasks <plan-file>` that parses the XML, two-pass registers tasks in amauta (Pass 0 validates plan shape, Pass 1 creates tasks, Pass 2 links dependencies), auto-assigns agents from `<files_expected>` patterns, caps at 10 tasks per plan, rejects cycles at plan time, detects PLAN.md ↔ amauta drift on re-runs, and emits a structured `PLAN_REGISTRATION:` block in P-phase RPETD content for Phase 15 dogfood verification.

Highest blast radius in v2.6 — ships LAST because every other RPETD upgrade depends on stable task topology underneath it. The seven requirements PLAN-01..07 are well-specified in REQUIREMENTS.md; this CONTEXT captures the HOW, not the WHAT.

</domain>

<decisions>
## Implementation Decisions

### Pre-decision LOCKS (asserted before gray-area discussion began)

#### LOCK A — Task cap stays at 10
REQUIREMENTS.md PLAN-05 is the spec; DELTA paper's 12-cap is prior-art research, not a correctness argument. Phase 14 ships at 10. If research surfaces a correctness argument for 12 between now and v2.7 (e.g., "10 produces excess plan-splitting that destroys parallelism in measurable ways"), it gets a v2.7 conversation, not a silent 14 patch.

#### LOCK B — `_dedup_check` global guard cannot be weakened
The bypass for plan-to-tasks idempotency MUST be scoped: only suppresses similarity matches against other `plan-to-tasks`-sourced entries from the same `plan_id`. Manual `amauta add task` calls keep the full 70%/60% guard. Any design that turns global dedup off is rejected.

---

### Area 1 — Identity & Idempotency Contract

#### Stable plan-local-ID ↔ amauta TK-XXXX mapping
- **Mapping lives in amauta task metadata fields**: `metadata.plan_local_id` (e.g. `"14-01-01"`) and `metadata.plan_file` (e.g. `".planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-01-PLAN.md"`).
- `plan-to-tasks` queries `amauta board --filter-metadata` (or equivalent) to find existing tasks before creating new ones.
- **PLAN.md is immutable post-write.** No write-back, no inline `amauta_id` attribute, no sidecar JSON. PLAN.md mutability would conflict with HARDEN-01's manifest invariants.
- Aligns with Phase 12's "metadata jsonb is the right place for cross-cutting refs" precedent.

#### `_dedup_check` bypass mechanism (LOCK B implementation)
- **Two-layer scoped bypass**: `source: "plan-to-tasks"` field stamped on the task record AND `--from-plan <plan_id>` CLI flag passed to `amauta add task`.
- `_dedup_check` is patched to skip the similarity check IFF BOTH conditions hold: `source == "plan-to-tasks"` AND `--from-plan` matches an existing task's `metadata.plan_id`.
- Manual `amauta add task` calls still hit the full 70%/60% guard. Future callers that set `source` without the CLI flag inherit no bypass.
- Phase 10 LEARN-05 two-layer kill-switch pattern (caller + callee both required). Source field provides the audit trail; CLI flag provides the gate.
- **Mandatory test (single test, three assertions):**
  1. Two `plan-to-tasks`-sourced tasks from the SAME `plan_id` with 90% title similarity → both create successfully (bypass fires).
  2. Two `plan-to-tasks`-sourced tasks from DIFFERENT `plan_id` with 90% title similarity → second triggers dedup (bypass scoped).
  3. A manual `amauta add task` with 70% similarity to ANY existing task → dedup triggers regardless of source (global guard preserved).

#### Story-wrapper creation
- **PLAN.md gets a top-level `<story>` block as a first-class element**, sibling to `<task>` blocks. Fields: `<title>`, `<success_criteria>` (Given/When/Then), `<doc_refs>`.
- `plan-to-tasks` parses the `<story>` block as part of Pass 0 and creates the story via `amauta add story` BEFORE Pass 1 (call it Pass 0.5 if needed). Captures the resulting ST-ID and threads it into Pass 1 as `--parent ST-XXXX` for every task.
- **`<story>` is MANDATORY, not optional.** A PLAN.md without a `<story>` block is rejected by `plan-to-tasks` as a malformed plan. Same lesson as HARDEN-01's `files_expected:` mandate — optional becomes unwritten.
- Single source of truth for story content. No orchestrator/planner authoring split. Story `success_criteria` is what `_inherit_parent_spec` walks at claim time (Phase 12).

#### Phase cutoff (HARDEN-01 mirror)
- **Hard cutoff at phase ≥ 14.** Orchestrator skips `plan-to-tasks` entirely for phases 9-13. "Phases 13.1+ get manifest-check, phases 14+ get plan-to-tasks" — symmetric, one cutoff per phase, documented in STATE.md.
- Phase number is authoritative, NOT the presence of a `<story>` block. A future editor adding `<story>` to a Phase 12 plan for documentation reasons must NOT accidentally trigger registration.
- Existing 9-13 plans never get back-registered; the data lives in commit history, not amauta.
- **STATE.md Roadmap Evolution gets one durable line:** *"Phase 14+ plans are auto-registered via plan-to-tasks. Phases 9-13 are grandfathered. The presence of a `<story>` block is not sufficient to trigger registration — the phase number cutoff is authoritative."*

---

### Area 2 — Agent Assignment & Dependency Model

#### `<agent>` authority — both run, mismatch halts
- `plan-to-tasks` computes `routeExecutor()` over the union of `<files_expected>.modify` + `<files_expected>.create` for each task, then compares against the planner-emitted `<agent>` field.
- **Match → use it. Mismatch → file `divergence_report` with `divergence_type: "agent_assignment_conflict"` and HALT plan-to-tasks before any task creation.**
- Forces planner reconciliation: either the `<agent>` field is wrong OR the `<files_expected>` list is wrong. Both are bugs, neither should be silent. Aligns with HARDEN-02 divergence-over-flow principle.
- This requires a NEW enum value in `divergence-protocol.md` — see "divergence-protocol enum extensions" below.

#### Default dependency relationship — explicit-only, parallel by default
- Every dependency MUST appear in `<depends_on>`. NO implicit N+1 ordering. Tasks default to parallel-eligible.
- Aligns with PITFALLS P8 ("reject spurious dependency inference") which is the binding constraint.
- **PLAN-04's implicit-ordering language is a real REQUIREMENTS errata, not a reinterpretation.** REQUIREMENTS.md gets the original implicit-N+1 text struck through with the new explicit-only text underneath, plus a commit-referenced footnote citing PITFALLS P8 as the correctness argument. The edit happens in Phase 14's CLOSEOUT commit, not inline during execution. Plan-phase must surface this so it doesn't get buried in a refactor commit. Silent re-reading of a requirement to mean its opposite is the paperwork drift the closeout dogfood memo (project_phase13_1_closeout_paperwork_dogfood.md) warns against.
- **Mitigation for missing explicit deps:** plan-checker emits an advisory warning if a wave has zero `<depends_on>` edges across N>2 tasks (likely-missing-deps signal). Advisory only, not a hard error.

#### Authoritative DAG cycle detection — Pass 0 of plan-to-tasks
- Single source of truth. `plan-to-tasks` runs full batch DAG cycle check before Pass 1 creates any task.
- Lifts the per-edge `_reaches()` check in `cmd_link` (`amauta.py:5419`) up one level into batch validation. `cmd_link`'s per-edge check stays in place for the manual `amauta link` path; Phase 14 adds the batch path on top.
- Plan-checker stays focused on plan content quality (read_first, AC, action concreteness) and does NOT duplicate graph logic. Two-layer pattern was for kill switches, not deterministic checks.
- Hard error on cycle, no partial creation, no rollback needed because nothing was created. Aligns with REQUIREMENTS PLAN-05 "reject at plan time, not execution time."
- **Mandatory synthetic test:** Same shape as HARDEN-05's synthetic divergence test. Deterministic cyclic-graph fixture, four assertions in one test:
  1. Hard error returned (non-zero exit).
  2. Zero tasks created in amauta.
  3. Zero `amauta link` calls attempted.
  4. Structured error output naming the cycle participants by plan-local ID (not just "a cycle exists").
- Without this test the "no partial creation" guarantee is faith, not proof.

#### `routeExecutor()` input — modify + create only
- Pass `union of <files_expected>.modify + <files_expected>.create`, comma-joined, to `routeExecutor()`.
- **Excludes `<files_expected>.delete`.** Delete-only tasks (refactor cleanup, file removal) shouldn't route to backend just because the deleted file ends in `.py` — the work is about removal, not modification. Information about what USED to exist is misleading for routing.
- Implementation is one-line in `plan-to-tasks`.

---

### Area 3 — Failure-Mode Contract

#### 10-task cap enforcement point — Pass 0 of plan-to-tasks (single source)
- Same place as cycle detection. `plan-to-tasks` counts `<task>` elements in Pass 0; > 10 → hard error with split-boundary suggestion before any task creation.
- Symmetric with the cycle-detection lock. Pass 0 owns ALL plan-shape validation.
- Plan-checker stays focused on content quality.
- **Cap-overflow case folds into the existing Pass 0 test file**, not a separate test. 13-task fixture, assertions: hard error + zero creation + structured output with the cap number visible. Pass 0 test file covers cycle and cap together.

#### Cap-overflow guidance — files-disjoint split-boundary suggestion
- `plan-to-tasks` walks the task list, finds the largest contiguous prefix where every task's `<files_expected>.modify + .create` is disjoint from the next batch, suggests the split index there.
- **Output is structured JSON, not just prose.** Schema: `{cap, actual, suggested_split_index, split_rationale, new_plan_files: []}` PLUS a human-readable string for terminals. Tests assert on the JSON, not the prose. Same HARDEN-05 lesson — assert on filesystem effects and structured outputs, not LLM/CLI prose.
- Example output: `Plan has 13 tasks, max 10. Suggested split boundary: between task 7 and 8 (tasks 1-7 touch get-shit-done/bin/, tasks 8-13 touch agents/). Two new PLAN.md files: 14-NN-PLAN-a.md, 14-NN-PLAN-b.md.`
- Files-disjointness is the meaningful boundary because that's how `execute-phase` groups waves in practice. Dependency-graph cuts are a proxy; file-disjointness is what matters for parallel execution.
- **Mandatory three-case unit test for the split algorithm:**
  1. Tasks whose files overlap with everyone → output: "no clean boundary, human picks", `suggested_split_index: null`, `split_rationale: "no_disjoint_prefix"`.
  2. Plan where no disjoint boundary exists but partial overlap is detectable → output: "least-overlapping cut at index N", with the rationale identifying the smallest overlap.
  3. Plan at exactly 10 tasks → no suggestion needed, no error (cap is `≤ 10`, not `< 10`).
- Without these tests the split-boundary logic ships untested and the first real cap-overflow in Phase 15+ produces mysterious suggestions nobody can debug.

#### Mid-flight failure semantics — forward-only, re-run resumes via identity contract
- Pass 2 (link) failure leaves the partial state as-is. `plan-to-tasks` exits non-zero with a structured error report showing which links succeeded and which didn't.
- The identity contract (`metadata.plan_local_id` + `--from-plan` flag) makes the natural recovery a re-run: it skips already-created tasks, checks already-existing links, attempts the missing ones.
- Recovery is "fix the cause of the link failure, re-run plan-to-tasks." No rollback complexity. Tasks are NEVER silently un-created — aligns with audit-log permanence philosophy.
- No `--resume` flag. The normal idempotent re-run already handles resumption transparently; adding a flag adds CLI surface for no semantic gain.
- **Mandatory three-case re-run idempotency test (one fixture):**
  1. Fresh run → re-run immediately: zero new creates, zero new links, exit 0.
  2. Pass 2 partial failure simulation: kill the daemon connection AFTER the first link succeeds. Re-run: remaining links created, already-successful link not duplicated, exit 0.
  3. Pass 1 partial failure simulation: kill the daemon AFTER task 3 of 5 created. Re-run: tasks 4-5 created, all edges then attempted, exit 0.
- All three assert on FINAL state (`amauta board` matches PLAN.md topology exactly), not on intermediate operations.
- **Real failure injection, not mocks.** The test harness needs `spawnDaemon()` + `killDaemon()` helpers with lifecycle control. SIGKILL the actual daemon mid-operation, then restart, then re-run. Mocks hide the contract drift this test is supposed to catch.
- Without these tests, "re-run resumes via identity contract" is a design claim, not a verified property. The whole reason forward-only wins over atomic-rollback is that the identity contract makes recovery free — that's only true if it actually works on re-run, which is only proven if tested.

#### Re-run drift handling — verify-and-halt (drift = divergence event)
- `plan-to-tasks` fetches each existing task by `metadata.plan_local_id`, compares STRUCTURAL fields against the current PLAN.md XML.
- **Compared fields (locked):** `title`, `agent`, `files_expected.modify`, `files_expected.create`, `files_expected.delete`, `depends_on`.
- **Explicitly NOT compared:** `read_first`, `action`, `acceptance_criteria`. These legitimately drift between planner revisions without changing task topology identity. Flagging them as drift produces false positives that train operators to ignore the drift check (false-positive immunity decay).
- Match → silent skip. Mismatch → halt with `divergence_report` (NEW `divergence_type: "plan_amauta_drift"`), enumerating the diff.
- Forces human reconciliation: either the plan was edited and amauta needs an explicit resync, or amauta was edited and the plan needs to catch up. Silent state divergence is exactly what the divergence protocol exists to catch.

#### divergence-protocol enum extensions (single atomic bump)
- Phase 14 bumps `get-shit-done/references/divergence-protocol.md` from version `1.0.0` to `1.1.0` EXACTLY ONCE, in a single atomic edit.
- **Both new enum values land in the same task:**
  - `agent_assignment_conflict` (Topology Q1)
  - `plan_amauta_drift` (Failure Q4)
- Don't fragment the version bumps into two tasks that each touch the version field — they would collide on the version line and require a merge.
- Bootstrap problem: Phase 14 can't use enum values that don't exist yet. Normally protocol schema changes go to Phase 13.2, but these two are load-bearing for Phase 14's plan-to-tasks work, so they ship as part of Phase 14 in the same task that implements the conflict/drift detection.
- **Phase 13.2 baseline becomes 1.1.0, not 1.0.0.** Flag this in Phase 13.2's eventual scope so 13.2's planning accounts for the updated baseline.

---

### Area 4 — P-phase RPETD Output & Phase 12/15 Handoff

#### PLAN_REGISTRATION block — new structured block
- Parallel to existing `EDGE_CASES:`, `PRE_EXECUTION_EVIDENCE:`, `LEARNING:` blocks. Indented-field format same as the others.
- Operator gets a dedicated parser (`plan_registration_phase_end`).
- Validator gets a structural advisory check (presence + non-empty fields), NOT content judgment.
- "Each parser owns its block type" — Phase 12 lock.
- DOGFOOD-01 in Phase 15 has a dedicated thing to assert on, same as it does for other RPETD intelligence blocks.
- **Parser registration mechanism — verify during plan-phase.** The new `plan_registration_phase_end` parser MUST register via the same parser-registry mechanism the other RPETD block parsers use. Phase 15's DOGFOOD-01 audit will iterate over the parser registry to validate all RPETD blocks; an unregistered parser is invisible to the audit. Plan-phase action: check what the current parser-registration pattern looks like in the codebase. If there's no central registry and each parser is hand-wired, Phase 14 INHERITS the hand-wiring pattern. Introducing a registry is scope creep and defers to Phase 15 or later.

#### PLAN_REGISTRATION block schema — rich, with DAG text
Fields:
- `plan_id` — e.g. `"14-01"`
- `story_id` — amauta ST-XXXX created in Pass 0.5
- `task_count` — e.g. `7`
- `cap` — `10` (literal cap value, makes the block self-describing)
- `task_ids` — ordered list of TK-XXXX
- `agent_assignments` — map of TK-XXXX → `{agent, reasoning}` (e.g. `"executor-backend (routeExecutor matched *.py)"`)
- `edges` — list of `[from, to]` pairs (plan-local IDs OR TK-XXXX, decide in plan)
- `dag_text` — ASCII rendering of the dependency graph
- `inherited_criteria_count` — preview count, NOT the criteria text (see Q3 below)

#### Token budget — 1500 chars total
- Block-level cap: `PLAN_REGISTRATION ≤ 1500 chars`.
- T-phase cap is 1000 chars (Phase 12 lock); P-phase gets 1500. **The extra 500 is specifically for the `dag_text` field.** Document this ratio in the plan with the rationale so the six-month-later "why is P higher than T" question has an answer in the plan, not in someone's memory.
- **Edge case — `dag_text` exceeds 500 chars:** Only the `dag_text` field truncates with `...` and a reference to a sidecar path containing the full graph. Other fields stay intact. The whole block does NOT truncate.
- **Mandatory test:** 20-edge graph fixture exercises the truncation logic, asserts that `dag_text` truncates AND the other fields remain complete AND the sidecar path is referenced.

#### Inherited success criteria — defer to claim time (Phase 12 lock wins)
- `plan-to-tasks` creates each task with its own `<acceptance_criteria>` as `success_criteria` and sets `parent=<story_id>`. The chain is intact.
- `_inherit_parent_spec` walks the chain at CLAIM time (Phase 12 mechanism, already shipped). plan-to-tasks does NOT pre-resolve and does NOT stamp `metadata.inherited_spec`.
- **`inherited_criteria_count` in PLAN_REGISTRATION is a COUNT, not a preview of the criteria text.** Locked explicitly to prevent future drift toward an `inherited_criteria_preview` field that would duplicate Phase 12's claim-time resolution and recreate the two-sources-of-truth problem.
- The count is computed at registration time as a read-only call to `_inherit_parent_spec` (no caching, no metadata stamp). It's a preview value for human review of the PLAN_REGISTRATION block — "this story will inherit N criteria into each child task at claim time."
- If Phase 15's audit wants to verify the inheritance is correct at claim time, it calls `_inherit_parent_spec` read-only itself — that's a Phase 15 concern, not a Phase 14 one.

#### Test strategy — hybrid
- **Pure CJS unit tests** (no daemon, no mocks needed) for Pass 0 logic: cycle detection, cap counting, schema validation, files-disjoint split algorithm, agent_assignment_conflict detection.
- **Real-daemon integration test** for end-to-end registration: Pass 1 + Pass 2, idempotency 3-case test (with daemon SIGKILL), drift detection, dedup bypass scope (3-assertion test), PLAN_REGISTRATION parser, dag_text truncation.
- File naming: `tests/14-plan-to-tasks.test.cjs` for unit, `tests/14-plan-to-tasks.integration.test.cjs` for integration. Matches Phase 12/13.1 conventions.
- Matches Phase 12's pattern (CJS for parsers, real daemon for cross-process integration) and Phase 13.1's split between deterministic and behavioral.

### Test Surface Estimate
**~20-25 test cases minimum.** Phase 14 is NOT the phase where test count gets squeezed to fit. The tests ARE the proof the design claims hold:
- Pass 0 deterministic suite (cycle + cap, combined fixture file): ~6 cases
- Files-disjoint split algorithm: 3 cases
- Re-run idempotency with daemon lifecycle: 3 cases
- Drift detection (`plan_amauta_drift`): ~2 cases
- Agent assignment conflict (`agent_assignment_conflict`): ~2 cases
- Dedup bypass scope (single test, three assertions): 1 case
- PLAN_REGISTRATION parser registration + structural advisory: ~2 cases
- `dag_text` truncation with 20-edge fixture: 1 case
- divergence-protocol enum extension version-bump: 1 case
- Hybrid integration suite tying together a full plan-to-tasks → execute → verify cycle: ~2-4 cases

Plan-phase should budget accordingly when atomizing tasks and assigning waves.

### Carry-Forward Decisions from Prior Phases (locked, not re-litigated)

- **Kill switch:** `GSD_P_AUTO_TASK=false` default. Plan-to-tasks parser disabled when set; planner falls back to prose output and manual `amauta add task` calls as in v2.5. Two-layer kill switch (caller + callee) checked in both `gsd-tools.cjs plan-to-tasks` and `execute-phase.md` invocation point. Same advisory-first pattern as Phases 11/12/13.
- **Reference files use runtime Read by agents**, not `@`-include syntax (Phase 10 LEARN-07).
- **New utilities export behind `require.main !== module` guard** so CJS tests can `require()` the functions (Phase 13.1 pattern).
- **External validation principle** (Phase 12): validator checks structural presence, doesn't re-do work.
- **Hard caps don't rely on honor systems** (Phase 10 lesson). The 10-task cap is enforced at Pass 0, not "the planner should keep it small."
- **Each parser owns its block type** (Phase 12). PLAN_REGISTRATION gets its own dedicated parser, not folded into a generic block scanner.
- **gsd-planner.md is at the 200-line ceiling.** Phase 14 additions go to a `references/plan-task-xml-schema.md` runtime Read reference, NOT inline in the planner prompt. Existing `<planning_protocol>` section gets a 3-5 line addition pointing at the reference.
- **Test naming:** `14-*.test.cjs` for CJS, no Python (plan-to-tasks lives entirely in `gsd-tools.cjs`).
- **No new PG schema in v2.6.** Migration 008 (Phase 10 LEARN-05) is the only ALTER TABLE. Phase 14 uses existing `gsd_memory.metadata jsonb` and the existing 39-field task schema (PG sync MIGRATION-007). `metadata.plan_local_id`, `metadata.plan_file`, `source: "plan-to-tasks"` all live in the existing `metadata jsonb` column.
- **HARDEN-01 manifest enforcement is mandatory for phases 13.1+.** Every PLAN.md Phase 14 emits MUST already carry per-task `<files_expected>` blocks. Phase 14 adds `<story>` on top; the existing `<files_expected>` schema is unchanged.
- **Manifest enforcement cutoff symmetry:** Phase 14 adds the parallel cutoff for plan-to-tasks ("phases 14+ get plan-to-tasks") in the same STATE.md "Roadmap Evolution" section that already documents the manifest cutoff.

### Claude's Discretion
- Exact wording of error messages for cap-overflow, cycle detection, agent_assignment_conflict, plan_amauta_drift (within the locked structured-output schemas)
- Internal implementation of the files-disjoint split algorithm (within the locked I/O contract and 3 mandatory test cases)
- Exact ASCII rendering format for `dag_text` (within the 500-char field budget and the mandatory truncation behavior)
- The hand-wiring vs registry decision for parser registration (after plan-phase verifies what pattern exists today)
- Order of operations within Pass 0 between cycle check and cap check (both must run before Pass 1; ordering between them is a flip-a-coin)
- File layout inside `tests/14-plan-to-tasks.integration.test.cjs` (test grouping, fixture organization, helper file structure)
- Whether `spawnDaemon()` / `killDaemon()` helpers live in the integration test file or in a shared `tests/helpers/` module (introduce a shared helper if other phases will need it; inline if it's Phase 14 only)
- Exact field ordering inside the PLAN_REGISTRATION block (within the locked field set)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Roadmap
- `.planning/REQUIREMENTS.md` lines 101-114 — PLAN-01..07 detailed requirements + kill switch + measurement criteria
- `.planning/REQUIREMENTS.md` lines 242-248 — Phase 14 traceability rows
- `.planning/ROADMAP.md` lines 294-333 — Phase 14 deliverables, success criteria, pitfalls prevented, rollback plan

### v2.6 Research
- `.planning/research/v2.6/ARCHITECTURE.md` lines 85-126 — P-phase integration architecture: structured XML schema rationale, 2-pass walk decision (rejected planner-direct-call option a, accepted workflow-parsed option b), `_dedup_check` collision risk, `--schema-version` backward compat note
- `.planning/research/v2.6/PITFALLS.md` lines 49-63 — P1..P8 P-phase pitfalls (runaway sub-task creation, wrong agent assignment, circular deps, vague G/W/T, unreadable plans, over-atomization, priority scoring collapse, spurious dependency inference)
- `.planning/research/v2.6/SUMMARY.md` — Ship-order lock (P-phase ships LAST), highest-blast-radius rationale
- `.planning/research/v2.6/STACK.md` — 90% prompt engineering / 10% tooling, ~425 LOC code changes total budget
- `.planning/research/v2.6/FEATURES.md` — Table-stakes vs differentiators

### Phase 12 dependencies (already shipped, Phase 14 reuses)
- `.planning/milestones/v2.2-phases/12-semantic-memory-pipeline/12-CONTEXT.md` — Phase 12 decisions; `_inherit_parent_spec` claim-time caching, `metadata jsonb` cross-cutting refs precedent, "each parser owns its block type"
- `amauta.py` `_inherit_parent_spec()` (added by Plan 12-01) — Walks task → story → epic, first-non-empty wins, capped at 10 inherited criteria
- `get-shit-done/bin/gsd-amauta.cjs` `cmdShow` — Returns `inherited_spec` in JSON, supports `--no-inherit` flag

### Phase 13.1 dependencies (already shipped, Phase 14 extends)
- `.planning/milestones/v2.2-phases/13.1-orchestrator-hardening-divergence-protocol/13.1-CONTEXT.md` — HARDEN-01..05 decisions
- `get-shit-done/references/divergence-protocol.md` v1.0.0 — Decision tree, divergence_report schema, mandatory `rationalization_check` field. **Phase 14 bumps to v1.1.0** with two new enum values (`agent_assignment_conflict`, `plan_amauta_drift`)
- `get-shit-done/bin/gsd-tools.cjs` `manifestCheck()` — Per-task `files_expected:` enforcement, called from `execute-phase.md` after each task
- `get-shit-done/bin/gsd-tools.cjs` `routeExecutor()` line 184 — Reads `agent-capabilities.json` `file_patterns`, returns `executor-frontend|infra|backend|general`. Phase 14 calls this from plan-to-tasks for agent_assignment_conflict detection

### Reference files (runtime Read pattern)
- `get-shit-done/references/divergence-protocol.md` — Phase 14 BUMPS this to v1.1.0
- `get-shit-done/references/qa-checklist.md` — Reference-file pattern to follow for new `plan-task-xml-schema.md`
- `get-shit-done/references/cli-variables.md` — `$CLI`, `$RLM`, `$MEM`, `$RESEARCH`, `$TOOLS` shell var pattern
- `get-shit-done/references/learning-format.md` — D-phase LEARNING block template (planner inherits)
- `get-shit-done/references/pre-execution-checklist.md` — Phase 11 reference file pattern
- `get-shit-done/references/creative-research.md` — Phase 13 reference file pattern
- **NEW reference file (Phase 14 creates):** `get-shit-done/references/plan-task-xml-schema.md` — Locks the `<story>` + `<task>` + `<files_expected>` + `<depends_on>` schema. Runtime Read by gsd-planner.md.

### Agent definitions
- `agents/gsd-planner.md` (200 lines, at v2.6 ceiling) — `<planning_protocol>` section gets ~5-line addition pointing at `plan-task-xml-schema.md` runtime Read. NO inline schema bloat.
- `agents/gsd-validator.md` — Gains structural advisory check for PLAN_REGISTRATION block presence
- `agents/gsd-operator.md` — Gains `plan_registration_phase_end` parser (registered via existing parser pattern, see Area 4 Q1 verification)

### Workflow files
- `get-shit-done/workflows/plan-phase.md` (645 lines) — Plan checker integration; advisory zero-deps warning lives here
- `get-shit-done/workflows/execute-phase.md` — Already invokes `manifest-check` per task (HARDEN-01); Phase 14 adds `plan-to-tasks` invocation in `discover_and_group_plans` step (post-mortem item #1) gated by phase ≥ 14 cutoff

### CLI tools (Phase 14 modifies)
- `get-shit-done/bin/gsd-tools.cjs` — NEW `plan-to-tasks` subcommand alongside existing `routeExecutor`, `manifestCheck`, `commit`. Sibling functions in the same module — no import-graph cycle (verified during discuss-phase: `gsd-tools.cjs` imports only `./lib/*.cjs`, `gsd-amauta.cjs` does NOT import `gsd-tools.cjs`)
- `get-shit-done/bin/gsd-amauta.cjs` — `cmdAdd` (line 436), `cmdLink` (line 1444). Phase 14 adds `--from-plan <plan_id>` flag to `cmdAdd` for the dedup bypass; `cmdLink` is unchanged (the cycle check at `cmd_link` per-edge stays in place)
- `amauta.py` — `_dedup_check` (line 2461) PATCHED to honor scoped bypass per LOCK B; `cmd_add` (line 2494) carries the new `source` and `--from-plan` plumbing; `cmd_link` (line 5406) `_reaches()` cycle check is unchanged

### Configuration
- `get-shit-done/agent-capabilities.json` — Source of truth for `file_patterns` (read by `routeExecutor`); already includes `security_patterns` from Phase 12. Phase 14 does NOT modify this file — it consumes it.

### State tracking
- `.planning/STATE.md` — Phase 14 cutoff documentation in "Roadmap Evolution" section (one durable line)

### Memory references (researcher should surface during plan-phase)
- `project_phase13_1_postmortem_followups.md` — Item #1 (amauta task pre-registration) is exactly what Phase 14 closes; item #2 (gsd-amauta.cjs inline `resolvePhaseDir` duplication) is a small refactor Phase 14 CAN absorb but is NOT required to; item #5 (SUMMARY.md gitignore) is unchanged
- `project_phase13_1_closeout_paperwork_dogfood.md` — Depth-4 dogfood: orchestrator resisted "while I'm here" rationalization. Same discipline applies to Phase 14's PLAN-04 errata (do it in closeout commit, not inline)
- `project_phase13_1_discuss_phase_reconciliation_dogfood.md` — Depth-5 dogfood: discuss-phase orchestrator caught the directory-slot drift that triggered the reconciliation commit
- `project_phase13_1_wave3_near_miss.md` — "the helper is useless if nothing consumes it" rationalization at hard ceilings — Phase 14 has multiple "while I'm here" temptations (the inline resolver refactor, parser registry introduction, etc.)
- `project_phase13_1_behavioral_test_findings.md` — Phase 13.2 planning input on behavioral test taxonomy. Relevant only insofar as Phase 14's enum extensions need to land cleanly into the same protocol

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

**Already-built infrastructure Phase 14 reuses (don't reinvent):**

- **`routeExecutor()` in `gsd-tools.cjs:184`** — Reads `agent-capabilities.json` `file_patterns`, applies priority order (frontend > infra > backend > general), returns executor name. Phase 14 calls it as a sibling in-file function, no import edge added.
- **`manifestCheck()` in `gsd-tools.cjs:459`** — Per-task `files_expected:` enforcement. Phase 14 doesn't modify it but DOES depend on it: every Phase 14 PLAN.md task already carries the `<files_expected>` block manifestCheck consumes.
- **`_globToRegExp()` and `_matchesAny()` in `gsd-tools.cjs`** — Minimal glob matcher for `files_expected:` paths. Reusable for the files-disjoint split algorithm without adding a runtime dep.
- **`_parseFilesExpectedYaml()` in `gsd-tools.cjs:348`** — Minimal YAML loader for `files_expected:` blocks. The `<task>` XML embeds this YAML inside `<files_expected>`; Phase 14's XML parser can reuse this loader for the inner YAML.
- **`cmd_link` in `amauta.py:5406`** — Per-edge cycle check via `_reaches()`. Stays unchanged. Phase 14 adds batch DAG validation in Pass 0 of `plan-to-tasks` ON TOP of this existing per-edge check.
- **`_dedup_check` in `amauta.py:2461`** — Phase 14 PATCHES this to honor the scoped bypass: skip the similarity check IFF `source == "plan-to-tasks"` AND `--from-plan` matches the existing task's `metadata.plan_id`. The patch is minimal — guard the existing logic with the bypass conditional.
- **`cmdAdd` in `gsd-amauta.cjs:436`** — Phase 14 adds `--from-plan <plan_id>` to the parsed flags and passes it through to either `httpRequest('POST', '/api/add', body)` (daemon path) or `runDirect(args)` (direct path). Symmetric with how `--parent`, `--agent`, etc. are handled.
- **`cmdLink` in `gsd-amauta.cjs:1444`** — Unchanged. Phase 14's Pass 2 calls it via subprocess (`runDirect` or daemon path), not via module import.
- **`_inherit_parent_spec` in `amauta.py`** — Phase 12 helper. Phase 14 calls it READ-ONLY for the `inherited_criteria_count` preview in PLAN_REGISTRATION block. Does NOT cache, does NOT stamp metadata.
- **Existing `<task>` XML format** in `13.1-01-PLAN.md`, `12-01-PLAN.md`, etc. — `<title>`, `<agent>`, `<depends_on>`, `<read_first>`, `<action>`, `<acceptance_criteria>`, `<files_expected>` are already the conventions. Phase 14 LOCKS this schema in `plan-task-xml-schema.md` and adds the `<story>` wrapper. Existing 9-13 plans are grandfathered out of registration (phase cutoff), so backward compat concerns are minimal.

### Established Patterns

- **Two-layer kill switch** (Phase 10 LEARN-05): `GSD_P_AUTO_TASK=false` checked at BOTH the orchestrator invocation point (`execute-phase.md`) AND the `plan-to-tasks` subcommand entry. Either alone is sufficient; the redundancy survives refactors.
- **Runtime Read for reference files** (Phase 10 LEARN-07): `gsd-planner.md` reads `plan-task-xml-schema.md` at task start, not via `@`-include.
- **Structured JSON artifacts as audit trail** (Phase 13.1 HARDEN-01): manifest-violation reports, divergence reports, gaps reports all follow the same pattern. Phase 14's PLAN_REGISTRATION block is structured-text (indented fields, like LEARNING/EDGE_CASES); the cap-overflow guidance is structured JSON.
- **Each parser owns its block type** (Phase 12): no generic catch-all RPETD block scanner; PLAN_REGISTRATION gets its own dedicated parser registered through whatever mechanism the existing block parsers use.
- **Validator checks structural presence, not content** (Phase 12 advisory pattern): validator's PLAN_REGISTRATION check is "block present, fields non-empty, task_count matches edges' max id"; it does NOT re-validate the dependency graph or recompute agent assignments. The PASS 0 logic in plan-to-tasks is the authority.
- **`module.exports` behind `require.main !== module` guard** (Phase 13.1): Phase 14's new functions (`planToTasks`, `_validatePlanShape`, `_filesDisjointSplit`, `_renderDagText`, `_diffPlanVsAmauta`) all export for CJS test imports.
- **Position-based criterion IDs** (Phase 12 SC-01, SC-02): the `<acceptance_criteria>` block in each `<task>` already follows this convention via Phase 12's `_inherit_parent_spec` SC-XX assignment. Phase 14 doesn't touch criterion ID assignment.
- **Forward-only failure with idempotent re-run** (NEW with Phase 14): no rollback, no atomic transactions. Recovery is "fix the cause, re-run." This pattern may be reused in Phase 15 dogfood harness.

### Integration Points

- `get-shit-done/bin/gsd-tools.cjs` — Add `plan-to-tasks` subcommand alongside `commit`, `route-executor`, `manifest-check`. Pure Node.js CLI, no new runtime deps.
- `get-shit-done/bin/gsd-amauta.cjs` — Patch `cmdAdd` to plumb `--from-plan` flag. Minimal diff (~5 lines).
- `amauta.py` — Patch `_dedup_check` to honor scoped bypass (~10 lines, guard the existing logic with the bypass conditional). Patch `cmd_add` to carry the `source` field through to task creation (~5 lines).
- `get-shit-done/workflows/execute-phase.md` — `discover_and_group_plans` step gains a phase-cutoff conditional: phase ≥ 14 → invoke `plan-to-tasks` for each PLAN.md before wave dispatch. Closes post-mortem item #1.
- `get-shit-done/workflows/plan-phase.md` — Plan-checker gets the advisory zero-deps warning logic. NO duplicate cycle check, NO duplicate cap check (those belong in Pass 0).
- `agents/gsd-planner.md` — `<planning_protocol>` adds 3-5 lines pointing at `plan-task-xml-schema.md` runtime Read. NO inline schema bloat.
- `agents/gsd-validator.md` — Add structural advisory check for PLAN_REGISTRATION block (parallel to existing EDGE_CASES, REGRESSION, ADVERSARIAL checks).
- `agents/gsd-operator.md` — Add `plan_registration_phase_end` parser via existing parser-registration mechanism (verify mechanism in plan-phase).
- `get-shit-done/references/divergence-protocol.md` — Bump v1.0.0 → v1.1.0 with `agent_assignment_conflict` and `plan_amauta_drift` enum values (single atomic edit, single Phase 14 task).
- **NEW file:** `get-shit-done/references/plan-task-xml-schema.md` — Locks `<story>` + `<task>` + `<files_expected>` + `<depends_on>` schema. Runtime Read by gsd-planner.md.
- `.planning/STATE.md` — Roadmap Evolution gets one durable line documenting the Phase 14+ cutoff.
- `.planning/REQUIREMENTS.md` — PLAN-04 errata applied in Phase 14 CLOSEOUT commit (not inline). Original implicit-N+1 text struck through, new explicit-only text underneath, footnote citing PITFALLS P8.

### Code paths NOT to touch
- `_dedup_check`'s 70%/60% similarity thresholds — only the bypass conditional is added; the underlying matching logic is unchanged
- `routeExecutor`'s priority order or pattern matching — Phase 14 only consumes it
- `cmd_link`'s per-edge `_reaches()` cycle check — stays in place for the manual link path
- The 39-field PG sync (MIGRATION-007) — Phase 14 reuses `metadata jsonb` only
- `_inherit_parent_spec` — Phase 14 calls it read-only, doesn't modify
- `manifestCheck` — Phase 14 doesn't touch it; consumes its output via existing `<files_expected>` blocks
- `gsd-roadmapper.md` (685 lines, grandfathered) — irrelevant to Phase 14

</code_context>

<specifics>
## Specific Ideas

- **"the identity contract makes recovery free"** — but only if the re-run idempotency tests actually verify it. Real daemon SIGKILL or it's faith.
- **"each parser owns its block type"** is the load-bearing pattern Phase 14 must inherit, not invent. PLAN_REGISTRATION parser registers via the same mechanism the others use; if there's no central registry, that's fine — hand-wire it. Introducing a registry is scope creep for Phase 15+.
- **"Don't fragment the version bump"** — both new divergence_type enum values (`agent_assignment_conflict`, `plan_amauta_drift`) land in `divergence-protocol.md` v1.1.0 in a single Phase 14 task. Phase 13.2 baseline becomes 1.1.0 not 1.0.0 — flag this in 13.2's eventual scope.
- **PLAN-04 is a real REQUIREMENTS errata, not a reinterpretation.** Original implicit-N+1 text gets struck through with explicit-only text underneath, footnote citing PITFALLS P8. Done in CLOSEOUT commit, not inline. Same paperwork-drift discipline as the depth-4 closeout dogfood.
- **The `<story>` block is mandatory** (same lesson as HARDEN-01 `files_expected:`). Optional becomes unwritten. Plan-to-tasks rejects malformed plans without one.
- **Drift comparison is structural, not textual.** Locked field set: `title`, `agent`, `files_expected.{modify,create,delete}`, `depends_on`. `read_first`, `action`, `acceptance_criteria` legitimately drift between planner revisions; flagging them produces immunity decay.
- **Files-disjoint split is the meaningful boundary** because that's how `execute-phase` groups waves. Dependency-graph cuts are a proxy.
- **`inherited_criteria_count` is a COUNT** — preventing future drift toward an `inherited_criteria_preview` field that would duplicate Phase 12's claim-time resolution.
- **Token budget rationale must be captured**, not just the number. P-phase 1500 chars vs T-phase 1000 chars; the extra 500 is for `dag_text`. Document the ratio so the six-month-later question has an answer in the plan.
- **`dag_text` truncates with `...` and a sidecar reference** when many-edge graphs exceed 500 chars. Only the field truncates; other PLAN_REGISTRATION fields stay intact.
- **Forward-only with idempotent re-run** > atomic rollback. Tasks should never be silently un-created (audit-log permanence).
- **Phase 14 has multiple "while I'm here" temptations** that the protocol must catch: the `gsd-amauta.cjs` inline `resolvePhaseDir` refactor (post-mortem item #2), parser registry introduction, expanding the planner prompt inline instead of using a reference file, sneaking PLAN-04 errata into a refactor commit. All four are flagged as deferred or out-of-scope and the rationalization is named in the executor's divergence protocol vocabulary.
- **Phase 14's test count is a feature, not a bloat target.** ~20-25 cases minimum. The tests ARE the proof the design claims hold — squeezing them defeats the phase.

</specifics>

<deferred>
## Deferred Ideas

- **Parser registry introduction** — if the codebase currently hand-wires RPETD parsers, Phase 14 INHERITS hand-wiring. Centralizing into a registry is its own concern, defers to Phase 15 or later.
- **Inline `resolvePhaseDir` refactor in `gsd-amauta.cjs:1108-1113`** (post-mortem item #2) — Phase 14 CAN absorb it but is not required to. The two regexes diverge for hypothetical multi-dot phase ids; if Phase 14 does the refactor, the commit message must call out the regex widening explicitly. Default position: defer to a dedicated cleanup PR.
- **`v2.2-phases/` → `v2.6-phases/` directory rename** (post-mortem item #9) — milestone-wide rename, NOT Phase 14's scope.
- **STATE.md frontmatter `progress` counter reconciliation** (post-mortem item #8) — uniform staleness reasoning still applies; defers until all four counter values can be derived authoritatively in one pass.
- **`amauta plan validate` as a separate CLI subcommand** — Pass 0 logic is currently invoked only via `plan-to-tasks`. A standalone `amauta plan validate <plan-file>` command for ad-hoc validation outside the registration flow is a v2.7 nice-to-have; not Phase 14 scope.
- **`--schema-version` flag for backward compat with v2.5 plans** — Architecture research mentioned this; the phase ≥ 14 hard cutoff makes it unnecessary. Plans 9-13 are grandfathered, not back-registered.
- **Trajectory evaluation / Devin-style monitoring** — explicitly v2.7+ (PITFALLS T7 says defer until golden datasets exist).
- **Suggest-mode atomization** (PITFALLS C5 mitigation, "human approves before tasks created") — v2.6.4 deferred per the v2.6 ship-order. Phase 14 ships fully automatic with kill switch and forward-only failure as the safety net.
- **Per-item kill switch granularity** — single `GSD_P_AUTO_TASK` covers everything, parallel to single `GSD_T_SPEC_INHERIT`.
- **Embedding-based agent assignment fallback for ties** — Architecture research mentioned this for AGT-02 follow-up; Phase 14 stays with the existing routeExecutor priority order + performance tiebreaker.
- **Auto-task priority inheritance from parent story** (PITFALLS P7) — defers to v2.6.4 or v2.7. Phase 14 creates tasks with the planner-supplied `--priority` or default; no inheritance.
- **Spec-driven parent-story kick-back** (PITFALLS P4 prevention — "if parent story has vague G/W/T, planner refuses to atomize") — Phase 14 does not enforce this. The `<story>` block is mandatory, but its `success_criteria` content is not validated for executability. v2.7 hard gate territory.
- **plan-to-tasks behavioral test against real LLM via Task tool** — Phase 13.1's HARDEN-05 pattern. Phase 14 ships deterministic tests + real-daemon integration, NOT real-LLM behavioral. The plan-to-tasks logic is deterministic CLI work, not LLM behavior.
- **Phase 14.1 / Phase 13.2 fork** — Phase 14 ships at 7 requirements (PLAN-01..07). Anything that surfaces during execution but doesn't fit those 7 goes to a 14.1 ticket or rolls into Phase 15 dogfood, NOT silent expansion.

</deferred>

---

*Phase: 14-p-phase-task-management-integration*
*Context gathered: 2026-04-10*
