---
gsd_state_version: 1.0
milestone: v2.5
milestone_name: milestone
status: in-progress
stopped_at: Plan 04-05 complete. RLM-07 rerank wiring done (_get_pgstore_rerank helper + len>=3 guard + graceful degradation). Phase 04 all 5 plans complete.
last_updated: "2026-04-06T19:30:00.000Z"
last_activity: "2026-04-06 -- Plan 04-05: Voyage rerank-2.5 wired into _mem_semantic_search with len>=3 guard; 14/14 tests pass"
progress:
  total_phases: 8
  completed_phases: 6
  total_plans: 15
  completed_plans: 17
  percent: 30
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-06)

**Core value:** Every subsystem audited against reference papers, gaps fixed, token usage reduced while quality improves.
**Current focus:** Milestone v2.5 -- Smarter Brain. INITIALIZED.

## Current Position

Phase: 4 of 8
Plan: 5/5 complete for Phase 04 (04-01, 04-02, 04-03, 04-04, 04-05 all done)
Status: Phase 04 complete. All 5 plans finished. RLM-07 rerank wiring, MEM-04 embedding cache, TOK-01..05 token efficiency all done. Phase 2 (MEM-01..10) and Phase 3 (RLM-01..06, RLM-08, RLM-09) both fully complete.
Last activity: 2026-04-06 -- Plan 04-05: Voyage rerank-2.5 wired into _mem_semantic_search with len>=3 guard; 14/14 tests pass

Progress: [###.......] 30%

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
- RLM-05: MAX_CHUNK_CHARS default reduced 8000->4000 in rlm-service.py + CLI; 8000-char chunks spanned multiple unrelated functions
- RLM-06: Label boost changed from unbounded 2.0x to 1.5x capped at 3.0*idf; prevents short-label chunks from outranking content-rich chunks; test_label_boost_preserved still passes
- MEM-02: LLM summarization added to distill via --use-llm flag; isOllamaAvailable/selectOllamaModel/llmSummarize helpers; distill_strategy+distill_model metadata provenance; main() gated on require.main for testability
- RLM-08: ChunkCache hit/miss counters added (_hit_count, _miss_count, hit_rate property); /cache/stats endpoint extended with all 3 fields; counters reset on clear()
- RLM-09: ChunkCache.clear_file() evicts entries by filepath only; fresh=body.get('fresh',False) in _handle_query and _handle_search with bypass loop; --fresh CLI flag in parseArgs + all 4 body paths; fresh bypasses cache for single query, result re-enters cache normally
- MEM-04: query embedding cache in pg_store.py; module-level dict with sha256 key (text:input_type:model)[:16], 1h TTL, 500-entry max, batch eviction of oldest 100; query-only (document embeddings bypass cache); process-local for Phase 4 (Redis in Phase 5 for cross-invocation)
- TOK-05: Perplexity citation markers ([1],[12],[999]) stripped from answer text before both memory store and return path; cleanAnswer = answer.replace(/\[\d+\]/g,'').replace(/\s{2,}/g,' ').trim(); res.data.citations metadata untouched
- TOK-03 AUDIT: ENRICHMENT_DEDUP_WINDOW=300 confirmed correct; 3 edge cases documented as inline comments in amauta.py (>5min expiry, R-phase-only scope, reversed() safe non-bug)
- TOK-02: _rpetd_phase_enrich phase map -- T=pass (disabled, ~1350 chars/task saved), D=writes-only (RLM removed, ~600 chars/task saved), E=RLM+failure-LIKE-only (semantic search removed, ~750 chars/task saved); all D-phase writes preserved (_mem_log_event, WEB_SEARCH FINDING, _skb_promote)
- TOK-04: selectPerplexityModel already complete from Phase 1 Plan 01-02; regression confirmed (11/11 tests pass)
- Pre-change audit for enrichment removal is mandatory: test_rlm_enrichment.py and security-infrastructure.test.cjs had stale T/D-phase RLM call assertions that required updating
- TOK-01: Perplexity temp-file response cache at ~/.amauta/perplexity-cache.json; 6h TTL; SHA-256(query:model)[:16] key; atomic tmp+rename write; _noCache function property flag for --no-cache bypass; cache read before API, cache write always after API; two gsd-research.cjs copies exist (repo vs installed) -- tests use repo copy
- RLM-07: Voyage rerank-2.5 wired into _mem_semantic_search() via _get_pgstore_rerank() lazy import helper; guarded by len(out) >= 3; rerank_score metadata added to reranked entries; except Exception: pass for silent graceful degradation to original pgvector ordering

### Pending Todos

None.

### Blockers/Concerns

None. Phase 1 blockers resolved:
- RLM service restart failure chain fixed (Plan 01-01)
- PERPLEXITY_MODEL auto-selection added (Plan 01-02)

## Session Continuity

Last session: 2026-04-06
Stopped at: Plan 04-02 complete. Phase 04 plans 01-04 done. Ready for Plan 04-05 (reranking wire-up).
Resume file: None

## Previous Milestone: v2.4 -- Bulletproof (COMPLETE)

Archived to .planning/milestones/v2.4-archive/
4 phases, 6 plans, 20 requirements, 408 tests.
