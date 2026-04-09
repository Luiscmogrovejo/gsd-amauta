---
gsd_state_version: 1.0
milestone: v2.6
milestone_name: Sight Beyond Sight
status: planning
stopped_at: Plan 09-06 executed — comprehensive-e2e 4 failures fixed (substance gates + migration count 6→7 + README routes table, commit 440115c)
last_updated: "2026-04-09T22:00:00.000Z"
last_activity: "2026-04-09 -- Plan 09-06: fullPhases() R/P defaults >=50 chars (96+91), migration count 6→7, Daemon API Routes table added to README (440115c) -- comprehensive-e2e 117/117 green"
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 6
  completed_plans: 6
  percent: 11
current_phase:
  number: 9
  name: Tech-Debt Sweep
  status: in-progress
  depends_on: []
  requirements_count: 6
next_action: "Close Phase 9 (all plans 09-01..09-09 complete) then begin Phase 10 planning (D-Phase Structured Learning + CLI Dedup)"
previous_milestone:
  version: v2.5
  name: Smarter Brain
  shipped: "2026-04-06"
  phases: 8
  plans: 26
  requirements: "49/49"
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-09)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.6 -- Sight Beyond Sight. Roadmap approved. Phase 9 queued for planning.

## Current Position

Phase: 9 — Tech-Debt Sweep (complete)
Plan: 09-06 DONE (GAP: comprehensive-e2e 117/117 green — fullPhases R/P defaults >=50 chars, migration count 6→7, README API routes, commit 440115c).
Status: All Phase 9 plans executed (09-01..09-09). TECH-01..06 resolved. GAP plans 09-06..09-09 resolved. Phase 9 complete — ready to close.
Last activity: 2026-04-09 -- Plan 09-06: comprehensive-e2e 4 failures fixed (substance gates + migration count + README routes, 440115c)

Progress: [##........] 11%

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
- **No new runtimes, no new schema**: v2.6 is 90% prompt engineering, 10% CLI flags (~425 LOC); zero `ALTER TABLE`, zero new runtime deps, pytest-bdd/fast-check/Hypothesis are opt-in per-project dev deps.
- **Phase 12 unblocks Phase 14**: `_inherit_parent_spec` helper (Phase 12) is used by planner when emitting child tasks (Phase 14).

### Pending Todos

- Close Phase 9 after validator confirms npm test + pytest both pass with 0 failures
- Begin Phase 10 planning (D-Phase Structured Learning + CLI Dedup)

### Blockers/Concerns

None. Part A blockers resolved pre-roadmap:
- Redis reconnected (pipeline=healthy)
- `amauta health` dashboard added (cmd_health at amauta.py:3231)

## Session Continuity

Last session: 2026-04-09T17:00:00.000Z
Stopped at: v2.6 roadmap written; Phase 9 queued; ready for `/amauta:plan-phase 9`
Resume file: `.planning/ROADMAP.md` (Phase 9 details) + `.planning/REQUIREMENTS.md` (TECH-01..06)

## Previous Milestone: v2.5 -- Smarter Brain (COMPLETE)

Shipped 2026-04-06. 8 phases (1..8), 26 plans, 49/49 requirements, 39.4% Layer 2 token reduction, 479 new tests (~2479 total).
Archive: `.planning/MILESTONES.md` + legacy v2.5 ROADMAP sections.
