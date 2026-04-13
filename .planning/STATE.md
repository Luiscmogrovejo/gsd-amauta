---
gsd_state_version: 1.0
milestone: v2.9
milestone_name: Nervous System
status: completed
stopped_at: Plan 26-01 complete — ready for 26-02
last_updated: "2026-04-13T15:54:01.162Z"
last_activity: 2026-04-13 — Plan 26-01 complete (5 atomic commits, 14 tests passing)
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
  percent: 4
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-13 for v2.9)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.9 -- Nervous System. Five infrastructure layers composing into a unified upgrade: substrate (Valkey, pgvector, ParadeDB, tree-sitter), retrieval rewrite, behavioral upgrade, MCP interface, observability + security.

## Current Position

Phase: 26 — The Substrate (complete — all 2 plans done)
Plan: — (phase complete, ready for Phase 27/28)
Status: Plan 26-02 complete — INFRA-02 (pgvector) + INFRA-03 (pg_search BM25) done
Last activity: 2026-04-13 — Plan 26-02 complete (5 atomic commits + 1 docs, 11 CJS + 10 Python tests passing)

Progress: [██████████] 96%

## v2.9 Phase Map

| Phase | Name | Requirements | Depends On | Status |
|-------|------|--------------|------------|--------|
| 26 | The Substrate | INFRA-01..04 (4) | Nothing | Complete (2026-04-13) |
| 27 | The Retrieval Rewrite | RLM-01..06 (6) | Phase 26 | Not started |
| 28 | The Behavioral Upgrade | BEHAV-01..06 (6) | Phase 26 | Not started |
| 29 | The MCP Interface | MCP-01..05 (5) | Phase 27 | Not started |
| 30 | Observability + Security | OBS-01..02, SEC-01..03 (5) | Phases 27+28 | Not started |

**Execution order:**
- Phase 26 first (foundation)
- Phases 27 and 28 in parallel (both need only Phase 26)
- Phase 29 after Phase 27 (search-code tool needs hybrid pipeline)
- Phase 30 after Phases 27 + 28 (tracing + audit cover both)
- Phases 29 and 30 can run in parallel once 27+28 both complete

## Performance Metrics

(Reset for new milestone)

## Accumulated Context

### Decisions

- v2.8 shipped: 6 phases, 13 plans, 26 requirements. Structured context handoffs, staleness detection, caveman compression, prefix caching, semantic cache, tiered routing, tech debt sweep.
- CAVE-02 divergence (known): 30% compression ratio not achievable on dense technical .md files (~1.5% actual). Does not block downstream work.
- v2.9 research: 35 findings across 7 tracks. Key: tree-sitter + ParadeDB + reranking for 3x retrieval, Valkey swap for 37% throughput, AGENTS.md for ecosystem alignment, gVisor for isolation.
- Plan 26-01: tree-sitter Node pinned to 0.21.1 (0.25 native build fails on Node 25 — C++ v8-memory-span.h API break). Grammar versions matched.
- Plan 26-01: Valkey 8 benchmark shows +35.7% SET throughput vs redis:8 reference (238095 vs 175439 rps).
- Plan 26-02: paradedb tag is latest-pg16 (not pg16). pg_search v0.22.6 needs shared_preload_libraries=pg_search. BM25 API uses CREATE INDEX USING bm25 WITH (key_field). BM25 queries need column prefix 'content:term'.

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-04-13
Stopped at: Plan 26-02 complete — Phase 26 done. Ready for Phase 27 (Retrieval Rewrite) and Phase 28 (Behavioral Upgrade) in parallel.
Resume file: None

## Learnings

