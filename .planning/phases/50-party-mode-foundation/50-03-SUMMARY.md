---
phase: 50-party-mode-foundation
plan: 03
subsystem: cli
tags: [python, argparse, nodejs, spawnSync, integration-test, party-mode]

# Dependency graph
requires:
  - phase: 50-02
    provides: party_session.py with post_finding, list_findings, and resume() replay

provides:
  - services/party_session_cli.py — argparse 6-action CLI (create/start/pause/resume/terminate/get) + --json + exit codes 0/1/2
  - get-shit-done/bin/gsd-tools.cjs case 'party': — spawnSync dispatch mirroring case 'module':
  - bin/cli.cjs party branch — npx gsd-amauta party ... shortcut via process.argv.slice(3)
  - tests/party-cli.test.cjs — 10 Node integration tests (help/unknown-action/create/start/pause/resume/terminate/invalid-transition/shortcut/canary)

affects: [50-04, 51, party-operator-cli]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - argparse subparser CLI with --json + exit codes 0/1/2 (mirrors module_lifecycle_cli.py)
    - gsd-tools.cjs case dispatch with args[1] action / args.slice(2) rest indexing
    - bin/cli.cjs shortcut via process.argv.slice(3) rewrite + spawnSync

key-files:
  created:
    - services/party_session_cli.py
    - tests/party-cli.test.cjs
  modified:
    - get-shit-done/bin/gsd-tools.cjs
    - bin/cli.cjs

key-decisions:
  - "args[1]/args.slice(2) indexing preserved — matches Phase 48/49 case 'module': convention (FROZEN)"
  - "PG-gate in tests: detect via get <bogus-uuid> checking for pg_io_error/OperationalError — matches agent-hydrate-cli.test.cjs pattern"
  - "State-machine tests run sequentially in describe() block sharing sessionId thread"
  - "party-invalid-transition-exit-1 creates its own fresh session (not reusing the state-machine chain) to avoid ordering dependency"

patterns-established:
  - "party CLI pattern: argparse + 6 actions + --json + exit codes 0/1/2 reusable for Phase 51 operator CLI"
  - "Node integration test PG-gate: pgAvailable() probe returns bool; state-machine subtests t.skip() when false"

requirements-completed: [PARTY-01, PARTY-02]

# Metrics
duration: 25min
completed: 2026-05-13
---

# Plan 50-03 Summary — CLI dispatch: party_session_cli.py + gsd-tools.cjs case 'party': + bin/cli.cjs + 10 Node tests

**argparse 6-action party CLI + gsd-tools.cjs case 'party': dispatch + bin/cli.cjs party shortcut + 10 Node integration tests covering full state-machine round-trip, invalid transitions, and Phase 48 canary.**

## Performance

- **Duration:** ~25 min (this session; tasks 01/02/03 pre-committed in prior session)
- **Started:** 2026-05-13T22:30:00Z
- **Completed:** 2026-05-13T23:00:00Z
- **Tasks:** 4 (tasks 01/02/03 pre-committed; task 04 committed this session)
- **Files modified:** 2 (get-shit-done/bin/gsd-tools.cjs, bin/cli.cjs)
- **Files created:** 2 (services/party_session_cli.py, tests/party-cli.test.cjs)

## Accomplishments

- `services/party_session_cli.py`: argparse with 6 subcommands (create/start/pause/resume/terminate/get), `--json` on all subcommands, exit codes 0=success / 1=InvalidTransitionError|SessionNotFoundError|validation / 2=PG/IO, JSON error format `{"error": "...", "detail": "...", "schema_version": "1.0"}`, `if __name__ == "__main__":` guard, sys.path bump mirrors module_lifecycle_cli.py L25-32
- `get-shit-done/bin/gsd-tools.cjs case 'party':` inserted after `case 'module':` (L3712); args[1]/args.slice(2) indexing preserved per Phase 48 FROZEN convention; KNOWN_ACTIONS set of 6; spawnSync to party_session_cli.py; Usage message on no-action or flag-as-action
- `bin/cli.cjs party branch`: process.argv.slice(3) → spawnSync node gsd-tools.cjs party ...; mirrors module branch exactly; usage comment block updated to mention party (Phase 50)
- `tests/party-cli.test.cjs`: 10 tests, all pass (PG available); PG-gate probe via bogus UUID; state-machine round-trip in sequential describe() block; Phase 48 canary as file-read assertion

## Task Commits

1. **Task 50-03-01: services/party_session_cli.py** — `9f87ddf` (feat) — committed in prior session
2. **Task 50-03-02: gsd-tools.cjs case 'party':` — `c77c700` (feat) — committed in prior session
3. **Task 50-03-03: bin/cli.cjs party branch** — `58e7b72` (feat) — committed in prior session
4. **Task 50-03-04: tests/party-cli.test.cjs** — `3c7a81d` (feat) — committed this session

## Files Created/Modified

- `services/party_session_cli.py` — argparse 6-action CLI entry-point for party session lifecycle
- `get-shit-done/bin/gsd-tools.cjs` — added case 'party': dispatch block at L3712 (after case 'module':)
- `bin/cli.cjs` — added `if (command === 'party')` branch + updated usage comment
- `tests/party-cli.test.cjs` — 10 Node integration tests (all pass, PG available)

## Decisions Made

- `party-invalid-transition-exit-1` test creates its own fresh session (not reusing the shared state-machine chain session) to avoid ordering dependency — the shared session was already terminated by `party-terminate-transitions`.
- Phase 48 canary implemented as a file-read + regex grep rather than a subprocess call — faster and deterministic regardless of PG availability.
- PG-gate probe (`pgAvailable()`) checks for `pg_io_error` OR `OperationalError` in combined stdout+stderr when exit is 2 — matches exactly the two conditions that indicate PG is down vs. session-not-found (exit 1 with SessionNotFoundError = PG up).

## Deviations from Plan

### Pre-committed Tasks (Observation, Not Divergence)

**50-03-01, 50-03-02, 50-03-03 already committed in prior session before this dispatch.**

- **Found during:** R-phase verification (`git log --oneline -10` revealed commits 9f87ddf, c77c700, 58e7b72)
- **Issue:** Plan brief said to execute all 4 tasks; 3 were already done.
- **Action:** Verified each committed artifact against acceptance criteria (all pass); proceeded directly to 50-03-04.
- **Impact:** Zero regressions. No duplicate commits created.

---

**Total deviations:** 1 observation (pre-committed tasks detected; handled correctly per divergence-over-flow discipline)
**Impact on plan:** None — artifacts are correct, commitments match AC.

## Issues Encountered

None — PG was available, all 10 tests passed on first run.

## v3.1 Surface Canary

No modifications to: `services/amauta-mcp.py`, `services/skill_schema.py`, `services/agent_hydrator.py`, `services/module_schema.py`, `services/module_resolver.py`, `services/module_validator_cli.py`, `services/module_lifecycle.py`, `services/module_lifecycle_cli.py`, `scripts/skill-compiler.cjs`, `agents/*.md`, `bin/init.cjs`. Wave 3 modifies only `get-shit-done/bin/gsd-tools.cjs` (case 'party': addition) and `bin/cli.cjs` (party branch addition) and creates new CLI + test files.

## Test Results

```
tests/party-cli.test.cjs (node --test):
  party-help-emits-usage          PASS
  party-unknown-action            PASS
  party-state-machine (PG required):
    party-create-roundtrip        PASS
    party-start-transitions       PASS
    party-pause-transitions       PASS
    party-resume-transitions      PASS
    party-terminate-transitions   PASS
    party-invalid-transition-exit-1 PASS
  party-cli-shortcut-mirrors-tools  PASS
  phase-48-module-case-untouched-canary PASS
Total: 10 pass, 0 fail, 0 skip  (2656ms)

Python regression (Wave 1+2):
  tests/test_party_session_migration.py:      6 passed
  tests/test_party_session_state_machine.py: 13 passed
  tests/test_party_session_findings.py:       7 passed
  tests/test_party_session_resume.py:         6 passed
Total:                                        32 passed in 2.03s
```

## Next Plans

- **50-04** — E2E (SC4 full daemon restart scenario via `gsd-tools.cjs spawnSync`) + v3.1 canary
- **51** — Party Mode Decisions + Operator CLI (depends on 50)

---
*Phase: 50-party-mode-foundation*
*Completed: 2026-05-13*
