---
phase: 51-party-mode-decisions-operator-cli
plan: 51-01
subsystem: database, testing
tags: [postgresql, migration, party-mode, decisions, psycopg2, pytest]

# Dependency graph
requires:
  - phase: 50-party-mode-foundation
    provides: party_sessions table + agent_findings.session_id FK + post_finding() + list_findings() + PartySession Pydantic model + VALID_TRANSITIONS + _HAS_PG pattern

provides:
  - migration 023: agent_findings.decision_type VARCHAR(16) column (nullable, no DDL CHECK)
  - migration 023: partial index idx_agent_findings_session_decision WHERE decision_type IS NOT NULL
  - migration 023 DOWN: reverse-order drops with IF EXISTS
  - services/party_session.py: DECISION_TYPES = ("propose","agree","dissent","block") frozen tuple
  - services/party_session.py: post_decision() — validates type, INSERTs with decision_type
  - services/party_session.py: list_decisions() — SELECT WHERE decision_type IS NOT NULL ORDER BY created_at ASC
  - services/party_session.py: summarize_decisions() — GROUP BY decision_type, missing keys default to 0
  - tests/test_party_decisions_migration.py: 4 migration introspection tests
  - tests/test_party_decisions.py: 7 unit tests covering ValueError, round-trip, summarize counts

affects:
  - phase 51-02 (SC3 dissent no-rollback test)
  - phase 51-03 (CLI dispatch: status/inspect/kill)
  - phase 51-04 (E2E + canary)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Frozen vocabulary tuple (DECISION_TYPES) at module level — same as INSTALL_STEPS (Phase 49), VALID_TRANSITIONS (Phase 50)
    - Append-only extension of Phase 50 service — Phase 50 functions byte-identical
    - Write-site enforcement (ValueError) instead of DDL CHECK constraint for nullable vocabulary column
    - Missing-type default-to-0 in summarize_decisions via {dt:0 for dt in DECISION_TYPES} pre-fill before GROUP BY merge

key-files:
  created:
    - migrations/023-party-decisions.sql
    - migrations/023-party-decisions-DOWN.sql
    - tests/test_party_decisions_migration.py
    - tests/test_party_decisions.py
  modified:
    - services/party_session.py (DECISION_TYPES constant + 3 new functions, append-only)

key-decisions:
  - "No DDL CHECK constraint on decision_type — enforced at write site in post_decision() per FROZEN Phase 51 design"
  - "DECISION_TYPES inserted after VALID_TRANSITIONS, before exception classes — logical grouping with other module-level constants"
  - "post_decision delegates its own INSERT (not via post_finding) — keeps the two code paths independent and the Phase 50 post_finding body byte-identical"
  - "summarize_decisions uses single GROUP BY query pre-filled with {dt:0} dict — one round-trip, missing keys automatically 0"
  - "list_decisions returns finding_id (alias of id::text) not id — consistent with Phase 51 CONTEXT §Area 5 decision_trail shape"

patterns-established:
  - "Write-site enum validation: validate in DECISION_TYPES before first DB call; raise ValueError with f-string naming both the valid set and the rejected value"
  - "Migration DOWN: DROP INDEX before DROP COLUMN (respects dependency order); IF EXISTS guards for idempotency; no CASCADE"
  - "summarize_decisions two-pass: pre-fill all DECISION_TYPES keys with 0, then merge GROUP BY results — guarantees all 4 keys present regardless of DB state"

requirements-completed: [PARTY-03]

# Metrics
duration: ~25min
completed: 2026-05-13
---

# Plan 51-01 Summary

**Migration 023 (decision_type VARCHAR(16) column + partial index) + DECISION_TYPES frozen tuple + post_decision/list_decisions/summarize_decisions helpers, with 11 new tests (4 migration + 7 unit), all passing**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-13T20:45:00Z
- **Completed:** 2026-05-13T21:00:00Z
- **Tasks:** 5 (all committed atomically)
- **Files modified:** 1 (services/party_session.py)
- **Files created:** 4

## Accomplishments

- Migration 023 UP/DOWN ships additive, idempotent DDL: `decision_type VARCHAR(16)` nullable column + partial index for trail queries, no DDL CHECK (write-site enforcement only)
- services/party_session.py extended append-only: DECISION_TYPES frozen tuple + 3 new helpers; all Phase 50 functions byte-identical
- 11 tests pass: 4 migration introspection (column type, partial index predicate, DOWN reversal, no CHECK constraint) + 7 unit tests (ValueError rejection, round-trip, default finding_type, filter non-decisions, empty session, summarize counts with block:0 present)

## Task Commits

1. **Task 51-01-01: migration 023 UP** — `2a823bd` (feat)
2. **Task 51-01-02: migration 023 DOWN** — `5b156bb` (feat)
3. **Task 51-01-03: extend party_session.py** — `4d63473` (feat)
4. **Task 51-01-04: test_party_decisions_migration.py** — `28c9fbd` (feat)
5. **Task 51-01-05: test_party_decisions.py** — `b8fe085` (feat)

## Files Created/Modified

- `migrations/023-party-decisions.sql` — UP: ALTER TABLE ADD COLUMN decision_type + CREATE INDEX partial
- `migrations/023-party-decisions-DOWN.sql` — DOWN: DROP INDEX then DROP COLUMN with IF EXISTS
- `services/party_session.py` — Extended: DECISION_TYPES constant + post_decision/list_decisions/summarize_decisions (append-only; Phase 50 content unchanged)
- `tests/test_party_decisions_migration.py` — 4 migration regression tests (info_schema + pg_indexes + pg_constraint)
- `tests/test_party_decisions.py` — 7 unit tests for decision helpers

## Decisions Made

- `post_decision` does its own INSERT rather than delegating to `post_finding()` — keeps Phase 50 `post_finding` body byte-identical for the 51-04 canary, and the INSERT columns differ (decision_type vs recipient_agent/severity).
- DECISION_TYPES constant placed after VALID_TRANSITIONS (before exception classes) — same section as other Phase 50 module-level constants, logical grouping.
- `summarize_decisions` uses a pre-fill dict `{dt: 0 for dt in DECISION_TYPES}` before merging GROUP BY rows — guarantees all 4 keys present with value 0 for types with no decisions, which is the PARTY-03 contract.

## Deviations from Plan

### AC grep mismatch for `grep -c "CHECK" == 0` on migration 023

- **Found during:** Task 51-01-01 (creating migration 023 UP)
- **Issue:** Plan `<action>` provides the FROZEN DDL verbatim, which includes `COMMENT ON COLUMN` text containing "CHECK constraint deliberately omitted". The `<acceptance_criteria>` says `grep -c "CHECK" == 0`, intended to verify no DDL CHECK constraint exists — but the grep matches the documentation text too. The two directives are internally inconsistent.
- **Resolution:** Followed Action verbatim (per `feedback_plan_ac_regex_vs_action_form` precedent). The COMMENT ON COLUMN is documentation, not a DDL constraint. No `CHECK (...)` constraint exists in the file. The substantive intent of the AC is satisfied.
- **Verification:** `grep "CHECK" migrations/023-party-decisions.sql` returns only the comment line and the COMMENT ON COLUMN string — zero DDL CHECK constraints.

---

**Total deviations:** 1 (AC grep-vs-intent mismatch — substantive intent satisfied; documented per precedent)
**Impact on plan:** No functional impact. The migration has no DDL CHECK constraint as intended.

## Issues Encountered

None — plan executed cleanly. PG was available in the test environment; all 11 tests passed (no skips).

## Next Phase Readiness

- Phase 51-02 (SC3 dissent-no-rollback + decision_trail unit tests) can proceed: post_decision/list_decisions/summarize_decisions are live.
- Phase 51-03 (CLI dispatch: status/inspect/kill) can proceed: decision helpers available for the inspect + status output shapes.
- Phase 51-04 (E2E + canary) can proceed when 51-02 and 51-03 are complete.
- Blocker: none.

---
*Phase: 51-party-mode-decisions-operator-cli*
*Completed: 2026-05-13*
