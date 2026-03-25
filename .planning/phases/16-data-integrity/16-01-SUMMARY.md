---
phase: 16-data-integrity
plan: "01"
subsystem: database
tags: [pgvector, cosine-similarity, dedup, distillation, embedding, memory]

requires:
  - phase: 15-data-purge
    provides: Clean memory baseline (219 entries, zero test pollution)
provides:
  - exclude_source parameter on memory_list (PG + SQLite + daemon)
  - Distill input filtering (source='distilled' excluded from merge input)
  - Pre-store embedding dedup (cosine >= 0.95 blocks insert)
  - Dedup response handling in daemon /api/memory/store
  - 9 data integrity tests
affects: [16-data-integrity, 18-memory-optimization]

tech-stack:
  added: []
  patterns: [pre-store-dedup, exclude-source-filtering, dedup-response-dict]

key-files:
  created:
    - tests/test_data_integrity.py
  modified:
    - services/pg_store.py
    - services/sqlite_store.py
    - services/amauta-daemon.py
    - get-shit-done/bin/gsd-memory.cjs

key-decisions:
  - "Dedup threshold 0.95 (configurable via GSD_DEDUP_THRESHOLD) -- high enough to only catch near-duplicates"
  - "exclude_source at API layer (not hardcoded in distill) -- reusable for other callers"
  - "Return type of memory_store_with_embedding changes from int to int|dict -- daemon handles both"
  - "Single _get_conn() with two cursor sub-blocks for dedup check + insert (no nested connections)"

patterns-established:
  - "Pre-store dedup: check similarity before INSERT, return dict on skip"
  - "Exclude-source filtering: API-layer param that propagates through daemon -> store"

requirements-completed: [DATA-03, DATA-04]

duration: 15min
completed: 2026-03-25
---

# Plan 16-01: Fix Distill Re-Merging and Add Pre-Store Embedding Dedup Summary

**Distill now skips its own output (source='distilled') and pre-store cosine dedup (>=0.95) blocks near-duplicate inserts at the embedding layer**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-25
- **Completed:** 2026-03-25
- **Tasks:** 5
- **Files modified:** 5 (4 modified, 1 created)

## Accomplishments
- Distill input filtering prevents cascading mega-entry bug (source='distilled' entries excluded from merge input)
- Pre-store embedding dedup catches near-duplicate memory writes before INSERT (cosine >= 0.95 threshold)
- Daemon returns structured dedup response {stored: false, dedup_skipped: true} for caller awareness
- 9 new tests cover exclude_source filtering and dedup response handling with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Add exclude_source param to memory_list** - `e4fc9ab` (feat)
2. **Task 2: Fix cmdDistill to exclude distilled entries** - `0471f06` (fix)
3. **Task 3: Add pre-store embedding dedup** - `7019e3e` (feat)
4. **Task 4: Update daemon dedup response handling** - `122408e` (feat)
5. **Task 5: Add data integrity tests** - `de010d3` (test)

## Files Created/Modified
- `services/pg_store.py` - Added exclude_source to memory_list, pre-store dedup to memory_store_with_embedding
- `services/sqlite_store.py` - Added exclude_source to memory_list for PG parity
- `services/amauta-daemon.py` - Passes exclude_source param, handles dedup dict response
- `get-shit-done/bin/gsd-memory.cjs` - cmdDistill fetches with exclude_source=distilled
- `tests/test_data_integrity.py` - 9 tests for exclude_source and dedup behavior

## Decisions Made
- Used 0.95 cosine threshold (configurable via GSD_DEDUP_THRESHOLD) -- conservative to avoid false positives
- exclude_source implemented at API layer rather than hardcoded in distill -- more reusable
- Return type polymorphism (int | dict) for memory_store_with_embedding -- daemon checks isinstance()
- Single connection with two cursor sub-blocks instead of nested _get_conn() calls

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 16-02 (project_id isolation + test isolation) is ready to execute
- Clean memory baseline preserved (219 entries, no new test pollution)
- Distill and dedup are safe to use immediately

---
*Phase: 16-data-integrity*
*Completed: 2026-03-25*
