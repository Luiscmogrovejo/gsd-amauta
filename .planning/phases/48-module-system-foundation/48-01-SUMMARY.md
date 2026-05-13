---
phase: 48-module-system-foundation
plan: 48-01
subsystem: api
tags: [pydantic, python, semver, yaml, module-system, resolver, pytest]

# Dependency graph
requires: []
provides:
  - ModuleManifest Pydantic v2 model with 8-field locked declaration order + _HAS_PYDANTIC/_HAS_YAML fallbacks
  - pure-function resolve() producing frozen ResolveResult with schema_version "1.0"
  - module_validator_cli.py argparse entry-point with exit codes 0/1/2 + --json flag
  - 3 fixture YAML files: core-1.2.0, feature-requires-core (satisfiable), feature-wants-core-v2 (conflict)
  - 24 pytest tests across test_module_schema.py + test_module_resolver.py
affects: [phase-49-module-cli-lifecycle]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Pydantic v2 model_config extra=forbid + field_validator + model_validator(mode=after) for cross-field checks
    - _HAS_PYDANTIC + _HAS_YAML import-safety dual-path (mirrors skill_schema.py Phase 43)
    - Frozen SCHEMA_FIELD_ORDER tuple at module scope + regression-locked by pytest introspection
    - SCHEMA_VERSION = "1.0" module-level constant replicated into every ResolveResult
    - Kahn's algorithm (alphabetical tiebreak) + DFS cycle detection (separate passes)
    - Fails-closed resolver: return dict, never raises

key-files:
  created:
    - services/module_schema.py
    - services/module_resolver.py
    - services/module_validator_cli.py
    - tests/test_module_schema.py
    - tests/test_module_resolver.py
    - tests/fixtures/modules/core-1.2.0/module.yaml
    - tests/fixtures/modules/feature-requires-core/module.yaml
    - tests/fixtures/modules/feature-wants-core-v2/module.yaml
  modified: []

key-decisions:
  - "Migration file on-disk existence check deferred to Phase 49 install logic (not load-time context)"
  - "Pre-release ordering deferred to v3.3+ — pre-release tags parse but compare equal to release version"
  - "Cycle detection uses DFS (separate pass) + Kahn's algorithm for install_order (separate pass) for clarity"
  - "Resolver fails-closed via return-dict — never raises, even for cycle or malformed ranges"
  - "conflict fixture (feature-wants-core-v2) committed to disk so Phase 49 tests reuse stable on-disk scenario"

patterns-established:
  - "_HAS_PYDANTIC + _HAS_YAML dual-import-safety: both guards required for schema files loading YAML"
  - "SCHEMA_FIELD_ORDER tuple at module scope + pytest model_fields introspection lock (SC4 discipline)"
  - "SCHEMA_VERSION='1.0' constant present in every resolver return dict (Phase 48→49 contract)"
  - "Committed conflict fixture pattern: Phase 49 tests load from disk rather than constructing at runtime"

requirements-completed:
  - MOD-01
  - MOD-02

# Metrics
duration: ~60min (tasks 1-4 pre-committed; tasks 5-6 executed in this session)
completed: 2026-05-13
---

# Plan 48-01 Summary

**Pydantic v2 ModuleManifest with 8-field locked declaration order + pure-function semver resolver (caret/tilde/exact/zero-major) with cycle detection + argparse CLI entry-point + 24 pytest tests**

## Performance

- **Duration:** ~60 min (tasks 1-4 pre-committed; tasks 5-6 in this session)
- **Started:** 2026-05-13
- **Completed:** 2026-05-13
- **Tasks:** 6 of 6
- **Files created:** 8

## Accomplishments

- `services/module_schema.py`: Pydantic v2 `ModuleManifest` with 8-field LOCKED order (`name → version → description → requires → migrations → services → agents → skills`), `_HAS_PYDANTIC`+`_HAS_YAML` import-safety, `SCHEMA_FIELD_ORDER` tuple, `load_module_manifest()` helper. Self-dependency and at-least-one-ships validations.
- `services/module_resolver.py`: Pure-function `resolve()` returning frozen `ResolveResult` with `schema_version "1.0"`, topological install order (Kahn's + alphabetical tiebreak), DFS cycle detection (first-class `cycle` field), conflict detection for non-overlapping ranges + version-vs-range mismatches, missing dependency tracking. Fails-closed via return dict.
- `services/module_validator_cli.py`: argparse `__main__` entry-point with exit codes 0/1/2, `--json` flag, I/O error vs validation error vs resolver conflict routing, human-readable summary fallback.
- 3 fixture YAML files committed: `core-1.2.0` (satisfiable base), `feature-requires-core` (depends `^1.0.0`), `feature-wants-core-v2` (depends `^2.0.0` — committed conflict fixture for Phase 49 reuse).
- 24 pytest tests: 11 schema tests (SC4 regression lock, valid/invalid manifests, self-dep, empty-ships, extra-field) + 13 resolver tests (empty, satisfiable fixture, committed conflict fixture, programmatic conflict, missing, cycle, alphabetical tiebreak, semver caret/zero-major/tilde/exact, determinism, schema_version).

## Task Commits

1. **Task 48-01-01: services/module_schema.py** — `087751f` (feat)
2. **Task 48-01-02: services/module_resolver.py** — `233bbe4` (feat)
3. **Task 48-01-03: services/module_validator_cli.py** — `72ec18f` (feat)
4. **Task 48-01-04: 3 fixture YAML files** — `79c52fc` (feat)
5. **Task 48-01-05: tests/test_module_schema.py** — `0db40f5` (feat)
6. **Task 48-01-06: tests/test_module_resolver.py** — `430b8b2` (feat)

## Files Created

- `services/module_schema.py` — ModuleManifest Pydantic v2 model + SCHEMA_FIELD_ORDER + _HAS_PYDANTIC/_HAS_YAML + load_module_manifest
- `services/module_resolver.py` — resolve() + SCHEMA_VERSION + semver helpers + Kahn's topo sort + DFS cycle detection
- `services/module_validator_cli.py` — argparse __main__ entry-point, exit codes 0/1/2, --json flag
- `tests/test_module_schema.py` — 11 pytest tests (SC4 regression lock + valid/invalid assertions)
- `tests/test_module_resolver.py` — 13 pytest tests (semver subset + conflict/missing/cycle + determinism)
- `tests/fixtures/modules/core-1.2.0/module.yaml` — core fixture v1.2.0
- `tests/fixtures/modules/feature-requires-core/module.yaml` — satisfiable dependent fixture
- `tests/fixtures/modules/feature-wants-core-v2/module.yaml` — committed conflict fixture (Phase 49 reuse)

## Decisions Made

- Migration file on-disk existence check deferred to Phase 49 install logic. At load-module-manifest time, migration path resolution against module root is install-time context not validation context.
- Caret zero-major (`^0.x.y`) follows npm semantics: locks to minor (`>=0.x.y, <0.(x+1).0`) not major.
- DFS cycle detection and Kahn's topo sort are separate passes for clarity. Both run only when needed.
- `feature-wants-core-v2` fixture committed so Phase 49 tests can load from disk rather than constructing conflict manifests programmatically — stable on-disk reference for downstream phases.

## Deviations from Plan

### Minor AC Divergence — Self-Referential grep Count

The AC `grep -c "test_schema_field_order_locked" tests/test_module_schema.py returns 1` returns 2 because the function name also appears in the module docstring list. The function definition (`def test_schema_field_order_locked():`) is at line 67. This is a known self-referential grep pattern (see `feedback_self_referential_ac_grep`). Substantive AC: 1 function definition exists — confirmed.

### Minor Fix — test_schema_version_present used 1-char names

Initial write used `"a"` and `"b"` as module names. The `_NAME_RE` requires `^[a-z][a-z0-9-]{1,63}$` (minimum 2 chars). Fixed to `"mod-a"` and `"mod-b"` before commit.

**Total deviations:** 2 (1 known grep pattern, 1 test bug caught in T-phase and fixed before commit)
**Impact on plan:** No scope creep. All 24 tests pass.

## Issues Encountered

None. All 24 tests pass. Protected v3.1 files verified untouched via canary diff.

## Next Phase Readiness

- Phase 48-02 can now wire `gsd-tools module validate` through `get-shit-done/bin/gsd-tools.cjs` as `case 'module':` (shells out to `module_validator_cli.py`).
- Phase 49 (Module CLI + Lifecycle) can import `resolve()` from `services.module_resolver` and `load_module_manifest` from `services.module_schema` without modification.
- Committed conflict fixture (`feature-wants-core-v2`) is ready for Phase 49 integration tests.

---
*Phase: 48-module-system-foundation*
*Completed: 2026-05-13*
