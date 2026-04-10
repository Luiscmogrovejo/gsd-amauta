# Phase 13: R-Phase Creative Research (Narrowed) - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Add creative query variants (lateral, inversion, anti-pattern, cross-domain, constraint-removal) to `gsd-research.cjs` behind a `--creative` flag, auto-gated by task type. Research/exploration/architecture-review tasks get 1 original + 3 variant queries (4 total); implementation/bug-fix/documentation tasks stay on the v2.5 conservative single-query cascade. Kill switch: `GSD_R_CREATIVE=off`.

</domain>

<decisions>
## Implementation Decisions

### Query Variant Strategy
- **Fixed 3 per query from 5 techniques**, selected by query domain — not random rotation.
- **Always include:** inversion ("why does X fail", "common mistakes in X") — failure patterns are universally valuable.
- **Always include:** anti-pattern ("X anti-patterns", "X worst practices") — negative constraints reveal more than positive examples.
- **Third slot rotates by domain:**
  - Architecture/design tasks → lateral analogy ("what natural systems solve X")
  - Implementation tasks → cross-domain transfer ("how does Kafka vs RabbitMQ solve X")
  - Optimization tasks → constraint removal ("if unlimited compute, how solve X")
- **4 total queries** when creative is on: 1 original + 3 variants. Each variant is a SEPARATE query to the research cascade.
- **Variant query cap:** 8 words max (same as existing search best practice).
- **Templates in `get-shit-done/references/creative-research.md`** — researcher agent Reads at R-phase start. Reference file contains 5 techniques with per-domain example pairs + good/bad query examples. Keep under 100 lines. Same runtime Read pattern as qa-checklist.md (Phase 12).

### Task-Type Gating Rules
- **Explicit `--task-type` flag** on gsd-research.cjs: `gsd-research search "query" --creative --task-type research`.
- **Values:** research, exploration, architecture-review, implementation, bug-fix, documentation.
- **Creative auto-triggers for:** research, exploration, architecture-review.
- **Creative suppressed for:** implementation, bug-fix, documentation (JetBrains Junie 3x rollback rate evidence).
- **No --task-type provided → creative does NOT fire** even with `--creative` flag. Must be explicit. No guessing.
- **Unknown task type → treated as implementation** (conservative default). Log warning to stderr: `Unknown task type '<value>', defaulting to implementation — creative suppressed.`
- **Researcher agent infers from task metadata** — if task_type matches creative-eligible set, auto-enables `--creative` when invoking gsd-research.cjs. The `--creative` CLI flag exists for direct use and testing. Researcher uses metadata, operator doesn't need to know about the flag.

### Dedup & Result Merging
- **Port Jaccard to JS** — ~15-line function in gsd-research.cjs. Don't call Python. Existing `normalizeTags()` in gsd-memory.cjs shows word tokenization pattern.
- **Dedup threshold:** 0.7 Jaccard similarity (same as memory dedup).
- **Merging:** Collect all results from 4 queries, dedup, sort by relevance score, return top-K (existing `--limit` flag, default 10).
- **Source tagging:** Each result gets `source: "original" | "inversion" | "anti-pattern" | "lateral" | "cross-domain" | "constraint-removal"`. Feeds into R-phase RPETD content.
- **No-novelty log:** If all 3 variants return >0.7 similar to original, log: `Creative variants produced no novel results — domain well-covered by direct search.` Informational, not a failure.

### Token Budget Monitoring
- **Per-variant logging to stderr:** `[creative] variant=inversion query="rate limiting failures" tokens_used=847 model=sonar cached=false`
- **Cumulative cost tracking:** Log ratio at end: `[creative] cost_delta: +14.2% (creative: 3420 tokens, baseline: 2995 tokens)`
- **<20% delta measured over batch, not per-query.** Per-query enforcement would kill creative on first expensive variant. Phase 15 dogfood verifies aggregate over 10 comparable tasks.
- **Creative variants ALWAYS use sonar** (cheaper model) regardless of complexity classification. Only original query gets sonar-pro routing via selectPerplexityModel(). This inherently caps creative cost.
- **Perplexity cache (6h TTL) applies to creative variants.** Creative cost amortizes over time.
- **Creative variant Perplexity cap: `max_tokens: 500`, output cap 750 chars** (vs original's 1000/1500). Variants are supplementary, not primary. Halves per-variant cost and keeps <20% delta achievable.

### Memory-First for Creative Variants
- **Yes — memory-first applies to creative variants.** Each variant runs through the same cascade (memory → skb → context7 → perplexity → webfetch). Memory queries are local/in-process (~0 cost). No extra wiring needed — the variant just uses a different query string through the existing cascade.

### Creative Results Storage
- **No separate source type.** Creative variants use the same storage mechanism as the existing research chain. No `creative_research` source type. The `source:` tag on results is sufficient data for Phase 15 dogfood to measure creative ROI by grepping R-phase RPETD content.

### APPLIED_LEARNING in R-Phase
- **Follow existing pattern.** If the researcher finds a relevant memory entry during creative search, emit `APPLIED_LEARNING: mem-XXXX — reason`. This is already the convention from Phase 10. No new mechanism needed.

### Kill Switch Behavior
- **Warn and proceed without creative.** `GSD_R_CREATIVE=off` + `--creative` → log `[creative] disabled (GSD_R_CREATIVE=off) — using conservative cascade` to stderr. Never silent. Return results from single original query only.

### Creative vs Research Modes
- **Orthogonal.** Modes (quick-check, deep-dive, architecture-review, pattern-search) control research depth. `--creative` controls query diversity. They compose. Per gating rules, architecture-review tasks auto-enable creative, so they naturally align.

### Researcher Agent Prompt Changes
- **gsd-researcher.md is currently 168 lines.** +25% budget = 210 max. Adding `<creative_protocol>` section (~20-25 lines) → ~190 lines. Within budget.
- **Content:** When to use `--creative` vs conservative cascade; task type check; variant generation pattern; dedup behavior; source tagging.

### R-Phase Workflow Changes
- **`execute-phase.md:254`** is where `gsd-research.cjs search '{plan_objective}'` is invoked. This is where `--creative --task-type {type}` flags get added when task type is creative-eligible.
- **Operator passes task type metadata** when spawning executor agents. Already implicit in routing decision — Phase 13 makes it explicit as a metadata field.

### Testing Strategy
- **CJS only** — gsd-research.cjs is Node. ~20 tests in `tests/13-creative-research.test.cjs`:
  - Jaccard JS implementation (~5 tests)
  - Variant query generation from templates (~5 tests)
  - Task-type gating logic (~5 tests)
  - `--creative` flag parsing + kill switch (~3 tests)
  - Dedup across variants (~3 tests)

### Cross-Phase Creative Value Measurement
- **Defer to Phase 15 dogfood.** The `source:` tag on results is sufficient data. Phase 15 greps R-phase RPETD content and counts which creative sources produced APPLIED_LEARNING citations downstream. No new mechanism in Phase 13.

### Claude's Discretion
- Exact Jaccard JS implementation (word tokenization, normalization)
- Domain detection heuristic for third-slot variant selection
- creative-research.md example quality/quantity within 100-line budget
- Exact error message wording for kill switch and gating warnings
- Test fixture design for variant generation and dedup tests

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Research infrastructure
- `get-shit-done/bin/gsd-research.cjs` — Main research CLI; cascade logic at lines 850-868; `parseArgs` at line 694; `PERPLEXITY_OUTPUT_CAP` at line 75; `selectPerplexityModel` at line 205; `providerPerplexity` at line 442
- `agents/gsd-researcher.md` — Researcher agent prompt (168 lines); line 77 already references creative research gating as a LEARNING
- `get-shit-done/workflows/execute-phase.md` — Line 254 invokes `gsd-research.cjs search`; this is where `--creative --task-type` flags wire in

### Dedup and tokenization patterns
- `amauta.py` — `_jaccard_similarity()` Python implementation; reference for JS port
- `get-shit-done/bin/gsd-memory.cjs` — `normalizeTags()` word tokenization pattern reusable for JS Jaccard

### Prior phase context (patterns to follow)
- `.planning/milestones/v2.2-phases/12-semantic-memory-pipeline/12-CONTEXT.md` — Phase 12 decisions; reference file pattern (qa-checklist.md as runtime Read)
- `.planning/milestones/v2.2-phases/11-context-engine-activation/11-CONTEXT.md` — Phase 11 decisions; kill switch pattern, advisory behavior

### Requirements
- `.planning/REQUIREMENTS.md` lines 90-97 — CREATIVE-01..05 requirements + kill switch + measurement criteria
- `.planning/ROADMAP.md` lines 235-269 — Phase 13 deliverables, success criteria, pitfalls prevented, rollback plan
- `.planning/research/v2.6/PITFALLS.md` — R1 (noise not lift), R2 (token bloat), R3 (dedup failures), R5 (overfitting to novelty)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gsd-research.cjs:parseArgs()` — Boolean flag pattern (`--json`, `--all`, `--no-cache`); `--creative` and `--task-type` slot into same pattern
- `gsd-research.cjs:PROVIDER_ORDER` + cascade loop (lines 850-868) — Creative variants run the SAME cascade with different query strings
- `gsd-research.cjs:selectPerplexityModel()` — Creative variants bypass this (always use sonar)
- `gsd-research.cjs:PERPLEXITY_OUTPUT_CAP` (1500) — Creative variants use lower cap (750)
- `amauta.py:_jaccard_similarity()` — Reference implementation for JS port
- `gsd-memory.cjs:normalizeTags()` — Word tokenization usable for JS Jaccard

### Established Patterns
- **Kill switch env var:** `GSD_R_CREATIVE=off` follows `GSD_T_SPEC_INHERIT=false`, `GSD_E_MANDATE=off`, `GSD_D_STRUCTURED=false` pattern
- **Runtime Read for reference files:** Researcher reads `creative-research.md` at runtime, same as checker reads `qa-checklist.md`
- **module.exports for test-only functions:** Jaccard JS, variant generation, and gating logic exported behind `require.main` guard for CJS tests

### Integration Points
- `gsd-research.cjs:cmdSearch()` — Main entry point; creative variant loop inserts BEFORE final result output
- `execute-phase.md:254` — Where `--creative --task-type` flags are added to research invocation
- `agents/gsd-researcher.md` — New `<creative_protocol>` section added; line count from 168 → ~190
- `get-shit-done/agent-capabilities.json` — May need task_type field surfaced in agent metadata

</code_context>

<specifics>
## Specific Ideas

- Variant query examples: original "how to implement rate limiting" → inversion "rate limiting failures common mistakes" → anti-pattern "rate limiting anti-patterns" → lateral "TCP congestion control flow throttling"
- creative-research.md should include per-domain example pairs: "for database tasks, lateral = TCP congestion → connection pooling analogy"
- No-novelty log message is informational feedback, not a failure — it means direct search already covered the domain well
- Cost amortization through Perplexity cache means creative is most expensive on first use, nearly free on subsequent queries in the same domain

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 13-r-phase-creative-research*
*Context gathered: 2026-04-09*
