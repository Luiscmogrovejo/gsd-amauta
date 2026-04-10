# GSD-Amauta — RPETD Intelligence Platform

## What This Is

GSD-Amauta is a quality-enforced AI development harness for Claude Code: persistent PostgreSQL memory with pgvector semantic search, BM25 RLM code context retrieval, 11 specialist agents, a 5-phase RPETD pipeline with external validation, a 5-step research chain, and a Redis L2 caching layer. v2.5 "Smarter Brain" proved the plumbing works (every subsystem audited against MIT RLM/REPL paper, Google agentic patterns, industry best practices, 49/49 requirements shipped, 39.4% Layer 2 token reduction). v2.6 "Sight Beyond Sight" makes the agent prompts that drive the plumbing see more — creative research, task-integrated planning, research-informed execution, QA-grade testing, and a structured learning feedback loop.

## Core Value

Every RPETD phase must *see* what the other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats. The brain synthesizes, not accumulates.

## Current Milestone: v2.7 Steady Hands

**Goal:** Close the loops that the v2.6 audit phase opened. Fix the tooling bugs that caused the most real-world friction during v2.6, harden the audit script that Phase 15 trusted to produce its own verdict, and modernize the schema layer so depths discovered during execution no longer get orphaned from the machine-readable audit trail. The body-metaphor sequence is brain → sight → hands: v2.7 is the milestone where the tooling stops shaking.

**Target upgrades (4 hardening clusters, one per phase):**
- **Phase 16 — Init Resolver Fix (RESOLVE-01..02):** `gsd-tools init` resolver gets milestone-scoped lookup via ROADMAP.md cross-reference instead of first-match-by-numeric-prefix; `cmdInitExecutePhase` gains a `--phase-dir <path>` override. Closes depths 7 + 8 from the v2.6 dogfood ledger (the same bug fired at discuss-phase init, execute-phase init, and tonight's closeout — three strikes).
- **Phase 17 — Audit Script Hardening (AUDIT-01..03):** `verify-v26.cjs::checkVerificationFiles()` prefix-form probe, `verify-v26.cjs::parseNpmFailures()` regex upgrade to match real npm runner output, `15-AUDIT-REPORT.json` schema extension adding `tooling_bugs_observed` category. Closes the three Wave-2 patches that the Phase 15 executor resisted in-scope and routed as findings (depth 9).
- **Phase 18 — Sampling Pool Expansion (SAMPLE-01):** DOGFOOD-01's n=1 sampling pool gets fixed by broadening `sampleCompletedTasks()` to scan RPETD logs instead of SUMMARY text (preferred) or formalizing the sampling floor as a documented limitation. Makes future audits statistically meaningful.
- **Phase 19 — Dynamic Ledger Schema (SCHEMA-01):** Extend `dogfood_ledger_depths_captured` from a static Wave-1-authoring-time list to a runtime filesystem scan of `memory/*dogfood*.md` entries, so future depths 10+ are not orphaned from the JSON the way depths 8 + 9 were in v2.6. The meta-finding from the v2.6 ledger's Limitations section.

Primary input for v2.7: `docs/v2.6-dogfood-ledger.md` § "Routed follow-ups (Phase 16 / v2.7)" — 7 items, clustered by the above phase plan.

v2.7 is a **hardening milestone**, not a mandate-expansion milestone. No new RPETD intelligence upgrades, no new kill switches, no new D-phase formats — the bar for v2.7 is "the tooling the operator and agents relied on during v2.6 stops producing recurring divergence events." Success is measurable by: depth-7+8 class bugs never firing again across milestone boundaries, Wave-2-style resisted-script-patches dropping to zero in the next audit phase, and audit JSON becoming the canonical machine-readable record of dogfood depths (no more schema orphans).

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

#### v2.6 Sight Beyond Sight — RPETD Intelligence Upgrade (in progress)
See `.planning/REQUIREMENTS.md` for scoped REQ-IDs.

#### Legacy (archive after v2.6 closes)
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
*Last updated: 2026-04-09 after v2.6 "Sight Beyond Sight" milestone kickoff*
