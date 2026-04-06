---
plan: 07-02
title: "Priority Scoring Edge Cases + Research Chain Cascade Tuning"
status: complete
completed_at: "2026-04-06"
commits:
  - cf1f2cd: "fix(07-02-T1): dep_pressure cache key uses content hash instead of id()"
  - 4c1c8ba: "fix(07-02-T2): tie-break cmd_next sort by created_at ascending"
  - 1486ea3: "fix(07-02-T3): cascade requires >= RESEARCH_MIN_RESULTS before stopping"
  - 27b96bd: "fix(07-02-T4): guard research chain with _search_q check"
  - 5811799: "test(07-02-T5): add guard tests for priority scoring and cascade behavior"
tests: 14/14 pass
---

# Plan 07-02: Summary

## What Was Done

### T1: Fix dep_pressure_cache key (amauta.py)

**Problem:** Cache key used `id(all_items)` — Python object memory address. Since `load()` returns a new dict each call, the address always differs, making the cache rebuild on every `_score()` call (never reused).

**Fix:** Changed to content-based hash:
```python
cache_key = (len(all_items), hash(tuple((i.get("id",""), i.get("status",""), len(i.get("dependencies",[]))) for i in all_items)))
```
Captures: task count + identity + status + dependency count changes. Status included because a dependency completing changes dep_pressure semantics.

### T2: Tie-breaking by created_at in cmd_next (amauta.py)

**Problem:** Python's stable sort preserves insertion order when scores are equal, but JSON insertion order is not meaningful — non-deterministic tie-breaking.

**Fix:** Sort key changed from `reverse=True` with score to negated tuple:
```python
best = sorted(candidates, key=lambda i: (-_score(i, all_items), i.get("created_at", "")))[0]
```
Oldest tasks (by ISO created_at string) get priority among equal-scored tasks.

### T3: Cascade threshold >= 2 (get-shit-done/bin/gsd-research.cjs)

**Problem:** Cascade stopped at the first provider with `count > 0` — a single low-quality memory result prevented Perplexity from being queried.

**Fix:** Added configurable minimum:
```javascript
const RESEARCH_MIN_RESULTS = parseInt(process.env.GSD_RESEARCH_MIN_RESULTS || '2', 10);
// ...
if (!args.all && !result.error && !ADDITIVE_PROVIDERS.has(name) && (result.count >= RESEARCH_MIN_RESULTS || name === 'perplexity')) {
```
Perplexity is always terminal (returns 1 curated answer, not a count-based list).

### T4: Empty _search_q guard (amauta.py)

**Problem:** Stopword-only titles (e.g. "Add code", "Fix bug") produce empty `_search_q`. The `if _search_q:` semantic search block is skipped, making `mem_result_count = 0 < 2` always true, so research chain fired unconditionally on an empty query.

**Fix:** Added guard:
```python
if _search_q and mem_result_count < 2:
    research_q = f"{title} {desc[:200]}"
    research_results = _research_chain_query(research_q, limit=3)
```

### T5: Guard tests (tests/07-02-priority-cascade.test.cjs)

14 static-analysis tests across 3 suites:
- **SCORE-01** (7 tests): dep_pressure hash, created_at tie-break, clamping, dep_pressure cap, critical boost, overdue urgency
- **CASCADE-01** (4 tests): RESEARCH_MIN_RESULTS defined, >= threshold, perplexity terminal, context7 additive
- **GUARD-01** (3 tests): _search_q guard, word length filter, stopword list contents

## Test Results

```
tests 14
pass  14
fail  0
duration_ms 174
```

## Files Changed

| File | Task | Change |
|------|------|--------|
| `amauta.py` | T1 | Cache key: `id(all_items)` -> content hash |
| `amauta.py` | T2 | Sort key: `reverse=True` -> `(-score, created_at)` tuple |
| `amauta.py` | T4 | Research chain guard: `if mem_result_count < 2` -> `if _search_q and mem_result_count < 2` |
| `get-shit-done/bin/gsd-research.cjs` | T3 | `RESEARCH_MIN_RESULTS` const + cascade stop `count > 0` -> `count >= RESEARCH_MIN_RESULTS OR perplexity` |
| `tests/07-02-priority-cascade.test.cjs` | T5 | New guard test file (14 tests) |

## Key Learnings

- **Cache key design:** Object identity (`id()`) is wrong for cross-call caches — use content-derived hashes. Include all fields that affect cache semantics (status changes count).
- **Sort tie-breaking:** Always provide a secondary sort key for deterministic ordering. ISO timestamps sort lexicographically so `created_at` works directly.
- **Cascade thresholds:** Use configurable env var defaults (not hardcoded magic numbers) for quality thresholds — allows tuning without code changes.
- **Perplexity special case:** Perplexity returns 1 curated answer by design, so `count >= 2` would never stop at Perplexity. Explicit `name === 'perplexity'` terminal case is required.
- **Guard empty queries:** Stopword-only titles are a real edge case — always guard subprocess spawns with a non-empty query check.
