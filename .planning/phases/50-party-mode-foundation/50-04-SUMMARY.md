---
phase: 50-party-mode-foundation
plan: 04
subsystem: testing
tags: [nodejs, python, spawnSync, subprocess, e2e, canary, git-diff, party-mode, sc4]

# Dependency graph
requires:
  - phase: 50-03
    provides: party_session_cli.py (6-action argparse CLI) + gsd-tools.cjs case 'party': + bin/cli.cjs party branch

provides:
  - tests/party-e2e.test.cjs — 7-subtest full lifecycle E2E (SC4 Layer 2 subprocess restart evidence)
  - tests/party-canary.test.cjs — 6-subtest cross-surface canary (13 protected paths, never skips)

affects: [51, party-operator-cli, v3.2-milestone-closeout]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - SC4 Layer 2: fresh node subprocess → fresh python3 subprocess → fresh psycopg2 pool = daemon restart simulation
    - Phase 50 canary: git diff PHASE_50_BASE -- <path> returns empty string for protected paths
    - extractBlock() brace-counter for content-preserved checks on files modified by Phase 50
    - pgAvailable probe via create call (not bogus-uuid get) for E2E vs CLI test difference

key-files:
  created:
    - tests/party-e2e.test.cjs
    - tests/party-canary.test.cjs
  modified: []

key-decisions:
  - "probeCreate() returns { pgUp, sessionId } — creates session in before() to both gate PG and seed the lifecycle thread"
  - "postFinding() via inline python3 -c with PYTHONPATH=ROOT — true subprocess restart per call, proving no in-memory state"
  - "PHASE_50_BASE SHA is a FROZEN contract — executor MUST surface divergence report if it changes, NOT silently update"
  - "extractBlock() uses brace-balancing rather than line-offset search — robust against whitespace/comment drift between versions"

patterns-established:
  - "E2E PG-gate: probe via the first real operation (create) rather than a bogus UUID get — avoids ambiguous exit codes"
  - "Canary PHASE_50_BASE sanity: git show --format=%s -s validates SHA resolves before any diff runs"

requirements-completed: [PARTY-01, PARTY-02]

# Metrics
duration: 25min
completed: 2026-05-13
---

# Plan 50-04 Summary — E2E lifecycle + v3.1/Phase 48/Phase 49 cross-surface canary

**7-subtest SC4 Layer 2 E2E test (fresh subprocess resume proves PG-only persistence) + 6-subtest canary verifying 13 protected paths unchanged since Phase 50 base 3889ff38. Phase 50 COMPLETE.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-13T23:00:00Z
- **Completed:** 2026-05-13T23:30:00Z
- **Tasks:** 2 (tasks 01 + 02 committed this session)
- **Files created:** 2 (tests/party-e2e.test.cjs, tests/party-canary.test.cjs)
- **Files modified:** 3 (.planning/STATE.md, .planning/ROADMAP.md, 50-04-SUMMARY.md)

## Accomplishments

- `tests/party-e2e.test.cjs`: 7 subtests covering create+start → post 3 findings via inline python3 subprocess → pause → fresh-subprocess resume with ordered replay assertions (SC4 Layer 2) → terminate → post-terminate InvalidTransitionError check → bin/cli.cjs shortcut equivalence. All 7 pass with PG. Graceful t.skip() when PG unavailable.
- `tests/party-canary.test.cjs`: 6 subtests, never skips. PHASE_50_BASE = '3889ff38e687eb7dfdbc133de30196c66c7a7f9d'. Covers all 13 protected paths: agents/ dir + 6 v3.1 services/scripts + 3 Phase 48 outputs + 3 Phase 49 outputs (all diff-empty); gsd-tools.cjs case 'module': block and bin/cli.cjs module branch byte-equal to base. All 6 pass.
- Phase 50 OVERALL complete: 55 total tests (32 Python Wave 1+2 + 10 Node Wave 3 + 7 Node E2E + 6 Node canary). 0 regressions across all waves.

## Task Commits

1. **Task 50-04-01: tests/party-e2e.test.cjs** — `167b12e` (feat)
2. **Task 50-04-02: tests/party-canary.test.cjs** — `0713550` (feat)

## Files Created/Modified

- `tests/party-e2e.test.cjs` — 7-subtest full lifecycle E2E via public CLI surface (SC4 Layer 2 subprocess restart evidence)
- `tests/party-canary.test.cjs` — 6-subtest cross-surface canary; 13 protected paths; never skips

## Decisions Made

- `probeCreate()` in the E2E test creates an actual session in `before()` and returns both `{ pgUp, sessionId }`. This seeds the lifecycle thread while gating PG availability — cleaner than a separate bogus-UUID probe which could ambiguously return exit 2.
- `postFinding()` uses `python3 -c` with an inline script rather than importing Python via Node bindings. Each call is a completely fresh subprocess demonstrating SC4 Layer 2 (daemon restart = new process = new PG pool).
- `extractBlock()` in the canary uses brace-depth counting rather than line-offset heuristics. This is robust against minor comment or whitespace drift between the base and HEAD versions of gsd-tools.cjs and bin/cli.cjs.
- PHASE_50_BASE SHA is treated as a frozen contract: the canary validates it resolves (`git show --format=%s -s`) before running any diffs. If the SHA changes, the canary throws and the executor MUST surface a divergence report — not silently update.

## Deviations from Plan

None — plan executed exactly as written. Both protected files (gsd-tools.cjs and bin/cli.cjs) were modified by Phase 50 exactly as expected, and all 13 protected paths show empty diffs as required.

## Issues Encountered

None — PG was available, all 7 E2E subtests passed on first run. Canary 6/6 passed on first run.

## v3.1 Surface Canary

No modifications to: `services/amauta-mcp.py`, `services/skill_schema.py`, `services/agent_hydrator.py`, `services/agent_hydrate_cli.py`, `services/module_schema.py`, `services/module_resolver.py`, `services/module_validator_cli.py`, `services/module_lifecycle.py`, `services/module_lifecycle_cli.py`, `services/install_record_store.py`, `scripts/skill-compiler.cjs`, `agents/*.md`, `bin/init.cjs`. Wave 4 creates test files only.

## Test Results

```
tests/party-e2e.test.cjs (node --test):
  party-e2e (PG required):
    e2e-create-start                         PASS  (424ms)
    e2e-post-three-findings                  PASS  (444ms)
    e2e-pause                                PASS  (214ms)
    e2e-simulated-daemon-restart-resume      PASS  (212ms)  ← SC4 Layer 2
    e2e-terminate                            PASS  (211ms)
    e2e-terminated-cannot-resume             PASS  (206ms)
    e2e-shortcut-equivalence                 PASS  (506ms)
Total: 7 pass, 0 fail, 0 skip  (2592ms)

tests/party-canary.test.cjs (node --test):
  canary-agents-untouched                    PASS  (10ms)
  canary-services-v31-untouched              PASS  (44ms)
  canary-phase-48-outputs-untouched          PASS  (24ms)
  canary-phase-49-outputs-untouched          PASS  (23ms)
  canary-gsd-tools-module-case-content-preserved  PASS  (11ms)
  canary-cli-module-branch-preserved         PASS  (8ms)
Total: 6 pass, 0 fail, 0 skip  (207ms)

tests/party-cli.test.cjs (Wave 3 regression):
Total: 10 pass, 0 fail, 0 skip

Python regression (Wave 1+2):
  tests/test_party_session_migration.py:      6 passed
  tests/test_party_session_state_machine.py: 13 passed
  tests/test_party_session_findings.py:       7 passed
  tests/test_party_session_resume.py:         6 passed
Total:                                        32 passed in 2.28s

GRAND TOTAL Phase 50: 55 tests (32 Python + 23 Node), 0 fail, 0 skip
```

## Next Plans

- **51** — Party Mode Decisions + Operator CLI (depends on 50; PARTY-03, PARTY-04)
- **52** — Agent Compilation (no Phase 50 deps; COMPILE-01..04)

---
*Phase: 50-party-mode-foundation*
*Completed: 2026-05-13*
