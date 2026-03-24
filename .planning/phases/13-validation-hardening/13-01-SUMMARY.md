---
phase: 13-validation-hardening
plan: 01
subsystem: validation
tags: [argparse, gates, test-evidence, learning, audit]

requires:
  - phase: 12-semantic-memory-pipeline
    provides: semantic search and memory pipeline (no direct dependency, but same codebase)
provides:
  - --force-reason on validate with mandatory justification string
  - --test-exempt flag for tasks without testable behaviors
  - Tightened test evidence patterns (no 100-char proxy, no loose regex)
  - LEARNING gate >=100 chars with structured keyword requirement
affects: [14-pipeline-integration, agent-prompts, executor-workflows]

tech-stack:
  added: []
  patterns: [force-reason audit trail, test-exempt gate skip, structured test evidence]

key-files:
  created: []
  modified:
    - amauta.py
    - get-shit-done/bin/gsd-amauta.cjs
    - services/amauta-daemon.py
    - tests/test_gates.py
    - tests/validation-gates.test.cjs
    - tests/comprehensive-e2e.test.cjs
    - tests/e2e-advanced.test.cjs
    - tests/e2e-lifecycle.test.cjs
    - tests/gsd-amauta.test.cjs
    - tests/pipeline-offline.test.cjs

key-decisions:
  - "--force-reason uses type=str with default='' so empty string is falsy and non-empty is truthy"
  - "Removed 6 loose test evidence patterns and added 5 strong ones (shell prompt, REPL, pytest, Jest)"
  - "LEARNING threshold 20->100 chars applies to D-phase primary and all phases fallback"
  - "test_exempt as keyword-only arg to _validate_all_gates for backward compatibility"
  - "CJS wrapper and daemon both updated to pass --force-reason as key-value pair"

patterns-established:
  - "Key-value argparse flags use dest= for snake_case Python attributes from hyphenated CLI args"
  - "Gate SKIP status used for explicit exemptions (test_exempt, non-code tasks)"
  - "Audit metadata includes justification text for forced validations"

requirements-completed: [GATE-01, GATE-02, GATE-03]

duration: 35min
completed: 2026-03-24
---

# Phase 13 Plan 01: Core Gate Tightening Summary

**Replaced --force with --force-reason requiring justification, removed gameable test evidence proxy, tightened LEARNING to >=100 chars, added --test-exempt escape hatch**

## Performance

- **Duration:** 35 min
- **Started:** 2026-03-24T08:30:46Z
- **Completed:** 2026-03-24T09:05:46Z
- **Tasks:** 5
- **Files modified:** 10

## Accomplishments
- All 11 bypass points in cmd_validate now require --force-reason with justification text recorded in audit
- 100-char content proxy removed from _has_test_evidence, plus 6 loose regex patterns stripped
- LEARNING gate threshold increased from 20 to 100 chars with cross-phase quality verification
- --test-exempt flag provides clean escape for scaffolding and docs-only tasks
- 38 Python tests pass (7 new), 38 CJS validation-gates tests pass, 73 e2e-advanced pass, 59 pipeline-offline pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace --force with --force-reason in argparse and cmd_validate** - `4daeef2` (feat)
2. **Task 2: Tighten _has_test_evidence -- remove 100-char proxy and loose patterns** - `535d3c7` (feat)
3. **Task 3: Add --test-exempt flag to validate command** - `4da09e0` (feat)
4. **Task 4: Tighten LEARNING gate threshold from 20 to 100 chars** - `3a409c7` (feat)
5. **Task 5: Update all test files for --force-reason and tightened gates** - `da83bce` (test)

## Files Created/Modified
- `amauta.py` - argparse, cmd_validate, _has_test_evidence, _validate_all_gates, audit metadata
- `get-shit-done/bin/gsd-amauta.cjs` - parseFlags, cmdValidate, help text
- `services/amauta-daemon.py` - flag_map for force_reason key-value passing
- `tests/test_gates.py` - 7 new tests, updated thresholds, proxy removal verification
- `tests/validation-gates.test.cjs` - parseFlags tests, --force-reason CLI tests, LEARNING blocks
- `tests/comprehensive-e2e.test.cjs` - 8 --force-reason migrations, LEARNING block extensions
- `tests/e2e-advanced.test.cjs` - LEARNING blocks extended to >=100 chars, --force-reason
- `tests/e2e-lifecycle.test.cjs` - --force-reason migration
- `tests/gsd-amauta.test.cjs` - --force-reason migration
- `tests/pipeline-offline.test.cjs` - --force-reason migration

## Decisions Made
- Used type=str with default="" for --force-reason (empty string is falsy, any content is truthy) -- avoids separate validation step
- Kept --force as boolean on add and status commands (only validate changed)
- Added force_reason string to audit metadata dict for compliance traceability
- test_exempt is keyword-only on _validate_all_gates to maintain backward compatibility
- Updated CJS wrapper and daemon to properly handle --force-reason as key-value pair (not boolean)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] CJS wrapper and daemon needed --force-reason updates**
- **Found during:** Task 5 (test file updates)
- **Issue:** CJS wrapper (gsd-amauta.cjs) had its own parseFlags with --force as boolean, and daemon flag_map passed --force as boolean flag
- **Fix:** Updated CJS parseFlags for --force-reason key-value, updated cmdValidate gate check and direct CLI args, updated daemon flag_map
- **Files modified:** get-shit-done/bin/gsd-amauta.cjs, services/amauta-daemon.py
- **Verification:** All 38 validation-gates tests pass, all 73 e2e-advanced tests pass
- **Committed in:** da83bce (Task 5 commit)

**2. [Rule 1 - Bug] Test LEARNING blocks needed >=100 chars**
- **Found during:** Task 5 (test file updates)
- **Issue:** Test fixtures in 4 CJS test files had LEARNING blocks with 27-77 chars, failing the new 100-char threshold
- **Fix:** Extended all LEARNING blocks in test fixtures to >=100 chars with substantive content
- **Files modified:** tests/validation-gates.test.cjs, tests/comprehensive-e2e.test.cjs, tests/e2e-advanced.test.cjs
- **Verification:** All tests pass with extended LEARNING content
- **Committed in:** da83bce (Task 5 commit)

**3. [Rule 1 - Bug] comprehensive-e2e test 2.9 "merged" keyword was pre-existing false pass**
- **Found during:** Task 5
- **Issue:** Test assumed "merged" keyword satisfies Python Gate 4 PR_URL, but Python only checks for actual URLs (CJS wrapper has broader check)
- **Fix:** Added actual PR URL to test D-phase to make Gate 4 pass legitimately
- **Files modified:** tests/comprehensive-e2e.test.cjs
- **Verification:** Test 2.9 now passes with real URL
- **Committed in:** da83bce (Task 5 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs)
**Impact on plan:** All auto-fixes necessary for correctness. CJS wrapper and daemon updates were implicit dependencies not listed in the plan but required for end-to-end --force-reason flow.

## Issues Encountered
- Pre-existing test_rlm_enrichment.py::test_rlm_empty_result_no_crash failure (unrelated to this plan)
- Pre-existing comprehensive-e2e.test.cjs 6.12 migration count test failure (expects 5 UP, now has 6)

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 13-01 complete, ready for 13-02 (self-validation block, mandatory --note on failed/deferred, forced:true audit on status)
- Both plans are Wave 1 and independent, so 13-02 can proceed immediately

---
*Phase: 13-validation-hardening*
*Completed: 2026-03-24*
