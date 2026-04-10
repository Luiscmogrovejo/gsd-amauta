# Phase 13: R-Phase Creative Research (Narrowed) - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Add creative query variants (lateral, inversion, anti-pattern, cross-domain, constraint-removal) to `gsd-research.cjs` behind a `--creative` flag, auto-gated by task type. Research/exploration/architecture-review tasks get 1 original + 3 variant queries (4 total); implementation/bug-fix/documentation tasks stay on the v2.5 conservative single-query cascade. Kill switch: `GSD_R_CREATIVE=off`.

</domain>

<decisions>
## Implementation Decisions

### 1. Query Variant Strategy (Areas 1, 17, 36)
- **Fixed 3 per query from 5 techniques**, selected by query domain — not random rotation.
- **Always include:** inversion ("why does X fail", "common mistakes in X") — failure patterns are universally valuable.
- **Always include:** anti-pattern ("X anti-patterns", "X worst practices") — negative constraints reveal more than positive examples.
- **Third slot rotates by domain:**
  - Architecture/design tasks → lateral analogy ("what natural systems solve X")
  - Implementation tasks → cross-domain transfer ("how does Kafka vs RabbitMQ solve X")
  - Optimization tasks → constraint removal ("if unlimited compute, how solve X")
- **4 total queries** when creative is on: 1 original + 3 variants. Each variant is a SEPARATE query to the research cascade.
- **Variant query cap: 8 words max.** Enforced by gsd-research.cjs — truncate to 8 words with warning if template output exceeds cap. Long queries produce worse results.
- **Templates in `get-shit-done/references/creative-research.md`** — researcher agent Reads at R-phase start. Same runtime Read pattern as qa-checklist.md (Phase 12).
- **Always English for Perplexity queries** regardless of original query language. Note `metadata.original_language` if detected. Perplexity's English corpus is vastly larger.

### 2. Task-Type Gating Rules (Areas 2, 25, 26, 44)
- **Explicit `--task-type` flag** on gsd-research.cjs: `gsd-research search "query" --creative --task-type research`.
- **Values:** research, exploration, architecture-review, implementation, bug-fix, documentation.
- **Creative auto-triggers for:** research, exploration, architecture-review.
- **Creative suppressed for:** implementation, bug-fix, documentation (JetBrains Junie 3x rollback rate).
- **No --task-type provided → creative does NOT fire** even with `--creative` flag. Must be explicit. No guessing.
- **Unknown task type → treated as implementation** (conservative default). Log warning: `Unknown task type '<value>', defaulting to implementation — creative suppressed.`
- **Researcher agent infers from task metadata** — auto-enables `--creative` when task matches creative-eligible set. BUT `--creative` flag ALSO works independently for manual/ad-hoc research outside task context. Both paths valid.
- **New `metadata.execution_type` field** in existing metadata jsonb. No schema change. Set at routing time by operator.
- **Operator classification keywords** (~5 lines added to operator prompt):
  - "research", "investigate", "study", "analyze", "compare" → research
  - "explore", "prototype", "spike", "POC" → exploration
  - "design", "architect", "restructure", "refactor" → architecture-review
  - "implement", "build", "create", "add", "wire" → implementation
  - "fix", "resolve", "patch" + BG-prefix → bug-fix
  - "document", "write docs", "update README" → documentation
  - **Ambiguous cases** (e.g., "refactor auth module"): default to implementation. The operator can always override with explicit type. Conservative default is safe.

### 3. Dedup & Result Merging (Areas 3, 20, 27, 35)
- **Port Jaccard to JS** — ~15-line function in gsd-research.cjs. Existing `normalizeTags()` in gsd-memory.cjs shows word tokenization pattern.
- **Dedup threshold:** 0.7 Jaccard similarity (same as memory dedup).
- **Creative variant result cap: top-3 per variant.** Original gets top-10 (existing default). After dedup: max ~19 unique results. 40 raw results is waste; R-phase only summarizes top insights.
- **Source tagging:** Each result gets `source: "original" | "inversion" | "anti-pattern" | "lateral" | "cross-domain" | "constraint-removal"`. Feeds into R-phase RPETD content.
- **Creative results tagged with `metadata.creative_source`** — same value as source tag ("inversion", "anti-pattern", "lateral"). Uses existing `web_search_result` source type. Phase 15 queries by `metadata.creative_source` to measure creative ROI.
- **No-novelty log:** If all 3 variants return >0.7 similar to original, log: `Creative variants produced no novel results — domain well-covered by direct search.` Informational, not a failure.
- **Enrichment dedup window applies to creative variants.** If variant 1 and variant 3 return the same RLM chunk, the 300-second dedup window suppresses the duplicate. Creative variants add entries to the window so they don't collide with each other.
- **Pre-store embedding dedup (0.95 cosine) applies normally.** If creative result is 0.95 similar to existing memory entry, the existing entry is sufficient. Creative value is finding what memory doesn't have.

### 4. Token Budget Monitoring (Areas 4, 11, 34, 41)
- **Per-variant logging to stderr:** `[creative] variant=inversion query="rate limiting failures" tokens_used=847 model=sonar cached=false`
- **Cumulative cost tracking:** Log ratio at end: `[creative] cost_delta: +14.2% (creative: 3420 tokens, baseline: 2995 tokens)`
- **<20% delta measured over batch, not per-query.** Phase 15 dogfood verifies aggregate over 10 comparable tasks.
- **Creative variants ALWAYS use sonar** (cheaper model). Only original query gets sonar-pro routing via `selectPerplexityModel()`.
- **Perplexity cache (6h TTL) applies to creative variants.** Cost amortizes over time.
- **Creative variant Perplexity cap: `max_tokens: 500`, output cap 750 chars** (vs original's 1000/1500). Halves per-variant cost.
- **Creative Perplexity delay: 500ms** between creative variant calls (vs 1000ms for original with sonar-pro). Sonar is faster. Worst case: 1000ms (original) + 3x500ms (variants) = 2500ms total. Acceptable for research tasks.
- **Structured creative search log:** Append-only JSON at `data/creative-research-log.json`. ~1KB per creative search. Schema: `{ timestamp, task_id, original_query, variants: [{type, query, results_count, source_hits: {memory, skb, perplexity}, tokens_used}] }`. Phase 15 reads this for cost delta analysis and creative ROI. Negligible disk cost, high analysis value.

### 5. Creative Cascade Configuration (Gaps 18, 21, 22)
- **Each variant independently runs cascade** with same `GSD_RESEARCH_MIN_RESULTS` (default 2). If inversion finds 3 results in memory, skip Perplexity for that variant. Saves tokens.
- **Creative variants use reduced cascade: memory → SKB → Perplexity only (3 steps).** Skip Context7 (lateral queries won't match library docs). Skip WebFetch (too expensive for supplementary queries). Original query gets full 5-step cascade.
- **Sequential execution** with existing delay pattern. No Promise.all complexity. Most variants resolve in memory/SKB anyway. Simplicity > speed.

### 6. Output Formatting (Gaps 19, 30, 33)
- **R-phase RPETD content: grouped by variant.** Original results first, then inversion, anti-pattern, lateral — each labeled. Clearer for human review. Downstream phases can grep by source type.
- **JSON output (`--json --creative`): nested structure.** `{ original: [...], variants: { inversion: [...], anti_pattern: [...], lateral: [...] } }`. Source field still present on each result for grep-ability. Cleaner for programmatic consumers.
- **Human-readable output: `[creative:inversion]` prefix.** Distinguishes creative variants from original results and from provider names. `[creative:]` prefix is greppable.

### 7. R-Phase Content Impact (Gap 24)
- **Keep R-phase at 500 char soft cap** when creative is active. Each variant gets ~125 chars. Force conciseness. Creative results are supplementary — conciseness is a feature.

### 8. Creative Reference File (Gaps 5, 23, 45)
- **Include per-domain example pairs** — 5 techniques with good/bad query examples per domain. Keep under 100 lines.
- **Top 6 domains covered:** database, api, security, frontend, backend, infrastructure. The rest (testing, authentication, caching, deployment, monitoring, performance) are rare enough that generic templates suffice.
- **No version field.** Edit and bump like tag-rules.json. Git history is sufficient versioning.

### 9. Memory & Storage (Gaps 6, 7, 12)
- **Memory-first applies to creative variants.** Each variant runs through the same (reduced) cascade. Memory queries are local/in-process (~0 cost). No extra wiring — variant just uses a different query string.
- **No separate source type for creative results.** Same storage mechanism as existing research chain. Tag with `metadata.creative_source` for Phase 15 tracking, but use standard `web_search_result` source.
- **APPLIED_LEARNING citations follow existing pattern.** If researcher finds relevant memory entry during creative search, emit `APPLIED_LEARNING: mem-XXXX — reason`. No new mechanism.

### 10. Kill Switch & Error Handling (Gaps 15, 31)
- **Warn and proceed without creative.** `GSD_R_CREATIVE=off` + `--creative` → log `[creative] disabled (GSD_R_CREATIVE=off) — using conservative cascade` to stderr. Never silent.
- **Variants are independent.** Failed variant logs warning, other variants proceed. Never fail the entire creative search because one variant timed out. Same graceful degradation principle as existing providers.

### 11. Scope & Interaction Rules (Gaps 10, 32, 37, 38, 39, 42, 43)
- **Creative vs modes: orthogonal.** Modes control depth, `--creative` controls diversity. They compose.
- **`--provider` forces single-provider for ALL queries** including variants. `--creative --provider perplexity` = 4 Perplexity queries. Explicit is explicit.
- **`--creative` only applies to `search` sub-command.** Not `perplexity` direct, `fetch`, or `check-providers`. Creative is an exploration feature.
- **R-phase creative + E-phase pre-execution: no conflict.** Different timing, different consumer intent. R-phase finds patterns for research, E-phase finds patterns for implementation. Same query running twice is acceptable.
- **Creative works with cross-project search.** Broader failure pattern search is more valuable, not less. Creative variants query cross-project memory when available.
- **Creative is ONLY for the researcher agent.** Executors do basic R-phase queries (existing behavior). If a task needs creative research, operator routes to researcher first, then executor. Division of labor.
- **Auto-enable creative on re-research.** If task fails validation and returns to R-phase, creative auto-enables regardless of task type. Conservative search failed — creative is worth trying. Log: `[creative] auto-enabled on re-research attempt.`

### 12. Researcher Agent Changes (Gaps 8, 13)
- **gsd-researcher.md: 168 lines currently.** Adding `<creative_protocol>` (~20-25 lines) → ~190 lines. Within +25% budget (210 max).
- **Researcher infers creative from task metadata** for auto-enable. `--creative` flag on CLI ALSO works independently for manual/ad-hoc use outside task context.

### 13. Workflow Integration (Gaps 9, 26)
- **`execute-phase.md:254`** is where `--creative --task-type {type}` flags wire in.
- **Operator prompt addition** (~5 lines): classify `metadata.execution_type` from task description keywords at routing time.

### 14. Testing Strategy (Gap 14)
- **CJS only.** ~20 tests in `tests/13-creative-research.test.cjs`:
  - Jaccard JS implementation (~5 tests)
  - Variant query generation from templates (~5 tests)
  - Task-type gating logic (~5 tests)
  - `--creative` flag parsing + kill switch (~3 tests)
  - Dedup across variants (~3 tests)

### 15. Phase 15 Dogfood Criteria (Gaps 16, 28, 40)
- **Defined now for Phase 15:**
  (a) `--creative` flag parsing works
  (b) Task-type gating correctly enables/disables
  (c) At least 1 variant produces a result absent from original query's results
  (d) <20% token cost delta over 10 tasks (from `data/creative-research-log.json`)
  (e) Kill switch emits warning and suppresses variants
- **Rollback rate measurement deferred to Phase 15.** Phase 13 implements; Phase 15 measures effectiveness including failure correlation.
- **Creative ROI via `metadata.creative_source`:** Phase 15 queries which creative sources produced APPLIED_LEARNING citations downstream.

### Claude's Discretion
- Exact Jaccard JS implementation (word tokenization, normalization)
- Domain detection heuristic for third-slot variant selection
- creative-research.md example quality/quantity within 100-line budget
- Exact error message wording for kill switch and gating warnings
- Test fixture design for variant generation and dedup tests
- Exact keyword patterns for ambiguous operator classification edge cases
- creative-research-log.json rotation/cleanup policy (if needed)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Research infrastructure
- `get-shit-done/bin/gsd-research.cjs` — Main research CLI (1037 lines); cascade logic at lines 850-868; `parseArgs` at line 694; `PERPLEXITY_OUTPUT_CAP` at line 75 (1500 chars); `PERPLEXITY_BASE_DELAY_MS` at line 232 (1000ms); `selectPerplexityModel` at line 205; `providerPerplexity` at line 442; `cmdSearch` at line 825; `PROVIDER_ORDER` + `ADDITIVE_PROVIDERS` at lines 853-854; `GSD_RESEARCH_MIN_RESULTS` at line 76 (default 2)
- `agents/gsd-researcher.md` — Researcher agent prompt (168 lines); line 77 already references creative research gating as a LEARNING; line 96 documents research chain usage
- `get-shit-done/workflows/execute-phase.md` — Line 254 invokes `gsd-research.cjs search`; this is where `--creative --task-type` flags wire in
- `agents/gsd-operator.md` — Operator agent; needs `metadata.execution_type` classification addition

### Dedup and tokenization patterns
- `amauta.py` — `_jaccard_similarity()` Python implementation; reference for JS port
- `get-shit-done/bin/gsd-memory.cjs` — `normalizeTags()` word tokenization pattern reusable for JS Jaccard

### Prior phase context (patterns to follow)
- `.planning/milestones/v2.2-phases/12-semantic-memory-pipeline/12-CONTEXT.md` — Phase 12 decisions; reference file pattern (qa-checklist.md as runtime Read)
- `.planning/milestones/v2.2-phases/11-context-engine-activation/11-CONTEXT.md` — Phase 11 decisions; kill switch pattern, advisory behavior
- `.planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-CONTEXT.md` — Phase 10 decisions; APPLIED_LEARNING citation pattern

### Requirements
- `.planning/REQUIREMENTS.md` lines 90-97 — CREATIVE-01..05 requirements + kill switch + measurement criteria
- `.planning/ROADMAP.md` lines 235-269 — Phase 13 deliverables, success criteria, pitfalls prevented, rollback plan
- `.planning/research/v2.6/PITFALLS.md` — R1 (noise not lift), R2 (token bloat), R3 (dedup failures), R5 (overfitting to novelty)

### Domain vocabulary
- `get-shit-done/bin/tag-rules.json` — 12 seed domains; top 6 (database, api, security, frontend, backend, infrastructure) get per-domain creative examples

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gsd-research.cjs:parseArgs()` — Boolean flag pattern (`--json`, `--all`, `--no-cache`); `--creative` and `--task-type` slot in
- `gsd-research.cjs:PROVIDER_ORDER` + cascade loop (lines 850-868) — Creative variants run reduced cascade (memory → SKB → Perplexity)
- `gsd-research.cjs:ADDITIVE_PROVIDERS` set — Creative cascade skips Context7 and WebFetch
- `gsd-research.cjs:selectPerplexityModel()` — Creative variants bypass this (always use sonar)
- `gsd-research.cjs:PERPLEXITY_OUTPUT_CAP` (1500) — Creative variants use 750
- `gsd-research.cjs:PERPLEXITY_BASE_DELAY_MS` (1000) — Creative variants use 500
- `amauta.py:_jaccard_similarity()` — Reference implementation for JS port
- `gsd-memory.cjs:normalizeTags()` — Word tokenization usable for JS Jaccard

### Established Patterns
- **Kill switch env var:** `GSD_R_CREATIVE=off` follows `GSD_T_SPEC_INHERIT=false`, `GSD_E_MANDATE=off`, `GSD_D_STRUCTURED=false`
- **Runtime Read for reference files:** Researcher reads `creative-research.md` at runtime, same as checker reads `qa-checklist.md`
- **module.exports for test-only functions:** Jaccard JS, variant generation, and gating logic exported behind `require.main` guard for CJS tests
- **Structured log files:** `data/creative-research-log.json` follows append-only pattern

### Integration Points
- `gsd-research.cjs:cmdSearch()` — Main entry point; creative variant loop inserts BEFORE final result output
- `execute-phase.md:254` — Where `--creative --task-type` flags wire in
- `agents/gsd-researcher.md` — New `<creative_protocol>` section; 168 → ~190 lines
- `agents/gsd-operator.md` — New `metadata.execution_type` classification (~5 lines)
- `get-shit-done/agent-capabilities.json` — execution_type field surfaced in agent metadata

</code_context>

<specifics>
## Specific Ideas

- Variant query examples: original "how to implement rate limiting" → inversion "rate limiting failures common mistakes" → anti-pattern "rate limiting anti-patterns" → lateral "TCP congestion control flow throttling"
- creative-research.md: per-domain example pairs for top 6 domains: "for database tasks, lateral = TCP congestion → connection pooling analogy"
- No-novelty log is informational feedback — means direct search already covered the domain well
- Cost amortization through Perplexity cache: creative is most expensive on first use, nearly free on subsequent queries in the same domain
- Re-research auto-creative: "if conservative search failed, creative is worth trying" — this is the single exception to task-type gating

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 13-r-phase-creative-research*
*Context gathered: 2026-04-09*
