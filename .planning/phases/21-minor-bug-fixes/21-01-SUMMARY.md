---
phase: 21-minor-bug-fixes
plan: 01
subsystem: core
tags: [jaccard, threading, archive, skb, dedup, daemon]

# Dependency graph
requires:
  - phase: none
    provides: independent of Phase 20
provides:
  - Jaccard character trigram fallback for short-word texts
  - Interruptible retention thread via threading.Event
  - Archive genealogy cleanup (parent.children)
  - SKB promotion dedup observability (True/False return)
affects: [22-core-system-tests, 23-integration-tests]

# Tech tracking
tech-stack:
  added: []
  patterns: [threading.Event for interruptible daemon threads, character trigram fallback for text similarity]

key-files:
  created: []
  modified: [amauta.py, services/amauta-daemon.py]

key-decisions:
  - "_skb_promote returns True/False instead of None -- backward-compatible since all 3 callers ignored return"
  - "Trigram fallback requires min 3 chars per text -- sub-3-char texts return 0.0 (no meaningful trigrams)"

patterns-established:
  - "threading.Event pattern: module-level Event, .is_set() loop condition, .wait(timeout=) for sleep, .set() in signal handler"
  - "Genealogy cleanup on bulk removal: iterate remaining items, filter children arrays by removed ID set"

requirements-completed: [FIX-07, FIX-08, FIX-09, FIX-10]

# Metrics
duration: 8min
completed: 2026-03-25
---

# Plan 21-01: Minor Bug Fixes Summary

**Jaccard trigram fallback, Event-based retention shutdown, archive genealogy cleanup, SKB dedup observability**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-25
- **Completed:** 2026-03-25
- **Tasks:** 4
- **Files modified:** 2

## Accomplishments
- `_jaccard_similarity` now falls back to character trigrams when word extraction yields empty sets (sub-3-char words)
- Retention thread uses `threading.Event.wait(timeout=)` for SIGTERM-interruptible sleep instead of `time.sleep(86400)`
- `cmd_archive` strips archived task IDs from remaining parents' `children` arrays (reuses `cmd_delete` pattern)
- `_skb_promote` returns `True`/`False` for dedup observability; `_auto_write_learning` logs "SKB dedup hit" when skipped

## Task Commits

Each task was committed atomically:

1. **Task 1: FIX-07 Jaccard short-word fallback** - `cd197b3` + `ca840f6` (fix -- trigram fallback + empty-string guard)
2. **Task 2: FIX-08 Retention thread graceful shutdown** - `e16a920` (fix)
3. **Task 3: FIX-09 Archive genealogy cleanup** - `f72b4d4` (fix)
4. **Task 4: FIX-10 Auto-learn SKB dedup** - `e94eb98` (fix)

## Files Created/Modified
- `amauta.py` - _jaccard_similarity trigram fallback, cmd_archive children cleanup, _skb_promote return values, _auto_write_learning dedup log
- `services/amauta-daemon.py` - _shutdown_event Event, retention thread loop, shutdown_handler

## Decisions Made
- Trigram fallback guards texts < 3 chars with early return 0.0 -- no meaningful trigrams possible
- _skb_promote return change is backward-compatible (all 3 callers verified to ignore return value)
- Used `is False` check (not just falsy) in caller to distinguish dedup-skip from mem-unavailable (None)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Edge Case] Empty string trigram guard**
- **Found during:** Task 1 (FIX-07 testing)
- **Issue:** Empty strings produced `{""}` set via fallback, making `_jaccard_similarity("", "")` return 1.0
- **Fix:** Added `len(text_a) < 3 or len(text_b) < 3` guard before trigram computation
- **Files modified:** amauta.py
- **Verification:** All 6 inline tests pass, 6/6 pytest TestJaccardSimilarity pass
- **Committed in:** ca840f6 (separate commit from initial FIX-07)

---

**Total deviations:** 1 auto-fixed (1 edge case)
**Impact on plan:** Essential correctness fix caught during testing. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 21 complete (1/1 plans, 4/4 requirements)
- Phase 22 (Core System Tests) is now unblocked -- will validate FIX-09 and FIX-10
- Phase 23 (Integration Tests) will validate FIX-08 retention shutdown behavior

---
*Phase: 21-minor-bug-fixes*
*Completed: 2026-03-25*
