---
gsd_state_version: 1.0
milestone: v2.5
milestone_name: milestone
status: completed
stopped_at: Plan 06-03 complete. R_PHASE_SUBSTANCE+P_PHASE_SUBSTANCE gates (>=50 chars), T threshold raised, phase-order warning, force_reason persisted, 16 new tests pass, 38+114+72 existing tests still pass.
last_updated: "2026-04-06T16:05:00.000Z"
last_activity: "2026-04-06 -- Plan 06-03: R/P substance gates, T threshold >=50, phase-order warning, force_reason->notes+metadata, 16/16 tests"
progress:
  total_phases: 7
  completed_phases: 4
  total_plans: 22
  completed_plans: 18
  percent: 100
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-06)

**Core value:** Every subsystem audited against reference papers, gaps fixed, token usage reduced while quality improves.
**Current focus:** Milestone v2.5 -- Smarter Brain. INITIALIZED.

## Current Position

Phase: 7 of 7
Plan: 1/1 complete for Phase 07 (07-01 done)
Status: Phase 07 complete. Plan 07-01 complete: archive/reconcile added to _EXEC_ALLOWLIST+command_map+special handlers (HIGH severity dead-code fix), STALE_CHECK_INTERVAL now reads GSD_STALE_INTERVAL env var, 17/17 guard tests pass (ROUTE/WATCHDOG/PGSYNC/ARCHIVE suites). All 7 phases complete.
Last activity: 2026-04-06 -- Plan 07-01: archive/reconcile routing, GSD_STALE_INTERVAL, 17 guard tests

Progress: [##########] 100%

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
- INF-05: Redis added to docker-compose (redis:7-alpine, allkeys-lru, no persistence), redis-py>=5.0 in requirements.txt, _HAS_REDIS import guard mirrors _HAS_PG_MODULE pattern; daemon has 5 Redis management functions (_start_redis, _auto_start_redis_container, _stop_redis, _check_redis_health, _redis_watchdog) mirroring RLM pattern; health endpoint exposes redis_managed/running/url/restarts; infra_detect._detect_redis + redis_available on all 4 return paths; _auto_start_docker_postgresql also starts gsd-redis

- TOK-06: Redis L2 embedding cache wraps Phase 4 L1 dict in generate_embedding(); bridge module amauta_daemon_redis.py (get/set_redis_client) solves circular import; key gsd:emb:{sha256_16hex}, 3600s TTL, JSON float list; L1 promotion on L2 hit; silent except-pass degradation; daemon injects client at startup via try/ImportError guard
- TOK-06 (Perplexity cache): /api/research-cache GET/POST in daemon (REDIS_PERPLEXITY_PREFIX="gsd:ppx:", REDIS_PERPLEXITY_TTL=21600); _checkDaemonCache/_writeDaemonCache in gsd-research.cjs (stdlib http only, 2s timeout, resolves null/false on error); providerPerplexity: cacheKey hoisted before noCache guard, daemon Redis L1 check first then file L2; POST handler placed before command_map in do_POST (direct redis, not amauta.py CLI)
- [Phase 06]: routeExecutor: path-prefix anchoring for infra eliminates false positives (src/config.ts, src/deploy-utils.ts, .github/ISSUE_TEMPLATE.md) — Broad substring match on docker/ci/deploy/infra was flagging any file path containing those substrings as infra — path-prefix anchoring restricts to known infra file patterns only
- [Plan 06-03]: R_PHASE_SUBSTANCE gate (>=50 chars) and P_PHASE_SUBSTANCE gate (>=50 chars) added to _validate_all_gates() after Gate 0; non-code T threshold raised from >20 to >=50; substance gates emit SKIP (not FAIL) for empty phases, deferring to RPETD_COMPLETE
- [Plan 06-03]: Phase-order warning in cmd_rpetd() is soft (YELLOW print, no sys.exit) -- intentional design for async parallel agent workflows; PHASE_ORDER = ["R","P","E","T","D"] defined in function scope
- [Plan 06-03]: force_reason persisted to two audit surfaces: _append_note (FORCE_OVERRIDE: text in task notes) and _mem_log_event metadata (force_reason + forced boolean) -- AGT-05 fix; validation-gates.test.cjs setupTask defaults updated to meet new 50-char gates

### Pending Todos

None.

### Blockers/Concerns

None. Phase 1 blockers resolved:
- RLM service restart failure chain fixed (Plan 01-01)
- PERPLEXITY_MODEL auto-selection added (Plan 01-02)

## Session Continuity

Last session: 2026-04-06T15:42:06.582Z
Stopped at: Plan 06-02 complete. Routing extracted to gsd-tools route-executor, infra regex tightened, pass_rate normalized, PERF_ROUTING_OVERRIDE audit trail added, 27 tests pass.
Resume file: None

## Previous Milestone: v2.4 -- Bulletproof (COMPLETE)

Archived to .planning/milestones/v2.4-archive/
4 phases, 6 plans, 20 requirements, 408 tests.
