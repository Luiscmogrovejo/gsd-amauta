---
plan: "18-01"
phase: 18
title: "Source Filtering + Recency Decay"
status: complete
completed: "2026-03-25"
agent: executor-backend
duration_minutes: 25
---

# Summary: 18-01 Source Filtering + Recency Decay

## What Was Done

5 plan tasks executed across 4 atomic commits:

1. **pg_store.py** -- Added `DEFAULT_EXCLUDE_SOURCES = ("task_event", "rpetd_phase")` constant, `exclude_sources` parameter to `memory_search()` and `memory_semantic_search()` with parameterized `NOT IN` clause. Added `RECENCY_DECAY_PER_30D` (0.5, env-configurable) and `MAX_RECENCY_PENALTY` (3.0) with decay logic in `_score_memories()` and `_score_semantic_results()`.

2. **sqlite_store.py** -- Mirror changes: same constants, `exclude_sources` param on `memory_search()` and `memory_semantic_search()` (FTS fallback), recency decay in `_score_memories()` using `datetime.fromisoformat()` for SQLite's ISO string format.

3. **amauta-daemon.py** -- Both `/api/memory/search` and `/api/memory/semantic-search` endpoints check `body.include_noise` and pass `exclude_sources=None` when truthy. **gsd-memory.cjs** -- `cmdSearch` and `cmdSemanticSearch` accept `--include-noise` boolean flag. **amauta.py** -- `_mem_pg_search()` takes `exclude_sources` param with default + recency decay post-query; `_mem_semantic_search()` passes `include_noise` in request body.

4. **Recency decay** (bundled into tasks 1-3) -- All three scoring functions compute `min(RECENCY_DECAY_PER_30D * (days_old / 30), MAX_RECENCY_PENALTY)` and subtract from composite score. Handles None/unparseable dates gracefully. Configurable via `GSD_RECENCY_DECAY_PER_30D` env var (set to 0 to disable).

5. **tests/test_memory_optimization.py** -- 12 tests in 3 classes: source filtering (6 tests), recency decay (4 tests), composition (2 tests). All pass. Zero regressions in existing test_data_integrity.py (20 tests).

## Requirements Satisfied

| Requirement | Criterion | Verified |
|-------------|-----------|----------|
| MEM-01 | Default search excludes task_event/rpetd_phase | 12/12 tests pass |
| MEM-01 | --include-noise overrides exclusion | Test + code verified |
| MEM-03 | Recency decay -0.5/30d, capped at -3.0 | 4 decay tests pass |
| MEM-03 | GSD_RECENCY_DECAY_PER_30D=0 disables decay | Test verified |

## Files Changed

| File | Lines | Change |
|------|-------|--------|
| services/pg_store.py | +88/-11 | exclude_sources + recency decay |
| services/sqlite_store.py | +50/-7 | exclude_sources + recency decay |
| services/amauta-daemon.py | +12/-4 | include_noise wiring |
| get-shit-done/bin/gsd-memory.cjs | +6/-2 | --include-noise flag |
| amauta.py | +46/-8 | exclude_sources + recency decay |
| tests/test_memory_optimization.py | +238 | New test file |

## Commits

1. `f37a20d` -- feat(pg_store): add source filtering + recency decay to search scoring
2. `0a47387` -- feat(sqlite_store): add source filtering + recency decay for parity
3. `3c54850` -- feat(daemon,cli,amauta): wire include_noise through search stack
4. `161f73b` -- test(memory): add 12 tests for source filtering + recency decay

## Design Decisions

- **Bundled Task 4 into Tasks 1-3**: Recency decay touches the same scoring functions as source filtering. Modifying them once (not twice) is cleaner and avoids intermediate broken states.
- **Post-query decay in amauta.py**: `_mem_pg_search` computes scores in SQL but applies recency decay in Python after fetching. This keeps the SQL simple and matches the pg_store.py pattern.
- **Cap at 3.0**: Even the oldest lesson-learned (+4 bonus) stays above 0 after max penalty. This ensures high-value entries never drop below noise threshold.
