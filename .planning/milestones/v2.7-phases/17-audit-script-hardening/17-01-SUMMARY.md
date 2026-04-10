---
phase: 17-audit-script-hardening
plan: 17-01
subsystem: testing
tags: [audit, verify-v26, npm-test-parser, schema-versioning, tooling-bugs]

requires:
  - phase: 16-init-resolver-fix
    provides: resolver test patterns; stable init surface for audit script work

provides:
  - checkVerificationFiles() probes both prefixed and unprefixed VERIFICATION.md forms
  - parseNpmFailures() returns structured { test_file, test_name, reason } objects
  - classifyFailures() handles structured npm failure entries via exact basename match
  - buildReport() emits schema_version: 2 and tooling_bugs_observed with TOOL-01/TOOL-02 seed entries
  - generateMarkdown() renders Tooling Bugs Observed table before Hygiene Debt Observed
  - module.exports includes parseNpmFailures, checkVerificationFiles, findPhaseDir, classifyFailures, TOOLING_BUGS_SEED

affects: [17-02-regression-tests, 18-sampling-pool-expansion]

tech-stack:
  added: []
  patterns:
    - Dual-probe file lookup (prefixed-wins-over-unprefixed) for VERIFICATION.md discovery
    - Structured failure objects { test_file, test_name, reason } from node --test runner output
    - TOOLING_BUGS_SEED constant for seed-populating tooling_bugs_observed without runtime scanning
    - schema_version integer field (absence = version 1, explicit = version N) for report provenance

key-files:
  created: []
  modified:
    - scripts/verify-v26.cjs

key-decisions:
  - "Tasks 17-01-01 and core of 17-01-02 (checkVerificationFiles dual-probe + parseNpmFailures rewrite + classifyFailures update) were already committed (6be5cf6) from a prior session. Surfaced as a divergence observation rather than silent re-execution."
  - "generateMarkdown renderer for structured failures uses typeof check for backward compatibility — string entries still render as plain bullet, structured entries render as backtick-filename format."
  - "tooling_bugs_observed placed after hygiene_debt_observed in buildReport() return object key ordering (matches plan spec). In generateMarkdown(), Tooling Bugs section renders BEFORE Hygiene Debt section — ordering difference is intentional: key ordering in JSON is arbitrary, rendering order is by importance."

patterns-established:
  - "Dual-probe pattern: probe prefixed form first, fall through to unprefixed, record 'form' field with which convention matched"
  - "Backward-compatible renderer: typeof entry === 'string' guard on structured-object arrays allows progressive adoption"

requirements-completed: [AUDIT-01, AUDIT-02, AUDIT-03]

duration: 25min
completed: 2026-04-10
---

# Plan 17-01: Audit Script Three-Fix Bundle Summary

**Three-fix bundle to scripts/verify-v26.cjs: dual-probe VERIFICATION.md discovery (AUDIT-01), structured npm failure objects (AUDIT-02), and tooling_bugs_observed schema with schema_version: 2 (AUDIT-03)**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-10T22:40:00Z
- **Completed:** 2026-04-10T23:05:00Z
- **Tasks:** 5 (1 pre-committed from prior session, 4 executed this session)
- **Files modified:** 1

## Accomplishments

- `checkVerificationFiles()` now probes `<phase>-VERIFICATION.md` first, then falls back to `VERIFICATION.md` — Phase 14 will be marked present (not missing) when the audit re-runs
- `parseNpmFailures()` parses actual `node --test` runner output (Unicode cross mark ✖ + `test at` file reference) and returns `{ test_file, test_name, reason }` structured objects; `classifyFailures()` updated to compare `entry.test_file` via exact basename match
- `buildReport()` emits `schema_version: 2` and `tooling_bugs_observed: TOOLING_BUGS_SEED` — depths 7 and 8 from the v2.6 ledger are now machine-readable fields in the report
- `generateMarkdown()` renders a Tooling Bugs Observed table (before Hygiene Debt) and a Schema version row in the Summary table
- `module.exports` exposes `parseNpmFailures`, `checkVerificationFiles`, `findPhaseDir`, `classifyFailures`, `TOOLING_BUGS_SEED` for Plan 17-02 regression tests

## Task Commits

1. **Task 17-01-01: AUDIT-01 prefix probe** - `6be5cf6` (feat) — prior session
2. **Task 17-01-02: parseNpmFailures + classifyFailures rewrite** - `6be5cf6` (feat) — prior session (bundled in same commit)
3. **Task 17-01-02 (renderer): generateMarkdown structured failure rendering** - `9400044` (feat)
4. **Task 17-01-03: TOOLING_BUGS_SEED + schema_version + tooling_bugs_observed** - `2840428` (feat)
5. **Task 17-01-04: Tooling Bugs Observed section in generateMarkdown** - `6403481` (feat)
6. **Task 17-01-05: Export additions to module.exports** - `4e731b8` (feat)

## Files Created/Modified

- `scripts/verify-v26.cjs` — all three AUDIT-* fixes applied, exports extended

## Decisions Made

- **Prior session pre-commit:** Tasks 17-01-01 and the core of 17-01-02 were already committed (6be5cf6) before this session. Surfaced as a divergence observation at R-phase. Remaining work was correctly identified and executed without re-running completed work.
- **Renderer backward compatibility:** `generateMarkdown()` renders structured failure objects with `typeof f === 'string'` guard so any pre-Phase-17 callers passing flat strings still work correctly.
- **tooling_bugs_observed placement in JSON vs Markdown:** In the JSON return object, `tooling_bugs_observed` follows `hygiene_debt_observed`. In the Markdown renderer, Tooling Bugs Observed section renders BEFORE Hygiene Debt Observed — bugs affect audit correctness, debt is cosmetic. The ordering difference is intentional.

## Deviations from Plan

**1. Tasks 17-01-01 and 17-01-02 (core logic) pre-committed from prior session**
- **Found during:** R-phase — reading scripts/verify-v26.cjs showed dual-probe logic and structured parseNpmFailures already in place
- **Issue:** Plan tasks 1-2 were already fully implemented and committed (6be5cf6)
- **Fix:** Surfaced as observation (not silent absorption). Remaining work (generateMarkdown renderer, buildReport schema, Tooling Bugs section, exports) correctly executed as tasks 17-01-02 partial through 17-01-05
- **Verification:** All 6 plan verification criteria pass
- **Impact:** Zero scope creep. Prior work carried forward cleanly.

---

**Total deviations:** 1 (prior-session pre-commit, surfaced and handled correctly)
**Impact on plan:** None — prior work was valid and carried forward. All plan verification criteria satisfied.

## Issues Encountered

None — plan executed cleanly. Prior-session pre-commit was detected early and handled.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 17-01 complete. `scripts/verify-v26.cjs` has all three AUDIT-* fixes applied.
- Plan 17-02 (regression tests) is unblocked — all functions and constants are now exported.
- No blockers.

---
*Phase: 17-audit-script-hardening*
*Completed: 2026-04-10*
