---
phase: 17-task-manager-reliability
plan: "01"
subsystem: task-manager
tags: [file-locking, archive, toctou, concurrency, python]

requires:
  - phase: 16-data-integrity
    provides: clean task data baseline
provides:
  - cmd_archive command (done tasks >N days to archive file)
  - reentrant _file_lock (thread-local, no deadlock on nested calls)
  - TOCTOU race fix (17 mutating cmd_* wrapped in _file_lock before load())
  - show --archive fallback lookup
affects: [17-task-manager-reliability, daemon-watchdog, reconciliation]

tech-stack:
  added: [threading.local]
  patterns: [reentrant-file-lock, atomic-archive-write, age-based-archival]

key-files:
  created:
    - tests/17-01-archive-toctou.test.cjs
  modified:
    - amauta.py

key-decisions:
  - "Reentrant lock via thread-local flag rather than removing lock from save() -- save() remains safe for standalone calls"
  - "Archive always checked as show fallback (no explicit --archive flag required)"
  - "17 mutating cmd_* wrapped mechanically via Python AST-aware script -- zero manual edits"

patterns-established:
  - "Reentrant file lock: _lock_held thread-local flag, _acquired instance flag, skip acquisition when already held"
  - "Archive persistence: _load_archive/_save_archive with same atomic write pattern as save()"

requirements-completed: [TASK-01, TASK-02]

duration: 6min
completed: 2026-03-25
---

# Phase 17 Plan 01: Archive Command + TOCTOU Race Fix Summary

**cmd_archive moves done tasks >N days to tasks-archive.json; reentrant _file_lock wraps all 17 mutating cmd_* functions to prevent TOCTOU races**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-25T03:05:19Z
- **Completed:** 2026-03-25T03:12:16Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Archive command with --days, --dry-run, idempotent operation, and age-based filtering
- Reentrant _file_lock using thread-local flag -- nested calls (cmd_atomize -> cmd_add -> save) don't deadlock
- All 17 mutating cmd_* functions wrapped in _file_lock before load() -- serializes concurrent access
- 10 read-only functions intentionally NOT wrapped (no contention for reads)
- 13 tests covering archive behavior, lock reentrancy, and AST verification of wrapping

## Task Commits

Each task was committed atomically:

1. **Task 1: cmd_archive + reentrant _file_lock + archive persistence** - `e2b63ad` (feat)
2. **Task 2: TOCTOU fix -- wrap 17 mutating cmd_* in _file_lock** - `b6eab79` (fix)
3. **Task 3: Tests for archive and TOCTOU verification** - `e07ce77` (test)

## Files Created/Modified
- `amauta.py` - Added cmd_archive, _load_archive, _save_archive, ARCHIVE_FILE, reentrant _file_lock, wrapped 17 mutating functions
- `tests/17-01-archive-toctou.test.cjs` - 13 tests across 3 describe blocks

## Decisions Made
- Made _file_lock reentrant via thread-local flag rather than removing lock from save() -- save() remains independently safe for any caller
- Archive fallback is automatic in cmd_show (no explicit --archive flag required, though flag is registered for explicitness)
- Used mechanical Python AST-aware wrapping script to wrap all 17 functions in a single operation -- zero manual edits, zero missed functions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Python 3.12+ removed `ast.Str` (deprecated since 3.8). AST check tests initially used `ast.Constant, ast.Str` tuple -- fixed to use only `ast.Constant` for forward compatibility.

## Next Phase Readiness
- Plan 17-01 complete. Ready for 17-02 (stale watchdog + retry flush).
- Archive infrastructure in place for any future gc/prune commands.
- Reentrant lock pattern established for any new mutating functions added in future phases.

---
*Phase: 17-task-manager-reliability*
*Completed: 2026-03-25*
