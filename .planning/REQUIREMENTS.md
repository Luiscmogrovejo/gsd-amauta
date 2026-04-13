# Requirements: GSD-Amauta v2.8 "Metabolism"

**Defined:** 2026-04-12
**Core Value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.

## v2.8 Requirements

Requirements for token optimization milestone. Each maps to roadmap phases.

### Structured Context Handoffs

- [x] **HANDOFF-01**: RPETDContext Pydantic model exists with exactly 8 typed fields (task_id, original_intent, completed_work, current_state, active_constraints, relevant_files, next_actions, context_version); model validates on construction; unit test creates instance with all fields and asserts `.model_dump()` round-trips without loss
- [x] **HANDOFF-02**: Compaction function at each RPETD phase boundary produces RPETDContext from raw conversation; prune step removes tool outputs older than the last 40K tokens; compact step LLM-summarizes remainder into structured object; test verifies a 15K-token conversation compacts to an RPETDContext instance
- [x] **HANDOFF-03**: RPETDContext serialized to `rpetd_context` PostgreSQL table after each phase; table has `task_id`, `phase`, `context_json`, `created_at` columns; `SELECT * FROM rpetd_context WHERE task_id = X` returns one row per completed phase
- [x] **HANDOFF-04**: Downstream phase input contains compiled view at <= 600 tokens (measured via `tiktoken cl100k_base`); full conversation history is NOT forwarded; test asserts compiled view token count < 600 for a representative 5-phase RPETD cycle
- [x] **HANDOFF-05**: All 5 existing RPETD phase runners (R, P, E, T, D) execute successfully with RPETDContext as input; no existing test regressions; `node --test tests/` exit code 0

### Hash-Based Staleness Detection

- [ ] **STALE-01**: `ContextValidator.compute_file_hash(path)` returns SHA-256 hex digest; hashes stored in `rpetd_context.relevant_files` as `{path: hash}` dict; test verifies hash changes when file content changes and stays stable when file is unchanged
- [ ] **STALE-02**: `ContextValidator.changed_since(context)` calls `git diff --name-only` against stored commit ref; returns list of changed file paths; zero additional filesystem reads for unchanged files; test verifies correct diff detection after a commit
- [ ] **STALE-03**: `ContextValidator.selective_refresh(context, stale_files)` re-generates descriptions only for stale files; unchanged files retain their cached descriptions verbatim; test with 10 files where 2 changed verifies only 2 descriptions regenerated
- [ ] **STALE-04**: RPETD orchestrator calls `ContextValidator.validate_context()` before each phase start; if stale files found, `selective_refresh()` runs before phase begins; log line emitted: `[STALE] N files refreshed, M cached`; test verifies hook fires on phase transition

### Caveman-Compressed Descriptions

- [ ] **CAVE-01**: File description generator outputs structured format: `[function 10w max] | deps: [list] | touches: [file patterns] | tests: [file(count)] | [quality signal]`; format parseable by regex `^.+\|.deps:.+\|.touches:.+\|.tests:.+\|.+$`; test verifies 10 sample files produce parseable descriptions
- [ ] **CAVE-02**: Grammar stripping applied to CLAUDE.md and agent definition files; articles (a, an, the), filler words, and hedging removed; output is valid markdown; achieves >= 5% total-file character reduction on files with < 30% code block density, or documents the irreducible floor for dense technical markdown (files with >= 50% code blocks/XML/YAML achieve ~1-2% — this is the honest ceiling, not a failure); test verifies stripping runs and preserves structure
- [ ] **CAVE-03**: BM25 retrieval benchmark: run 20 queries against both original and compressed descriptions; mean reciprocal rank (MRR) of compressed >= 95% of original MRR; no query drops more than 2 rank positions; test suite with golden queries and expected top-3 results
- [ ] **CAVE-04**: Side-by-side measurement: for 10 representative files, count distinct technical facts (identifiers, relationships, constraints) in 500-char original vs 500-char compressed description; compressed contains >= 40% more facts; test with manual fact annotations as ground truth

### Prompt Prefix Caching

- [ ] **CACHE-01**: All 11 specialist agent prompts restructured so stable content (system instructions, tool definitions, file descriptions) precedes variable content (phase-specific instructions, latest outputs); diff shows no variable content before the `cache_control` breakpoint; audit script verifies ordering for all 11 agents
- [ ] **CACHE-02**: `annotate_cache_control()` utility returns correct `cache_control: {"type": "ephemeral"}` metadata for the stable prefix breakpoint; utility is available for any future direct API integration; test verifies annotation logic returns correct structure (note: GSD-Amauta delegates API calls to Claude Code, which handles cache_control internally — the utility documents intent and provides infrastructure for direct-call paths)
- [ ] **CACHE-03**: Prefix stability lint: no `datetime.now()`, `time.time()`, or `Date.now()` in system prompt construction; tool definitions sorted alphabetically and frozen; test generates two sequential prompts for the same agent and asserts byte-identical prefixes up to the breakpoint
- [ ] **CACHE-04**: After each Claude API call, `cache_read_input_tokens` and `cache_creation_input_tokens` logged to structured metrics; `/metrics/cache` endpoint returns cumulative hit rate, total tokens saved, and cost savings estimate; test verifies metrics update after API call

### Semantic Cache Layer

- [ ] **SEMANTIC-01**: Before any research-chain LLM call, query is embedded and checked against `semantic_cache` table (pgvector cosine similarity >= 0.90); cache hit returns stored response without LLM call; cache miss stores response after LLM call; test verifies paraphrased query ("how to parse JSON in Python" / "Python JSON parsing") returns cached response
- [ ] **SEMANTIC-02**: When source file referenced by cached response changes (SHA-256 mismatch), cached entry marked stale and excluded from future hits; `semantic_cache.valid` column flipped to false; test modifies source file, verifies cache miss on next query for that context
- [ ] **SEMANTIC-03**: `/cache/stats` HTTP endpoint returns JSON: `{hits, misses, hit_rate, entries, total_tokens_saved, estimated_cost_saved}`; all counters increment correctly; test makes 5 cache hits + 3 misses and verifies `hit_rate` = 0.625

### Tiered Model Routing

- [ ] **ROUTE-01**: `config.json::model_routing` map defines model per RPETD phase; default: `{R: "sonnet", P: "sonnet", E: "sonnet", T: "haiku", D: "haiku"}`; orchestrator reads config and passes correct model to each phase; test overrides config to all-haiku and verifies T/D phases use haiku
- [ ] **ROUTE-02**: Compaction summarization (HANDOFF-02's LLM call) uses model from `config.json::model_routing.compaction` (default: "haiku"); test verifies compaction call uses configured model, not the phase's primary model

### Tech Debt Sweep

- [ ] **DEBT-01**: `cmdInitPhaseOp` no longer falls back to archived milestone directories; calling `init discuss-phase` for a phase with no v2.8 directory returns error (not a v2.3/v2.6 ghost); test replays Depth-11 scenario and verifies no ghost returned
- [ ] **DEBT-02**: `plan-to-tasks` auto-registration succeeds for phases >= 20; daemon task list contains entries for v2.8 phases after plan execution; test creates phase 20 plan and verifies daemon `GET /tasks?phase=20` returns registered tasks
- [ ] **DEBT-03**: `amauta.cjs` wrapper routes HTTP requests correctly to daemon endpoints; `amauta.cjs task list` returns same output as `gsd-amauta.cjs task list`; test compares outputs of both wrappers
- [ ] **DEBT-04**: `routeExecutor` selects agent via deterministic first-match on file patterns; given two agents matching the same file, the one with higher specificity wins (longer glob); test with overlapping patterns verifies deterministic selection

## Future Requirements

Deferred to v2.9+. Tracked but not in current roadmap.

### Advanced Optimization

- **ADV-01**: LLMLingua-2 token-level compression for file analysis before truncation
- **ADV-02**: Batch API integration (50% off) for non-interactive RPETD phases
- **ADV-03**: Cross-session context persistence via RPETDContext serialization
- **ADV-04**: Adaptive model routing based on task complexity scoring

## Out of Scope

| Feature | Reason |
|---------|--------|
| Model weight access / Attention Residuals implementation | Requires model internals — paper insight applied at application layer only |
| OpenAI API caching integration | GSD-Amauta uses Claude API exclusively; dual-API deferred |
| Real-time KV cache management | Claude API handles cache lifecycle; no client-side KV needed |
| Full LLMLingua-2 pipeline | Adds Python ML dependency; deferred to v2.9 after measuring caveman approach |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| HANDOFF-01 | Phase 20 | Complete |
| HANDOFF-02 | Phase 20 | Complete |
| HANDOFF-03 | Phase 20 | Complete |
| HANDOFF-04 | Phase 20 | Complete |
| HANDOFF-05 | Phase 20 | Complete |
| STALE-01 | Phase 21 | Pending |
| STALE-02 | Phase 21 | Pending |
| STALE-03 | Phase 21 | Pending |
| STALE-04 | Phase 21 | Pending |
| CAVE-01 | Phase 22 | Pending |
| CAVE-02 | Phase 22 | Revised (threshold updated per divergence) |
| CAVE-03 | Phase 22 | Pending |
| CAVE-04 | Phase 22 | Pending |
| CACHE-01 | Phase 23 | Pending |
| CACHE-02 | Phase 23 | Pending |
| CACHE-03 | Phase 23 | Pending |
| CACHE-04 | Phase 23 | Pending |
| SEMANTIC-01 | Phase 24 | Pending |
| SEMANTIC-02 | Phase 24 | Pending |
| SEMANTIC-03 | Phase 24 | Pending |
| ROUTE-01 | Phase 24 | Pending |
| ROUTE-02 | Phase 24 | Pending |
| DEBT-01 | Phase 25 | Pending |
| DEBT-02 | Phase 25 | Pending |
| DEBT-03 | Phase 25 | Pending |
| DEBT-04 | Phase 25 | Pending |

**Coverage:**
- v2.8 requirements: 23 total
- Mapped to phases: 23
- Unmapped: 0

---
*Requirements defined: 2026-04-12*
*Last updated: 2026-04-12 after initial definition*
