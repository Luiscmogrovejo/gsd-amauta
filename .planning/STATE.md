---
gsd_state_version: 1.0
milestone: v2.5
milestone_name: milestone
status: completed
stopped_at: Plan 02-02 SUMMARY created. MEM-07 guard tests + MEM-08 web_search_result:180 tier complete.
last_updated: "2026-04-06T19:35:00.000Z"
last_activity: 2026-04-06 -- Plan 02-02: web_search_result:180 added to RETENTION_DAYS in both stores; 21 retention+decay tests pass
progress:
  total_phases: 8
  completed_phases: 6
  total_plans: 17
  completed_plans: 13
  percent: 18
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-06)

**Core value:** Every subsystem audited against reference papers, gaps fixed, token usage reduced while quality improves.
**Current focus:** Milestone v2.5 -- Smarter Brain. INITIALIZED.

## Current Position

Phase: 2 and 3 of 8 (both planned, executing in parallel)
Plan: 3/7 complete (02-04, 02-01, 02-02 done; 2 remaining in Phase 2, 2 remaining in Phase 3)
Status: Plan 02-02 complete. MEM-07 guard tests + MEM-08 web_search_result:180 tier done. Phase 2: 4 plans, 2 waves, 12 tasks, 10 requirements (MEM-01..10). Phase 3: 3 plans, 3 waves, 8 tasks, 8 requirements (RLM-01..06, RLM-08, RLM-09).
Last activity: 2026-04-06 -- Plan 02-02: web_search_result:180 retention tier added to pg_store+sqlite_store; 6 recency decay guard tests + 3 new retention tests (15 total); 21/21 tests pass

Progress: [#.........] 12%

## Research Completed

3 research documents in .planning/research/:
- RLM-REPL-RESEARCH.md -- MIT paper audit, 10 BM25 gaps, 3 P1 bugs
- AGENTIC-PATTERNS-MEMORY.md -- 21 patterns audited, 4 weak gaps, distillation CRITICAL bug
- TOKEN-EFFICIENCY-CACHING.md -- No embedding cache, reranker never wired, Perplexity overpay

## Infrastructure Status (at project init)

- Daemon: Running on :18799, PG available
- RLM: FIXED -- orphan kill + port-free check + restart counter reset via Plan 01-01
- Voyage API key: SET (46 chars)
- Perplexity API key: SET (53 chars)
- PERPLEXITY_MODEL: FIXED -- defaults to 'auto' (query-complexity selection) via Plan 01-02
- OpenAI API key: NOT SET (not needed, Voyage is primary)

## Codebase Map

7 documents in .planning/codebase/ (2,337 lines total):
- ARCHITECTURE.md (434 lines)
- STRUCTURE.md (483 lines)
- TESTING.md (421 lines)
- CONCERNS.md (347 lines, 29 concerns)
- INTEGRATIONS.md (281 lines)
- CONVENTIONS.md (195 lines)
- STACK.md (176 lines)

## Accumulated Context

### Decisions

- Fresh audit project (not new milestone) -- clean slate for unbiased assessment
- All subsystems equal priority -- no shortcuts
- Research-backed improvements only -- every change cites a source
- Redis optional with graceful degradation -- same pattern as PG/file fallback
- Phases 2 and 3 can run in parallel after Phase 1
- MEM-04 embedding cache deferred to Phase 4: bundled with amauta.py write-path unification to avoid partial solutions across Python + Node.js
- MEM-03/MEM-10 CORRECT: no code changes needed, audit comments only
- Two-write-path gap (amauta.py direct SQL vs daemon HTTP) documented for Phase 4
- BM25 TF counting: use _tokenize_list() (list, preserves duplicates) alongside _tokenize() (set, for IDF) -- both pre-computed in score_chunks()
- Query-length normalization removed from BM25 -- standard Robertson-Sparck Jones 1994 sums per-term scores without dividing by term count
- Position decay reduced to 5% (was 10%) and exposed via RLM_POSITION_DECAY env var
- BM25_B set to 0.6 (was 0.75) -- code-optimized per literature (b=0.5-0.6 for high-variance-length corpora)
- MEM-01 distill-status bug FIXED: memory_count() now accepts exclude_source param; distill-status excludes source='distilled' from threshold count
- MEM-09 autolearning source: ALREADY CORRECT in v2.4 -- all 6 learning event paths have explicit source=; guard tests added
- MEM-05/MEM-06: dedup 0.95 cosine + Jaccard 0.7 distillation confirmed correct; dual scoring paths documented as intentional
- MEM-08: web_search_result:180 added to RETENTION_DAYS in both stores; sqlite_store also updated (not just pg_store) since tests use SQLiteStore
- MEM-07: recency decay confirmed present (amauta.py + both stores); guard tests prevent future regression; constants verified consistent: DECAY_PER_30D=0.5, MAX_PENALTY=3.0

### Pending Todos

None.

### Blockers/Concerns

None. Phase 1 blockers resolved:
- RLM service restart failure chain fixed (Plan 01-01)
- PERPLEXITY_MODEL auto-selection added (Plan 01-02)

## Session Continuity

Last session: 2026-04-06
Stopped at: Plan 02-02 complete. MEM-07 + MEM-08 done. Ready for 02-03 or 03-02 (parallel).
Resume file: None

## Previous Milestone: v2.4 -- Bulletproof (COMPLETE)

Archived to .planning/milestones/v2.4-archive/
4 phases, 6 plans, 20 requirements, 408 tests.
