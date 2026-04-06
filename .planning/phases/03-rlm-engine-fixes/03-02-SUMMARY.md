---
phase: 03-rlm-engine-fixes
plan: 03-02
subsystem: rlm
tags: [bm25, scoring, chunking, label-boost, retrieval]

# Dependency graph
requires:
  - phase: 03-01
    provides: BM25 TF counting and IDF fixes that set absolute score values label boost operates on

provides:
  - MAX_CHUNK_CHARS default reduced to 4000 (was 8000) for tighter, focused retrieval
  - Label boost reduced to 1.5x with 3.0*idf cap preventing short-label domination
  - Guard tests for both RLM-05 and RLM-06 requirements

affects: [03-rlm-engine-fixes, 04-embedding-cache, any plan using RLM query results]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "BM25 label boost cap: multiply first, then min(boosted, N*idf) to bound contribution"
    - "Env-var default reduction: change string literal in os.environ.get() + matching CLI default"

key-files:
  created: []
  modified:
    - services/rlm-service.py
    - get-shit-done/bin/gsd-rlm.cjs
    - tests/test_rlm_scoring.py

key-decisions:
  - "Label boost cap set at 3.0*idf: allows label to double a medium-IDF term but not overwhelm high-content chunks"
  - "CLI defaults updated in both cmdQuery and cmdChunk to stay in sync with server default"
  - "test_label_boost_preserved still passes: label match with equal content still ranks first, margin just narrows"

patterns-established:
  - "Score cap pattern: boosted = score * multiplier; capped = min(boosted, N * idf) -- prevents runaway boosts without removing the feature"
  - "Config constant test pattern: load rlm-service.py via importlib in a fresh module instance to verify env-var defaults"

requirements-completed:
  - RLM-05
  - RLM-06

# Metrics
duration: 12min
completed: 2026-04-06
---

# Plan 03-02: Chunk Size + Label Boost Saturation Fix Summary

**RLM chunk size halved to 4000 chars and label boost capped at 1.5x/3xIDF to prevent short-label domination over content-rich chunks**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-06T~20:00Z
- **Completed:** 2026-04-06T~20:12Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Reduced MAX_CHUNK_CHARS from 8000 to 4000 — chunks no longer span multiple unrelated functions
- Fixed label boost saturation: 2.0x unbounded multiplier replaced with 1.5x capped at 3.0*idf
- All 20 pre-existing tests still pass; 2 new guard tests added (22 total)

## Task Commits

Each task was committed atomically:

1. **T1: Reduce default max chunk size from 8000 to 4000 chars (RLM-05)** - `fe05ab6` (fix)
2. **T2: Fix label boost saturation bypass — reduce multiplier and cap contribution (RLM-06)** - `0f79fa7` (fix)

## Files Created/Modified
- `services/rlm-service.py` - MAX_CHUNK_CHARS default 8000→4000; label boost block replaced with 1.5x+cap
- `get-shit-done/bin/gsd-rlm.cjs` - CLI help text + cmdQuery + cmdChunk defaults updated 8000→4000
- `tests/test_rlm_scoring.py` - Added test_default_chunk_size_4000 and test_label_boost_does_not_dominate

## Decisions Made
- Cap at `3.0 * idf` chosen: permits label boost to double a typical mid-IDF term (idf~1.5 → cap~4.5) but cannot outlast a chunk with 5+ matching content terms
- Both `cmdQuery` and `cmdChunk` in gsd-rlm.cjs updated — they are independent call paths, both needed to match the server default

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- RLM-05 and RLM-06 complete; Phase 3 Wave 2 done
- Phase 3 Wave 3 (03-03) can now proceed: reranker wiring depends on corrected scoring from 03-01 + 03-02
- All 22 scoring tests passing as regression baseline

---
*Phase: 03-rlm-engine-fixes*
*Completed: 2026-04-06*
