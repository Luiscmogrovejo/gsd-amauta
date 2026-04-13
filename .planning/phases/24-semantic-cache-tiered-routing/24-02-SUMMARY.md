---
plan: 24-02
status: complete
completed_at: "2026-04-12"
tasks_total: 4
tasks_complete: 4
commits:
  - c0acf00 feat(24-02-01): wire semantic cache into creative research path
  - dc5681e feat(24-02-02): wire ROUTE-02 compaction llm_call from model_routing config
  - fa10c34 test(24-02-03): integration tests for semantic cache + ROUTE-02
requirements_met:
  - SEMANTIC-01
  - SEMANTIC-02
  - SEMANTIC-03
  - ROUTE-02
---

# Plan 24-02 Summary: Research Chain Integration + ROUTE-02 Compaction Wiring

## What Was Built

**Task 24-02-01: Semantic cache wired into creative research path**

The regular `providerPerplexity()` path already had SEMANTIC-01 wired from
prior work. This task added the same check+store pattern to
`providerPerplexity._creative()`:
- Check `/api/semantic-cache/search` before Perplexity API call
- Return semantic hit with `_tokens_used: 0` for downstream compatibility
- Store response to `/api/semantic-cache/store` after successful API call
- Both operations are best-effort (wrapped in try/catch)

Result: `grep -c 'semantic-cache/search' gsd-research.cjs` = 2 (regular +
creative), `grep -c 'semantic-cache/store'` = 2.

**Task 24-02-02: ROUTE-02 compaction llm_call wired in daemon**

Added `_make_compaction_llm_call()` helper function to `services/amauta-daemon.py`
(after `_get_store()`). The function:
- Reads `model_routing.compaction` from `.planning/config.json`
- Creates a typed `llm_call(prompt) -> None` closure with `_compaction_model`
  attribute as a test hook
- Returns `None` on any config error (graceful fallback)
- Logs model resolution at INFO level

Replaced `llm_call=None` placeholder in `POST /api/context/compact` with
`llm_call=_make_compaction_llm_call()`. The closure currently returns `None`
(triggering compact_conversation's fallback path) because GSD-Amauta delegates
API calls to Claude Code — ROUTE-02 verifies model SELECTION, not API execution.

**Task 24-02-03: Integration tests**

Created `tests/test_semantic_cache_integration.py` with 8 tests:
- 2 SEMANTIC-01: end-to-end store then lookup, unrelated query miss
- 2 SEMANTIC-02: file change invalidates then miss, stats reflect invalidation
- 1 SEMANTIC-03: 5 hits + 3 misses yields hit_rate=0.625 exactly
- 3 ROUTE-02: config read resolves 'haiku', not 'sonnet'; missing config returns None

All 8 pass with 0 failures.

**Task 24-02-04: Regression check**

- `pytest test_semantic_cache.py test_semantic_cache_integration.py`: 22/22 pass
- `pytest tests/` (ignoring live PG): 594/602 pass — 8 pre-existing failures
  (5 CAVE-02 compression ratio, 3 pg_integration live-DB). Zero new failures.
- `node --test tests/core.test.cjs`: 76/76 pass, 0 failures.

## Decisions

- Creative path cache hit returns `_tokens_used: 0` — required for downstream
  compatibility since the creative path normally returns `_tokens_used` from
  Perplexity usage data, and callers may rely on it being present.
- ROUTE-02 `llm_call` returns `None` by design — GSD-Amauta architecture
  delegates Claude API calls to Claude Code, not the Python daemon. The function
  exists to prove model selection is wired; actual API integration is future work
  (e.g., local Ollama or Anthropic API key in daemon context).
- Integration test ROUTE-02 uses `importlib.util.spec_from_file_location` to load
  `amauta-daemon.py` because its hyphenated filename prevents standard module import.
  `builtins.open` is monkey-patched per-test to inject temp config.json paths.

## Requirements Coverage

| Req | Description | Status |
|-----|-------------|--------|
| SEMANTIC-01 | Cache check before Perplexity (regular + creative) | COMPLETE |
| SEMANTIC-02 | File-change invalidation integration test | COMPLETE |
| SEMANTIC-03 | Stats hit_rate=0.625 integration test | COMPLETE |
| ROUTE-02 | Compaction llm_call reads model_routing.compaction | COMPLETE |

## Files Modified

- `get-shit-done/bin/gsd-research.cjs` — +75 lines (creative path semantic cache)
- `services/amauta-daemon.py` — +40 lines (_make_compaction_llm_call + wiring)
- `tests/test_semantic_cache_integration.py` — new, 407 lines

## Test Counts

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| test_semantic_cache.py | 14 | 14 | 0 |
| test_semantic_cache_integration.py | 0 | 8 | +8 |
| core.test.cjs | 76 | 76 | 0 |
| Full pytest (non-PG) | 586 | 594 | +8 |
