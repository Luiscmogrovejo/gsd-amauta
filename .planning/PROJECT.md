# GSD-Amauta — RPETD Intelligence Platform

## What This Is

GSD-Amauta is a portable, quality-enforced AI development harness for Claude Code — and any MCP-compatible AI coding agent. v3.0 "The Birth" shipped 17 agents with standardized format, specialized capabilities, blackboard communication, and lifecycle management (820 assertions, 55 requirements). v3.1 "The Gathering" grafts the best patterns from BMAD-METHOD (scale-adaptive intelligence, skills architecture, sharded workflows, cross-IDE installer) onto Amauta's infrastructure advantage (PG memory, hybrid retrieval, blackboard, security pipeline, agent lifecycle). BMAD is wide but stateless. Amauta is deep and persistent. The Gathering makes it both.

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

## Shipped: v3.1 "The Gathering" (2026-05-13)

**7 phases, 18 plans, ~536 tests, 25 requirements.** BMAD-METHOD patterns grafted onto Amauta's PG/retrieval infrastructure.

**Shipped:**
1. Sharded Workflows — StepHandoff persistence + 3-layer HALT, resumable micro-steps
2. Scale-Adaptive Intelligence — Continuous complexity classifier (0-100) + PG-backed learning
3. Skills Architecture — SKILL.md schema + cross-IDE compiler + PG invocation memory + Semgrep enforcement
4. Cross-IDE Installer — `npx gsd-amauta init` 7-step flow + IDE auto-detection + legacy migration
5. Intelligent Help Routing — `gsd-tools bearings` deterministic 4-source + 4 pattern stats
6. Standalone MCP Server — `services/amauta-mcp.py` daemon-independent + 6 tools + 3 resources
7. Agent Dynamic Hydration — `gsd-tools agent-hydrate` + frozen `## Current context` injection

## Shipped: v3.2 "The Federation" (2026-05-14)

**6 phases, 24 plans, ~336 tests, 22 requirements.** Modules + party mode + agent compilation + v3.1 carry-forward polish.

**Shipped:**
1. Module System Foundation — `ModuleManifest` Pydantic + semver resolver + 8-field locked frontmatter
2. Module CLI + Lifecycle — `gsd-amauta module install/uninstall/upgrade` with 22 frozen step names
3. Party Mode Foundation — `party_session` blackboard binding + 5 frozen state transitions
4. Party Mode Decisions + Operator CLI — decision records (propose/agree/dissent/block) + `status/inspect/kill`
5. Agent Compilation — `agent-compiler.cjs` symmetric with Phase 43 skill compiler, 17/17 byte-match LOCK
6. v3.1 Carry-Forwards — skill input/output schemas, installer upgrade/uninstall, MCP wrappers, hydration auto-invoke

**Body metaphor sequence:** brain → sight → hands → metabolism → nervous system → birth → gathering → **federation (v3.2)**

## Current Milestone: v3.3 "The Dialect"

**Goal:** Federation members start speaking directly to each other (A2A protocol on top of the blackboard), close real debt accumulated across v2.9 → v3.2, extend the module system into a marketplace, and ship the whole thing to the public via npm.

**Target features:**
- Stability & Hardening (foundation): close v2.9 → v3.2 carry-forwards (Redis self-heal, coverage bootstrap, PATH collision, observability gaps, LLM behavioral test flakiness, doctor command) — don't ship debt to public
- A2A Dialect: direct agent-to-agent protocol layered on existing blackboard — correlation IDs, capability negotiation, timeout/retry, circuit breakers per agent-pair, conversation threading, full operator audit trail
- Module Marketplace: extend Phase 48-49 module system — registry index, `gsd-amauta module search`, signed manifests (sha256 + maintainer key), install from URL/GitHub
- Public Launch (capstone): npm publish workflow, public README rewrite, CONTRIBUTING + LICENSE audit, `npx gsd-amauta init` UX polish, demo walkthrough docs

**Body metaphor sequence:** brain → sight → hands → metabolism → nervous system → birth → gathering → federation → **dialect (v3.3)**. The Dialect lets members speak directly to each other — then goes public.

**Body metaphor sequence:** brain → sight → hands → metabolism → nervous system → birth → gathering → **federation (v3.2)**. The Federation binds individuals into operable, installable, cooperating units.

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

#### v3.2 The Federation — Shipped 2026-05-14 (22/22 requirements)
- ✓ **MOD-01..04**: Module system foundation, semver resolver, CLI lifecycle, manifest validation — v3.2
- ✓ **PARTY-01..04**: Multi-agent sessions, persistent memory, decision records, operator CLI — v3.2
- ✓ **COMPILE-01..04**: YAML agent definitions → per-IDE Markdown with optional hydration injection — v3.2
- ✓ **POLISH-01..05**: Skill input/output schemas, installer upgrade/uninstall, MCP wrappers, hydration auto-invoke — v3.2

### Active — v3.3 "The Dialect"

#### Stability & Hardening (foundation)
- [ ] **STAB-01**: Coverage baseline bootstrap — `.coverage_threshold.json` populated with real values via `npx c8`
- [ ] **STAB-02**: Redis watchdog self-heal activation + counter-reset uptime-window live test (closes 2026-05-11 incident class)
- [ ] **STAB-03**: `rlm_restarts_lifetime` cumulative counter on health endpoint (observability gap)
- [ ] **STAB-04**: PATH collision fix — bare `amauta` resolves to plugin not pipx package
- [ ] **STAB-05**: LLM behavioral test flakiness — quarantine or determinize `tests/13.1-divergence-protocol.integration.test.cjs`
- [ ] **STAB-06**: `gsd-amauta doctor` command — diagnose install (paths, daemon, DB, keys)

#### A2A Dialect (direct agent-to-agent protocol)
- [ ] **A2A-01**: `a2a_messages` PG migration — correlation_id, capability, request/response, parent_correlation
- [ ] **A2A-02**: Capability negotiation schema — each agent publishes what it can do, queryable by other agents
- [ ] **A2A-03**: Direct message send/receive between agents atop existing messages table (operator-mediated audit retained)
- [ ] **A2A-04**: Timeout + retry semantics with structured error vocabulary
- [ ] **A2A-05**: Circuit breaker per agent-pair (3-failure / 60s — mirrors Phase 28 Valkey breaker pattern)
- [ ] **A2A-06**: Conversation threading + parent_correlation chains (multi-turn dialogue audit trail)
- [ ] **A2A-07**: Operator audit endpoint — every A2A exchange viewable via daemon `/a2a/exchanges`

#### Module Marketplace
- [ ] **MARK-01**: Static JSON registry index file format (versioned, signed by index maintainer)
- [ ] **MARK-02**: `gsd-amauta module search <query>` — queries local or remote registry index
- [ ] **MARK-03**: Manifest signing — sha256 of module + maintainer pubkey verification at install
- [ ] **MARK-04**: Install from URL — `gsd-amauta module install https://...` or `github:owner/repo@tag`

#### Public Launch (capstone)
- [ ] **PUB-01**: Public README rewrite — audience is a developer evaluating an AI dev harness, not internal milestone log
- [ ] **PUB-02**: CONTRIBUTING.md + LICENSE audit + SECURITY.md refresh
- [ ] **PUB-03**: `npm publish` workflow — `npm publish` from CI on semver tag push, with provenance
- [ ] **PUB-04**: `npx gsd-amauta init` UX polish — error messages, progress display, prompts (consumes Phase 44 + 53)
- [ ] **PUB-05**: Demo walkthrough docs — first-task end-to-end with screenshots, install → first phase ship

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
- Hosted module registry service — v3.3 ships static JSON index + URL install; SaaS registry deferred to v3.4+

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
*Last updated: 2026-05-14 after v3.2 "The Federation" shipped; v3.3 "The Dialect" milestone defined (Phases 54-58)*
