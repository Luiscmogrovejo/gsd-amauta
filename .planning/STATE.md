---
gsd_state_version: 1.0
milestone: v2.6
milestone_name: milestone
status: verifying
stopped_at: Phase 14 plan 14-02 DONE — planToTasks() Pass 0 engine + scoped dedup bypass + 20 unit tests
last_updated: "2026-04-10T18:15:00.000Z"
last_activity: "2026-04-10 -- Plan 14-02 complete: 3 tasks, 3 commits. PLAN-02/03/04/05 requirements addressed."
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 9
  completed_plans: 9
  percent: 40
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-09)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.6 -- Sight Beyond Sight. Phase 10 complete, 2-week quarantine before Phase 11.

## Current Position

Phase: 14 -- P-Phase Task-Management Integration (IN PROGRESS)
Plan: 14-02 DONE (planToTasks() Pass 0 engine + scoped _dedup_check bypass + gsd-amauta.cjs CJS pass-through + 20 unit tests. 3 commits. PLAN-02/03/04/05 addressed.)
Previous: 14-01 DONE (divergence-protocol v1.1.0 + plan-task-xml-schema.md + gsd-planner pointer). Phase 13.1 VERIFIED (HARDEN-01..05). Phase 13 VERIFIED (CREATIVE-01..05). Phase 12 COMPLETE (QA-01..08).
Status: Phase 14 Wave 2 complete. Plans 14-03, 14-04 not started.
Last activity: 2026-04-10 -- Plan 14-02 complete: planToTasks() Pass 0 validation engine + scoped dedup bypass + 20 unit tests all green. 3 atomic commits.

Progress: [####......] 40% (v2.6 milestone — phases 10, 12, 13, 13.1 done; phase 9 pending green baseline; phases 11, 14, 15 not started)

## v2.6 Phase Map

| Phase | Name | Requirements | Depends On | Kill Switch | Wave |
|-------|------|--------------|------------|-------------|------|
| 9 | Tech-Debt Sweep | TECH-01..06 (6) | — | N/A | 1 |
| 10 | D-Phase Structured Learning + CLI Dedup | LEARN-01..07 (7) | 9 | `GSD_D_STRUCTURED=false` | 2 |
| 11 | E-Phase Research-Informed Execution Mandate | EXEC-01..08 (8) | 10 | `GSD_E_MANDATE=off` | 3 |
| 12 | T-Phase QA + Spec Inheritance | QA-01..08 (8) | 11 | `GSD_T_SPEC_INHERIT=false` | 4 |
| 13 | R-Phase Creative Research (Narrowed) | CREATIVE-01..05 (5) | 11 | `GSD_R_CREATIVE=off` (default) | 4 |
| 13.1 | Orchestrator Hardening & Divergence Protocol | HARDEN-01..05 (5) | 13 | N/A | 4.5 |
| 14 | P-Phase Task-Management Integration | PLAN-01..07 (7) | 12, 13.1 | `GSD_P_AUTO_TASK=false` (default) | 5 |
| 15 | End-to-End Dogfood Verification | DOGFOOD-01..05 (5) | 14 | N/A (observational) | 6 |

Waves 4 has Phase 12 + Phase 13 running in parallel (T and R are architecturally independent once E lands).

## Research Completed

4 research documents in .planning/research/v2.6/ (validated the approved plan with 5 course corrections):
- SUMMARY.md -- synthesis + 5 course corrections (ship-order reversed, R narrowed, E advisory, D human-review, Phase 9 tech-debt prerequisite)
- STACK.md -- 90% prompt engineering, 10% tooling; pytest-bdd/fast-check/Hypothesis opt-in; ~425 LOC code changes
- FEATURES.md -- 4 of 5 convergent 2025 practices are prompt-level; graph-ranked repo map deferred to v2.7
- ARCHITECTURE.md -- 1100 LOC production + 560 LOC docs, fully additive, zero schema deletions; `_inherit_parent_spec` gap at amauta.py:2218
- PITFALLS.md -- 36 pitfalls + 7 anti-features + 6-stage rollout + 7 kill switches

Previous milestone research preserved in .planning/research/ (legacy v2.5 docs).

## Infrastructure Status (pre-v2.6 baseline)

- Daemon: Running on :18799, PG available, Redis reconnected (pipeline=healthy after Part A blocker fix)
- RLM: Running (v2.5 fixes)
- Voyage API key: SET, Perplexity API key: SET, PERPLEXITY_MODEL: auto (v2.5)
- `amauta health` dashboard: SHIPPED (cmd_health at amauta.py:3231 via Part A blocker fix)
- Baseline tests: **34 CJS fails + 6 pytest fails** (Phase 9 will fix)
- Agent prompt sizes: gsd-roadmapper grandfathered at 685 lines; all others < 200 lines (budget for v2.6)

## Codebase Map

v2.5 codebase docs in .planning/codebase/ (2,337 lines). v2.6 research in .planning/research/v2.6/ (5 docs).

## Accumulated Context

### Roadmap Evolution

- Phase 13.1 inserted after Phase 13: Orchestrator Hardening & Divergence Protocol (URGENT) — post-wave commit/file manifest check, shared divergence protocol for executors and validators, validator severity vocabulary lock. Triggered by Phase 13 silent scope-expansion incident. Must land before Phase 14 (highest blast radius).

### Decisions (v2.6-specific)

- **Ship order locked** by research Correction 1: Tech-debt (9) → D-learning (10) → E-mandate (11) → T-QA + R-creative parallel (12, 13) → P-auto-task (14) → Dogfood (15). Reversed from original plan's R-P-E-T-D ordering.
- **Phase 10 quarantine**: D-phase learnings are additive/reversible for 2 weeks before Phase 11 starts; compensates for feedback-loop instability (PITFALLS D5, D6).
- **R-phase narrowed** (Correction 2): Creative variants gated behind task-type classification; implementation tasks use v2.5 conservative cascade (JetBrains Junie 3x rollback rate evidence).
- **E-phase advisory in v2.6** (Correction 3): `PRE_EXECUTION_EVIDENCE` parsed by gsd-validator, logs warning on miss but does NOT fail validation; hard gate deferred to v2.7 after compliance measurement.
- **D-phase structure is HUMAN REVIEW** (Correction 4): Not a retrieval optimizer (free-text + embeddings still wins recall per ragflow.io 2025); structured format lives inside existing `tags jsonb`, no new PG column, GIN index for filters.
- **Tech-debt prerequisite** (Correction 5): Baseline must be green (0 failures) before any v2.6 mandate lands; adding mandates on flaky base amplifies flakes.
- **Prompt-size budget hard gate**: NEW agents ≤ 200 lines; existing agents may grow +25% max; `gsd-roadmapper.md` grandfathered at 685 but MUST NOT grow.
- **Kill switch per phase**: Every v2.6 phase ships with an env var so upgrade can be disabled without code revert.
- **External validator principle**: Evidence blocks inspected by gsd-validator (not executor self-validation) per v2.5 AGT-05.
- **Runtime Read, NOT `@` include**: `references/*.md` files are read by agents at runtime via `Read` tool, not via `@` include syntax (which doesn't work in agent .md files). Pattern applies to `cli-variables.md`, `pre-execution-checklist.md`, `learning-format.md`, etc.
- **No new runtimes, no new schema**: v2.6 is 90% prompt engineering, 10% CLI flags (~425 LOC); zero `ALTER TABLE`, zero new runtime deps, pytest-bdd/fast-check/Hypothesis are opt-in per-project dev deps. **One exception (locked):** migration 008 adds `applied_count INTEGER NOT NULL DEFAULT 0` to `gsd_memory` (LEARN-05 echo-chamber defense). No other ALTER TABLE permitted in v2.6.
- **Phase 12 unblocks Phase 14**: `_inherit_parent_spec` helper (Phase 12) is used by planner when emitting child tasks (Phase 14).
- **_inherit_parent_spec shallow-copy in cmd_show** (Plan 12-01): `cmd_show` uses `out = dict(item)` before injecting `inherited_success_criteria` to avoid mutating the in-memory stored item. The field lives only in the show JSON output unless also cached at claim time.
- **_inherit_parent_spec on-demand fallback** (Plan 12-01): If `metadata.inherited_spec` is missing at show time (task not yet claimed), `cmd_show` calls `_inherit_parent_spec()` on demand. Claim-time caching is the primary path but show-time resolution is the safe fallback.
- **noInherit global flag extraction in CJS** (Plan 12-01): `--no-inherit` extracted from `rawArgs` in `main()` alongside `--json`, stripped before subcommand dispatch. Same pattern as `--json` extraction. Passed as 4th parameter to `cmdShow(useDaemon, id, jsonMode, noInherit)`.
- **SC-ID assignment is position-based** (Plan 12-01): `f"SC-{i:02d}: {c}"` with `enumerate(capped, 1)`. Position-based IDs are grep-friendly and accept rare reorder edge case; `resync-criteria` (future) regenerates if parent criteria change.
- **qa-checklist.md as runtime Read reference** (Plan 12-02): gsd-checker.md absorbs inline 6-step checklist into runtime Read of qa-checklist.md, same pattern as cli-variables.md and pre-execution-checklist.md. Inline checklists in agent prompts are replaced by Read instructions when they grow beyond 6 items or require structured block format examples.
- **security_patterns before "agents" in agent-capabilities.json** (Plan 12-02): Top-level key placed before the agents array for readability. Operator matches patterns via `fnmatch.fnmatch()` against task doc_refs at claim time and sets `metadata.security_sensitive=true` to trigger adversarial testing gate in checker.
- **QA_REPORT has dedicated operator parser, not generic block scanner** (Plan 12-02): gsd-operator.md has specific parsers for LEARNING (d_phase_structured_learning), APPLIED_LEARNING (applied_learning_citation_scan), and now QA_REPORT (qa_report_phase_end). Operator does NOT have a catch-all block scanner -- each block type gets its own section with its own dispatch logic.
- **checkSpecInheritanceAdvisory placement** (Plan 12-03): Placed AFTER `checkEvidenceAdvisory` function definition; called AFTER evidence advisory block in cmdValidate, BEFORE `const body = { id, ...flags }`. Same non-blocking try/catch pattern as Phase 11 evidence advisory.
- **_checkQaBlocks/_checkRedGreenOrder were pre-implemented** (Plan 12-03): Function bodies were already present in gsd-amauta.cjs from partial plan 12-02 work. Task 12-03-02 only needed to add them to the `module.exports` test-only block.
- **spawnSync for git log in advisory** (Plan 12-03): `_checkRedGreenOrder` receives pre-parsed git log output as a string; `checkSpecInheritanceAdvisory` calls `spawnSync('git', ['log', '--oneline', '--grep='+taskId, '--reverse'])` synchronously inside the async function. Failure is non-fatal (try/catch swallows errors).
- **Migration 008 idempotency pattern** (Plan 10-02): BEGIN/COMMIT wrapper + `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + COMMENT ON COLUMN. Partial index (`WHERE applied_count > 0`) minimizes maintenance cost because new learnings start at 0 — only cited entries get indexed. Re-run produces NOTICE skip messages but no error, safe for `init-db.sh` loops.
- **FOR UPDATE row lock on metadata jsonb read-modify-write** (Plan 10-04): When concurrent mutations to a jsonb field need dedup that can't be expressed as a UNIQUE constraint (e.g., dedup key lives inside a nested array), SELECT ... FOR UPDATE inside a transaction is the least-invasive serialization mechanism. Advisory locks require namespacing; separate tables require a migration + join. FOR UPDATE scopes the lock to the exact row for the exact transaction duration.
- **Idempotent HTTP mutations return 200, not 409** (Plan 10-04): Repeat citation endpoints (`/api/memory/:id/increment-applied`) return 200 + `{action: False, already_done: True}` on dedup hit. 409 would force callers to treat conflict-as-success, which is fragile. 200-with-flag lets callers treat idempotence as the expected case — the operator's APPLIED_LEARNING scanner runs on every D-phase and will re-hit the same keys legitimately.
- **Defense-in-depth tag validation at the daemon** (Plan 10-04): The Python daemon's `pg_store.memory_store()` runs `normalize_tags()` even though the Node.js CLI already does so, because the operator's post-D-phase `parse-learning` path bypasses the CLI. Cross-runtime parity — Python reads the same `tag-rules.json` that Node.js does and produces identical normalization output.
- **BOOLEAN_FLAGS set in gsd-memory.cjs parseArgs** (Plan 10-03): The argv tokenizer previously used a heuristic (`!argv[i + 1].startsWith('--')`) to decide whether a flag consumed the next token. That breaks `learn --structured "LEARNING: ..."` because the block text would be bound to `args.structured` and `_positional` would be empty. Fix is to declare boolean flags in a module-level Set and check it first in parseArgs. Future boolean flags (dry-run, use-llm, include-noise already included preemptively) go in the same set.
- **Structured CLI as a flag, not a subcommand** (Plan 10-03): `learn --structured` is a hybrid command — named-flag branch OR text-block branch, selected by input presence. Adding a new `learn-structured` subcommand would split the intent across two dispatch entries and force agents to remember two commands for the same goal. The flag-based variant preserves backward compat and keeps the command hierarchy flat. Future Phase 10 commands (SKB entries in 10-05) should consider the same pattern.
- **Kill switch fall-through semantics** (Plan 10-03): `GSD_D_STRUCTURED=false` with `learn --structured --what "x"` must still land the memory — the legacy free-text path rebuilds the text body from `--what`/`--why`/`--when` joined with ` — ` when no positional was supplied. Falling through to a usage error would surprise agents that set the env var for experimentation and lose learnings. Env var off = feature disabled, not command disabled.
- **HTTP verb expansion pattern on the daemon** (Plan 10-05): When a new verb is needed (PATCH, DELETE), add a `do_VERB` method with the same auth/OIDC/rate-limit prologue as `do_GET`/`do_POST` by copying the pattern verbatim, then route by path prefix inside. The new verbs inherit the full security envelope automatically. First landed PATCH /api/memory/mem-XXXX + DELETE /api/skb/skb-XXXX; future plans needing PUT or additional DELETE routes follow the same pattern.
- **ID-prefix route matching** (Plan 10-05): Single-entry REST routes like `/api/memory/mem-XXXX` use `path.startswith('/api/memory/mem-')` to disambiguate from static sibling routes like `/api/memory/list`, `/api/memory/count`, `/api/memory/skb-candidates`. Clearer than a regex dispatcher and fails closed on empty IDs. Requires the id format to have a stable prefix (`mem-`, `skb-`, `tk-`) which the existing migrations guarantee.
- **Two-layer boolean flag safety** (Plan 10-05): `--reviewed` on `skb-promote` is added to `BOOLEAN_FLAGS` (tokenizer-level) AND explicitly checked in the handler with `if (!args.reviewed)` (handler-level). The set prevents token swallowing; the check enforces the gate regardless of how the CLI was invoked. Future risky operations (bulk-delete, tag-rewrite) should follow the same two-layer pattern.
- **source_task column as promotion link** (Plan 10-05): The `gsd_shared_kb` schema has no dedicated `source_mem_id` column. Rather than adding a migration (out of scope for a Wave 2 plan), skb-promote stores the link as `source_task = 'promoted_from:mem-XXXX'` in the existing free-text column and skb-remove parses the prefix to recover the source mem_id for demotion. Future plan 10-06 (or a later tech-debt sweep) can formalize this with a proper column.
- **Nested subcommand dispatcher alongside hyphenated commands** (Plan 10-05): `gsd-memory skb candidates` (space) and `gsd-memory skb-candidates` (hyphen) both route to the same handler via a new `cmdSkb` switch dispatcher. Registering both forms preserves existing hyphenated callers AND supports the friendlier space-separated form. Legacy `skb-search`/`skb-add`/`skb-list` commands continue to work as before; they are also routed through `cmdSkb` for consistency.
- **Extract `node -e` filters into helper scripts instead of inlining in agent prompts** (Plan 10-06): When an agent prompt needs executable JS more than ~3 lines long, put it in `get-shit-done/bin/<helper>.sh` instead of inlining. The previous revision of plan 10-06 tried to inline ~12 lines of nested-quoted `node -e` in the operator markdown — markdown -> bash -> `node -e '...'` -> JS string literals is fragile, hard to test, and easy to silently break. The helper script pattern adds one file but makes the complexity testable in isolation and keeps the operator prompt readable. `gsd-memory-learn-blocks.sh` is the first instance.
- **Defense-in-depth kill switches checked at both caller and callee** (Plan 10-06): `GSD_D_STRUCTURED=false` is checked at BOTH the operator prompt (before dispatch) AND the helper script (first 5 lines). Either layer alone is sufficient, but the belt-and-suspenders pattern ensures a future refactor cannot accidentally bypass the kill switch. Kill switches are load-bearing — they must survive refactors.
- **Helper failure falls through to legacy learn, never hard-fails** (Plan 10-06): `$LEARN_BLOCKS "$D_CONTENT" || $MEM learn "$LEARNING_ONE_LINER"`. Agents run in the field with unreliable daemon connectivity — hard-failing the task close on a helper non-zero would lose the learning entirely. Falling through preserves the one-liner in all cases. The learning may lose its structured fields but never gets dropped.
- **Citation scanner runs post-task, not per-phase** (Plan 10-06): `$CLI show --json` fetches the full task content once at task close and greps all 5 phases for `APPLIED_LEARNING: mem-XXXX` citations. Cheaper than grepping each phase as it lands, and the daemon's (mem_id, task_id) dedup makes running-it-once equivalent to running-it-per-phase. Also localizes the scanner's code to one place in the operator instead of scattered across 5 RPETD handlers.
- **Daemon-side dedup is the source of truth for citation idempotence** (Plan 10-06): The operator does NOT try to dedupe citations in bash. It calls `increment-applied` for every match and lets the daemon return `already_cited:true` (200 OK, not 409) for repeats. Keeps the operator bash trivial and pushes dedup to the one authoritative place (the pg_store FOR UPDATE row lock on the metadata jsonb).
- **Manifest enforcement cutoff (Phase 13.1)**: `files_expected:` per-task manifest blocks are MANDATORY for phases 13.1 and later. Phases 9-13 are grandfathered — the orchestrator skips the check when a PLAN.md lacks a `files_expected:` block. Override: `GSD_MANIFEST_CHECK=warn` downgrades halts to warnings (logged in `orchestrator_action`); removed in v2.7. Orchestrator-owned files (`.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`) always hard-halt regardless of override.
- **divergence-protocol.md at v1.1.0 (Plan 14-01)**: Bumped from 1.0.0 in a single atomic edit. Two new enum values: `agent_assignment_conflict` (planner-emitted `<agent>` field disagrees with `routeExecutor()` computed from `<files_expected>`) and `plan_amauta_drift` (structural fields in PLAN.md diverge from amauta task on re-run). Phase 13.2 baseline is now 1.1.0.
- **plan-task-xml-schema.md reference file (Plan 14-01)**: Runtime-Read reference locking the `<story>` + `<task>` XML schema for phases >= 14. MANDATORY `<story>` block (title, success_criteria, doc_refs), child-element style `<task>` (7 required fields), 7 validation rules, phase cutoff at 14 (phases 9-13 grandfathered). gsd-planner.md has Read pointer (203 lines, within 200+4 budget).
- **Plan-to-tasks phase cutoff (Plan 14-01 lock)**: Phase cutoff is the authoritative trigger for plan-to-tasks registration, NOT the presence of a `<story>` block. A future editor adding `<story>` to a Phase 9-13 plan for documentation reasons must NOT accidentally trigger registration.
- **planToTasks() Pass 0 engine (Plan 14-02)**: `gsd-tools.cjs` now exports `planToTasks()` and 6 helpers: `_validatePlanShape` (story, required fields, 10-task cap), `_detectCycles` (DFS), `_checkAgentConflicts` (routeExecutor comparison), `_filesDisjointSplit` (disjoint boundary finder), `_renderDagText` (500-char truncating DAG), `_diffPlanVsAmauta` (structural drift with plan_amauta_drift type). Kill switch: `GSD_P_AUTO_TASK=false`.
- **_filesDisjointSplit boundary semantics (Plan 14-02)**: Returns the FIRST disjoint boundary (smallest valid cut index), not a midpoint suggestion. "Largest contiguous prefix" means the algorithm takes the first clean cut walking forward — if tasks[0] and tasks[1] have no shared files, the split is at index 1. Partial-overlap case returns least-overlap cut with `split_rationale: "least_overlap_at_N"`.
- **_renderDagText 500-char contract (Plan 14-02)**: Total output (including `\n...(full DAG in sidecar file)` marker of 30 chars) must be <= 500 chars. Truncation point is `500 - marker.length`, not a fixed 490. Tests assert on the total length, not just the pre-marker portion.
- **scoped _dedup_check bypass already in amauta.py (Plan 14-02 observation)**: The bypass, cmd_add stamping, and argparse flags were already present from a prior partial implementation. Only the CJS cmdAdd direct-CLI path was missing `--source`/`--from-plan` pass-through. Daemon path always passed flags through via `...flags` spread.

### Pending Todos

- Close Phase 9 after validator confirms npm test + pytest both pass with 0 failures
- Execute remaining Phase 10 plans: 10-09 (tests + README)
- Restart amauta-daemon to pick up new /api/memory/skb-candidates + /api/memory/:id/increment-applied + GET/PATCH /api/memory/mem- + GET/DELETE /api/skb/skb- routes + do_PATCH + do_DELETE verb handlers (operator action, not executor task)
- Sync repo copy of `get-shit-done/bin/` binaries into user-install `~/.claude/get-shit-done/bin/` so `parse-learning` and `increment-applied` subcommands are reachable from agents using the default MEM path (Plan 10-06 helper defaults to user-install; repo callers must pass `MEM="node <repo-path>"` explicitly)

### Blockers/Concerns

None. Part A blockers resolved pre-roadmap:
- Redis reconnected (pipeline=healthy)
- `amauta health` dashboard added (cmd_health at amauta.py:3231)

## Session Continuity

Last session: 2026-04-10T15:26:16.283Z
Stopped at: Phase 14 planned — 4 plans, 10 tasks, 4 waves, checker passed
Resume file: .planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-04-PLAN.md
Next: /amauta:discuss-phase 14 — P-Phase Task-Management Integration (unblocked by Phase 13.1, blocked by Phase 12 which is already done)

Memory entries from Phase 13.1 (researcher recall during Phase 14 planning should surface these):
- project_phase13_1_wave1_dogfood.md — first-invocation positive example (depth 0)
- project_phase13_1_meta_recursive_dogfood.md — 13.1-02 executor applied protocol to its own creation (depth 1)
- project_phase13_1_wave3_near_miss.md — 13.1-05 executor resisted Phase-13-shaped rationalization at hard ceiling (depth 2)
- project_phase13_1_postmortem_followups.md — 5 operational follow-ups for Phase 14 (amauta pre-registration, gsd-amauta.cjs inline resolver refactor, etc.)

## Previous Milestone: v2.5 -- Smarter Brain (COMPLETE)

Shipped 2026-04-06. 8 phases (1..8), 26 plans, 49/49 requirements, 39.4% Layer 2 token reduction, 479 new tests (~2479 total).
Archive: `.planning/MILESTONES.md` + legacy v2.5 ROADMAP sections.


## Test Baseline (auto-updated at phase completion)

npm_pass: 2071
npm_fail: 4
pytest_pass: 466
pytest_fail: 3
last_updated: 2026-04-10
phase: 13.1

Baseline includes Phase 13.1 tests: 13.1-manifest-check.test.cjs (13 deterministic tests, validator-verified 13/13 pass).
Also includes Phase 13 tests: 13-creative-research.test.cjs (30 tests).
Previous: Phase 12 tests: test_phase12_inherit_spec.py (8 tests), 12-qa-blocks.test.cjs (17 tests), 12-red-green.test.cjs (8 tests).
Pre-existing failures: npm 4 (rlm-workflow-spec.test.cjs, agent-frontmatter.test.cjs gsd-planner, comprehensive-e2e.test.cjs 6.12 migration count, gsd-amauta.test.cjs daemon not running), pytest 3 (test_pg_integration.py) — not Phase 13 or 13.1 regressions.
Behavioral test suite (tests/13.1-divergence-protocol.integration.test.cjs, 15 invocations + Phase 13 incident replay) is run via `npm run test:behavioral` — NOT in `npm test`. Real-LLM execution; triggers via CI on PRs touching sensitive path globs OR run manually. Phase 13 incident replay test verified in isolation at phase close (76s runtime, PASS).

## Learnings







































- [learning] 2026-04-10T15:42:46.694Z: legacy regression test: free text learning
- [learning] 2026-04-10T15:33:58.988Z: Plan 14-01 pattern: when two enum values in the same file require a version bump, land them in a single atomic edit to prevent version-field collision if fragmented across tasks.
- [learning] 2026-04-10T04:26:03.843Z: Phase 13 creative research: when adding module.exports to a CLI script for CJS test imports, use require.main !== module guard with else { main() } pattern -- not just a guard block -- so CLI still executes when run directly. Also: npm_fail counts must be verified by running the full suite before stash/after, not assumed from prior baseline.
- [learning] 2026-04-10T04:21:49.640Z: E2E test learning — cleanup after test
- [learning] 2026-04-10T04:21:33.738Z: legacy with agent
- [learning] 2026-04-10T04:21:33.593Z: legacy regression test: free text learning
- [learning] 2026-04-10T04:21:02.379Z: E2E test learning — cleanup after test
- [learning] 2026-04-10T04:20:45.967Z: legacy with agent
- [learning] 2026-04-10T04:20:45.750Z: legacy regression test: free text learning
- [learning] 2026-04-10T04:20:04.585Z: E2E test learning — cleanup after test
- [learning] 2026-04-10T04:19:49.166Z: legacy with agent
- [learning] 2026-04-10T04:19:48.972Z: legacy regression test: free text learning
- [learning] 2026-04-10T04:19:15.770Z: E2E test learning — cleanup after test
- [learning] 2026-04-10T04:19:05.733Z: legacy with agent
- [learning] 2026-04-10T04:19:05.496Z: legacy regression test: free text learning
- [learning] 2026-04-10T04:18:37.465Z: E2E test learning — cleanup after test
- [learning] 2026-04-10T04:18:19.597Z: legacy with agent
- [learning] 2026-04-10T04:18:19.230Z: legacy regression test: free text learning
- [learning] 2026-04-10T03:15:44.790Z: legacy regression test: free text learning
- [learning] 2026-04-10T03:15:01.241Z: E2E test learning — cleanup after test
- [learning] 2026-04-10T03:12:54.629Z: legacy regression test: free text learning
- [learning] 2026-04-10T03:07:10.883Z: checkSpecInheritanceAdvisory pattern: pure check fns (_checkQaBlocks, _checkRedGreenOrder) separate from async advisory wrapper; advisory uses spawnSync('git') for RED-GREEN; all advisory blocks in cmdValidate use if(pass_result && !force_reason){try{...}catch{}} for non-blocking best-effort behavior
- [learning] 2026-04-10T03:05:49.613Z: Plan 12-02: operator block parsers are always per-type (LEARNING, APPLIED_LEARNING, QA_REPORT each have their own section in gsd-operator.md); no generic catch-all scanner. When adding a new structured block type, add a dedicated parser section after applied_learning_citation_scan.
- [learning] 2026-04-10T02:52:56.868Z: Phase 12 _inherit_parent_spec pattern: parent-chain walk stops at first non-empty success_criteria (first-wins semantics); cmd_show uses shallow dict copy (dict(item)) to inject inherited_success_criteria without mutating stored item; CJS --no-inherit extracted as global flag in main() alongside --json using same rawArgs.indexOf+splice pattern
- [learning] 2026-04-10T01:44:59.926Z: legacy regression test: free text learning
- [learning] 2026-04-10T01:40:12.323Z: Phase 11 execution: rate limiting causes agent stalls during long-running phases — commit partial work and respawn with explicit partial state context is the reliable recovery pattern. Also: require.main guard needed when adding module.exports to CLI scripts for test imports.
- [learning] 2026-04-10T01:31:45.096Z: legacy with agent
- [learning] 2026-04-10T01:31:37.659Z: legacy regression test: free text learning
- [learning] 2026-04-09T23:53:04.660Z: Phase 10 execution: validator caught GIN index missing from live DB despite being defined in migration 001-init.sql — always verify index existence on the LIVE database, not just migration file presence. Also: ROADMAP success criteria wording can diverge from plan must-haves; plan spec is the implementation authority.
- [learning] 2026-04-09T23:44:46.710Z: legacy with agent
- [learning] 2026-04-09T23:44:39.479Z: legacy regression test: free text learning
- [learning] 2026-04-09T23:44:27.093Z: kill-switch-test — testing — now
- [learning] 2026-04-09T23:40:29.082Z: legacy with agent
- [learning] 2026-04-09T23:40:22.298Z: legacy regression test: free text learning
- [learning] 2026-04-09T23:39:27.736Z: Daemon GET route path matching must strip query params before route comparison (self.path.split('?')[0].rstrip('/') not self.path.rstrip('/')). Routes with query string filters (e.g. /api/memory/skb-candidates?rising_min=5) will 404 if the path variable includes the query string. Discovered during Phase 10 integration testing (10-09).
- [learning] 2026-04-09T23:36:40.747Z: legacy with agent
- [learning] 2026-04-09T23:36:32.812Z: legacy regression test: free text learning
- [learning] 2026-04-09T23:32:17.915Z: legacy with agent
- [learning] 2026-04-09T23:32:10.945Z: legacy regression test: free text learning
