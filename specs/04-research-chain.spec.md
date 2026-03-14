# SPEC-04: Research Chain

## Overview
5-step research pipeline that searches for information in order of cost/latency, stopping at the first sufficient answer. Agents use this for current information that LLMs don't have.

## Requirements

### RSC-1: Chain Order
The research chain searches providers in this order (stop at first sufficient answer):
1. **Memory** (PG) — Past learnings from this and other projects (free, instant)
2. **SKB** (PG) — Validated cross-project knowledge base (free, instant)
3. **Context7** (MCP) — Library documentation via MCP server (free, fast)
4. **Perplexity** (API) — Web search via Perplexity sonar model (costs tokens, slow)
5. **WebFetch** (HTTP) — Direct URL fetch as last resort (free, slow)

### RSC-2: Provider Graceful Degradation
- Each provider wraps its work in try/catch and returns null on failure
- Missing API keys (PERPLEXITY_API_KEY) cause the provider to be silently skipped
- The chain continues to the next provider on any failure
- If all providers return null/empty, the chain returns an empty result set

### RSC-3: Auto-Storage of External Results
- Perplexity results are auto-stored to gsd_memory with source=web_search_result (+3 boost)
- Deduplication: Jaccard similarity > 0.7 against existing entries prevents duplicate storage
- Auto-embedding: if VOYAGE_API_KEY or OPENAI_API_KEY is set, results are embedded for semantic search

### RSC-4: Agent Integration
All 11 agents have `RESEARCH="node ~/.claude/get-shit-done/bin/gsd-research.cjs"` variable.
Usage patterns:
- `$RESEARCH search "<topic>"` — Full 5-step chain
- `$RESEARCH perplexity "<question>"` — Direct Perplexity query (skip memory/SKB)
- `$RESEARCH fetch --url "<url>"` — Direct URL fetch
- `$RESEARCH check-providers` — Show which providers are available

### RSC-5: Workflow Integration
Research chain is called in the amauta_enrichment blocks of:
- `execute-phase.md` — Step 2b before executor spawning
- `execute-plan.md` — Step 2b before plan execution
- `quick.md` — In the enrichment block before quick task execution
- `plan-phase.md` — Before planner spawning (via researcher agent)
- `new-project.md` — During ecosystem research (via researcher agent)

### RSC-6: Token Guard Patterns
- PERPLEXITY_API_KEY: read from process.env, never hardcoded
  - Chain mode: returns null (graceful skip) when not set
  - Direct mode (`gsd-research.cjs perplexity`): exits with clear error
- VOYAGE_API_KEY / OPENAI_API_KEY: for embedding results, not for research itself
  - When neither set: results stored without embedding (text search still works)

## Test Coverage
- `tests/pipeline-offline.test.cjs`: CLI wrapper correctness, help output
- Provider availability checked via `gsd-research.cjs check-providers`
