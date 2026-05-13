---
phase: 51-party-mode-decisions-operator-cli
plan: 51-02
subsystem: testing
tags: [postgresql, pytest, party-mode, decisions, integration-testing, psycopg2]

# Dependency graph
requires:
  - phase: 51-01
    provides: migration 023 (decision_type column + partial index) + DECISION_TYPES frozen tuple + post_decision/list_decisions/summarize_decisions helpers + tests/test_party_decisions.py PG-gate pattern

provides:
  - tests/test_party_decision_trail.py: 5 integration tests for SC1 (all four decision types queryable as structured trail)
  - tests/test_party_dissent_no_rollback.py: 4 integration tests for SC3 (dissent does NOT auto-rollback; session stays active; propose row byte-identical)
  - grep evidence: "Auto-rollback" string appears 9 times in test_party_dissent_no_rollback.py (matches REQUIREMENTS.md Out of Scope wording)

affects:
  - phase 51-03 (CLI dispatch status/inspect/kill — builds on decision helpers)
  - phase 51-04 (E2E + canary — runs all party-mode tests as regression suite)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Migration 023 apply guard in integration tests (_apply_migration_023_if_needed) — mirrors Wave 1 unit test pattern for clean-slate PG robustness
    - SC3 Out-of-Scope contract string placed in module docstring + inline test comments — satisfies AC grep + documents the invariant
    - Direct SQL introspection of information_schema.columns to verify no rollback-flavored columns added by post_decision
    - Byte-identical row comparison via direct agent_findings SELECT (content + decision_type + agent_name + created_at) pre/post dissent

key-files:
  created:
    - tests/test_party_decision_trail.py
    - tests/test_party_dissent_no_rollback.py
  modified: []

key-decisions:
  - "test_dissent_does_not_rollback directly introspects information_schema.columns for rollback-flavored column names — guards against schema drift silently adding a 'rolled_back' column in future"
  - "SC3 string 'Auto-rollback' placed in module docstring + all 4 test functions as inline comments — one grep hit satisfies AC, multiple hits make future readers understand the guard's purpose"
  - "Migration 023 apply guard included in both test files — same pattern as test_party_decisions.py to handle clean-slate PG environments without manual migration pre-run"
  - "Direct SQL helper _query_agent_findings_row() returns all columns including decision_type and created_at — enables byte-identical pre/post comparison without relying on list_decisions (which only returns a subset)"

patterns-established:
  - "SC3 lock pattern: module docstring cites REQUIREMENTS.md Out of Scope item verbatim + inline comments on each test; AC grep checks against docstring"
  - "Pre/post row snapshot pattern: capture row via direct SQL before the action under test, re-query after, assert field-by-field equality"
  - "Column name introspection pattern: SELECT column_name FROM information_schema.columns WHERE table_name=... to guard against unintended schema additions"

requirements-completed: [PARTY-03]

# Metrics
duration: ~20min
completed: 2026-05-13
---

# Plan 51-02 Summary

**SC1 four-decision-types queryable trail (5 tests) + SC3 dissent-no-rollback contract (4 tests), 27 party-mode tests total passing**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-13T21:00:00Z
- **Completed:** 2026-05-13T21:20:00Z
- **Tasks:** 2 (both committed atomically)
- **Files modified:** 0 (test-only wave — no code modifications)
- **Files created:** 2

## Accomplishments

- SC1 contract locked: test_party_decision_trail.py posts all 4 decision types (propose/agree/dissent/block) from 3 agents in one session, asserts list_decisions returns all 4 in ASC order with correct attribution, confidence precision, filtering of non-decision findings, summarize_decisions counts, and UUID uniqueness.
- SC3 contract locked: test_party_dissent_no_rollback.py posts propose + dissent and asserts session remains active, propose row is byte-identical (content + decision_type + agent_name + created_at unchanged), no rollback-flavored column exists on agent_findings (information_schema introspection), and both findings remain in the decision_trail. Pattern mirrored for block. Also asserts observation findings unaffected, and dissent counted in summarize_decisions.
- Full 27-test regression clean: all Wave 1 (11) + Wave 2 SC1 (5) + Wave 2 SC3 (4) + prior party tests pass with 0 failures.

## Task Commits

1. **Task 51-02-01: test_party_decision_trail.py** — `66e928d` (feat)
2. **Task 51-02-02: test_party_dissent_no_rollback.py** — `7892a94` (feat)

## Files Created/Modified

- `tests/test_party_decision_trail.py` — 5 integration tests: all-four-types round-trip, confidence precision (1e-6), non-decision filter (list_decisions==3 vs list_findings==5), summarize_decisions {1,1,1,1}, finding_id uniqueness (set==4, 36 chars, 4 dashes)
- `tests/test_party_dissent_no_rollback.py` — 4 integration tests: test_dissent_does_not_rollback, test_block_does_not_rollback_propose, test_dissent_does_not_mutate_other_agents_findings, test_dissent_visible_in_summarize_decisions

## Decisions Made

- `_query_agent_findings_row()` helper queries all columns including `decision_type` and `created_at` via direct SQL — this is the only way to do a byte-identical row comparison independent of the `list_decisions` projection.
- Column introspection loop checks 5 rollback-flavored keywords (`rolled_back`, `revoked`, `invalidated`, `retracted`, `cancelled`) — not just one — to future-proof against alternative naming.
- "Auto-rollback" string placed 9 times (docstring + inline per test) rather than once — AC satisfied by docstring; inline repetition makes the invariant explicit in each test.

## Deviations from Plan

None — plan executed exactly as written. Both files match the `<files_expected>` manifest (create only, no modify/delete). All acceptance criteria pass without modification.

## Issues Encountered

None — Wave 1 substrate was live and correct. All 9 tests passed on first run.

## Next Phase Readiness

- Phase 51-03 (CLI dispatch: status/inspect/kill) can proceed: post_decision/list_decisions/summarize_decisions live, SC1+SC3 locked.
- Phase 51-04 (E2E + canary) can proceed when 51-03 ships.
- Blocker: none.

---
*Phase: 51-party-mode-decisions-operator-cli*
*Completed: 2026-05-13*
