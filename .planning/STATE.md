---
gsd_state_version: 1.0
milestone: v3.1
milestone_name: The Gathering
status: active
stopped_at: Roadmap created for v3.1 — 7 phases (41-47), 25 requirements mapped
last_updated: "2026-04-13T21:00:00.000Z"
last_activity: 2026-04-13 — v3.1 roadmap created. 7 phases derived from 25 requirements across 7 categories. Phase 41 (Sharded Workflows) is the foundation.
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 15
  completed_plans: 0
  percent: 0
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-14 after v3.0 milestone close)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates. The Gathering grafts BMAD-METHOD's best patterns onto Amauta's infrastructure advantage.
**Current focus:** Milestone v3.1 — The Gathering. Sharded workflows, scale-adaptive intelligence, skills architecture, cross-IDE installer, help routing, MCP server, agent hydration.

## Current Position

Phase: Not started (roadmap defined, ready to plan Phase 41)
Plan: —
Status: Roadmap defined. Ready for `/amauta:plan-phase 41`.
Last activity: 2026-04-13 — v3.1 roadmap created. 7 phases (41-47), 25 requirements, estimated 15 plans.

Progress: [░░░░░░░░░░] 0%

## v3.1 Phase Map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 41 | Sharded Workflows (FOUNDATION) | SHARD-01..05 | Not started |
| 42 | Scale-Adaptive Intelligence | SCALE-01..04 | Not started |
| 43 | Skills Architecture | SKILL-01..04 | Not started |
| 44 | Cross-IDE Installer | INST-01..04 | Not started |
| 45 | Intelligent Help Routing | HELP-01..03 | Not started |
| 46 | Standalone MCP Server | MCP-01..03 | Not started |
| 47 | Agent Dynamic Hydration | HYDRA-01..02 | Not started |

**Execution order:** 41 → 42 → 43 → 44 → 45 → 46 → 47
**Parallelizable:** 42+43 after 41; 44+45+46 after 43; 47 after 42+43

## Performance Metrics

(Reset for v3.1 milestone)

## Accumulated Context

### Decisions

- v3.0 shipped: 10 phases (31-40), 24 plans, 820 assertions, 55 requirements, 17 agents.
- v3.1 Phase 41 is the mandatory foundation: sharded workflows enable scale-adaptive skipping, skills format, and resumable execution.
- Phase 47 is the capstone: dynamic hydration needs both scale scores (42) and skill invocation history (43).
- Phases 44, 45, 46 are independent after Phase 43 — can run in any order or parallel.
- 7 phases justified despite coarse granularity: each category is a natural delivery boundary with distinct dependencies.

### Pending Todos

- Run `npx c8 --reporter json-summary node scripts/run-tests.cjs` to bootstrap .coverage_threshold.json with real values (carried from v3.0).

### Blockers/Concerns

- OBSERVATION: tests/13.1-divergence-protocol.integration.test.cjs LLM behavioral tests fail intermittently. Pre-existing issue from v2.6. Not a blocker.

## Session Continuity

Last session: 2026-04-13T21:00:00.000Z
Stopped at: v3.1 roadmap created — ready to plan Phase 41
Resume file: none — roadmap just created

## Learnings

