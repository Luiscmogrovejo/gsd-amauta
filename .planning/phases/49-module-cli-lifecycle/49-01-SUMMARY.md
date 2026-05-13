---
phase: 49-module-cli-lifecycle
plan: "49-01"
subsystem: database, backend
tags: [python, postgresql, sqlite, psycopg2, dataclass, migration, lifecycle]

# Dependency graph
requires:
  - phase: 48-module-system-foundation
    provides: services/module_schema.py ModuleManifest + services/module_resolver.py resolve()
  - phase: 44-cross-ide-installer
    provides: services/infra_detect.py PG/SQLite cascade + bin/init.cjs buildStepResult pattern

provides:
  - migrations/022-module-installs.sql — 8-column module_installs table with installed_at DESC index
  - migrations/022-module-installs-DOWN.sql — drops table with IF EXISTS
  - services/module_lifecycle.py — SCHEMA_VERSION + 22 frozen step names (3 tuples) + LifecycleResult dataclass + worst_of_status + compute_manifest_hash + 3 stub functions
  - services/install_record_store.py — get/put/delete/list CRUD with PG-or-SQLite cascade + _detect_backend env override
  - tests/test_install_record_store.py — 10 SQLite-fallback CRUD tests (0.07s)
  - tests/test_module_lifecycle_skeleton.py — 19 regression locks (0.07s)

affects: [49-02, 49-03, 49-04, 53-v3.1-carry-forwards]

# Tech tracking
tech-stack:
  added: [pyyaml-for-manifest-hash, dataclasses-asdict, psycopg2-RealDictCursor]
  patterns:
    - PG-or-SQLite cascade via _detect_backend() + GSD_INSTALL_RECORD_BACKEND env override
    - frozen constants as module-level tuples for step vocabulary (22 names, 3 operations)
    - worst-of-status combinator (fail > warn > pass > skip)
    - atomic JSON write via tempfile + os.replace

key-files:
  created:
    - migrations/022-module-installs.sql
    - migrations/022-module-installs-DOWN.sql
    - services/module_lifecycle.py
    - services/install_record_store.py
    - tests/test_install_record_store.py
    - tests/test_module_lifecycle_skeleton.py
  modified: []

key-decisions:
  - "Stub functions return LifecycleResult(status='skip') in 49-01; real bodies filled in 49-02/49-03"
  - "GSD_INSTALL_RECORD_BACKEND=sqlite env override enables hermetic test isolation without PG"
  - "SQLITE_FALLBACK_PATH monkeypatched via setattr (not reload) — matches Phase 44 pydantic-settings discipline"
  - "_json_file_path() indirection in install_record_store allows monkeypatch without reload side effects"
  - "compute_manifest_hash requires PyYAML — raises RuntimeError if absent (fail-loud vs silent wrong hash)"

patterns-established:
  - "Stub skeleton: 49-01 ships shape, 49-02/49-03 replace bodies — allows downstream tests to import without NotImplementedError"
  - "PG/SQLite cascade: _detect_backend() checks GSD_INSTALL_RECORD_BACKEND env first, then infra_detect, then default sqlite"
  - "Atomic file write: tempfile.mkstemp + os.fdopen + os.replace; cleanup on failure via try/except"
  - "Regression lock test: assert tuple == expected_tuple with full message (not just len check)"

requirements-completed: [MOD-03, MOD-04]

# Metrics
duration: ~45min
completed: 2026-05-13
---

# Plan 49-01 Summary

**Phase 49 foundation: migration 022 (module_installs), module_lifecycle.py skeleton with 22 frozen step names + LifecycleResult dataclass, install_record_store.py PG/SQLite cascade, 29 regression tests — 0 failures**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-13
- **Completed:** 2026-05-13
- **Tasks:** 5 (49-01-01 through 49-01-05)
- **Files created:** 6

## Accomplishments

- Migration 022 ships 8-column `module_installs` table with `module_name VARCHAR(64) PRIMARY KEY`, `manifest_hash CHAR(64)`, four TEXT[] arrays, and `installed_at DESC` index — DOWN file drops with IF EXISTS
- `services/module_lifecycle.py` skeleton locks SCHEMA_VERSION="1.0", 22 step names in 3 frozen tuples (INSTALL_STEPS/UNINSTALL_STEPS/UPGRADE_STEPS), 5 exit/prefix constants, `LifecycleResult` dataclass with `to_dict()`, `worst_of_status` combinator, `compute_manifest_hash` SHA-256 helper
- `services/install_record_store.py` ships full CRUD (get/put UPSERT/delete/list) with PG psycopg2 path and SQLite JSON fallback; `GSD_INSTALL_RECORD_BACKEND=sqlite` env override enables hermetic test isolation
- 29 tests: 10 SQLite CRUD + 19 skeleton regression locks — all PASS in 0.07s each
- Canary diff EMPTY: no v3.1 protected file and no Phase 48 file modified

## Task Commits

Each task committed atomically:

1. **Task 49-01-01: migration 022 UP + DOWN** — `da21169`
2. **Task 49-01-02: services/module_lifecycle.py skeleton** — `a1c1f88`
3. **Task 49-01-03: services/install_record_store.py** — `5d58d2b`
4. **Task 49-01-04: tests/test_install_record_store.py** — `40cb593`
5. **Task 49-01-05: tests/test_module_lifecycle_skeleton.py** — `0d549b2`

## Files Created

- `migrations/022-module-installs.sql` — 8-column DDL, index on installed_at DESC, COMMENT blocks
- `migrations/022-module-installs-DOWN.sql` — DROP INDEX IF EXISTS + DROP TABLE IF EXISTS
- `services/module_lifecycle.py` — 304 lines: frozen constants + 2 dataclasses + 3 helpers + 3 stubs
- `services/install_record_store.py` — 382 lines: CRUD + dual-backend cascade
- `tests/test_install_record_store.py` — 201 lines, 10 tests (10 PASS)
- `tests/test_module_lifecycle_skeleton.py` — 282 lines, 19 tests (19 PASS)

## Decisions Made

- Stub functions (`install`/`uninstall`/`upgrade`) return `status="skip"` in 49-01 — allows 49-01-05 tests to import + assert shapes without NotImplementedError; plans 49-02/49-03 REPLACE these bodies
- `_json_file_path()` indirection in install_record_store allows monkeypatch via `setattr` on the module attribute without reload side effects (consistent with Phase 44 pydantic-settings discipline)
- `compute_manifest_hash` raises `RuntimeError` if PyYAML absent — fail-loud is safer than silently producing a wrong hash
- `_detect_backend()` checks `GSD_INSTALL_RECORD_BACKEND` env first (test isolation), then `infra_detect`, then defaults to `"sqlite"` — same cascade as Phase 44

## Deviations from Plan

None — plan executed exactly as specified. The `roadmap_head` discrepancy (plan says `ecffbea`, HEAD was `4a531a7`) is non-blocking: the 3 intermediate commits are documentation-only pre-writes for phases 50/52/53 and none touch any dependency file (`git diff ecffbea..HEAD -- <deps>` is empty).

## Issues Encountered

- Task 49-01-01 commit required explicit `git add` for new files before `git commit -- <pathspec>` (new untracked files aren't staged by pathspec alone). Standard behavior, no impact.

## User Setup Required

None — migration 022 is authored but not applied. Phase 49 install logic (49-02) will apply it at install time. Operator can manually apply via `psql -f migrations/022-module-installs.sql` if needed before 49-02 lands.

## Next Phase Readiness

- Plans 49-02/49-03/49-04 can now proceed: the foundation (migration schema + dataclasses + store) is in place
- 49-02: implement `install()` + `uninstall()` bodies in `services/module_lifecycle.py`
- 49-03: implement `upgrade()` body
- 49-04: CLI dispatch in `gsd-tools.cjs` `case 'module':` + E2E tests

---
*Phase: 49-module-cli-lifecycle*
*Completed: 2026-05-13*
