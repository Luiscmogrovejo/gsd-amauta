---
gsd_state_version: 1.0
milestone: v2.8
milestone_name: milestone
status: completed
stopped_at: phase_21_plan_01_complete
last_updated: "2026-04-12"
last_activity: 2026-04-12 — Plan 21-01 complete (STALE-01/02/03, 4 tasks, 2 new files, 13 tests)
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 5
  completed_plans: 4
  percent: 22
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-12 for v2.8)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.8 -- Metabolism. Token optimization: 75-90% reduction in effective token cost per RPETD cycle via structured context handoffs, staleness detection, caveman compression, prefix caching, semantic cache, and tiered routing.

## Current Position

Phase: 21 of 25 (Hash-Based Staleness Detection — in progress)
Plan: 21-02 (Wave 2, ready for execution)
Status: Plan 21-01 complete (STALE-01/02/03 satisfied). Plan 21-02 next (STALE-04: orchestrator wiring).
Last activity: 2026-04-12 — Plan 21-01 executed (ContextValidator class + 13 unit tests)

Progress: [██░░░░░░░░] 22%

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
- Total plans completed: 4 (20-01, 20-02, 20-03, 21-01)
- Average duration: ~25 min
- Total execution time: ~1.7 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 20 | 3/3 | ~75 min | ~25 min |
| 21 | 1/2 | ~25 min | ~25 min |

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
- Plan 20-03: compactRpetdContext uses minimal 2-message representation (user: task+phase, assistant: content) because full conversation history is unavailable in the CJS CLI path. Phase 24 ROUTE-02 will wire LLM-backed compaction without changing this call site.
- Plan 20-03: CJS regression baseline: 2168 tests, ~11 pre-existing failures (rlm-workflow-spec, behavioral, opencode-config). Zero new failures introduced.

### Pending Todos

None.

- Plan 21-01: ContextValidator.compute_file_hash reads in binary mode to avoid platform line-ending differences; returns None (not raises) for missing files.
- Plan 21-01: changed_since without commit_ref returns all file_hashes keys as safe first-run fallback.
- Plan 21-01: selective_refresh captures get_current_commit() in result dict so orchestrator stores it once without a second subprocess call.
- Plan 21-01: [STALE] log line emitted via log.info inside selective_refresh — STALE-04 verification can grep it.
- Plan 21-01: test count 13 (plan estimated 12); test_compute_file_hashes_batch is the 6th STALE-01 test, consistent with plan's listed coverage table.

### Blockers/Concerns

None. Plan 21-01 shipped cleanly. Plan 21-02 (STALE-04: orchestrator wiring) is unblocked. Phase 22 can proceed in parallel.

## Session Continuity

Last session: 2026-04-12
Stopped at: Plan 21-01 complete. STALE-01/02/03 satisfied. services/context_validator.py and tests/test_context_validator.py created and committed.
Resume file: None


## Learnings









- [learning] 2026-04-13T01:30:55.773Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:58:43.023Z: compactRpetdContext in gsd-amauta.cjs uses minimal 2-message array (user: task+phase, assistant: content[:2000]) because full conversation is unavailable in the CJS CLI path; daemon fallback extractor handles this gracefully; Phase 24 ROUTE-02 will wire LLM compaction without changing the call site
- [learning] 2026-04-13T00:52:07.931Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:42:14.221Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:39:01.825Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:36:50.801Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:27:00.814Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:24:57.175Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:15:18.995Z: Pydantic model_validator(mode='after') auto-computes derived fields like SHA-256 context versions; callers never set them manually. Pre-adding future columns (e.g., file_hashes for Phase 21) in the current migration avoids a second ALTER TABLE. PGStore new method groups belong between domain-matching section dividers.
