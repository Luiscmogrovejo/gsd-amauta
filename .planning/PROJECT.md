# GSD-Amauta — RPETD Intelligence Platform

## What This Is

GSD-Amauta is a portable, quality-enforced AI development harness for Claude Code — and any MCP-compatible AI coding agent. v3.0 "The Birth" delivered a 17-agent ecosystem with standardized format, specialized capabilities, blackboard inter-agent communication, lifecycle management, and embedded engineering standards. The system can now measure itself (agent_metrics), detect degradation (50-test canary suite with McNemar's test), version its components (SemVer + changelogs), catch tampering (tool integrity SHA-256), and communicate between agents (blackboard PG tables). 820 assertions, 0 failures, 55 requirements shipped.

## Core Value

Every RPETD phase must *see* what the other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats. The brain synthesizes, not accumulates.

## Shipped: v3.0 "The Birth" (2026-04-14)

**10 phases, 24 plans, 55 requirements, 820 assertions.** 17 agents with standardized format, specialized capabilities, and lifecycle management.

**Shipped:**
1. Format Standard — 17 agents on standardized 10-section format with shared security rules and engineering standards
2. Frontend Rebuild — Progressive 4-pass pipeline, React 19 + TypeScript + Tailwind 4 + shadcn/ui
3. Testing Pipeline — gsd-tester + gsd-qa agents, CoverUp, Stryker, Pact contracts
4. Security Pipeline — gsd-security agent, Semgrep SAST, Gitleaks, supply chain rules
5. Code Review Agent — gsd-reviewer, 10 detection rules, structured findings
6. Data Engineering Agent — gsd-executor-data, expand-and-contract migrations, static query analysis
7. Architect Agent — gsd-architect, ADR management, API review, design-level N+1 detection
8. Blackboard Communication — agent_findings + agent_messages PG tables, operator supervision, conflict resolution
9. Agent Lifecycle — SemVer versioning, agent_metrics, canary suite, eval framework, tool integrity
10. Engineering Standards — Git workflow, error handling, documentation, configuration, logging embedded in all agents

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

#### v2.9 Nervous System — Shipped 2026-04-13 (21/26 requirements; 5 deferred)
- ✓ **INFRA-01..04**: Valkey 8.x, pgvector 0.8.2, ParadeDB pg_search, tree-sitter parsers — v2.9
- ✓ **RLM-01..06**: AST-aware chunking, ParadeDB BM25, Voyage Code 3 embeddings, RRF hybrid search, Jina reranking, NetworkX dependency graph — v2.9
- ✓ **BEHAV-01..06**: AGENTS.md discovery, circuit breakers, Reflexion memory, lint guardrails, feature-list lifecycle, get-bearings ritual — v2.9
- ✓ **MCP-01..05**: amauta-mcp.py (stdio+SSE), search-code, memory, RPETD context resources, research chain — v2.9

#### v3.0 The Birth — Shipped 2026-04-14 (55/55 requirements)
- ✓ **FORMAT-01..07**: Standardized 10-section format for all agents — v3.0
- ✓ **FRONT-01..07**: Frontend rebuild with progressive pipeline, React 19 + Tailwind 4 + shadcn/ui — v3.0
- ✓ **TEST-01..08**: Testing pipeline (gsd-tester + gsd-qa), CoverUp, Stryker, Pact — v3.0
- ✓ **SEC-01..06**: Security pipeline (gsd-security), Semgrep, Gitleaks, supply chain — v3.0
- ✓ **REVIEW-01..04**: Code review agent (gsd-reviewer), 10 detection rules — v3.0
- ✓ **DATA-01..04**: Data engineering (gsd-executor-data), expand-and-contract, query analysis — v3.0
- ✓ **ARCH-01..03**: Architect agent (gsd-architect), ADRs, API review, N+1 detection — v3.0
- ✓ **COMM-01..05**: Blackboard communication, PG tables, operator supervision, conflict resolution — v3.0
- ✓ **LIFE-01..05**: Agent lifecycle, SemVer, canary suite, eval framework, tool integrity — v3.0
- ✓ **ENG-01..05**: Engineering standards embedded in all agents — v3.0

### Active

(No active requirements — v3.1 planning not yet started)

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

- Web UI — CLI-only
- Changing database engine — PostgreSQL + pgvector stays
- gVisor K3s sandbox — deferred indefinitely (not portable)
- A2A protocol — v3.2+ scope

## Context

- v3.0 milestone shipped (10 phases, 24 plans, 820 assertions, 55 requirements)
- 17 agents in standardized 10-section format with shared security rules and engineering standards
- Daemon running on :18799 with findings/messages/metrics/handoff endpoints
- 16 PG migrations (001-016), Valkey cache, pgvector 0.8.2
- 50-test canary suite with McNemar's degradation detection
- Eval framework: 15 scenarios across 3 agents, code-based graders
- Tool integrity SHA-256 checking at startup

## Constraints

- **Self-audit**: Use the tool's own features (RPETD, research chain, memory) to audit itself
- **No new runtimes**: Python + Node.js only, add Redis as service not runtime
- **Backward compatible**: All existing data, configs, and workflows must continue working
- **Research-backed**: Every improvement must cite its source (MIT paper, Google patterns, or best practice)
- **Test coverage**: Maintain or improve current test coverage

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 17-agent ecosystem with standardized format | Consistency enables cross-cutting updates and behavioral testing | ✓ Good — Phase 40 + 38 proved the pattern |
| Blackboard over direct agent calls | PG-backed shared state is simpler and more debuggable than direct A2A | ✓ Good — operator supervision model works |
| Behavioral rules over code enforcement | Agent .md prompts are the enforcement mechanism, not linters | ✓ Good — 820 assertions verify rules exist |
| Canary suite with McNemar's test | Statistical degradation detection after model updates | ✓ Good — 50 deterministic tests, <5 min |
| Code-based graders only in v3.0 | Keeps portable (no API key for evals); model-based = v3.1 | ✓ Good — 15/15 scenarios pass |

---
*Last updated: 2026-04-14 after v3.0 "The Birth" milestone completion*
