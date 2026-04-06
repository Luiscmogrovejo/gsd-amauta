# Roadmap: GSD-Amauta Self-Audit & Upgrade

**Milestone:** v2.5 — Smarter Brain
**Phases:** 8
**Requirements:** 49
**Research sources:** MIT RLM/REPL (arXiv:2512.24601v1), Google Agentic Patterns, Voyage AI docs, Redis docs

## Phase 1: Infrastructure & Quick Wins

**Goal:** Fix broken infrastructure and low-hanging fruit that block everything else.
**Requirements:** INF-01, INF-02, INF-03, INF-04
**Dependencies:** None (must run first)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Fix RLM service restart failures — diagnose why 3 restarts failed | INF-01 |
| 2 | Set PERPLEXITY_MODEL with auto-selection (sonar vs sonar-pro) | INF-02 |
| 3 | Add `max_tokens: 1000` to Perplexity API call | INF-03 |
| 4 | Add API key validation on daemon startup | INF-04 |

**Success criteria:**
- [ ] RLM service starts and stays running
- [x] Perplexity calls use max_tokens to prevent overpay (Plan 01-02 DONE: 4096->1000)
- [x] PERPLEXITY_MODEL=auto with sonar/sonar-pro complexity selection (Plan 01-02 DONE)
- [ ] Daemon reports API key status on startup

---

## Phase 2: Memory & Embeddings Deep Audit

**Goal:** Fix critical memory bugs, audit every scoring/dedup/retention path, ensure the brain works correctly.
**Requirements:** MEM-01 through MEM-10
**Dependencies:** Phase 1 (needs working services)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Fix distillation re-merging bug (exclude source='distilled') | MEM-01 |
| 2 | Replace concatenation merge with LLM summarization | MEM-02 |
| 3 | Audit Voyage AI input_type usage (query vs document) | MEM-03 |
| 4 | Verify cosine dedup thresholds (0.95 pre-store, 0.85 distill) | MEM-05 |
| 5 | Audit source scoring formula correctness | MEM-06 |
| 6 | Verify recency decay in all search paths | MEM-07 |
| 7 | Implement tiered retention policies | MEM-08 |
| 8 | Audit autolearning pipeline end-to-end | MEM-09 |
| 9 | Verify HNSW index config (ef_construction, m) | MEM-10 |

**Success criteria:**
- [ ] Distillation never re-merges already-distilled entries
- [ ] LLM summarization produces fixed-size, high-quality merges
- [ ] All search paths apply recency decay
- [ ] Tiered retention correctly archives by source category
- [ ] Autolearning stores full content, deduplicates, promotes to SKB

---

## Phase 3: RLM/REPL Engine Fixes

**Goal:** Fix 3 P1 BM25 bugs identified by MIT paper audit, optimize retrieval parameters.
**Requirements:** RLM-01 through RLM-06, RLM-08, RLM-09
**Dependencies:** Phase 1 (RLM service must be running)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Fix substring TF counting — use word boundary matching | RLM-01 |
| 2 | Remove query-length normalization from BM25 scoring | RLM-02 |
| 3 | Reduce position decay 10% → 5%, make configurable | RLM-03 |
| 4 | Adjust BM25 b parameter from 0.75 → 0.6 for code | RLM-04 |
| 5 | Reduce max chunk size 8000 → 4000 chars | RLM-05 |
| 6 | Fix label boost saturation bypass | RLM-06 |
| 7 | Audit LRU cache effectiveness | RLM-08 |
| 8 | Add --fresh flag for cache bypass | RLM-09 |

**Success criteria:**
- [ ] "get" no longer matches inside "getting", "forget", etc.
- [ ] Multi-term queries rank higher than single-term matches
- [ ] Python `if __name__` blocks no longer penalized by position
- [ ] Chunks are ~4000 chars, more focused per function

---

## Phase 4: Token Efficiency & Caching

**Goal:** Reduce token waste by 40-50% through caching, smart enrichment, and hybrid retrieval.
**Requirements:** RLM-07, MEM-04, TOK-01 through TOK-05
**Dependencies:** Phases 2, 3 (memory and RLM must be fixed first)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Wire hybrid BM25 + Voyage reranking pipeline | RLM-07 |
| 2 | Add in-memory query embedding cache (1-hour TTL) | MEM-04 |
| 3 | Add Perplexity response cache (6-hour TTL, --no-cache flag) | TOK-01 |
| 4 | Implement phase-specific enrichment reduction | TOK-02 |
| 5 | Audit enrichment dedup window (300s) effectiveness | TOK-03 |
| 6 | Add sonar/sonar-pro auto-selection | TOK-04 |
| 7 | Strip Perplexity citation markers before storage | TOK-05 |

**Success criteria:**
- [ ] Identical semantic searches within 1 hour hit cache, not Voyage API
- [ ] Perplexity responses cached, repeated research queries don't cost tokens
- [ ] T/D phases inject zero enrichment context (was ~800 chars each)
- [ ] Hybrid retrieval merges BM25 + semantic via reranking

---

## Phase 5: Redis Caching Layer

**Goal:** Add Redis as optional L2 cache for embeddings, responses, and RLM chunks.
**Requirements:** INF-05, TOK-06
**Dependencies:** Phase 4 (in-memory caches prove the pattern)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Add Redis to docker-compose.yml | INF-05 |
| 2 | Redis embedding cache with TTL per source type | TOK-06 |
| 3 | Redis RLM chunk cache (faster than re-parsing) | TOK-06 |
| 4 | Redis Perplexity response cache (replaces in-memory) | TOK-06 |
| 5 | Graceful degradation — Redis down falls back to in-memory | INF-05 |

**Success criteria:**
- [ ] Redis runs alongside PG in docker-compose
- [ ] Sub-1ms cache hits for redundant queries
- [ ] System works without Redis (graceful degradation)
- [ ] Cache hit/miss rates visible in health dashboard

---

## Phase 6: Multi-Agent & RPETD Audit

**Goal:** Audit agent definitions, routing logic, RPETD enforcement, and validation gates against Google agentic patterns.
**Requirements:** AGT-01 through AGT-07
**Dependencies:** Phases 2-4 (memory and token fixes inform agent behavior)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Audit all 11 agent definitions | AGT-01 |
| 2 | Audit file-pattern routing accuracy | AGT-02 |
| 3 | Audit performance routing and fallback | AGT-03 |
| 4 | Audit RPETD pipeline enforcement | AGT-04 |
| 5 | Audit external validation gates | AGT-05 |
| 6 | Add exception handling/recovery pipeline | AGT-06 |
| 7 | Add agent capability index | AGT-07 |

**Success criteria:**
- [ ] Every agent has clear, non-overlapping responsibilities
- [ ] Routing has <5% false positive rate
- [ ] RPETD gates block progression without evidence
- [ ] Failed tasks get recovery pipeline (not just fail status)

---

## Phase 7: Task Manager & Research Chain Audit

**Goal:** Audit task lifecycle, priority scoring, and the 5-step research chain.
**Requirements:** TSK-01 through TSK-05, RSC-01 through RSC-05
**Dependencies:** Phases 1-4 (all infrastructure must be stable)

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Audit task lifecycle TOCTOU safety | TSK-01 |
| 2 | Audit priority scoring edge cases | TSK-02 |
| 3 | Audit archive/reconcile gaps | TSK-03 |
| 4 | Audit stale watchdog behavior | TSK-04 |
| 5 | Verify PG sync across 39 fields | TSK-05 |
| 6 | Audit research chain cascade logic | RSC-01 |
| 7 | Audit R-phase auto-invocation | RSC-02 |
| 8 | Audit Perplexity preamble stripping | RSC-03 |
| 9 | Add Perplexity rate limiter | RSC-04 |
| 10 | Audit research dedup threshold | RSC-05 |

**Success criteria:**
- [ ] No TOCTOU races in concurrent task access
- [ ] Priority scoring handles all edge cases correctly
- [ ] Archive preserves parent-child genealogy
- [ ] Research chain fires each step only when needed
- [ ] Perplexity has rate limiting to prevent cost spikes

---

## Phase 8: Integration Testing & Baseline Measurement

**Goal:** Measure token usage before/after all optimizations, validate end-to-end system behavior.
**Requirements:** TOK-07
**Dependencies:** All previous phases

| # | Deliverable | Requirement |
|---|-------------|-------------|
| 1 | Measure baseline token usage per task lifecycle | TOK-07 |
| 2 | End-to-end test: full task lifecycle with all optimizations | TOK-07 |
| 3 | Performance benchmark: cache hit rates, query latency | TOK-07 |
| 4 | Regression test suite for all audit fixes | TOK-07 |

**Success criteria:**
- [ ] Token usage per task lifecycle measured and documented
- [ ] At least 30% reduction in enrichment tokens vs pre-audit baseline
- [ ] All cache layers show >50% hit rate
- [ ] Zero regressions from audit fixes

---

## Phase Dependency Graph

```
Phase 1 (Infrastructure) ──┬──> Phase 2 (Memory)    ──┐
                            ├──> Phase 3 (RLM)        ──┤──> Phase 4 (Token Efficiency) ──> Phase 5 (Redis)
                            │                           │
                            └───────────────────────────┘
                                                         └──> Phase 6 (Agents) ──> Phase 7 (Tasks/Research) ──> Phase 8 (Testing)
```

Phases 2 and 3 can run in parallel after Phase 1.
Phase 4 requires both 2 and 3.
Phase 5 requires 4.
Phases 6 and 7 can run in parallel after Phase 4.
Phase 8 requires all.

---

## Coverage

| Category | Requirements | Phases |
|----------|-------------|--------|
| Infrastructure | 5 | 1, 5 |
| RLM/BM25 | 9 | 3, 4 |
| Memory | 10 | 2, 4 |
| Token Efficiency | 7 | 4, 5, 8 |
| Agents/RPETD | 7 | 6 |
| Task Manager | 5 | 7 |
| Research Chain | 5 | 7 |
| **Total** | **49** | **8 phases** |

Unmapped requirements: 0

---
*Roadmap created: 2026-04-06*
*Research sources: MIT RLM/REPL, Google Agentic Patterns, Voyage AI, Redis, Perplexity docs*
