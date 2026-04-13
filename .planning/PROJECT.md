# GSD-Amauta — RPETD Intelligence Platform

## What This Is

GSD-Amauta is a portable, quality-enforced AI development harness for Claude Code — and any MCP-compatible AI coding agent. v2.9 "Nervous System" delivered the five infrastructure layers that compose into a unified upgrade: Valkey replaces Redis (+35.7% throughput), ParadeDB BM25 + pgvector HNSW consolidate retrieval inside PostgreSQL, tree-sitter AST-aware chunking replaces fixed-character splits, hybrid RRF search fuses BM25 + vector in a single SQL query, circuit breakers and Reflexion memory add self-correction, and amauta-mcp.py exposes the full stack as protocol-native MCP tools and resources. Any tool that speaks MCP — Claude Code, Cursor, Gemini CLI, OpenCode — can now consume Amauta's retrieval, memory, and RPETD context without knowing GSD-Amauta exists.

## Core Value

Every RPETD phase must *see* what the other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats. The brain synthesizes, not accumulates.

## Shipped: v2.9 "Nervous System" (2026-04-13)

**4 phases, 10 plans.** Phase 30 cancelled — K3s-dependent infrastructure not portable.

**Shipped:**
1. The Substrate — Valkey 8.x, pgvector 0.8.2, ParadeDB pg_search, tree-sitter parsers
2. The Retrieval Rewrite — AST chunking, ParadeDB BM25, Voyage Code 3 embeddings, RRF hybrid search, Jina reranking, NetworkX dependency graph
3. The Behavioral Upgrade — AGENTS.md discovery, circuit breakers, Reflexion memory, lint guardrails, feature-list lifecycle, get-bearings ritual
4. The MCP Interface — amauta-mcp.py (stdio + SSE :18800), search-code/memory/context/research as MCP tools and resources

## Current Milestone: v3.0 "The Birth"

**Goal:** Make GSD-Amauta ecosystem infrastructure — any AI coding agent that speaks MCP can consume it without installation. The MCP server becomes a standalone service with direct PG/Valkey connections (not daemon wrapper). One-command setup via npx. Public npm release. Portable security and observability as agent capabilities (no K3s dependency).

**Body metaphor sequence:** brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → **birth (v3.0)**

## Requirements

### Validated

#### v2.5 Smarter Brain — Shipped 2026-04-06 (49/49 requirements)
- ✓ **MEM-01..10**: PG memory, pgvector, Voyage AI, distillation, dedup, recency decay, source scoring, tiered retention, autolearning, Redis L2 cache
- ✓ **RLM-01..08**: BM25 k1/b tuning, position decay, chunk sizing (4000 char), camelCase splitting, service stability, enrichment layers, hybrid retrieval, LRU cache
- ✓ **TOK-01..07**: Enrichment dedup window, Perplexity cap (1500 char), RPETD soft cap, PERPLEXITY_MODEL auto-routing, Redis response caching, RLM chunk caching, context injection efficiency
- ✓ **AGT-01..06**: 11 agent audit, file-pattern routing, performance tiebreaker, RPETD phase transitions, validation hardening, inter-agent messaging
- ✓ **TSK-01..05**: Task lifecycle, priority scoring, archive/reconcile, stale watchdog, PG dual-write (39-field migration 007)
- ✓ **RSC-01..04**: Research chain 5-step cascade, R-phase auto-invoke, Perplexity preamble stripping, Jaccard dedup
- ✓ **INF-01..05**: API key validation, Redis docker-compose, graceful degradation, RLM auto-restart, daemon health monitoring

#### v2.6 Sight Beyond Sight — Shipped 2026-04-10 (46/46 requirements)
- ✓ **LEARN-01..07**: Structured D-phase learning, category/tag taxonomy, GIN index search
- ✓ **EXEC-01..08**: PRE_EXECUTION_EVIDENCE mandate, research-informed execution
- ✓ **QA-01..08**: Spec inheritance, EDGE_CASES + REGRESSION blocks, parent verification
- ✓ **CREATIVE-01..05**: Task-type-gated creative research variants
- ✓ **HARDEN-01..05**: Manifest check, divergence protocol v1.1.0, validator vocabulary lock
- ✓ **PLAN-01..07**: plan-to-tasks auto-registration, story blocks, Pass 0 cycle detection
- ✓ **DOGFOOD-01..05**: verify-v26.cjs structural audit, audit-rpetd-intelligence.cjs, dogfood ledger

#### v2.7 Steady Hands — Shipped 2026-04-12 (7/7 requirements)
- ✓ **RESOLVE-01..02**: Milestone-scoped init resolver + --phase-dir override
- ✓ **AUDIT-01..03**: Prefix probe + npm parser + tooling_bugs_observed schema
- ✓ **SAMPLE-01**: Daemon-sourced sampling pool with SUMMARY.md fallback
- ✓ **SCHEMA-01**: Dynamic ledger depth scan (ledger table + memory dir union)

#### v2.8 Metabolism — Shipped 2026-04-13 (26/26 requirements)
- ✓ **HANDOFF-01..05**: RPETDContext typed object, compact_conversation, CJS integration, context version hashing, phase-specific views
- ✓ **STALE-01..04**: SHA-256 file hashing, git diff change detection, selective refresh, staleness logging
- ✓ **CAVE-01..04**: Pipe-delimited descriptions, grammar stripping, BM25 benchmark, fact density validation
- ✓ **CACHE-01..04**: CACHE_BREAKPOINT markers, prefix stability audit, annotate_cache_control, /metrics/cache endpoint
- ✓ **SEMANTIC-01..03, ROUTE-01..02**: Semantic cache store/lookup/invalidation, model routing config, compaction model routing
- ✓ **DEBT-01..04**: Ghost fallback regression, plan-to-tasks default fix, amauta.cjs delegation, routeExecutor specificity

### Active

#### v2.9 Nervous System — Shipped 2026-04-13 (21/26 requirements; 5 deferred)
- ✓ **INFRA-01..04**: Valkey 8.x, pgvector 0.8.2, ParadeDB pg_search, tree-sitter parsers — v2.9
- ✓ **RLM-01..06**: AST-aware chunking, ParadeDB BM25, Voyage Code 3 embeddings, RRF hybrid search, Jina reranking, NetworkX dependency graph — v2.9
- ✓ **BEHAV-01..06**: AGENTS.md discovery, circuit breakers, Reflexion memory, lint guardrails, feature-list lifecycle, get-bearings ritual — v2.9
- ✓ **MCP-01..05**: amauta-mcp.py (stdio+SSE), search-code, memory, RPETD context resources, research chain — v2.9
- ~ **OBS-01**: Langfuse/K3s tracing — deferred to v3.0 (portable OTel optional integration)
- ~ **OBS-02**: Model canary suite — deferred to v3.0 (portable agent capability)
- ~ **SEC-01**: Rule of Two audit — deferred to v3.0 (portable agent capability)
- ~ **SEC-02**: gVisor K3s sandbox — deferred indefinitely (K3s-only infrastructure)
- ~ **SEC-03**: Tool integrity checking — deferred to v3.0 (MCP startup check)

#### Legacy (carried forward — all validated in v2.5)
##### Memory & Embeddings Audit
- [ ] **MEM-01**: Audit PG memory store (pg_store.py) — connection pooling, query patterns, error handling
- [ ] **MEM-02**: Audit pgvector usage — HNSW index config, embedding dimensions, similarity thresholds
- [ ] **MEM-03**: Audit Voyage AI integration — model selection (voyage-code-3), batch sizes, error handling
- [ ] **MEM-04**: Audit memory distillation — Jaccard threshold (0.7), merge quality, off-by-1 fix verification
- [ ] **MEM-05**: Audit embedding deduplication — cosine threshold (0.95), pre-store check effectiveness
- [ ] **MEM-06**: Audit recency decay — -0.5/30d scoring, cap at -3.0, impact on search quality
- [ ] **MEM-07**: Audit source scoring — bonus values (+0-4), search formula correctness
- [ ] **MEM-08**: Audit tiered retention — archive thresholds, policy enforcement
- [ ] **MEM-09**: Audit autolearning pipeline — D-phase extraction, SKB promotion, content integrity
- [ ] **MEM-10**: Implement Redis cache layer for embeddings and memory lookups

#### RLM/REPL Context Engine Audit
- [ ] **RLM-01**: Audit BM25 scoring — k1 (1.5), b (0.75) against MIT paper recommendations
- [ ] **RLM-02**: Audit chunk sizing — 8000 char max, position penalty (-10%), label boost (2x)
- [ ] **RLM-03**: Audit camelCase/snake_case splitting — tokenization quality, edge cases
- [ ] **RLM-04**: Audit RLM service stability — why 3 restart failures, graceful recovery
- [ ] **RLM-05**: Audit RPETD enrichment layers — Layer 1 (claim), Layer 2 (per-phase), dedup window (300s)
- [ ] **RLM-06**: Implement hybrid retrieval — BM25 + Voyage reranking (voyage-rerank-2.5)
- [ ] **RLM-07**: Audit LRU cache (200 files) — hit rates, eviction policy, memory bounds
- [ ] **RLM-08**: Audit context rot prevention — stale chunk detection, index refresh strategy

#### Token Efficiency Audit
- [ ] **TOK-01**: Audit enrichment dedup window (300s) — effectiveness, edge cases
- [ ] **TOK-02**: Audit Perplexity output cap (1500 chars) — impact on research quality
- [ ] **TOK-03**: Audit RPETD soft cap (2000 chars) — compliance rates, agent adherence
- [ ] **TOK-04**: Verify PERPLEXITY_MODEL should be sonar-pro (currently unset)
- [ ] **TOK-05**: Implement Redis response caching — Perplexity + WebFetch results
- [ ] **TOK-06**: Implement RLM chunk caching in Redis — faster than re-parsing
- [ ] **TOK-07**: Audit context injection efficiency — what % of injected context is actually used

#### Multi-Agent & RPETD Audit
- [ ] **AGT-01**: Audit 11 agent definitions — role clarity, tool access, pattern coverage
- [ ] **AGT-02**: Audit file-pattern routing — accuracy, false positives, tiebreaker logic
- [ ] **AGT-03**: Audit performance routing — pass rate tracking, 70% fallback threshold
- [ ] **AGT-04**: Audit RPETD pipeline — phase transitions, gate enforcement, evidence quality
- [ ] **AGT-05**: Audit external validation — self-validation block, --force-reason audit trail
- [ ] **AGT-06**: Audit inter-agent communication — RPETD phases as messages, information loss

#### Task Manager Audit
- [ ] **TSK-01**: Audit task lifecycle — TOCTOU safety, dual-write, retry flush
- [ ] **TSK-02**: Audit priority scoring — formula (imp*0.4 + urg*0.3 + dep*0.3), edge cases
- [ ] **TSK-03**: Audit archive/reconcile — daemon mirror list gap, parent.children genealogy
- [ ] **TSK-04**: Audit stale watchdog — 48h threshold, test-exempt flag
- [ ] **TSK-05**: Audit PG sync — 39 field sync (migration 007), [PG_SYNC_WARN] visibility

#### Research Chain Audit
- [ ] **RSC-01**: Audit 5-step chain — Memory -> SKB -> Context7 -> Perplexity -> WebFetch
- [ ] **RSC-02**: Audit auto-invocation — R-phase trigger when <2 local results
- [ ] **RSC-03**: Audit Perplexity integration — preamble stripping, response quality
- [ ] **RSC-04**: Audit research dedup — Jaccard threshold (0.7), false positive rate

#### Infrastructure & Configuration
- [ ] **INF-01**: Verify API key configuration — Voyage + Perplexity keys validated
- [ ] **INF-02**: Add Redis service to docker-compose — caching layer
- [ ] **INF-03**: Audit graceful degradation — PG -> file fallback paths tested
- [ ] **INF-04**: Audit RLM service auto-restart — fix 3-restart failure pattern
- [ ] **INF-05**: Audit daemon health monitoring — all endpoints, uptime tracking

### Out of Scope

- Web UI for audit results — CLI-only audit
- Rewriting core architecture — audit and improve, not rebuild
- Adding new agents — optimize existing 11 agents
- Changing database engine — PostgreSQL + pgvector stays

## Context

- v2.4 milestone completed (4 phases, 6 plans, 408 tests)
- Codebase mapped: 7 documents in .planning/codebase/ (2,337 lines total)
- Daemon running on :18799, PG available, RLM NOT running (3 restart failures)
- Voyage API key: SET, Perplexity API key: SET, PERPLEXITY_MODEL: NOT SET
- CONCERNS.md identified 29 concerns with file paths and impact assessments
- 21,579 lines across 17 primary source files
- ~2000+ tests (Python + CJS)

## Constraints

- **Self-audit**: Use the tool's own features (RPETD, research chain, memory) to audit itself
- **No new runtimes**: Python + Node.js only, add Redis as service not runtime
- **Backward compatible**: All existing data, configs, and workflows must continue working
- **Research-backed**: Every improvement must cite its source (MIT paper, Google patterns, or best practice)
- **Test coverage**: Maintain or improve current test coverage

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fresh audit project vs new milestone | Clean slate allows unbiased assessment of every subsystem | -- Pending |
| Redis as caching layer | Reduce token usage by caching embeddings, responses, and RLM chunks | -- Pending |
| Hybrid BM25 + Voyage reranking | MIT paper and Voyage docs recommend combining lexical + semantic | -- Pending |
| sonar-pro for Perplexity | Better quality research results, currently PERPLEXITY_MODEL unset | -- Pending |

---
*Last updated: 2026-04-13 after v2.9 "Nervous System" milestone kickoff*
