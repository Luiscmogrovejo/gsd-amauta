# GSD-Amauta — RPETD Intelligence Platform

## What This Is

GSD-Amauta is a quality-enforced AI development harness for Claude Code: persistent PostgreSQL memory with pgvector semantic search, BM25 RLM code context retrieval, 11 specialist agents, a 5-phase RPETD pipeline with external validation, a 5-step research chain, and a Redis L2 caching layer. v2.5 "Smarter Brain" proved the plumbing works (every subsystem audited against MIT RLM/REPL paper, Google agentic patterns, industry best practices, 49/49 requirements shipped, 39.4% Layer 2 token reduction). v2.6 "Sight Beyond Sight" makes the agent prompts that drive the plumbing see more — creative research, task-integrated planning, research-informed execution, QA-grade testing, and a structured learning feedback loop.

## Core Value

Every RPETD phase must *see* what the other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats. The brain synthesizes, not accumulates.

## Current Milestone: v2.8 Token Optimization

**Shipped:** v2.7 "Steady Hands" (2026-04-12) — 4 phases, 8 plans, 21 tasks, 47 tests

**Goal:** Reduce effective token cost per RPETD cycle by 75-90% through prompt prefix caching, structured context handoffs, hash-based staleness detection, caveman-style description compression, semantic caching, and tiered model routing. The body-metaphor sequence: brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8). v2.8 is the milestone where the system becomes lean — doing the same quality work at a fraction of the token cost.

**Research:** `.planning/research/v2.8-token-optimization-research.md` — comprehensive analysis correcting two misidentifications (Attention Residuals paper, caveman repo), mapping 6 optimization layers to GSD-Amauta's architecture.

**Target upgrades (6 optimization layers, ordered by impact-to-effort ratio):**
1. **Prompt prefix caching** — Restructure agent prompts for Claude API cache hits (90% cost reduction on repeated prefixes)
2. **Structured context handoffs** — RPETDContext typed object (~400 tokens) replaces full forwarding (~10K+) between phases
3. **Hash-based staleness detection** — SHA-256 + git diff; skip unchanged files (60-80% typical)
4. **Caveman-compressed descriptions** — 40-60% more info per 500-char budget via grammar stripping
5. **Semantic cache layer** — pgvector cosine >= 0.90 for cached LLM responses (up to 68% fewer calls)
6. **Tiered model routing** — Haiku for T/D phases ($1/MTok), Sonnet for R/P/E

**Also addresses v2.7 tech debt:** cmdInitPhaseOp residual ghost, plan-to-tasks registration gap, amauta.cjs wrapper.

**Primary input:** User-provided research brief (arXiv:2603.15031 Attention Residuals analysis + JuliusBrussee/caveman evaluation + Claude API caching docs + Google ADK/Microsoft Semantic Kernel/OpenAI Agents SDK context handoff patterns)

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

### Active

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
*Last updated: 2026-04-12 after v2.8 "Metabolism" milestone kickoff*
