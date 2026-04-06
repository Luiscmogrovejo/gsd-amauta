# Requirements: GSD-Amauta Self-Audit & Upgrade

**Defined:** 2026-04-06
**Core Value:** Every subsystem audited against reference papers, gaps fixed, token usage reduced while quality improves.

## v1 Requirements

### Infrastructure & Configuration (INF)

- [x] **INF-01**: RLM service starts reliably without 3-restart failures
- [x] **INF-02**: PERPLEXITY_MODEL env var set to appropriate model with auto-selection logic
- [x] **INF-03**: Perplexity API call sets `max_tokens: 1000` to prevent paying for truncated output
- [x] **INF-04**: All API keys validated on daemon startup with clear error messages
- [x] **INF-05**: Redis service added to docker-compose with optional graceful degradation

### BM25 & RLM Engine (RLM)

- [x] **RLM-01**: Fix substring-based TF counting that overcounts short terms inside longer words
- [x] **RLM-02**: Remove query-length normalization that changes BM25 ranking semantics
- [x] **RLM-03**: Reduce position decay from 10% to 5% (or configurable) to stop penalizing bottom-of-file code
- [x] **RLM-04**: Audit BM25 parameters k1=1.5, b=0.75 — lower b to 0.6 for code chunk length variance
- [x] **RLM-05**: Reduce default chunk size from 8000 to 4000 chars for more focused retrieval
- [x] **RLM-06**: Fix label boost saturation bypass edge case
- [x] **RLM-07**: Wire hybrid BM25 + Voyage reranking pipeline (voyage-rerank-2.5 is implemented but never called)
- [x] **RLM-08**: Audit LRU cache hit rates and eviction policy effectiveness
- [x] **RLM-09**: Add --fresh flag for cache bypass during debugging

### Memory & Embeddings (MEM)

- [x] **MEM-01**: Fix distillation re-merging bug — exclude `source='distilled'` from distill input
- [x] **MEM-02**: Replace concatenation merging with LLM-based summarization for distillation
- [x] **MEM-03**: Audit Voyage AI integration — verify `input_type="query"` vs `"document"` usage
- [x] **MEM-04**: Add in-memory query embedding cache with 1-hour TTL (no cache exists today)
- [x] **MEM-05**: Verify cosine dedup threshold 0.95 for pre-store and 0.85 for distillation grouping
- [x] **MEM-06**: Audit source scoring formula: `similarity * 10 + source_bonus`
- [x] **MEM-07**: Verify recency decay (-0.5/30d, cap -3.0) is applied correctly in all search paths
- [x] **MEM-08**: Implement tiered retention: permanent (lesson-learned, best-practice), long (auto_learning), medium (web_search 180d), short (rpetd_phase 90d), ephemeral (task_event 30d)
- [x] **MEM-09**: Audit autolearning pipeline — D-phase LEARNING extraction, SKB promotion, content integrity
- [x] **MEM-10**: Verify HNSW index configuration is optimal for <10K rows (ef_construction, m parameters)

### Token Efficiency (TOK)

- [x] **TOK-01**: Add Perplexity response cache with 6-hour TTL and --no-cache bypass
- [x] **TOK-02**: Implement phase-specific enrichment reduction (R=full, P=SKB-only, E=RLM-only, T/D=none)
- [x] **TOK-03**: Audit enrichment dedup window (300s) — verify effectiveness and edge cases
- [x] **TOK-04**: Add sonar/sonar-pro auto-selection based on query complexity
- [x] **TOK-05**: Strip Perplexity citation markers from responses before storage
- [x] **TOK-06**: Implement Redis as L2 cache for embeddings, responses, and RLM chunks
- [ ] **TOK-07**: Measure baseline token usage per task lifecycle before/after optimizations

### Multi-Agent & RPETD (AGT)

- [x] **AGT-01**: Audit all 11 agent definitions for role clarity, tool access, and pattern coverage
- [x] **AGT-02**: Audit file-pattern routing accuracy — false positive/negative rate
- [x] **AGT-03**: Audit performance routing — pass rate tracking, 70% fallback threshold
- [x] **AGT-04**: Audit RPETD pipeline — phase transitions, gate enforcement, evidence quality
- [x] **AGT-05**: Audit external validation — self-validation block, --force-reason audit trail
- [x] **AGT-06**: Add exception handling/recovery pipeline for failed tasks (weak pattern P15)
- [x] **AGT-07**: Add agent capability index for smarter routing (weak pattern — inter-agent communication)

### Task Manager (TSK)

- [x] **TSK-01**: Audit task lifecycle — TOCTOU safety, dual-write consistency, retry flush
- [x] **TSK-02**: Audit priority scoring formula edge cases
- [x] **TSK-03**: Audit archive/reconcile — daemon mirror list gap, parent.children genealogy
- [x] **TSK-04**: Audit stale watchdog — 48h threshold appropriateness, test-exempt behavior
- [x] **TSK-05**: Verify PG sync across all 39 fields (migration 007)

### Research Chain (RSC)

- [x] **RSC-01**: Audit 5-step chain cascade logic — when each step fires, threshold tuning
- [x] **RSC-02**: Audit R-phase auto-invocation trigger (<2 local results threshold)
- [x] **RSC-03**: Audit Perplexity preamble stripping completeness
- [x] **RSC-04**: Add Perplexity rate limiter to prevent API abuse
- [x] **RSC-05**: Audit research dedup — Jaccard 0.7 threshold, false positive rate

## v2 Requirements (Deferred)

### Advanced Upgrades

- **ADV-01**: Layer 3 agent-initiated RLM context (rlm_client.py)
- **ADV-02**: Multi-agent debate for high-stakes architectural decisions
- **ADV-03**: RLM synonym expansion for semantic code queries
- **ADV-04**: BM25+ delta variant for better short-document scoring
- **ADV-05**: Code-aware stopwords list for BM25 tokenization
- **ADV-06**: Dimensional validation scoring for memory quality
- **ADV-07**: npx gsd-amauta init one-command setup
- **ADV-08**: Docker auto-start for PG container

## Out of Scope

| Feature | Reason |
|---------|--------|
| Web UI for audit results | CLI-first tool, visual dashboards add complexity |
| Rewriting core Python/JS split | Architectural decision is settled, works well |
| Adding new agent types | Optimize existing 11 agents, not expand |
| Switching from PostgreSQL | pgvector is the right choice, confirmed by research |
| Changing embedding provider | voyage-code-3 at 1024-dim confirmed optimal by benchmarks |
| Cloud deployment | Local-first tool, homelab infrastructure |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INF-01 | Phase 1 | Complete |
| INF-02 | Phase 1 | Complete |
| INF-03 | Phase 1 | Complete |
| INF-04 | Phase 1 | Complete |
| INF-05 | Phase 5 | Complete |
| RLM-01 | Phase 3 | Complete |
| RLM-02 | Phase 3 | Complete |
| RLM-03 | Phase 3 | Complete |
| RLM-04 | Phase 3 | Complete |
| RLM-05 | Phase 3 | Complete |
| RLM-06 | Phase 3 | Complete |
| RLM-07 | Phase 4 | Complete |
| RLM-08 | Phase 3 | Complete |
| RLM-09 | Phase 3 | Complete |
| MEM-01 | Phase 2 | Complete |
| MEM-02 | Phase 2 | Complete |
| MEM-03 | Phase 2 | Complete |
| MEM-04 | Phase 4 | Complete |
| MEM-05 | Phase 2 | Complete |
| MEM-06 | Phase 2 | Complete |
| MEM-07 | Phase 2 | Complete |
| MEM-08 | Phase 2 | Complete |
| MEM-09 | Phase 2 | Complete |
| MEM-10 | Phase 2 | Complete |
| TOK-01 | Phase 4 | Complete |
| TOK-02 | Phase 4 | Complete |
| TOK-03 | Phase 4 | Complete |
| TOK-04 | Phase 4 | Complete |
| TOK-05 | Phase 4 | Complete |
| TOK-06 | Phase 5 | Complete |
| TOK-07 | Phase 8 | Pending |
| AGT-01 | Phase 6 | Complete |
| AGT-02 | Phase 6 | Complete |
| AGT-03 | Phase 6 | Complete |
| AGT-04 | Phase 6 | Complete |
| AGT-05 | Phase 6 | Complete |
| AGT-06 | Phase 6 | Complete |
| AGT-07 | Phase 6 | Complete |
| TSK-01 | Phase 7 | Complete |
| TSK-02 | Phase 7 | Complete |
| TSK-03 | Phase 7 | Complete |
| TSK-04 | Phase 7 | Complete |
| TSK-05 | Phase 7 | Complete |
| RSC-01 | Phase 7 | Complete |
| RSC-02 | Phase 7 | Complete |
| RSC-03 | Phase 7 | Complete |
| RSC-04 | Phase 7 | Complete |
| RSC-05 | Phase 7 | Complete |

**Coverage:**
- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0

---
*Requirements defined: 2026-04-06*
*Last updated: 2026-04-06 after research-informed definition*
