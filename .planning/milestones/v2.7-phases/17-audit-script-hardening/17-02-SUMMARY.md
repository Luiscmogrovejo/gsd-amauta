---
phase: 17-audit-script-hardening
plan: 17-02
subsystem: testing
tags: [audit, verify-v26, node-test, regression-tests, checkVerificationFiles, parseNpmFailures, buildReport]

requires:
  - phase: 17-01-audit-script-hardening
    provides: checkVerificationFiles() with form field, parseNpmFailures() returning structured objects, buildReport() with schema_version:2 and tooling_bugs_observed, module.exports exposing all test-target functions

provides:
  - tests/17-audit-script-hardening.test.cjs with 15 tests covering all three AUDIT-* fixes
  - AUDIT-01: prefixed form detection, unprefixed fallback, form=none, DOGFOOD-05 regression guard, both-exist collision
  - AUDIT-02: node --test format parsing, { test_file, test_name, reason } shape, empty-output, legacy FAIL fallback, classifyFailures structured object handling
  - AUDIT-03: TOOLING_BUGS_SEED structure, required field shape, buildReport schema_version+tooling_bugs_observed, generateMarkdown Tooling Bugs before Hygiene Debt, Schema version in Summary table

affects: [18-sampling-pool-expansion, 19-dynamic-ledger-schema]

tech-stack:
  added: []
  patterns:
    - node:test framework with assert/strict for CJS regression tests
    - Live filesystem tests (checkVerificationFiles operating on real repo) for integration coverage
    - Synthetic fixture strings (inline node --test output) for parser isolation tests
    - Minimal deterministic mock for buildReport -- only verification_files.per_phase shape required

key-files:
  created:
    - tests/17-audit-script-hardening.test.cjs
  modified: []

key-decisions:
  - "AUDIT-01 tests call the real checkVerificationFiles() against the live repo — no temp-dir fixture needed because the proof of fix IS the real phase directories. Phase 14 has 14-VERIFICATION.md (prefixed), Phase 10 has VERIFICATION.md (unprefixed), Phase 13.1 has neither. Both-exist collision tested inline with temp dir."
  - "buildReport(deterministic, null, envCheck) call with behavioral=null is safe — buildReport has an explicit null guard (lines 529-547) that falls into the skipped branch. No TypeError."
  - "AUDIT-02 classifyFailures test uses PRE_EXISTING_NPM_FAILURES constant (exported) rather than a hardcoded list — test stays in sync with the module's own definition automatically."

patterns-established:
  - "Live-repo integration tests are acceptable for filesystem-dependent functions when the real filesystem is the authoritative fixture (no synthetic dir needed)"
  - "Parser isolation tests with inline fixture strings keep node --test output format tests fast and deterministic"

requirements-completed: [AUDIT-01, AUDIT-02, AUDIT-03]

duration: 15min
completed: 2026-04-10
---

# Plan 17-02: Regression Tests for AUDIT-01, AUDIT-02, AUDIT-03 Summary

**15 node:test regression tests covering all three AUDIT-* fixes to scripts/verify-v26.cjs -- prefix-form probe, structured npm failure parsing, and tooling_bugs_observed schema**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-10T23:10:00Z
- **Completed:** 2026-04-10T23:25:00Z
- **Tasks:** 3 (serial: 17-02-01 → 17-02-02 → 17-02-03)
- **Files modified:** 1

## Accomplishments

- `tests/17-audit-script-hardening.test.cjs` created with 15 tests — all 15 pass via `node --test`
- AUDIT-01 coverage: 5 tests including prefixed form (Phase 14), unprefixed fallback (Phase 10), form=none (Phase 13.1), DOGFOOD-05 regression guard, and both-exist collision where prefixed wins
- AUDIT-02 coverage: 5 tests including node --test format parsing with real fixture, shape validation, empty-output edge case, legacy FAIL fallback, and classifyFailures with structured objects
- AUDIT-03 coverage: 5 tests including TOOLING_BUGS_SEED depth-7/depth-8 entries, required field shape, buildReport schema_version and tooling_bugs_observed, generateMarkdown rendering order (Tooling Bugs before Hygiene Debt), Schema version in Summary table

## Task Commits

1. **Task 17-02-01: AUDIT-01 tests** - `d24d0d2` (tests)
2. **Task 17-02-02: AUDIT-02 tests** - `98450b3` (tests)
3. **Task 17-02-03: AUDIT-03 tests** - `b36aa82` (tests)

## Files Created/Modified

- `tests/17-audit-script-hardening.test.cjs` — 15 regression tests, 277 lines

## Decisions Made

- **Live-repo tests for AUDIT-01:** `checkVerificationFiles()` operates on the real `.planning/milestones/` directory tree. The real phase directories ARE the authoritative fixture. Phase 14 has `14-VERIFICATION.md` (prefixed), Phase 10 has `VERIFICATION.md` (unprefixed), Phase 13.1 has neither. No temp-dir needed for these cases.
- **Both-exist collision uses temp dir:** The collision case (both prefixed and unprefixed exist simultaneously) cannot be replicated in the real repo, so a temp dir with both files is the correct approach.
- **buildReport null behavioral is safe:** Confirmed the function has an explicit null guard before accessing behavioral properties. No TypeError.
- **PRE_EXISTING_NPM_FAILURES used directly:** classifyFailures test imports the constant rather than hardcoding the list, so it stays in sync automatically.

## Deviations from Plan

None - plan executed exactly as written. All three tasks executed serially as required, all appended to the same file without conflict.

## Issues Encountered

None. All 15 tests passed on first run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 17 complete. Both plans (17-01 and 17-02) are done.
- Phase 18 (Sampling Pool Expansion) is unblocked — audit surface is now stable and tested.
- No blockers.

---
*Phase: 17-audit-script-hardening*
*Completed: 2026-04-10*
