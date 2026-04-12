---
phase: 19-dynamic-ledger-schema
plan: 19-01
subsystem: testing
tags: [verify-v26, dogfood-ledger, schema, node-test, dynamic-scan]

# Dependency graph
requires:
  - phase: 18-sampling-pool-expansion
    provides: sampling_health schema v3 and graceful degradation cascade pattern
provides:
  - scanDogfoodLedgerDepths(memoryDir, ledgerPath) function with dual-source union and three-tier degradation
  - schema_version bumped to 4 in buildReport()
  - generateMarkdown Scan source line in Dogfood Ledger Status section
  - 8 regression tests covering all four degradation tiers
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - dual-source scan with three-tier degradation cascade (full -> ledger-only -> memory-only -> static fallback)
    - temp-dir fixture pattern for filesystem-dependent pure functions

key-files:
  created:
    - tests/19-ledger-scan.test.cjs
  modified:
    - scripts/verify-v26.cjs

key-decisions:
  - "Gap computation covers {0..max} \\ union, not the full integer space — gaps only appear within the captured range"
  - "Test fixture for 'Not yet observed' gap detection requires surrounding captured depths to exercise the gap set difference"
  - "buildLedgerFixture helper centralizes table generation in test file, keeping fixtures readable"

patterns-established:
  - "Dual-source scan: parse structured table (primary) + scan memory files (secondary); union both Sets"
  - "Three-tier degradation: full union -> single-source -> static fallback with explicit observation strings per tier"
  - "scanDogfoodLedgerDepths accepts both params for testability; production call uses defaults"

requirements-completed:
  - SCHEMA-01

# Metrics
duration: 25min
completed: 2026-04-12
---

# Phase 19: Dynamic Ledger Schema Summary

**scanDogfoodLedgerDepths dual-source scan (ledger table + memory dir) with three-tier degradation replaces the static Wave-1 depth arrays, schema_version bumped to 4**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-12
- **Completed:** 2026-04-12
- **Tasks:** 2
- **Files modified:** 2 (scripts/verify-v26.cjs modified, tests/19-ledger-scan.test.cjs created)

## Accomplishments

- `scanDogfoodLedgerDepths(memoryDir, ledgerPath)` added to `scripts/verify-v26.cjs` — parses `docs/v2.6-dogfood-ledger.md` structured table (regex `/^\|\s*(\d+)\s*\|/`) and globs `project_*dogfood*.md` memory files (regex `/[Dd]epth[-:\s]+(\d+)/`), unions both Sets, computes gaps via set difference
- Three-tier degradation cascade: full union -> ledger only -> memory only -> static fallback `[0,1,2,4,5,6,7,8,9,10,11]`; each partial tier logs a `ledger_scan_degraded:` observation
- `buildReport()` wired: `const _ledgerScan = scanDogfoodLedgerDepths()` at top, static lines replaced with `_ledgerScan.depths/gaps/source/observations`; `schema_version` bumped 3 → 4
- `generateMarkdown()` Dogfood Ledger Status section extended with `Scan source: <source>` line
- Live scan returns `depths: [0,1,2,4,5,6,7,8,9,10,11]`, `gaps: [3]`, `source: "ledger + memory"` — exactly the expected post-Phase-19 state
- 8 regression tests in `tests/19-ledger-scan.test.cjs`: all four degradation tiers, gap detection, memory regex formats, empty-dir edge case, no-gaps contiguous range; all 8 pass

## Task Commits

1. **Task 19-01-01: scanDogfoodLedgerDepths + schema v4** — `bd3dc93` (feat)
2. **Task 19-01-02: 8 regression tests** — `56482bd` (test)

## Files Created/Modified

- `scripts/verify-v26.cjs` — added `scanDogfoodLedgerDepths` (~53 LOC function + wiring), bumped schema_version 3→4, added Scan source line, exported function
- `tests/19-ledger-scan.test.cjs` — 8 tests covering all four degradation tiers plus edge cases

## Decisions Made

- Gap computation covers `{0..max} \ union` — gaps only appear within the captured range. A depth beyond `max` is not a gap, it is simply uncaptured. This means a fixture for "Not yet observed" gap detection must include a captured depth above the gap row (depths 0,1,2,4 makes depth 3 appear as a gap in `{0..4}`).
- `buildLedgerFixture()` helper in the test file generates minimal Markdown table rows, keeping fixtures readable without large inline strings.
- LOC delta 65 insertions in verify-v26.cjs (diff context lines total 76), within the 80-line ceiling.

## Deviations from Plan

### Auto-fixed Issues

**1. Test fixture gap detection requires surrounding depths**
- **Found during:** Task 19-01-02 (test run, 1 failure)
- **Issue:** Second test used only depths 0 and 3 (with "Not yet observed"). Max captured depth was 0, so `{0..0} \ {0}` = `{}` — depth 3 was not in gaps.
- **Fix:** Updated fixture to use `buildLedgerFixture` with depths 0, 1, 2, 3(gap), 4. Max becomes 4, gap set becomes `{3}`.
- **Files modified:** tests/19-ledger-scan.test.cjs
- **Verification:** `node --test tests/19-ledger-scan.test.cjs` exits 0 with 8/8 passing
- **Committed in:** 56482bd (task 19-01-02 commit)

---

**Total deviations:** 1 auto-fixed (test fixture design)
**Impact on plan:** No scope creep. The fix corrected a test fixture misunderstanding of gap computation semantics.

## Issues Encountered

None beyond the fixture gap noted above.

## Next Phase Readiness

Phase 19 is the final v2.7 phase. Milestone v2.7 "Steady Hands" is COMPLETE. All 4 phases (16-19) done, all 7 requirements (RESOLVE-01..02, AUDIT-01..03, SAMPLE-01, SCHEMA-01) shipped.

---
*Phase: 19-dynamic-ledger-schema*
*Completed: 2026-04-12*
