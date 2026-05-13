---
phase: 51-party-mode-decisions-operator-cli
plan: 51-03
subsystem: cli
tags: [python, argparse, nodejs, cli, party-mode, psycopg2, integration-testing]

# Dependency graph
requires:
  - phase: 51-02
    provides: post_decision/list_decisions/summarize_decisions helpers + SC1+SC3 tests; decision_type column live via migration 023
  - phase: 51-01
    provides: migration 023 (decision_type column + partial index) + DECISION_TYPES frozen tuple

provides:
  - services/party_session_cli.py: 3 new argparse subcommands (status/inspect/kill) + dispatch handlers; existing 6 byte-preserved
  - get-shit-done/bin/gsd-tools.cjs case 'party':: KNOWN_ACTIONS Set extended to 9 actions; banners updated; spawnSync dispatch byte-preserved
  - tests/party-decisions-cli.test.cjs: 10 integration tests covering all 3 new CLI actions + Phase 50 canary

affects:
  - phase 51-04 (E2E + canary — runs all party-mode tests as regression suite; canary enforces byte-preservation)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Append-only argparse extension — 3 new subparsers + 3 elif handlers appended after existing 6; byte-preservation contract satisfied via pure append
    - gsd-tools KNOWN_ACTIONS Set gate — new actions inherit dispatch via Set + banner update only; no JS dispatch logic changes
    - postDecisionViaPython helper — inline Python -c spawn for decision posting in Node tests (mirrors postFinding from party-e2e.test.cjs)
    - kill audit verification via inspect — after kill, inspect asserts audit row in session.findings with finding_type=kill + agent_name=operator, absent from decision_trail

key-files:
  created:
    - tests/party-decisions-cli.test.cjs
  modified:
    - services/party_session_cli.py
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "status handler uses direct SQL via _get_store()._get_conn() + psycopg2.extras.RealDictCursor for the party_sessions scan; summarize_decisions called per row. No new PGStore helper needed."
  - "inspect handler reuses get() + list_findings() + list_decisions() + summarize_decisions() — all Phase 50/51 substrate functions."
  - "kill handler calls terminate() then post_finding() with decision_type=NULL (kill is an audit row, not a decision). No new parameters needed on existing post_finding()."
  - "Existing InvalidTransitionError + SessionNotFoundError + generic Exception handlers at bottom of main() handle all new elif blocks — no per-block try/except needed."
  - "gsd-tools.cjs: only KNOWN_ACTIONS Set + 2 banners changed; spawnSync dispatch is generic and handles all 9 actions uniformly."

patterns-established:
  - "Append-only CLI extension pattern: when Phase N+1 must extend Phase N argparse CLI with canary byte-preservation, add at the END of build_parser() and BEFORE the else: parser.error() fallthrough in main()"
  - "postDecisionViaPython helper: inline Python -c script with PYTHONPATH=ROOT for decision posting in Node integration tests"
  - "Kill audit trail verification: use inspect after kill to cross-verify kill row in session.findings but absent from decision_trail"

requirements-completed: [PARTY-04]

# Metrics
duration: ~25min
completed: 2026-05-13
---

# Plan 51-03 Summary

**Operator CLI surface live: party status/inspect/kill in Python argparse + gsd-tools.cjs dispatch, all 10 Node integration tests passing**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-13T21:30:00Z
- **Completed:** 2026-05-13T21:55:00Z
- **Tasks:** 3 (all committed atomically)
- **Files modified:** 2
- **Files created:** 1

## Accomplishments

- party_session_cli.py extended with 3 new argparse subparsers (status/inspect/kill) + dispatch handlers. Existing 6 subcommands (create/start/pause/resume/terminate/get) preserved byte-for-byte. Imports extended with post_decision/list_decisions/summarize_decisions/post_finding.
- gsd-tools.cjs case 'party': extended: KNOWN_ACTIONS Set grows from 6 to 9, usage banner and unknown-action banner updated to list all 9 actions. Existing spawnSync dispatch, args[1]/args.slice(2) convention, and break; byte-identical.
- 10 Node integration tests created and all pass (PG available). 3 unconditional + 7 PG-gated. Test 7 verifies kill audit row appears in session.findings via inspect but is absent from decision_trail (decision_type=NULL).

## Task Commits

1. **Task 51-03-01: Extend party_session_cli.py** — `4d09bbd` (feat)
2. **Task 51-03-02: Extend gsd-tools.cjs case 'party':** — `2128cbb` (feat)
3. **Task 51-03-03: Create tests/party-decisions-cli.test.cjs** — `a0abb55` (feat)

## Files Created/Modified

- `services/party_session_cli.py` — extended with 3 new subparsers + 3 elif handlers + 4 additional imports
- `get-shit-done/bin/gsd-tools.cjs` — case 'party': KNOWN_ACTIONS Set (6→9) + banners updated
- `tests/party-decisions-cli.test.cjs` — 10 integration tests (3 unconditional + 7 PG-gated)

## Decisions Made

- `status` handler uses direct SQL via `_get_store()._get_conn()` for the party_sessions list query; `summarize_decisions()` called per row. This avoids needing a new PGStore helper.
- `inspect` handler reuses `get() + list_findings() + list_decisions() + summarize_decisions()` — all Phase 50/51 substrate. No new DB queries needed in the CLI handler.
- `kill` handler calls `terminate()` then `post_finding()` with `decision_type=NULL` (implicit). The existing exception handlers at the bottom of `main()` route `InvalidTransitionError` (exit 1) and generic exceptions (exit 2) correctly for the new handlers too.
- gsd-tools.cjs: only KNOWN_ACTIONS Set + 2 banner strings changed. The generic `spawnSync('python3', [partyCli, action, ...rest])` dispatch already handles any action forwarded to Python — no JS per-action logic needed.

## Deviations from Plan

### Observation (not a blocking deviation)

**AC: `grep -c "services/party_session_cli.py" gsd-tools.cjs == at least 1` — pre-existing path.join pattern**
- **Context:** The AC grep uses a slash-path literal (`services/party_session_cli.py`) but the code constructs the path via `path.join(repoRoot, 'services', 'party_session_cli.py')`. This was already the pattern from Phase 50 — the grep returns 0 for the slash-path but 1 for the `party_session_cli.py` substring alone.
- **Impact:** Cosmetic only. The file reference is clearly present and correct. The AC was aspirational/pre-existing from Phase 50.
- **No change required:** The dispatch works correctly as verified by all 10 integration tests passing.

## Issues Encountered

None — Wave 1+2 substrate was live and correct. All 10 tests passed on first run (PG available).

## Next Phase Readiness

- Phase 51-04 (E2E + canary) can proceed: all 3 CLI actions live, all 10 Node tests pass, all prior party-mode tests (27 pytest + 10 Node Wave 3) remain passing.
- Phase 51-04 canary will enforce byte-preservation of the existing 6 actions in both services/party_session_cli.py and gsd-tools.cjs.
- Blocker: none.

---
*Phase: 51-party-mode-decisions-operator-cli*
*Completed: 2026-05-13*
