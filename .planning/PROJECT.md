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

## Shipped: v3.3 "The Dialect" (2026-05-15)

**5 phases, 20 plans, 22/22 requirements, 214 passing tests, 87 commits.** Federation members start speaking directly to each other (A2A protocol on top of the blackboard), close real debt accumulated across v2.9 → v3.2, extend the module system into a signed marketplace, and ship the whole thing to the public via npm.

**Shipped:**
1. Stability & Hardening (foundation) — coverage ratchet, `rlm_restarts_lifetime`, Redis watchdog tests, PATH collision detection, LLM behavioral test quarantine, `gsd-amauta doctor`
2. A2A Protocol Foundation — `a2a_messages` migration 024, capability registry, send/await/respond client, exponential-backoff retry with 4 frozen error tokens
3. A2A Orchestration — Valkey-backed per-pair circuit breakers, recursive-CTE conversation threading, `/a2a/exchanges` audit endpoint, `gsd-amauta a2a tail`
4. Module Marketplace — signed registry index (sha256 + ed25519), 3-tier ranked search CLI, fail-closed trust store, 3-scheme URL installer (https/github/registry) with atomic verify-before-install
5. Public Launch (capstone) — external README + HISTORY.md, MIT LICENSE corrected, CONTRIBUTING/SECURITY/NOTICE, npm publish workflow with OIDC provenance, `bin/init.cjs` UX polish, `docs/QUICKSTART.md` walkthrough

**Body metaphor sequence:** brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → birth (v3.0) → gathering (v3.1) → federation (v3.2) → **dialect (v3.3)**

## Current Milestone: v3.4 "The Mirror"

**Goal:** The harness sees itself and fixes how it actually works. v3.4 is NOT a feature-surface race against BMAD-METHOD — it's an effectiveness milestone: stop phases drifting from the files they should touch, give executors real reach into sources of truth (curl/ssh/live services), raise coding quality with role-shaped agent personas, instrument real usage with opt-in telemetry, and reposition the project around its actual differentiator (the executor-discipline layer).

**Strategic context (locked decision):** BMAD-METHOD (47.2k★, v6.6.0, 143 contributors) ships overlapping surface — modules, party mode, agent compilation, scale-adaptive intelligence, help system, npx install. Competing on feature breadth is a losing bet against a 5k-fork community. gsd-amauta's asymmetric differentiator is **delivery discipline**: RPETD enforcement, validator-gated phase closes, the divergence protocol, manifest-violation detection, sharded-workflow HALT enforcement. v3.4 makes that the headline and fixes the harness's own coding effectiveness rather than chasing parity.

**Target features (foundation-first ordering — fixing drift before building on it):**
- **Phase-File Fidelity (FOUNDATION):** stricter planner manifests (reject broad `**/*` globs / missing modify-create-delete keys), route-executor↔planner agreement gate, RLM/memory freshness re-index, validator manifest-fidelity gate, phase-scope-width cap. Locking v3.4 on top of drifting phases is the test-runner trap — this comes first.
- **Sources of Truth / Tool Reach:** declared capability catalog (curl endpoints, ssh operator-approved hosts, live PG/Redis/k3s state) with auth + security_class; executor tool-allowlist audit + expansion per the Phase 43 capability schema; live-state read tools.
- **Coding Quality (role personas, pattern from BMAD):** role-shaped agent personas (Senior Backend Engineer, Architect, …) as a new agent class alongside file-extension executors — role-framed prompting, same model; router upgrade to select by task role/intent not just extension.
- **Telemetry (see real usage):** opt-in framework (first-run consent, local default, `--enable-telemetry`, transparent payload), event taxonomy (phase start/complete, validator verdicts, divergence, escalation, error classes), offline-capable buffered ingest (portability constraint).
- **Positioning (discipline layer as headline):** README repositioning, public RPETD compliance scorecard (per-task: phases ran / validator verdict / divergence count / manifest fidelity), honest BMAD comparison doc.
- **Post-launch Hardening:** triage + close GitHub issues from the post-v3.3.0-publish window, `npx gsd-amauta init` + doctor UX hardening, doc gaps from real users, performance debt on slow paths. (Gated on v3.3.0 npm publish + a real-usage data window.)

**Body metaphor sequence:** brain → sight → hands → metabolism → nervous system → birth → gathering → federation → dialect → **mirror (v3.4)**. The Mirror: the harness sees itself — both via telemetry and via positioning that names what it actually is — and fixes how it works.

## Competitive Landscape

**BMAD-METHOD** (github.com/bmad-code-org/BMAD-METHOD, MIT, 47.2k★, v6.6.0) — adjacent project, overlapping surface (scale-adaptive intelligence, skills, party/collaboration mode, agent compilation, help system, npx installer, public npm release). Recorded here so future milestones do NOT re-litigate the positioning question or attempt feature-parity races. gsd-amauta is a *different category*: BMAD is an agile-collaboration framework; gsd-amauta is harness-enforced delivery discipline (RPETD / validator gates / divergence protocol / manifest enforcement / sharded HALT). Steal *patterns* (role personas), never integrate codebases, never compete on adoption.

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

#### v3.3 The Dialect — Shipped 2026-05-15 (22/22 requirements)
- ✓ **STAB-01..06**: Coverage ratchet, Redis watchdog self-heal tests, `rlm_restarts_lifetime` cumulative counter, PATH collision detection, LLM behavioral test quarantine, `gsd-amauta doctor` — v3.3
- ✓ **A2A-01..04**: `a2a_messages` migration 024, capability registry as 7th LOCKED AgentDefinition field, send/await/respond client, exponential-backoff retry with 4 frozen error tokens — v3.3
- ✓ **A2A-05..07**: Valkey CLOSED→OPEN→HALF_OPEN per-pair circuit breakers (SETNX probe lock + fail-open), recursive-CTE `get_thread()`, `GET /a2a/exchanges` daemon audit endpoint + `gsd-amauta a2a tail` — v3.3
- ✓ **MARK-01..04**: RegistryIndex Pydantic schema + ed25519 signer, 3-tier ranked `module search` CLI, fail-closed trust store at `~/.gsd-amauta/trusted-keys/`, 3-scheme URL installer (https/github/registry) with atomic verify-before-install — v3.3
- ✓ **PUB-01..05**: README rewrite (1855→151 lines) + HISTORY.md, LICENSE attribution fix (Luis Carlos Mogrovejo de Piérola, 2026), CONTRIBUTING + SECURITY + NOTICE, `release.yml` npm publish with OIDC provenance, `bin/init.cjs` UX polish, `docs/QUICKSTART.md` walkthrough — v3.3

### Active — v3.4 "The Mirror"

#### Phase-File Fidelity (FOUNDATION — must precede all other v3.4 tracks)
- [ ] **FIDEL-01**: Planner rejects plans whose `files_expected` uses broad globs (`**/*`) or omits any of modify/create/delete keys — concrete file lists only
- [ ] **FIDEL-02**: `route-executor` ↔ planner agreement gate — `agent_assignment_conflict` blocks `plan-to-tasks` registration with an actionable diff (no silent absorption)
- [ ] **FIDEL-03**: RLM/memory freshness — re-index after each milestone close; staleness detector flags executor citations to code that no longer exists
- [ ] **FIDEL-04**: Validator manifest-fidelity gate — fail tasks where `files_actual` ≠ `files_expected`; `manifest_violation` cannot be closed without atomization
- [ ] **FIDEL-05**: Phase-scope-width cap — Phase 42 scale-adaptive scoring flags phases spanning >N unrelated subsystems; verify it fires + add a hard ceiling

#### Sources of Truth / Tool Reach
- [ ] **TOOL-01**: Capability catalog — declared registry of systems amauta can reach (curl endpoints, ssh operator-approved hosts, PG/Redis/k3s live state) with auth method + `security_class`, surfaced to executors
- [ ] **TOOL-02**: Executor tool-allowlist audit + expansion — each `gsd-executor-*` gets explicit operator-approved bash/ssh/curl capability per the Phase 43 capability schema
- [ ] **TOOL-03**: Live-state read tools — ssh to operator-approved hosts + curl arbitrary endpoints + live PG/Redis/k3s state queries available to executors with audit trail

#### Coding Quality (role personas)
- [ ] **PERS-01**: Role-shaped agent personas (Senior Backend Engineer, Architect, …) as a new agent class alongside file-extension executors — role-framed prompting, same model
- [ ] **PERS-02**: Router upgrade — `plan-to-tasks` selects persona by task role/intent, not just file extension; file-extension routing becomes a fallback

#### Telemetry
- [ ] **TEL-01**: Opt-in telemetry framework — first-run consent flow, local-storage default, `--enable-telemetry` flag, transparent payload disclosure
- [ ] **TEL-02**: Event taxonomy — phase start/complete, validator verdicts, divergence reports, escalation fires, party-mode sessions, error classes
- [ ] **TEL-03**: Offline-capable buffered ingest — self-hosted endpoint or vendor chosen once; buffering required so the portability constraint holds (no hard dependency on a live service)

#### Positioning
- [ ] **POS-01**: README repositioning — lead with executor discipline (RPETD enforcement, validator gates, divergence protocol, manifest-violation detection); name BMAD as adjacent-but-different category
- [ ] **POS-02**: Public RPETD compliance scorecard — per-task report surfacing which RPETD phases ran, validator verdict, divergence count, manifest fidelity
- [ ] **POS-03**: Honest gsd-amauta vs BMAD comparison doc — where they overlap, where they differ, helps users self-select

#### Post-launch Hardening (gated on v3.3.0 npm publish + real-usage window)
- [ ] **HARD-01**: Triage and close GitHub issues opened in the post-v3.3.0-publish window
- [ ] **HARD-02**: `npx gsd-amauta init` + `gsd-amauta doctor` UX hardening — error messages, install-failure recovery
- [ ] **HARD-03**: Documentation gaps surfaced by real users — README, getting-started, troubleshooting
- [ ] **HARD-04**: Performance debt — slow paths users complain about (likely module install, party-mode startup, agent compile)

### Deferred to v3.5+

- A2A-09 (streaming responses) — revisit once telemetry shows whether A2A is actually used
- A2A-10 (cross-process / cross-host A2A) — same gate as A2A-09
- HOST-01..03 (hosted SaaS registry) — portability constraint conflict + BMAD installed base make this a weak bet; v3.5+ or never
- Module marketplace expansion — v3.6+ only if telemetry shows a module ecosystem forming

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
*Last updated: 2026-05-15 after v3.3 "The Dialect" shipped + v3.4 "The Mirror" scoped — strategic pivot away from A2A/registry feature-surface (BMAD prior art) toward harness effectiveness: phase-file fidelity, tool reach, role personas, telemetry, discipline-layer positioning*
