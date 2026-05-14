---
phase: 53-v3.1-carry-forwards
plan: 53-02
subsystem: installer
tags: [init, upgrade, uninstall, dry-run, migration-delta, preservation-contract, nodejs]

# Dependency graph
requires:
  - phase: 44-cross-ide-installer
    provides: bin/init.cjs 7-step flow + buildStepResult + worst-of combinator
  - phase: 49-module-lifecycle
    provides: compute_migration_delta pattern + upgrade/uninstall step vocabulary

provides:
  - bin/init.cjs --upgrade flag (6 frozen step names, idempotent, dry-run)
  - bin/init.cjs --uninstall flag (6 frozen step names, preservation contract, dry-run)
  - Mutual-exclusion guard: --upgrade + --uninstall → exit 1 stderr
  - tests/init-upgrade-uninstall.test.cjs (8 integration tests)

affects: [phase-53-polish-02, bin/init.cjs consumers, gsd-amauta installer users]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - name-alias injection into prevResults for FROZEN contract reuse (runUpgrade → stepAssertions)
    - PRESERVED_PATHS constant + post_uninstall_verify self-enforcing preservation
    - dry-run warn (not fail) on missing install record to allow full preview
    - makeInstallRecord() helper pattern for upgrade/uninstall integration tests

key-files:
  created:
    - tests/init-upgrade-uninstall.test.cjs
  modified:
    - bin/init.cjs

key-decisions:
  - "Phase 44 7-step install flow + existing flags UNCHANGED: only additive extension"
  - "Mutual exclusion via scoped block guard immediately after arg parsing, before any consumers"
  - "restart_daemon→start_daemon alias injected into prevResults to preserve stepAssertions FROZEN contract"
  - "dry-run: detect_current_version warns (not fails) on missing record to allow full preview of 6 steps"
  - "Preservation contract enforced by post_uninstall_verify asserting PRESERVED_PATHS exist at uninstall close"
  - "Install record at ~/.amauta/data/install_record.json (JSON fallback, mirrors SQLITE_FALLBACK_PATH in module_lifecycle.py)"

patterns-established:
  - "Alias injection: pass {...restartResult, name: 'start_daemon'} in prevForAssertions to preserve FROZEN stepAssertions lookup"
  - "PRESERVED_PATHS constant as named array → explicitly documents what is never deleted"
  - "makeInstallRecord(home, appliedMigrations, version) test helper for precise delta-count assertions"

requirements-completed: [POLISH-02]

# Metrics
duration: 45min
completed: 2026-05-14
---

# Plan 53-02: POLISH-02 --upgrade and --uninstall flags

**bin/init.cjs gains --upgrade (6 frozen migration-delta steps) + --uninstall (6 frozen steps with preservation contract) + mutual-exclusion guard + --dry-run support; Phase 44 7-step install flow UNCHANGED**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-14
- **Completed:** 2026-05-14
- **Tasks:** 4
- **Files modified:** 2 (bin/init.cjs modified, tests/init-upgrade-uninstall.test.cjs created)

## Accomplishments
- Added `--upgrade` and `--uninstall` flags to `bin/init.cjs` with 12 total frozen step names
- Phase 44's 7-step install flow, buildStepResult, and all existing flags preserved exactly
- Mutual-exclusion guard: `--upgrade --uninstall` together → exit 1 stderr "mutually exclusive"
- Idempotency for both flows: re-upgrade at latest migrations → all skip exit 0; no install record → uninstall all skip exit 0
- Preservation contract self-enforced by `post_uninstall_verify` asserting `.planning/`, `tests/`, `services/`, `agents/`, `migrations/` still exist
- 8 integration tests all pass (node --test exits 0, duration 778ms)

## Task Commits

Each task was committed atomically:

1. **Task 53-02-01: Flag parsing + dispatch stubs** - `4e728e5` (feat)
2. **Task 53-02-02: runUpgrade() implementation** - `b875eb3` (feat)
3. **Task 53-02-03: runUninstall() implementation** - `535b3b0` (feat)
4. **Task 53-02-04: tests/init-upgrade-uninstall.test.cjs** - `98dc071` (feat)

## Files Created/Modified
- `bin/init.cjs` — Extended with --upgrade/--uninstall/--dry-run flags, mutual-exclusion guard, emitResults(), runUpgrade() (6 steps), runUninstall() (6 steps)
- `tests/init-upgrade-uninstall.test.cjs` — 8 integration tests covering mutual exclusion, upgrade dry-run, idempotency, delta, uninstall dry-run, preservation contract

## Decisions Made
- Phase 44 `stepAssertions` frozen contract preserved by injecting `restart_daemon` result with name alias `start_daemon` into `prevForAssertions`; this avoids any modification to frozen Phase 44 code
- `detect_current_version` returns `warn` (not `fail`) when install record is absent in dry-run mode, allowing full 6-step preview; real mode keeps `fail` + early abort
- `PRESERVED_PATHS` defined as a named constant in `runUninstall`; `post_uninstall_verify` asserts all paths still exist — makes the preservation contract load-bearing (will fail loudly if violated)
- Install record location mirrors `SQLITE_FALLBACK_PATH` in `module_lifecycle.py`: `~/.amauta/data/install_record.json`
- `platform-codes.yaml` deletion gated on content marker (`amauta_generated`, `generated_by: amauta`, etc.) — user-edited files never touched

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness
- POLISH-02 complete. Plan 53-03 (POLISH-03: MCP amauta/bearings tool) is next.
- bin/init.cjs stable: 3 modes (install / upgrade / uninstall), all idempotent, all dry-runnable
- No blockers.

---
*Phase: 53-v3.1-carry-forwards*
*Completed: 2026-05-14*
