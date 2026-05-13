---
phase: 49-module-cli-lifecycle
plan: "49-04"
subsystem: backend, cli
tags: [python, argparse, nodejs, gsd-tools, cli, lifecycle, install, uninstall, upgrade, dry-run, exit-codes, e2e, integration-tests]

# Dependency graph
requires:
  - phase: 49-module-cli-lifecycle (49-01/02/03)
    provides: services/module_lifecycle.py install()/uninstall()/upgrade() + LifecycleResult + install_record_store
  - phase: 48-module-system-foundation
    provides: services/module_validator_cli.py (argparse pattern) + gsd-tools case 'module': at L3629

provides:
  - services/module_lifecycle_cli.py — Python argparse entry-point for install/uninstall/upgrade with frozen 0/1/2 exit-code mapping
  - get-shit-done/bin/gsd-tools.cjs case 'module': extended — KNOWN_ACTIONS Set promotes install/uninstall/upgrade to real spawnSync dispatch
  - bin/cli.cjs 'module' branch — npx gsd-amauta module <action> routes through gsd-tools.cjs
  - tests/module-lifecycle-cli.test.cjs — 11 integration tests for CLI dispatch surface + bin/cli.cjs shortcut
  - tests/module-lifecycle-e2e.test.cjs — 7 hermetic E2E tests (SC1 round-trip, SC2 dry-run, SC3 upgrade, SC4 rollback mapping)

affects: [50-party-mode-foundation, 53-v31-carry-forwards]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - module_lifecycle_cli.py mirrors module_validator_cli.py: argparse subparsers, sys.path bootstrap, try/except fallback import, --json mode, human render, exit-code derivation
    - gsd-tools.cjs module case: KNOWN_ACTIONS Set for whitelist expansion, separate validate/lifecycle dispatch blocks, args[1]/slice(2) indexing preserved (Phase 48 Issue 1 fix)
    - bin/cli.cjs module branch: spawnSync-based dispatch mirrors mcp branch; argv rewrite so gsd-tools.cjs sees 'module' as command[2]
    - E2E tests: HOME=tmpRoot for hermetic install records; absolute manifest paths required (gsd-tools.cjs Python cwd=repoRoot hardcoded); cleanupInstalledFiles() for repoRoot agent/skill cleanup
    - derive_exit_code(): 3-level mapping (pass/skip/warn→0, fail+clean_rollback→1, fail+partial/no_rollback→2)

key-files:
  created:
    - services/module_lifecycle_cli.py
    - tests/module-lifecycle-cli.test.cjs
    - tests/module-lifecycle-e2e.test.cjs
  modified:
    - get-shit-done/bin/gsd-tools.cjs (case 'module': extended with install/uninstall/upgrade)
    - bin/cli.cjs (module branch added)
    - tests/module-validate-cli.test.cjs (usage assertion updated for Phase 49 multi-line format)

key-decisions:
  - "spawnSync over require() for bin/cli.cjs module dispatch: gsd-tools.cjs guards main() with require.main===module, blocking require()-based dispatch. spawnSync preserves stdio inheritance and is consistent with the mcp branch pattern."
  - "Absolute manifest paths in E2E tests: gsd-tools.cjs hardcodes cwd=repoRoot for Python subprocess, so relative paths from tmpRoot fail os.path.isfile() preflight. Absolute paths from tmpRoot fixture copies are the correct design."
  - "HOME=tmpRoot for install record isolation: install_record_store uses os.path.expanduser('~/.amauta/data/module_installs.json') — redirecting HOME makes the JSON store hermetic per test without any store code changes."
  - "cleanupInstalledFiles() for agent/skill repoRoot side-effects: since Python copies agents/skills relative to repoRoot cwd, E2E tests that do real installs must clean up after themselves to avoid leaving test-agent.md in the production agents/ directory."

patterns-established:
  - "Python CLI entry-point pattern: build_parser() + derive_exit_code() + render_human() + main() + if __name__ == '__main__': guard — matches module_validator_cli.py structure"
  - "KNOWN_ACTIONS Set pattern for gsd-tools.cjs case blocks: enables safe extension of action whitelist without accidental promotion of unknown actions"
  - "E2E test design with cwd-reality awareness: always probe gsd-tools.cjs Python subprocess cwd before designing hermetic tests; the cwd may not equal the test's tmpdir"

requirements-completed:
  - MOD-03
  - MOD-04

# Metrics
duration: ~90min
completed: 2026-05-13
---

# Phase 49 Plan 04: CLI dispatch + module_lifecycle_cli.py + E2E + v3.1 canary

**Python argparse entry-point for install/uninstall/upgrade wired through gsd-tools.cjs + bin/cli.cjs with 18 integration/E2E tests and a clean 10-path v3.1 canary**

## Performance

- **Duration:** ~90 min
- **Started:** 2026-05-13T14:00:00Z
- **Completed:** 2026-05-13T16:30:00Z
- **Tasks:** 6 (01 pre-committed, 02 pre-committed, 03 pre-committed, 04 pre-committed, 05 created + fixed, 06 canary verification)
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- `services/module_lifecycle_cli.py` ships as the Python CLI entry-point with 4 functions (`build_parser`, `derive_exit_code`, `render_human`, `main`), 3 subcommands (install/uninstall/upgrade), 3 shared flags (`--dry-run`, `--json`, `--force`), and frozen 0/1/2 exit-code mapping from `LifecycleResult.status`
- `gsd-tools.cjs` `case 'module':` extended with `KNOWN_ACTIONS = new Set(['validate', 'install', 'uninstall', 'upgrade'])` — Phase 48 validate dispatch preserved; 3 new actions dispatch via spawnSync to `module_lifecycle_cli.py`; args[1]/slice(2) indexing preserved from Phase 48 Issue 1 fix
- `bin/cli.cjs` gains a `module` branch routing `npx gsd-amauta module <action>` through gsd-tools.cjs via spawnSync (argv rewrite pattern)
- 11 integration tests in `tests/module-lifecycle-cli.test.cjs` covering all 3 actions, dry-run, missing manifest, unknown action, Phase 48 regression, frozen JSON key contract, and bin/cli.cjs shortcut parity
- 7 hermetic E2E tests in `tests/module-lifecycle-e2e.test.cjs` covering SC1 (install→uninstall round-trip), SC2 (dry-run no-op + would_apply block), SC3 (upgrade v1→v2 version bump + installed_at preservation), idempotent reinstall, and absent-module skip
- Phase 49 closeout canary: 10/10 protected paths have empty diff vs ecffbea; 68 pytest + 18 Node tests all pass

## Task Commits

1. **Task 49-04-01: services/module_lifecycle_cli.py** — `3d734fb` (feat)
2. **Task 49-04-02: gsd-tools.cjs case 'module': extended** — `5a3d3e6` (feat)
3. **Task 49-04-03: bin/cli.cjs module branch** — `9511ed2` (feat)
4. **Task 49-04-04: tests/module-lifecycle-cli.test.cjs** — `5d859d0` (feat)
5. **Task 49-04-05: tests/module-lifecycle-e2e.test.cjs (initial)** — `1b3e1af` (feat)
6. **Task 49-04-06: fix Phase 48 test usage assertion** — `530ef5a` (fix)
7. **Task 49-04-05 (fixed): tests/module-lifecycle-e2e.test.cjs rewrite** — `3c4a77f` (fix)

## Files Created/Modified

- `services/module_lifecycle_cli.py` — Python argparse entry-point for install/uninstall/upgrade
- `get-shit-done/bin/gsd-tools.cjs` — case 'module': extended with install/uninstall/upgrade dispatch
- `bin/cli.cjs` — module branch added (spawnSync dispatch to gsd-tools.cjs)
- `tests/module-lifecycle-cli.test.cjs` — 11 integration tests for CLI dispatch + bin/cli.cjs shortcut
- `tests/module-lifecycle-e2e.test.cjs` — 7 hermetic E2E tests (SC1/SC2/SC3 gates)
- `tests/module-validate-cli.test.cjs` — usage assertion updated for Phase 49 multi-line format (Phase 48 regression fix)

## Decisions Made

1. **spawnSync over require() for bin/cli.cjs module dispatch**: gsd-tools.cjs guards `main()` with `require.main === module`, so `require(toolsPath)` from cli.cjs does not invoke main(). Used spawnSync with stdio: 'inherit' instead, matching the plan's intent of "rewrite argv so gsd-tools.cjs sees 'module' as its command".

2. **Absolute manifest paths required in E2E tests**: gsd-tools.cjs's Python subprocess uses `cwd: repoRoot` unconditionally. The plan described a `cwd: env.HOME` design for runStep, but this does not make manifest paths hermetic — Python's `os.path.isfile()` preflight sees relative paths as relative to repoRoot. Fixed by returning absolute paths from `setupHermeticTree()`.

3. **HOME=tmpRoot for install record isolation**: install_record_store uses `os.path.expanduser('~/.amauta/data/module_installs.json')`. Overriding HOME in the subprocess env redirects the JSON store without any store code changes.

4. **cleanupInstalledFiles() added for E2E**: since agent/skill copies land in repoRoot (not tmpRoot), real-install E2E tests must clean up after themselves. Added a try/catch cleanup helper to avoid test-agent.md persisting in the production agents/ directory.

## Deviations from Plan

### Auto-fixed Issues

**1. Phase 48 test regression (usage string format change)**
- **Found during:** Task 49-04-06 (canary run of `node tests/module-validate-cli.test.cjs`)
- **Issue:** Phase 49's `gsd-tools.cjs` case 'module': changed the usage format from single-line `Usage: gsd-tools module validate...` to multi-line `Usage:\n  gsd-tools module validate...`. The Phase 48 test asserted `r.stderr.includes('Usage: gsd-tools module validate')` which failed on the new format.
- **Fix:** Updated assertion to `r.stderr.includes('gsd-tools module validate')` (removes the `Usage: ` prefix from the match string).
- **Files modified:** `tests/module-validate-cli.test.cjs`
- **Verification:** `node tests/module-validate-cli.test.cjs` exits 0, 7 passed.
- **Committed in:** `530ef5a` (fix(49-04-06))

**2. E2E test gsd-tools cwd reality**
- **Found during:** Task 49-04-05 first run
- **Issue:** Plan described `cwd: env.HOME` for `runStep`, assuming Python would use the hermetic tmpRoot as its cwd. However, gsd-tools.cjs hardcodes `cwd: repoRoot` for the Python subprocess. Relative manifest paths from the tmpRoot failed `os.path.isfile()`.
- **Fix:** Rewrote E2E tests to use absolute manifest paths from tmpRoot + keep `cwd: repoRoot` for the Node subprocess.
- **Files modified:** `tests/module-lifecycle-e2e.test.cjs`
- **Verification:** All 7 E2E tests pass.
- **Committed in:** `3c4a77f` (fix(49-04-05))

---

**Total deviations:** 2 auto-fixed (1 Phase 48 test regression from format change, 1 E2E design reality mismatch)
**Impact on plan:** Both necessary for correctness. The Phase 48 test fix is a cosmetic string-match update; the E2E rewrite preserves full test intent with correct hermetic design.

## Issues Encountered

- gsd-tools.cjs Python subprocess `cwd: repoRoot` is hardcoded — this is the correct production behavior (Python services import from the repo root) but it means E2E tests cannot create a fully hermetic working tree for agent/skill filesystem assertions. The install record (HOME-redirected JSON file) is the correct hermetic assertion surface, which matches the plan's "install record assertions are the load-bearing check" note.

## Canary Results (Phase 49 Closeout Gate)

All 10 protected paths have empty diff vs `ecffbea`:
- `services/module_schema.py` — EMPTY
- `services/module_resolver.py` — EMPTY
- `services/module_validator_cli.py` — EMPTY
- `services/amauta-mcp.py` — EMPTY
- `services/skill_schema.py` — EMPTY
- `services/agent_hydrator.py` — EMPTY
- `services/agent_hydrate_cli.py` — EMPTY
- `scripts/skill-compiler.cjs` — EMPTY
- `bin/init.cjs` — EMPTY
- `agents/` — EMPTY

## Test Counts

- `node tests/module-validate-cli.test.cjs` → 7 passed (Phase 48 regression)
- `node tests/module-lifecycle-cli.test.cjs` → 11 passed
- `node tests/module-lifecycle-e2e.test.cjs` → 7 passed
- `pytest tests/test_install_record_store.py tests/test_module_lifecycle_skeleton.py tests/test_module_lifecycle_install.py tests/test_module_lifecycle_uninstall.py tests/test_module_lifecycle_rollback.py tests/test_module_lifecycle_upgrade.py tests/test_migration_delta.py` → 68 passed

**Phase 49 total: 93 tests (68 pytest + 25 Node)**

## Next Phase Readiness

Phase 49 COMPLETE. All 4 plans shipped (49-01/02/03/04). MOD-03 and MOD-04 requirements fulfilled.

The full module lifecycle surface is now operator-accessible:
- `gsd-amauta module validate <manifest.yaml>` (Phase 48)
- `gsd-amauta module install <manifest.yaml> [--dry-run] [--json] [--force]`
- `gsd-amauta module uninstall <module-name> [--dry-run] [--json]`
- `gsd-amauta module upgrade <new-manifest.yaml> [--dry-run] [--json] [--force]`

Phase 50 (Party Mode Foundation) is next and has no dependency on Phase 49.

---
*Phase: 49-module-cli-lifecycle*
*Completed: 2026-05-13*
