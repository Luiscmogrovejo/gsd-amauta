---
gsd_state_version: 1.0
milestone: v2.8
milestone_name: Metabolism
status: planned
stopped_at: phase_20_plan_02_complete
last_updated: "2026-04-12"
last_activity: 2026-04-12 — Plan 20-02 complete (prune_messages, compact_conversation, daemon endpoints POST /api/context/compact + GET /api/context/:task_id/:phase, 10 tests)
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 3
  completed_plans: 2
  percent: 7
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-12 for v2.8)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.8 -- Metabolism. Token optimization: 75-90% reduction in effective token cost per RPETD cycle via structured context handoffs, staleness detection, caveman compression, prefix caching, semantic cache, and tiered routing.

## Current Position

Phase: 20 of 25 (Structured Context Handoffs — in progress)
Plan: 20-03 (Wave 3, next)
Status: Plan 20-02 complete — prune_messages, compact_conversation, daemon endpoints, 10 tests passing
Last activity: 2026-04-12 — Plan 20-02 executed (3 tasks, 3 commits, 1 fixture deviation auto-fixed)

Progress: [░░░░░░░░░░] 0%

## v2.8 Phase Map

| Phase | Name | Requirements | Depends On | Parallel OK |
|-------|------|--------------|------------|-------------|
| 20 | Structured Context Handoffs | HANDOFF-01..05 (5) | — (foundation) | No |
| 21 | Hash-Based Staleness Detection | STALE-01..04 (4) | Phase 20 | Yes (with 22) |
| 22 | Caveman-Compressed Descriptions | CAVE-01..04 (4) | Phase 20 | Yes (with 21) |
| 23 | Prompt Prefix Caching | CACHE-01..04 (4) | Phase 20, 22 | No |
| 24 | Semantic Cache + Tiered Routing | SEMANTIC-01..03, ROUTE-01..02 (5) | Phase 20, 23 | No |
| 25 | Tech Debt Sweep | DEBT-01..04 (4) | None (independent) | Anytime |

Critical path: 20 → 22 → 23 → 24. Phase 21 parallel with 22. Phase 25 independent.

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- v2.7 carry-forward: cmdInitPhaseOp ghost, plan-to-tasks gap, amauta.cjs routing, routeExecutor specificity — all routed to Phase 25.
- Phase 21 and 22 may run in parallel (both depend only on Phase 20).
- Phase 25 (tech debt) sequenced last to avoid interrupting optimization chain.
- Plan 20-01: model_validator(mode="after") auto-computes context_version — callers never compute SHA-256 manually.
- Plan 20-01: file_hashes JSONB column pre-added in migration 009 to avoid second ALTER TABLE in Phase 21.
- Plan 20-01: fallback dataclass shim in rpetd_context.py guards daemon startup when pydantic absent.
- Plan 20-02: llm_call dependency injection for compact_conversation — Phase 24 ROUTE-02 wires to model router without changing function signature.
- Plan 20-02: POST /api/context/compact uses llm_call=None in v1 (fallback path only); LLM wiring deferred to Phase 24 ROUTE-02.
- Plan 20-02: PG storage in compact endpoint is best-effort — compiled_view returned even when store unavailable.
- Plan 20-02: Conversation text truncated to 3000 chars before compaction prompt to bound compaction call cost.

### Pending Todos

None.

### Blockers/Concerns

None. v2.7 shipped cleanly. v2.8 Phase 20 is unblocked.

## Session Continuity

Last session: 2026-04-12
Stopped at: Plan 20-02 complete. services/rpetd_context.py (compaction functions), services/amauta-daemon.py (context endpoints), tests/test_rpetd_compaction.py all committed. Ready for plan 20-03 execution.
Resume file: None


## Learnings



- [learning] 2026-04-13T00:27:00.814Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:24:57.175Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:15:18.995Z: Pydantic model_validator(mode='after') auto-computes derived fields like SHA-256 context versions; callers never set them manually. Pre-adding future columns (e.g., file_hashes for Phase 21) in the current migration avoids a second ALTER TABLE. PGStore new method groups belong between domain-matching section dividers.
