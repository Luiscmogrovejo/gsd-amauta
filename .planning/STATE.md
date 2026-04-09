---
gsd_state_version: 1.0
milestone: v2.6
milestone_name: milestone
status: in-progress
stopped_at: Phase 10 Plan 10-07 complete — cli-variables.md runtime Read dedup across 11 agent files + 6 workflow files (LEARN-07). Single atomic commit 923510e per CONTEXT.md two-commit constraint (commit 1 of 2 with Plan 10-08).
last_updated: "2026-04-09T23:30:00.000Z"
last_activity: "2026-04-09 -- Plan 10-07: cli-variables.md runtime Read dedup across 11 agents + 6 workflows (923510e single atomic refs(LEARN-07) commit)"
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 18
  completed_plans: 16
  percent: 23
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-09)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.6 -- Sight Beyond Sight. Roadmap approved. Phase 9 queued for planning.

## Current Position

Phase: 10 — D-Phase Structured Learning + CLI Dedup (in progress, Wave 3 in progress)
Plan: 10-07 DONE (cli-variables.md runtime Read dedup across 11 agent files + 6 workflow files — All 11 agents (gsd-checker, gsd-debugger, gsd-executor-{backend,frontend,general,infra}, gsd-operator, gsd-planner, gsd-researcher, gsd-roadmapper, gsd-validator) gained a `## Tool Paths (Phase 10 LEARN-07 — runtime Read dedup)` section pointing at `/Users/luismogrovejo/.claude/get-shit-done/references/cli-variables.md` with commented 7-var fallback block (CLI/RLM/MEM/RESEARCH/TOOLS/LEARNING_FORMAT/TAG_RULES). All 6 workflow files (execute-phase, execute-plan, new-project, resume-project, test-phase, help) gained the same top-of-file reference block. Single atomic commit 923510e per CONTEXT.md two-commit constraint with Plan 10-08. Budgets respected: gsd-operator 370/370, gsd-roadmapper 685/685 (grandfathered), all 9 other agents <=200. 10-06 sections preserved verbatim (operator <d_phase_structured_learning>, <applied_learning_citation_scan>, validator Gate 2 dual-format). Verification: 11 agents + 6 workflows reference cli-variables.md, 0 orphan inline `^CLI="node` declarations, all files have Phase 10 LEARN-07 marker + TOOLS fallback line.) 10-06 DONE (gsd-operator.md structured LEARNING detection + gsd-memory-learn-blocks.sh helper + APPLIED_LEARNING citation scanner + gsd-validator.md Gate 2 dual-format) 10-05 DONE (gsd-memory.cjs SKB workflow + search filters — cmdIncrementApplied (7f515ca), cmdSkbCandidates + cmdSkb nested dispatcher (41139b7), cmdSkbPromote + cmdSkbRemove + new do_PATCH/do_DELETE HTTP verbs + GET /api/memory/mem- + GET /api/skb/skb- + PATCH /api/memory/mem- + DELETE /api/skb/skb- routes + pg_store memory_get_by_id + memory_patch_metadata + skb_get_by_id + skb_delete (6ee63ee), cmdSearch --tags/--category + renderMemoryResult structured card (1fac128)). 10-04 DONE (pg_store.py + amauta-daemon.py — load_tag_rules + normalize_tags refactor (ec22631), memory_store defense-in-depth + kill switch + search tags/category filters (ab713bc), memory_increment_applied + memory_skb_candidates with FOR UPDATE row lock (05ebb2f), POST /api/memory/:id/increment-applied + GET /api/memory/skb-candidates + /api/memory/search tags/category wire-through (90e4aa5)). 10-03 DONE (gsd-memory.cjs — loadTagRules + normalizeTags refactor (b5e06de), parseLearningBlock + parse-learning subcommand (1eac6ab), cmdLearn --structured hybrid CLI + BOOLEAN_FLAGS tokenizer + cmdDistill guard (31088df)). 10-02 DONE (migration 008 applied_count column + DOWN file; 6307d93 + 72ff620). 10-01 DONE (tag-rules.json + learning-format.md + cli-variables.md; 6f10983 + b6faa13 + d03dd89).
Status: Phase 9 complete. Phase 10 Wave 1 complete (10-01 + 10-02). Phase 10 Wave 2 COMPLETE (10-03 + 10-04 + 10-05). Phase 10 Wave 3 IN PROGRESS: 10-06 DONE, 10-07 DONE (LEARN-07 complete — commit 1 of 2). Next: 10-08 (LEARNING block template across agents — commit 2 of 2), 10-09 (tests + README).
Last activity: 2026-04-09 -- Plan 10-07: cli-variables.md runtime Read dedup across 11 agents + 6 workflows (923510e single atomic refs(LEARN-07) commit)

Progress: [##........] 23%

## v2.6 Phase Map

| Phase | Name | Requirements | Depends On | Kill Switch | Wave |
|-------|------|--------------|------------|-------------|------|
| 9 | Tech-Debt Sweep | TECH-01..06 (6) | — | N/A | 1 |
| 10 | D-Phase Structured Learning + CLI Dedup | LEARN-01..07 (7) | 9 | `GSD_D_STRUCTURED=false` | 2 |
| 11 | E-Phase Research-Informed Execution Mandate | EXEC-01..08 (8) | 10 | `GSD_E_MANDATE=off` | 3 |
| 12 | T-Phase QA + Spec Inheritance | QA-01..08 (8) | 11 | `GSD_T_SPEC_INHERIT=false` | 4 |
| 13 | R-Phase Creative Research (Narrowed) | CREATIVE-01..05 (5) | 11 | `GSD_R_CREATIVE=off` (default) | 4 |
| 14 | P-Phase Task-Management Integration | PLAN-01..07 (7) | 12 | `GSD_P_AUTO_TASK=false` (default) | 5 |
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

### Pending Todos

- Close Phase 9 after validator confirms npm test + pytest both pass with 0 failures
- Execute remaining Phase 10 plans: 10-08 (LEARNING block template across agents — commit 2 of 2 per CONTEXT.md two-commit constraint), 10-09 (tests + README)
- Restart amauta-daemon to pick up new /api/memory/skb-candidates + /api/memory/:id/increment-applied + GET/PATCH /api/memory/mem- + GET/DELETE /api/skb/skb- routes + do_PATCH + do_DELETE verb handlers (operator action, not executor task)
- Sync repo copy of `get-shit-done/bin/` binaries into user-install `~/.claude/get-shit-done/bin/` so `parse-learning` and `increment-applied` subcommands are reachable from agents using the default MEM path (Plan 10-06 helper defaults to user-install; repo callers must pass `MEM="node <repo-path>"` explicitly)

### Blockers/Concerns

None. Part A blockers resolved pre-roadmap:
- Redis reconnected (pipeline=healthy)
- `amauta health` dashboard added (cmd_health at amauta.py:3231)

## Session Continuity

Last session: 2026-04-09T23:30:00.000Z
Stopped at: Phase 10 Plan 10-07 complete — cli-variables.md runtime Read dedup across 11 agents + 6 workflows (923510e). LEARN-07 complete. Commit 1 of 2 per CONTEXT.md two-commit constraint. 10-08 LEARNING block template (commit 2) is next.
Resume file: .planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-08-PLAN.md

## Previous Milestone: v2.5 -- Smarter Brain (COMPLETE)

Shipped 2026-04-06. 8 phases (1..8), 26 plans, 49/49 requirements, 39.4% Layer 2 token reduction, 479 new tests (~2479 total).
Archive: `.planning/MILESTONES.md` + legacy v2.5 ROADMAP sections.
