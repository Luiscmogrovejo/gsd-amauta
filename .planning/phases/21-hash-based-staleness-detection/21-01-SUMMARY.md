---
phase: 21-hash-based-staleness-detection
plan: 21-01
subsystem: context
tags: [hashlib, sha256, subprocess, git-diff, staleness-detection, rpetd-context]

# Dependency graph
requires:
  - phase: 20-structured-context-handoffs
    provides: RPETDContext model with file_hashes JSONB column pre-created in migration 009

provides:
  - ContextValidator class with compute_file_hash, changed_since, selective_refresh, compute_file_hashes
  - SHA-256 file hashing (64-char hex digest, chunked binary reads, None for missing files)
  - git diff --name-only intersection with file_hashes keys for change detection
  - Selective description refresh: regenerates only stale files, caches unchanged
  - 13 unit tests across 3 test classes covering STALE-01, STALE-02, STALE-03

affects: [21-02-orchestrator-wiring, 24-semantic-cache-tiered-routing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ContextValidator as a pure static-method class — no instance state, all operations are functions"
    - "safe fallback: git errors / missing commit_ref return all-changed rather than crashing"
    - "selective_refresh returns structured result dict with refreshed_count + cached_count for [STALE] log"
    - "description_fn failures fall back to cached description, never abort the refresh"
    - "file gone (unreadable during refresh) is silently dropped from tracking"

key-files:
  created:
    - services/context_validator.py
    - tests/test_context_validator.py
  modified: []

key-decisions:
  - "compute_file_hash reads in binary mode ('rb') to avoid platform line-ending differences between Windows/Unix"
  - "chunked reads (8192 bytes) — handles large files without full memory load"
  - "compute_file_hash returns None (not empty string, not raises) for missing files — callers treat None as 'needs refresh'"
  - "changed_since without commit_ref returns all file_hashes keys (safe first-run fallback)"
  - "selective_refresh captures get_current_commit() in the result dict so caller can persist for next cycle"
  - "[STALE] log line emitted via log.info inside selective_refresh — STALE-04 can grep it"
  - "compute_file_hashes (plural) is a batch wrapper for initial context creation when no prior hashes exist"

patterns-established:
  - "ContextValidator static method pattern: all methods @staticmethod — no __init__ required by callers"
  - "git subprocess pattern: capture_output=True, text=True, timeout=N, cwd=project_dir — matches amauta-daemon.py style"
  - "test pattern: import-inside-test-method (from services.X import Y) — consistent with test_rpetd_context.py"
  - "test pattern: tempfile.NamedTemporaryFile + os.unlink in try/finally for real filesystem hash tests"
  - "test pattern: @patch('services.context_validator.subprocess.run') for git subprocess mocking"

requirements-completed:
  - STALE-01
  - STALE-02
  - STALE-03

# Metrics
duration: 25min
completed: 2026-04-12
---

# Phase 21 Plan 01: ContextValidator Core — Hash-Based Staleness Detection Summary

**ContextValidator class with SHA-256 file hashing, git-diff change detection, and selective description refresh that skips unchanged files**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-12
- **Completed:** 2026-04-12
- **Tasks:** 4
- **Files created:** 2

## Accomplishments

- `services/context_validator.py` — ContextValidator class with 4 static methods covering STALE-01/02/03
- `compute_file_hash` returns 64-char SHA-256 hex digest via chunked binary reads; None for missing files
- `changed_since` runs git diff --name-only against stored commit_ref, intersects with file_hashes keys, safe fallback on error
- `selective_refresh` regenerates descriptions for only stale files, preserves cached data for unchanged, emits `[STALE] N refreshed M cached` log line
- 13 pytest unit tests all pass; zero CJS regression failures

## Task Commits

1. **Task 21-01-01: STALE-01 compute_file_hash** — `93e98db` (feat)
2. **Task 21-01-02: STALE-02 changed_since + get_current_commit** — `d4dc68f` (feat)
3. **Task 21-01-03: STALE-03 selective_refresh + compute_file_hashes** — `14e3ab7` (feat)
4. **Task 21-01-04: Unit tests for all three methods** — `f4afd91` (test)

## Files Created/Modified

- `/Users/luismogrovejo/Code/gsd-amauta/services/context_validator.py` — ContextValidator class, 229 LOC
- `/Users/luismogrovejo/Code/gsd-amauta/tests/test_context_validator.py` — 13 tests across 3 classes (TestComputeFileHash, TestChangedSince, TestSelectiveRefresh)

## Decisions Made

- Binary reads (`"rb"`) prevent platform line-ending hash divergence
- None return (not raises, not "") for unreadable files allows callers to treat missing files as "needs refresh"
- `commit_ref` always included in `selective_refresh` result so orchestrator can store it without a second call
- Test collected 13 (not 12) — plan said "at least 12"; `test_compute_file_hashes_batch` added as the 6th STALE-01 test per the plan's listed test coverage table

## Deviations from Plan

None — plan executed exactly as written. Test count is 13 (plan estimated 12); the extra test (`test_compute_file_hashes_batch`) was explicitly listed in the plan's task 21-01-04 coverage table under "STALE-01 (6 tests)".

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 21-01 complete: STALE-01, STALE-02, STALE-03 satisfied
- Plan 21-02 (STALE-04: orchestrator wiring) is now unblocked
- `services/context_validator.py` is ready to import — `from services.context_validator import ContextValidator`
- The `file_hashes` JSONB column in `rpetd_context` table was pre-created by migration 009 (Phase 20) — no schema change needed for 21-02

---
*Phase: 21-hash-based-staleness-detection*
*Completed: 2026-04-12*
