---
phase: 12-semantic-memory-pipeline
plan: 02
subsystem: memory
tags: [jaccard, dedup, semantic-search, enrichment, pgvector, skb]

requires:
  - phase: 12-01
    provides: _mem_semantic_search() helper for daemon-backed vector search
provides:
  - SKB Jaccard dedup preventing 3x near-duplicate entries per validated task
  - E-phase past execution patterns query (implementation approach reuse)
  - T-phase domain-based test strategy search (replaces useless task-ID search)
affects: [validation-hardening, pipeline-integration]

tech-stack:
  added: []
  patterns: [jaccard-word-overlap-similarity, domain-based-memory-search]

key-files:
  created:
    - tests/test_enrichment_memory.py
  modified:
    - amauta.py
    - tests/test_rlm_enrichment.py

key-decisions:
  - "Jaccard threshold 0.7 matches gsd-research.cjs Perplexity dedup (proven 6+ months)"
  - "SKB dedup compares title+content combined to catch different-prefix same-content entries"
  - "E-phase pattern query filters to high-signal sources only (auto_learning, session-learning, lesson-learned, best-practice)"
  - "T-phase uses title-based domain search instead of task-ID which almost never matched"

patterns-established:
  - "Jaccard word-overlap: re.findall(r'\\w{3,}', text.lower()) for 3+ char word sets, intersection/union ratio"
  - "Semantic search as primary, pg_search as fallback for enrichment queries"

requirements-completed: [SEM-03, SEM-04, SEM-06]

duration: 4min
completed: 2026-03-24
---

# Phase 12 Plan 02: E/T-Phase Memory Enrichment + SKB Jaccard Dedup Summary

**Jaccard word-overlap dedup for SKB entries, semantic E-phase execution pattern queries, and domain-based T-phase test strategy search**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-24T17:54:37Z
- **Completed:** 2026-03-24T17:58:31Z
- **Tasks:** 4
- **Files modified:** 3

## Accomplishments
- `_jaccard_similarity()` helper prevents 3x near-duplicate SKB entries from validated tasks (threshold 0.7)
- E-phase enrichment now queries past execution patterns via `_mem_semantic_search()` in addition to failure search
- T-phase enrichment replaced useless task-ID search with domain-based `_mem_semantic_search()` for test strategies
- 11 new tests covering Jaccard math, SKB dedup behavior, E-phase pattern calls, T-phase domain search

## Task Commits

Each task was committed atomically:

1. **Task 1: Jaccard similarity + SKB dedup** - `edc4290` (feat)
2. **Task 2: E-phase execution patterns query** - `69dd81b` (feat)
3. **Task 3: T-phase domain-based search** - `a4b6b4f` (feat)
4. **Task 4: Tests for all changes** - `594ba89` (test)

## Files Created/Modified
- `amauta.py` - Added `_jaccard_similarity()`, modified `_skb_promote()` dedup, added E-phase pattern query, replaced T-phase task-ID search
- `tests/test_enrichment_memory.py` - 11 new tests (Jaccard, SKB dedup, E-phase, T-phase)
- `tests/test_rlm_enrichment.py` - Fixed timing test to mock `_mem_semantic_search`

## Decisions Made
- Jaccard threshold 0.7 (matches gsd-research.cjs proven value)
- Combined title+content comparison catches different-prefix same-content SKB entries
- E-phase pattern query filters to high-signal sources only
- T-phase keyword filter (test, validat, assert, coverage, pass, playwright, pytest, evidence, criteria) prevents noise

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Timing test failure from unmocked _mem_semantic_search**
- **Found during:** Task 4 (test suite run)
- **Issue:** `test_all_phases_under_budget` in test_rlm_enrichment.py timed out at 2.37s because E/T-phase now call `_mem_semantic_search` which tries HTTP to daemon
- **Fix:** Added `@patch("amauta._mem_semantic_search", return_value=[])` to timing test
- **Files modified:** tests/test_rlm_enrichment.py
- **Verification:** Full suite 221 passed in 7.42s
- **Committed in:** 594ba89 (Task 4 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for existing test compatibility. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 12-02 complete (SEM-03, SEM-04, SEM-06 done)
- Ready for Plan 12-03 (research chain auto-invocation, SEM-05)
- 221 total tests all green

---
*Phase: 12-semantic-memory-pipeline*
*Completed: 2026-03-24*
