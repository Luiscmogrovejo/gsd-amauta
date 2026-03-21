---
phase: 03-memory-rlm
plan: 01
subsystem: memory
tags: [sqlite, postgresql, memory, tag-normalization, distillation, session-learning]

requires:
  - phase: 02-rpetd-enforcement
    provides: gate enforcement, daemon infrastructure
provides:
  - SQLite/PG memory result shape parity
  - Tag synonym normalization on store and search
  - Auto-capture endpoint for session learnings
  - Distill-status and tag-stats server-side endpoints
  - Enhanced status command with per-source breakdown
affects: [memory, rlm, daemon, cli]

tech-stack:
  added: []
  patterns:
    - "TAG_SYNONYMS map shared across Python stores and CJS CLI"
    - "normalize_tags() applied on both storage and search paths"
    - "Server-side distill threshold check via /api/memory/distill-status"

key-files:
  created:
    - tests/test_memory_parity.py
  modified:
    - services/sqlite_store.py
    - services/pg_store.py
    - services/amauta-daemon.py
    - get-shit-done/bin/gsd-memory.cjs

key-decisions:
  - "Tag synonym map duplicated in Python and JS (no shared config file — keeps zero-dependency constraint)"
  - "normalize_tags applied on both store and search for consistency"
  - "Auto-capture truncates context to 4000 chars (memory entries should be concise)"
  - "distill-status endpoint returns threshold from env var, keeping config server-side"

patterns-established:
  - "Result shape normalization: pop rowid, round floats, parse JSON fields in _score_memories"
  - "Server-side stats endpoints (distill-status, tag-stats) for CLI consumption"

requirements-completed: [MEM-01, MEM-02, MEM-03, MEM-04, MEM-05]

duration: 7min
completed: 2026-03-21
---

# Phase 3 Plan 01: Memory System Hardening Summary

**SQLite/PG result parity, tag synonym normalization, auto-capture endpoint, distill-status, and enhanced status with per-source breakdown**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-21T18:56:14Z
- **Completed:** 2026-03-21T19:03:26Z
- **Tasks:** 6
- **Files modified:** 5

## Accomplishments
- SQLite _score_memories output now matches PG shape exactly (no rowid, correct float types)
- Tag synonyms normalized on store and search in both Python stores and CJS CLI (15 synonym mappings)
- POST /api/memory/auto-capture endpoint with session-learning source and cmdAutoCapture CLI command
- GET /api/memory/distill-status endpoint with per-source counts and threshold check
- GET /api/memory/tag-stats endpoint with top-20 tag distribution
- cmdStatus enhanced: per-source breakdown, distillation status, tag distribution, enriched JSON output
- 16 parity tests covering search keys/types, list shape, tag normalization, count_by_source, tag_stats

## Task Commits

Each task was committed atomically:

1. **Task 1: Normalize SQLite result shapes (MEM-01)** - `7a97f88` (feat)
2. **Task 2: Tag synonym normalization (MEM-04)** - `263c022` (feat)
3. **Task 3: Auto-capture endpoint (MEM-02)** - `cb99388` (feat)
4. **Task 4: Distill-status endpoint (MEM-03)** - `fe6fe8c` (feat)
5. **Task 5: Enhanced status command (MEM-05)** - `efaca34` (feat)
6. **Task 6: Parity tests** - `5e3e76b` (test)

## Files Created/Modified
- `services/sqlite_store.py` - Added TAG_SYNONYMS, normalize_tags, rowid removal, memory_count_by_source, memory_tag_stats
- `services/pg_store.py` - Added TAG_SYNONYMS, normalize_tags, memory_count_by_source, memory_tag_stats
- `services/amauta-daemon.py` - Added auto-capture, distill-status, tag-stats endpoints
- `get-shit-done/bin/gsd-memory.cjs` - Added TAG_SYNONYMS, normalizeTags, cmdAutoCapture, enhanced cmdStatus
- `tests/test_memory_parity.py` - 16 parity tests for SQLiteStore result shapes

## Decisions Made
- Tag synonym map duplicated in Python and JS (no shared config file) to maintain zero-dependency constraint
- normalize_tags applied on both store and search paths for consistency (prevents stale synonym mismatches)
- Auto-capture truncates to 4000 chars (concise memory entries)
- distill-status reads threshold from GSD_MEMORY_DISTILL_THRESHOLD env (default: 500)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Memory system hardened for both SQLite and PG backends
- Ready for Plan 03-02 (RLM enhancements)
- Tag normalization ensures cross-project search accuracy

---
*Phase: 03-memory-rlm*
*Completed: 2026-03-21*
