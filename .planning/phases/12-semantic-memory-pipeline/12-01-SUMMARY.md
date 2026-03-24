---
phase: 12-semantic-memory-pipeline
plan: 01
subsystem: memory
tags: [pgvector, semantic-search, voyage-ai, embeddings, daemon-http]

# Dependency graph
requires:
  - phase: 11-context-engine-activation
    provides: urllib.request HTTP POST pattern in _rlm_query()
provides:
  - _mem_semantic_search() helper function for cosine-similarity memory queries
  - daemon-routed memory writes with auto-embedding via Voyage AI
  - full-fidelity RPETD phase storage without truncation
affects: [12-02, 12-03, 14-pipeline-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [daemon-HTTP-first-with-SQL-fallback, score-normalization-float-to-int]

key-files:
  created:
    - tests/test_semantic_search.py
  modified:
    - amauta.py

key-decisions:
  - "Daemon HTTP first with direct SQL fallback -- zero-downtime guarantee"
  - "Score normalization: cosine similarity 0-1 floats multiplied by 10 to match LIKE-based integer scores"
  - "Removed stopword extraction from search callers -- embeddings handle semantic meaning natively"
  - "Dedup check stays as direct SQL before HTTP store -- fast, no overhead, must precede store"
  - "stored_via_daemon flag prevents double-write on partial daemon failure"

patterns-established:
  - "Daemon-first pattern: try HTTP endpoint -> fallback to direct SQL -> fallback to JSONL"
  - "Score normalization: multiply float similarity by 10 for integer-based downstream filtering"
  - "Richer query context: title + desc[:200] instead of 4 extracted keywords for embeddings"

requirements-completed: [SEM-01, SEM-02, SEM-07]

# Metrics
duration: 12min
completed: 2026-03-24
---

# Phase 12 Plan 01: Semantic Search Wiring + Write Routing + Double-Truncation Fix Summary

**Wired pgvector semantic search into R-phase/claim enrichment, routed all memory writes through daemon HTTP for auto-embedding, removed double-truncation so full RPETD phase content is stored**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-24
- **Completed:** 2026-03-24
- **Tasks:** 5
- **Files modified:** 2

## Accomplishments
- `_mem_semantic_search()` helper queries daemon `/api/memory/semantic-search` with pgvector cosine similarity, falling back to LIKE-based `_mem_pg_search()` on daemon failure
- R-phase and claim-time enrichment now use semantic search with richer `title + desc[:200]` queries instead of 4-keyword LIKE matching
- `_mem_log_event()` routes through daemon `POST /api/memory/store` for auto-embedding via Voyage AI, with direct SQL fallback
- `_auto_write_learning()` stores full phase content (2-5KB) instead of truncating to ~900 chars, improving embedding quality
- 10 new tests covering all 3 changes, 210 total tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add _mem_semantic_search() helper** - `17ec1bc` (feat)
2. **Task 2: Wire semantic search into R-phase and claim-time** - `ec5ec88` (feat)
3. **Task 3: Route _mem_log_event() through daemon HTTP** - `487d073` (feat)
4. **Task 4: Remove double-truncation from _auto_write_learning()** - `f921b74` (fix)
5. **Task 5: Add tests** - `56ef8d5` (test)

## Files Created/Modified
- `amauta.py` - Added _mem_semantic_search(), modified _rpetd_phase_enrich(), _enrich_task_context(), _mem_log_event(), _auto_write_learning()
- `tests/test_semantic_search.py` - 10 tests covering semantic search, daemon writes, and full learning storage

## Decisions Made
- Daemon-first pattern with fallback chain: HTTP daemon -> direct SQL -> JSONL file (zero-downtime guarantee)
- Score normalization: cosine similarity 0-1 floats * 10 to match existing integer-based score filtering (>= 2 threshold)
- Removed stopword extraction from search callers -- embeddings handle semantic meaning better with raw title + description
- Kept dedup check as direct SQL before daemon store call -- must happen before store, minimal latency impact
- stored_via_daemon boolean flag prevents double-write if daemon returns non-JSON or partial success

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed indentation after claim-time search replacement**
- **Found during:** Task 2 (claim-time enrichment wiring)
- **Issue:** After removing 3-level nested `if _mem_pg_available() -> if search_q:` blocks, downstream Tier 1/Tier 2 filter code had wrong indentation
- **Fix:** Re-indented Tier 1 and Tier 2 filter blocks to match new `if search_q.strip():` nesting level
- **Files modified:** amauta.py
- **Verification:** Python syntax check passes, tests pass
- **Committed in:** ec5ec88 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary indentation correction after structural change. No scope creep.

## Issues Encountered
None

## Next Phase Readiness
- Plan 12-01 complete, ready for 12-02 (E-phase patterns, T-phase domain search, SKB Jaccard dedup)
- Wave 1 plans 12-01 and 12-02 are independent -- 12-02 can proceed immediately
- _mem_semantic_search() is available for any future caller that needs semantic memory queries

---
*Phase: 12-semantic-memory-pipeline*
*Completed: 2026-03-24*
