---
phase: 40-engineering-standards
plan: 40-02
subsystem: agents
tags: engineering-standards, agent-format, unit-tests, integration-tests, ENG-01, ENG-02, ENG-03, ENG-04, ENG-05

# Dependency graph
requires:
  - phase: 40-01
    provides: agents/shared/engineering-standards.md source of truth + 4 executor agents + gsd-planner ENG-01
provides:
  - Engineering standards (ENG-01..05) embedded verbatim in all 9 remaining agents
  - 75-assertion unit test suite (40-engineering-standards.unit.test.cjs)
  - 92-assertion integration test suite (40-engineering-standards.integration.test.cjs)
  - extractEngStandards() helper for content-identity verification
  - Full regression gate: phases 31/33/34/40 unit tests pass together
affects: Phase 39 (agent lifecycle canary suite will need all 14 agents at standard format)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - extractEngStandards(content) helper: finds ### Engineering standards block, clips at next ### or ## heading
    - Integration test run-once-reuse pattern: spawnSync at describe-block level, reuse result across it() assertions
    - NODE_TEST_CONTEXT unset in env before spawning recursive node --test regression gate

key-files:
  created:
    - tests/40-engineering-standards.unit.test.cjs
    - tests/40-engineering-standards.integration.test.cjs
    - .planning/phases/40-engineering-standards/40-02-SUMMARY.md
  modified:
    - agents/gsd-operator.md
    - agents/gsd-researcher.md
    - agents/gsd-roadmapper.md
    - agents/gsd-checker.md
    - agents/gsd-validator.md
    - agents/gsd-debugger.md
    - agents/gsd-tester.md
    - agents/gsd-qa.md
    - agents/gsd-security.md
    - .planning/STATE.md
    - .planning/ROADMAP.md

key-decisions:
  - "Insertion point differs by agent: checker/validator/debugger use 'Agents CANNOT' phrasing; tester/qa/security use 'You CANNOT' with an additional divergence_report paragraph before ## Tool access. This required two different Edit patterns."
  - "Integration test regression gate: node --test recursive invocation detection fires when the integration test is itself run with node --test. Fix: delete NODE_TEST_CONTEXT from env before spawning the inner node --test subprocess."
  - "Tasks 40-02-01, 40-02-02, 40-02-03 are parallel-eligible (disjoint file sets). Executed sequentially for simplicity — no correctness impact."

patterns-established:
  - "Engineering standards copy pattern: insert full agents/shared/engineering-standards.md content verbatim under ## Behavioral rules, before ## Tool access & guidance, using Edit tool"
  - "Recursive node --test fix: delete NODE_TEST_CONTEXT env var in spawnSync options.env before spawning a regression gate subprocess"
  - "Content-identity test helper: extractEngStandards(content) clips from ### Engineering standards to next ### or ## heading"

requirements-completed:
  - ENG-01
  - ENG-02
  - ENG-03
  - ENG-04
  - ENG-05

# Metrics
duration: 45min
completed: 2026-04-13
---

# Plan 40-02 Summary

**Engineering standards (ENG-01..05) propagated to all 9 remaining agents; 167-assertion verification test suite (75 unit + 92 integration) confirms content identity and full regression**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-13
- **Completed:** 2026-04-13
- **Tasks:** 5
- **Files modified:** 11 (9 agents + 2 test files)

## Accomplishments

- All 9 remaining agents (operator, researcher, roadmapper, checker, validator, debugger, tester, qa, security) now carry `### Engineering standards` verbatim under `## Behavioral rules`
- All 14 agent files remain at exactly 10 `## ` sections — FORMAT-01 constraint fully preserved
- 75-assertion unit test suite verifies source-of-truth integrity, content-identity (extractEngStandards helper), planner special-case, section count regression for all 14 agents, and ENG keyword presence in all 4 executors
- 92-assertion integration test suite verifies diff verification for all 13 agent copies, existing mandate preservation, 12 security rules intact, CACHE_BREAKPOINT in all 14 agents, and full regression gate
- Full regression gate: phases 31/33/34/40 unit tests (308 assertions) pass together with 0 failures

## Task Commits

1. **40-02-01: operator, researcher, roadmapper** - `bc47260` (feat)
2. **40-02-02: checker, validator, debugger** - `8f7fc2a` (feat)
3. **40-02-03: tester, qa, security** - `3bea971` (feat)
4. **40-02-04: unit tests** - `f4a297d` (test)
5. **40-02-05: integration tests** - `75a9e05` (test)

## Files Created/Modified

- `agents/gsd-operator.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-researcher.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-roadmapper.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-checker.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-validator.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-debugger.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-tester.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-qa.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `agents/gsd-security.md` — Added ### Engineering standards (ENG-01..05) under ## Behavioral rules
- `tests/40-engineering-standards.unit.test.cjs` — 75 assertions, 5 groups
- `tests/40-engineering-standards.integration.test.cjs` — 92 assertions, 5 groups

## Decisions Made

- Insertion point differed by agent: the 3 "tester/qa/security" agents had an additional divergence_report paragraph between the AGENTS.md constraint and `## Tool access & guidance`. The edit target was that paragraph, not the AGENTS.md line — required a different old_string match pattern.
- Integration test regression gate: node:test recursive invocation detection fires when an integration test spawned via `node --test` itself calls `spawnSync('node', ['--test', ...])`. Fix: delete `NODE_TEST_CONTEXT` from the subprocess env so Node.js treats it as a fresh top-level runner.

## Deviations from Plan

None — plan executed exactly as written. Two minor implementation choices surfaced during execution (insertion point variation for tester/qa/security, NODE_TEST_CONTEXT fix) but both were handled within task scope.

## Issues Encountered

- First iteration of integration test Group 5 (regression gate) failed when run with `node --test`: Node.js recursive run() detection fired. Fixed by deleting `NODE_TEST_CONTEXT` from subprocess env, which causes the inner runner to behave as a fresh top-level invocation.

## Next Phase Readiness

Phase 40 is fully complete (both plans 40-01 and 40-02 done). Next phase per execution order: Phase 32 (Frontend Rebuild).

All 14 agents now carry engineering standards. The verification test suite (167 assertions) provides regression coverage for future agent edits.

---
*Phase: 40-engineering-standards*
*Completed: 2026-04-13*
