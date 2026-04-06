---
phase: 03-rlm-engine-fixes
plan: 03-03
subsystem: api
tags: [python, rlm, cache, lru, observability, cli, nodejs]

# Dependency graph
requires:
  - phase: 03-01
    provides: BM25 scoring fixes that cache behavior is verified against
  - phase: 03-02
    provides: label boost + chunk size corrections
provides:
  - ChunkCache hit/miss counters with hit_rate property
  - /cache/stats endpoint with hit_count, miss_count, hit_rate fields
  - ChunkCache.clear_file() for targeted per-file cache eviction
  - --fresh CLI flag that bypasses cache for a single query (both /query and /search)
  - 3 new cache unit tests covering counters, reset, and clear_file

affects: [04-embedding-cache, any phase touching rlm-service.py or gsd-rlm.cjs]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Counter properties on LRU cache class (hit_count, miss_count, hit_rate)
    - Cache bypass flag (fresh) passed in HTTP request body, not as query param
    - clear_file() iterates _cache keys to collect victims before popping to avoid mid-iteration mutation

key-files:
  created: []
  modified:
    - services/rlm-service.py
    - get-shit-done/bin/gsd-rlm.cjs
    - tests/test_rlm_scoring.py

key-decisions:
  - "hit_rate is a computed property (not stored) to avoid drift: total = hit+miss, divide only if total > 0"
  - "clear_file bypasses bytes counter by manually subtracting before pop -- avoids double-free"
  - "fresh bypass in _handle_search calls os.path.expanduser() to match the key format used downstream"
  - "fresh flag does NOT clear MtimeIndex -- only ChunkCache entries, since chunk_file() checks cache first"
  - "Counters reset on clear() to keep stats consistent with cache state"

patterns-established:
  - "Cache observability: expose hit_count, miss_count, hit_rate on every LRU cache class"
  - "Debug bypass flags: accept fresh: bool in request body, not as URL param or env var"

requirements-completed:
  - RLM-08
  - RLM-09

# Metrics
duration: 25min
completed: 2026-04-06
---

# Plan 03-03: Cache Observability + Fresh Flag Summary

**ChunkCache hit/miss counters + /cache/stats observability fields + --fresh CLI flag for single-query cache bypass**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-06T21:00:00Z
- **Completed:** 2026-04-06T21:25:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- ChunkCache now tracks `_hit_count` and `_miss_count` that increment on every `get()` call; `clear()` resets both
- `/cache/stats` endpoint extended with `hit_count`, `miss_count`, and `hit_rate` fields for runtime observability
- `ChunkCache.clear_file(filepath)` evicts all entries for a single filepath while correctly adjusting `_current_bytes`
- `fresh: bool` parameter accepted by both `/query` and `/search`; when true, clears cache entries for all files in scope before chunking, then results re-enter cache normally
- CLI `--fresh` boolean flag parsed and forwarded as `fresh: !!flags.fresh` in all 4 body construction paths
- 3 new tests in `TestChunkCache`; full suite 25/25 pass

## Task Commits

1. **03-03-T1: hit/miss counters + /cache/stats** - `d1f9e91` (feat)
2. **03-03-T2: clear_file + --fresh bypass** - `e3db775` (feat)

## Files Created/Modified

- `services/rlm-service.py` - ChunkCache: _hit_count/_miss_count init, get() increments, clear() reset, clear_file() method, hit_count/miss_count/hit_rate properties; /cache/stats extended; _handle_query + _handle_search fresh param + bypass loops
- `get-shit-done/bin/gsd-rlm.cjs` - parseArgs boolean check adds 'fresh'; help text updated; fresh: !!flags.fresh in cmdQuery (3 paths) and cmdSearch (1 path)
- `tests/test_rlm_scoring.py` - TestChunkCache class with 3 tests

## Decisions Made

- `hit_rate` is a derived property (computed from hit_count + miss_count) rather than a stored float to avoid drift when counters change independently.
- `fresh` is passed in the HTTP body rather than as a URL query parameter to keep endpoint signatures stable and avoid cache-busting at the HTTP layer.
- `clear_file()` collects victim keys in a list comprehension first, then pops — avoids modifying the OrderedDict during iteration.
- MtimeIndex is NOT cleared on fresh because `chunk_file()` consults ChunkCache before the mtime check; clearing cache entries is sufficient to force re-chunking.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 03-rlm-engine-fixes is now complete (all 3 plans: 03-01, 03-02, 03-03 done).
- Phase 04 (embedding cache) can proceed; it will build on the corrected scoring engine and cache infrastructure from Phase 03.

---
*Phase: 03-rlm-engine-fixes*
*Completed: 2026-04-06*
