---
phase: 10-d-phase-structured-learning
plan: 10-09
subsystem: testing
tags: [parse-learning, tag-governance, normalizeTags, increment-applied, pytest, node-test, cross-runtime]

requires:
  - phase: 10-03
    provides: gsd-memory.cjs parseLearningBlock, splitLearningBlocks, validateLengthCaps, normalizeTags exports
  - phase: 10-04
    provides: pg_store.py normalize_tags, load_tag_rules, _tag_tier, memory_increment_applied
  - phase: 10-05
    provides: gsd-memory.cjs increment-applied, skb-promote, skb-candidates CLI commands
  - phase: 10-07
    provides: cli-variables.md referenced across 17 files
  - phase: 10-08
    provides: LEARNING block template across 11 agents
provides:
  - 62 new tests covering Phase 10 surface (38 CJS + 24 pytest)
  - README.md structured learnings documentation section
  - Cross-runtime tag governance parity verification (Node + Python)
affects: [phase-11, phase-15]

tech-stack:
  added: []
  patterns: [custom-test-runner for Phase 10 CJS, PGStore mock pattern for pytest]

key-files:
  created:
    - tests/10-parse-learning.test.cjs
    - tests/10-tag-governance.test.cjs
    - tests/10-structured-learn-pipeline.test.cjs
    - tests/10-legacy-compat.test.cjs
    - tests/test_tag_governance.py
    - tests/test_memory_increment_applied.py
  modified:
    - README.md
    - services/amauta-daemon.py

key-decisions:
  - "Fixed daemon GET route path matching (do_GET was not stripping query params from self.path, causing /api/memory/skb-candidates?... to 404)"
  - "Used custom test runner (not node:test describe/it) for Phase 10 CJS tests to match the parseLearningBlock/normalizeTags module.exports pattern"
  - "TestCrossRuntimeParity class in pytest explicitly verifies Node and Python produce identical output for identical inputs"

patterns-established:
  - "Phase 10 CJS test pattern: require(MEM_CLI) for unit tests + spawnSync for CLI integration tests"
  - "PGStore mock pattern: _make_pg_store + _patch_get_conn + cursor.fetchone.side_effect for deterministic DB response sequences"

requirements-completed: [LEARN-01, LEARN-02, LEARN-03, LEARN-04, LEARN-05, LEARN-06, LEARN-07]

duration: 25min
completed: 2026-04-09
---

# Plan 10-09: Tests + README Summary

**62 new tests (4 CJS + 2 pytest files) covering parse-learning, tag governance, structured pipeline, legacy compat, cross-runtime parity, and increment-applied dedup -- plus README Phase 10 documentation section**

## Performance

- **Duration:** 25 min
- **Started:** 2026-04-09T--
- **Completed:** 2026-04-09T--
- **Tasks:** 7 (+ 1 daemon bug fix)
- **Files modified:** 8

## Accomplishments
- 15 parse-learning unit tests: parseLearningBlock, splitLearningBlocks, validateLengthCaps, CLI integration, kill switch
- 11 tag governance unit tests: synonym normalization, banned tags, auto-trim, loadTagRules cache, tagTier
- 6 structured pipeline integration tests: CLI validation rejects + daemon-gated full pipeline
- 6 legacy compat regression tests: free-text learn, --agent flag, search, skb-search, module re-require
- 19 Python tag governance tests mirroring Node.js for cross-runtime parity (RISK-4)
- 5 Python increment-applied tests: happy path, dedup by (mem_id, task_id), not-found, citations metadata
- README.md Phase 10 section covering all new subcommands, categories, tag governance, applied_count, skb candidates, APPLIED_LEARNING citations, kill switch, backward compatibility
- Fixed daemon GET route bug: query params in self.path were not stripped, causing /api/memory/skb-candidates to 404

## Task Commits

Each task was committed atomically:

1. **Task 1: 10-parse-learning.test.cjs** - `232799b` (test: 15 tests LEARN-02)
2. **Task 2: 10-tag-governance.test.cjs** - `1f9ca7b` (test: 11 tests LEARN-04)
3. **Task 2.5: daemon GET route fix** - `9ec4004` (fix: strip query params from path matching)
4. **Task 3: 10-structured-learn-pipeline.test.cjs** - `bfebc93` (test: 6 tests LEARN-02/05)
5. **Task 4: 10-legacy-compat.test.cjs** - `56817d0` (test: 6 tests backward compat)
6. **Task 5: test_tag_governance.py** - `893d123` (test: 19 tests LEARN-04 cross-runtime)
7. **Task 6: test_memory_increment_applied.py** - `05c1109` (test: 5 tests LEARN-05)
8. **Task 7: README.md** - `64848df` (docs: Phase 10 structured learnings)

## Files Created/Modified
- `tests/10-parse-learning.test.cjs` - Unit tests for parseLearningBlock, splitLearningBlocks, validateLengthCaps
- `tests/10-tag-governance.test.cjs` - Unit tests for normalizeTags, loadTagRules, tagTier
- `tests/10-structured-learn-pipeline.test.cjs` - Integration tests for full learn->search->skb pipeline
- `tests/10-legacy-compat.test.cjs` - Regression tests for backward compatibility
- `tests/test_tag_governance.py` - Python mirror of tag tests for cross-runtime parity
- `tests/test_memory_increment_applied.py` - Pytest for PGStore.memory_increment_applied dedup logic
- `README.md` - Phase 10 structured learnings documentation section
- `services/amauta-daemon.py` - Fixed GET route path matching (line 1003: split("?") before rstrip)

## Decisions Made
- Fixed daemon GET route bug discovered during integration testing (query params not stripped from path)
- Used custom test runner pattern (not node:test) to match existing Phase 10 CJS export style
- TestCrossRuntimeParity in pytest explicitly validates Node+Python output parity per RISK-4

## Deviations from Plan

### Auto-fixed Issues

**1. [Blocking] Daemon GET route path matching bug**
- **Found during:** Task 3 (structured pipeline integration test)
- **Issue:** `do_GET` set `path = self.path.rstrip("/")` without stripping query parameters, so `/api/memory/skb-candidates?...` never matched the route
- **Fix:** Changed to `path = self.path.split("?")[0].rstrip("/")`
- **Files modified:** services/amauta-daemon.py
- **Verification:** Pipeline test passes with daemon-dependent skb-candidates call
- **Committed in:** 9ec4004 (separate fix commit)

---

**Total deviations:** 1 auto-fixed (1 blocking bug)
**Impact on plan:** Bug fix was necessary for integration test to exercise the full pipeline. No scope creep.

## Issues Encountered
None beyond the daemon route fix above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 10 is now COMPLETE: all 9 plans (10-01 through 10-09) executed
- 62 new tests all green, README documented
- 2-week quarantine before Phase 11 starts (per STATE.md)
- Phase 11 (E-Phase Research-Informed Execution Mandate) is next

---
*Phase: 10-d-phase-structured-learning*
*Plan: 10-09*
*Completed: 2026-04-09*
