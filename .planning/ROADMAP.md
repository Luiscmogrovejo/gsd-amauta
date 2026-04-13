# Roadmap: GSD-Amauta v2.8 "Metabolism"

**Milestone:** v2.8 — Metabolism (Token Optimization)
**Starting phase number:** 20 (v2.7 ended at Phase 19)
**Phases:** 6 (Phase 20..25)
**Requirements:** 23 total (v2.8 scope)
**Granularity:** coarse (per config.json)
**Status:** Defined 2026-04-12 — awaiting `/amauta:plan-phase 20`

**Core value:** Every RPETD phase must see what other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats. The brain synthesizes, not accumulates.

**Body-metaphor sequence:** v2.5 "Smarter Brain" (cognition) → v2.6 "Sight Beyond Sight" (perception) → v2.7 "Steady Hands" (action/tooling) → v2.8 "Metabolism" (efficiency). v2.8 is the milestone where the system becomes lean — doing the same quality work at a fraction of the token cost. The brain thinks. The eyes see. The hands act. The metabolism determines whether that process is cheap or ruinous.

**Goal:** Reduce effective token cost per RPETD cycle by 75-90% through six layered optimizations: structured context handoffs, hash-based staleness detection, caveman-compressed descriptions, prompt prefix caching, semantic cache + tiered routing, and a tech debt sweep clearing the residual v2.7 carry-forward items.

**Research:** `.planning/research/v2.8-token-optimization-research.md` — comprehensive analysis correcting two misidentifications (Attention Residuals paper, caveman repo), mapping 6 optimization layers to GSD-Amauta's architecture.

---

## Hard Constraints (apply to every phase)

1. **Scope ceilings are load-bearing.** Exceeding the declared LOC ceiling without a divergence report is a Phase 13 fingerprint and triggers halt-phase.
2. **Post-13.1:** HARDEN-01 manifest enforcement is active. `files_expected` blocks are mandatory per task.
3. **Post-14:** `gsd-tools plan-to-tasks` auto-registration is mandatory for every phase. Every PLAN.md must have `<story>` and `<task>` XML blocks.
4. **Divergence protocol v1.1.0 active.** Surface mismatches; never silently absorb them.
5. **Backward compatible.** All existing data, configs, and workflows must continue working.
6. **Research-backed.** Every improvement must cite its source (Claude API docs, Google ADK patterns, or prior research brief).
7. **Test coverage maintained.** `node --test tests/` and `pytest` must pass with 0 new failures before each phase is marked complete.

---

## Phases

- [x] **Phase 20: Structured Context Handoffs** — RPETDContext typed object replaces full conversation forwarding; each phase boundary compacts to <= 600 tokens stored in PostgreSQL (HANDOFF-01..05) — COMPLETE 2026-04-12
- [x] **Phase 21: Hash-Based Staleness Detection** — SHA-256 file hashing + git diff selectively refreshes only changed files, skipping unchanged file descriptions (STALE-01..04) — COMPLETE 2026-04-12
- [ ] **Phase 22: Caveman-Compressed Descriptions** — grammar-stripped agent definitions and structured file descriptions deliver >= 40% more facts per 500-char budget (CAVE-01..04)
- [ ] **Phase 23: Prompt Prefix Caching** — all 11 agent prompts restructured for stable prefix / variable suffix split with `cache_control` annotation; prefix stability lint added (CACHE-01..04)
- [ ] **Phase 24: Semantic Cache + Tiered Routing** — pgvector cosine >= 0.90 semantic cache for research calls; config-driven model routing (haiku T/D, sonnet R/P/E) (SEMANTIC-01..03, ROUTE-01..02)
- [ ] **Phase 25: Tech Debt Sweep** — cmdInitPhaseOp ghost fallback eliminated; plan-to-tasks registration for phases >= 20; amauta.cjs HTTP routing fixed; routeExecutor specificity-wins determinism (DEBT-01..04)

---

## Phase Details

### Phase 20: Structured Context Handoffs

**Goal:** RPETD phases stop forwarding full conversation history. Each phase boundary produces a typed RPETDContext object (8 fields, <= 600 tokens) that is stored in PostgreSQL and used as the sole input to the next phase.

**Depends on:** Nothing (v2.7 complete; this is the foundation for Phases 21-24)

**Requirements:** HANDOFF-01, HANDOFF-02, HANDOFF-03, HANDOFF-04, HANDOFF-05

**Success Criteria** (what must be TRUE):
1. `RPETDContext.model_dump()` round-trips all 8 required fields without loss — `SELECT * FROM rpetd_context WHERE task_id = X` returns one row per completed phase.
2. A 15K-token conversation compacts to a single RPETDContext instance (verified by test).
3. The compiled view passed to any downstream phase measures < 600 tokens via `tiktoken cl100k_base` — full conversation history is never forwarded.
4. All 5 phase runners (R, P, E, T, D) execute successfully with RPETDContext as input; `node --test tests/` exits 0 with no regressions.

**Plans:**
3/3 plans complete
- [x] Plan 20-02: prune_messages + compact_conversation + daemon endpoints POST /api/context/compact + GET /api/context/:task_id/:phase (complete 2026-04-12)
- [x] Plan 20-03: Phase runner integration + regression tests (complete 2026-04-12)

### Phase 21: Hash-Based Staleness Detection

**Goal:** Unchanged files are never re-described. SHA-256 hashes stored in `rpetd_context.relevant_files` and `git diff --name-only` drive selective refresh: only stale files incur description cost; the rest are served from cache verbatim.

**Depends on:** Phase 20 (RPETDContext must exist as the hash storage carrier)

**Requirements:** STALE-01, STALE-02, STALE-03, STALE-04

**Success Criteria** (what must be TRUE):
1. `ContextValidator.compute_file_hash(path)` returns a stable SHA-256 hex digest that changes when and only when file content changes (verified by test).
2. `ContextValidator.changed_since(context)` returns the correct changed-files list via `git diff --name-only` with zero additional filesystem reads for unchanged files.
3. In a 10-file test where 2 files changed, `selective_refresh()` regenerates exactly 2 descriptions; the 8 unchanged files retain their prior cached descriptions verbatim.
4. `[STALE] N files refreshed, M cached` log line appears on every phase transition where the staleness hook fires.

**Plans:**
2/2 plans complete
- [x] Plan 21-02: Orchestrator Integration — validate_context + daemon endpoint + file_hashes population + Integration Tests (Wave 2, STALE-04) — COMPLETE 2026-04-12

### Phase 22: Caveman-Compressed Descriptions

**Goal:** File descriptions and agent definitions deliver more signal per character. Structured `pipe-delimited` file descriptions and grammar-stripped agent markdown cut character counts by >= 30% while increasing distinct technical fact density by >= 40%.

**Depends on:** Phase 20 (compressed descriptions are stored in and served from RPETDContext; the Phase 20 storage layer must exist first)

**Requirements:** CAVE-01, CAVE-02, CAVE-03, CAVE-04

**Success Criteria** (what must be TRUE):
1. All 10 sample file descriptions match the regex `^.+\|.deps:.+\|.touches:.+\|.tests:.+\|.+$` (parseable pipe-delimited format).
2. Running the grammar-stripping pass on 5 agent files produces valid markdown with character count reduced >= 30% vs original.
3. BM25 retrieval MRR on compressed descriptions is >= 95% of original MRR across 20 queries; no single query drops more than 2 rank positions.
4. For 10 representative files, compressed 500-char descriptions contain >= 40% more distinct technical facts (identifiers, relationships, constraints) than original 500-char descriptions.

**Plans:**
- [ ] Plan 22-01: Caveman Description Generator + Grammar Stripper + Unit Tests (Wave 1, CAVE-01/02)
- [ ] Plan 22-02: Daemon Wiring + BM25 Benchmark + Fact Density Test + Integration (Wave 2, CAVE-01/03/04)

### Phase 23: Prompt Prefix Caching

**Goal:** Every Claude API call in the RPETD pipeline is structured for prefix caching — stable content precedes variable content, `cache_control: {"type": "ephemeral"}` is annotated, no volatile timestamps pollute the stable prefix, and cache hit/miss metrics are surfaced at `/metrics/cache`.

**Depends on:** Phase 20 (structured handoffs establish stable context shape); Phase 22 (caveman descriptions must be in place so the stable prefix contains compressed, not verbose, descriptions — maximizes cache hit rate)

**Requirements:** CACHE-01, CACHE-02, CACHE-03, CACHE-04

**Success Criteria** (what must be TRUE):
1. All 11 agent prompts have zero variable content before the `cache_control` breakpoint — verified by the audit script for all 11 agents.
2. `grep cache_control` finds annotations at all API call sites; test verifies annotation present in actual request payload.
3. Two sequential prompts for the same agent produce byte-identical prefixes up to the breakpoint (no `datetime.now()`, `time.time()`, or `Date.now()` in prefix construction; tool definitions sorted and frozen).
4. `/metrics/cache` endpoint returns `{hit_rate, total_tokens_saved, cost_savings_estimate}` and counters update correctly after each API call.

**Plans:** TBD

### Phase 24: Semantic Cache + Tiered Routing

**Goal:** Research-chain LLM calls that are semantically equivalent to prior calls return cached responses without an LLM round-trip. T and D phases route to Haiku by default; R, P, E use Sonnet. Both behaviors are config-driven and observable via HTTP endpoints.

**Depends on:** Phase 23 (prefix caching must be live — semantic cache sits on top of a pipeline that is already prefix-cached; stacking in correct order prevents double-spending on cache infra); Phase 20 (RPETDContext provides the source-file hash used to invalidate stale semantic cache entries)

**Requirements:** SEMANTIC-01, SEMANTIC-02, SEMANTIC-03, ROUTE-01, ROUTE-02

**Success Criteria** (what must be TRUE):
1. A paraphrased query ("how to parse JSON in Python" / "Python JSON parsing") returns the cached response without an LLM call — cosine similarity >= 0.90 threshold enforced.
2. Modifying the source file referenced by a cached response flips `semantic_cache.valid = false`; the next query for that context is a cache miss (verified by test).
3. `/cache/stats` returns `{hits, misses, hit_rate, entries, total_tokens_saved, estimated_cost_saved}`; after 5 hits + 3 misses, `hit_rate` = 0.625 exactly.
4. `config.json::model_routing` default `{R: "sonnet", P: "sonnet", E: "sonnet", T: "haiku", D: "haiku"}` is read by the orchestrator; overriding to all-haiku in tests verifies T/D phases use haiku.
5. Compaction LLM call (HANDOFF-02) uses `config.json::model_routing.compaction` (default: "haiku"), not the phase's primary model.

**Plans:** TBD

### Phase 25: Tech Debt Sweep

**Goal:** Four v2.7 carry-forward items are closed: the cmdInitPhaseOp ghost fallback eliminated, plan-to-tasks registration working for phases >= 20, amauta.cjs HTTP routing producing correct output, and routeExecutor selecting agents deterministically by specificity.

**Depends on:** Nothing in v2.8 (these are self-contained fixes independent of the optimization chain). Can run before, during, or after Phases 20-24 — sequenced last here to keep the optimization chain uninterrupted.

**Requirements:** DEBT-01, DEBT-02, DEBT-03, DEBT-04

**Success Criteria** (what must be TRUE):
1. `gsd-tools init discuss-phase 20` from a v2.8 context returns an error (not a v2.3/v2.6 ghost directory) — the Depth-11 scenario replayed by test produces no ghost.
2. After plan execution for Phase 20, `GET /tasks?phase=20` on the daemon returns registered tasks — daemon task list is non-empty for v2.8 phases.
3. `amauta.cjs task list` produces the same output as `gsd-amauta.cjs task list` — the wrapper routes correctly.
4. Given two agents with overlapping file patterns, the agent with the longer (more specific) glob wins deterministically — verified by test with overlapping patterns.

**Plans:** TBD

---

## Phase Dependency Graph

```
Phase 20 (Structured Context Handoffs)
    │   Foundation: RPETDContext storage + compaction
    │
    ├──> Phase 21 (Hash-Based Staleness Detection)
    │        Depends on Phase 20 (hash storage in RPETDContext)
    │
    └──> Phase 22 (Caveman-Compressed Descriptions)
             Depends on Phase 20 (descriptions stored in RPETDContext)
             Can run in parallel with Phase 21
             │
             └──> Phase 23 (Prompt Prefix Caching)
                      Depends on Phase 20 (stable context shape)
                      Depends on Phase 22 (compressed descriptions in stable prefix)
                      │
                      └──> Phase 24 (Semantic Cache + Tiered Routing)
                               Depends on Phase 23 (prefix caching live)
                               Depends on Phase 20 (source-file hashes for invalidation)

Phase 25 (Tech Debt Sweep) — no v2.8 dependencies, runs anytime
```

**Critical path:** 20 → 22 → 23 → 24 (linear spine)
**Parallel opportunity:** Phase 21 can run concurrently with Phase 22 (both depend only on Phase 20)
**Independent:** Phase 25 has no deps on 20-24; sequenced last to avoid interrupting the optimization chain

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 20. Structured Context Handoffs | 3/3 | Complete    | 2026-04-12 |
| 21. Hash-Based Staleness Detection | 1/2 | Complete    | 2026-04-13 |
| 22. Caveman-Compressed Descriptions | 0/TBD | Not started | - |
| 23. Prompt Prefix Caching | 0/TBD | Not started | - |
| 24. Semantic Cache + Tiered Routing | 0/TBD | Not started | - |
| 25. Tech Debt Sweep | 0/TBD | Not started | - |

---

*Roadmap created: 2026-04-12 for v2.8 Metabolism milestone.*
*Primary input: .planning/REQUIREMENTS.md (23 requirements across 6 categories), .planning/research/v2.8-token-optimization-research.md*
*Phase structure: user-defined dependency chain ordering (20 → 21/22 parallel → 23 → 24, 25 anytime)*
*Previous milestone (v2.7 Steady Hands) archived to .planning/milestones/v2.7-ROADMAP.md*
