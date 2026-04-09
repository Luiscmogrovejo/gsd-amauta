---
gsd_state_version: 1.0
milestone: v2.6
milestone_name: milestone
status: in-progress
stopped_at: Phase 10 Plan 10-02 complete — migration 008 applied_count column shipped + applied to dev DB (LEARN-05)
last_updated: "2026-04-09T21:40:00.000Z"
last_activity: "2026-04-09 -- Plan 10-02: migrations/008-applied-count.sql + DOWN (6307d93 + 72ff620), applied to dev DB + idempotency verified"
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 18
  completed_plans: 11
  percent: 16
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-09)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.6 -- Sight Beyond Sight. Roadmap approved. Phase 9 queued for planning.

## Current Position

Phase: 10 — D-Phase Structured Learning + CLI Dedup (in progress, Wave 1)
Plan: 10-02 DONE (migration 008 applied_count column + DOWN file; commits 6307d93 + 72ff620; applied to dev DB 127.0.0.1:5432/gsd_amauta; idempotency verified via re-run NOTICE). 10-01 DONE (tag-rules.json + learning-format.md + cli-variables.md; 6f10983 + b6faa13 + d03dd89).
Status: Phase 9 complete. Phase 10 Wave 1 complete (10-01 + 10-02 shipped). Next: Wave 2 — 10-03 (gsd-memory.cjs parse-learning + learn --structured) and 10-04 (pg_store.py + daemon API increment-applied endpoint, depends on 10-02 schema).
Last activity: 2026-04-09 -- Plan 10-02: migrations/008-applied-count.sql + DOWN (6307d93 + 72ff620), applied to dev DB + idempotency verified

Progress: [##........] 16%

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

### Pending Todos

- Close Phase 9 after validator confirms npm test + pytest both pass with 0 failures
- Execute remaining Phase 10 plans: 10-03 (gsd-memory.cjs core — parse-learning + learn --structured), 10-04 (pg_store.py + daemon API — increment-applied + skb-candidates endpoints, depends on 10-02 schema), 10-05 (gsd-memory.cjs SKB commands), 10-06 (operator + APPLIED_LEARNING citation scanner), 10-07 (cli-variables dedup across agents + workflows), 10-08 (LEARNING block template across agents), 10-09 (tests + README)

### Blockers/Concerns

None. Part A blockers resolved pre-roadmap:
- Redis reconnected (pipeline=healthy)
- `amauta health` dashboard added (cmd_health at amauta.py:3231)

## Session Continuity

Last session: 2026-04-09T21:40:00.000Z
Stopped at: Phase 10 Plan 10-02 complete — migration 008 applied_count column + DOWN shipped, applied to dev DB (LEARN-05)
Resume file: .planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-03-PLAN.md

## Previous Milestone: v2.5 -- Smarter Brain (COMPLETE)

Shipped 2026-04-06. 8 phases (1..8), 26 plans, 49/49 requirements, 39.4% Layer 2 token reduction, 479 new tests (~2479 total).
Archive: `.planning/MILESTONES.md` + legacy v2.5 ROADMAP sections.
