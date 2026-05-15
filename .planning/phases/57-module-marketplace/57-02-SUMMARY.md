---
phase: 57-module-marketplace
plan: 57-02
subsystem: backend
tags: [python, argparse, registry, search, ranking, semver, nodejs]

# Dependency graph
requires:
  - phase: 57-module-marketplace
    provides: RegistryIndex/RegistryEntry schema, _REGISTRY_ERROR_CODES 8-tuple, load_registry_index, SCHEMA_VERSION (57-01)
  - phase: 48-module-foundation
    provides: _parse_version(v) semver helper reused for descending sort key
  - phase: 49-module-lifecycle
    provides: module_lifecycle_cli.py argparse pattern + sys.path setup + spawnSync dispatch convention

provides:
  - services/module_search.py — search(), _tier(), fetch_remote(), load_index(), SearchError, CACHE_PATH, REPO_INDEX_PATH
  - services/module_search_cli.py — argparse front-end for module search; --registry URL override; --json output
  - gsd-tools.cjs case 'module': extended with 'search' action + KNOWN_ACTIONS whitelist update
  - 18 passing tests covering tier ranking, semver ordering, load_index fallback, fetch_remote errors, CLI integration

affects:
  - 57-03 (URL install) — same KNOWN_ACTIONS pattern; same SearchError vocabulary
  - 58 (public launch) — marketplace search is a headline feature for README/docs

# Tech tracking
tech-stack:
  added: []  # zero new deps — urllib.request only
  patterns:
    - 3-tier ranking: exact-name(0) > name-substring(1) > maintainer-substring(2), tier-3 = excluded
    - Negated semver tuple (-major,-minor,-patch) for semver-descending sort within tier
    - load_index() 3-source fallback chain: URL -> cache (~/.gsd-amauta/registry-cache/) -> in-repo
    - Non-fatal cache write (OSError caught silently)
    - Node spawnSync with stdio:'inherit' for search passthrough (vs stdio:'utf8' for captured output)
    - sys.path.insert(0, REPO_ROOT) at top of Python subprocess CLI (mirrors lifecycle_cli.py pattern)

key-files:
  created:
    - services/module_search.py
    - services/module_search_cli.py
    - tests/test_module_search.py
  modified:
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "KNOWN_ACTIONS Set updated to include 'search' — critical for bypassing early-exit guard at L3780"
  - "stdio:'inherit' for search spawnSync (user sees output directly); lifecycle uses encoding:'utf8'"
  - "18 tests (12+ required): added case-insensitive test + maintainer-after-name ordering + JSON decode error"
  - "python3 -m pytest is the accepted invocation in this repo (homebrew pytest lacks cwd sys.path injection)"

patterns-established:
  - "Phase 57 search dispatch: spawnSync with stdio:inherit + cwd:repoRoot + process.exit(status||0)"
  - "SearchError.error_code always from _REGISTRY_ERROR_CODES (frozen 8-tuple) — no 9th token"
  - "CLI exit codes: 0=success, 2=SearchError (consistent with Phase 49 lifecycle_cli convention)"

requirements-completed: [MARK-02]

# Metrics
duration: 25min
completed: 2026-05-14
---

# Phase 57 Plan 57-02: Module Marketplace Search Summary

**3-tier ranked search CLI (`gsd-amauta module search`) with local cache, remote registry override, and semver-descending tie-break — 18 tests, zero new deps**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-14T00:30:00Z
- **Completed:** 2026-05-14T01:00:00Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- `services/module_search.py`: single-pass O(n) tier-ranked scan. `_tier()` returns 0/1/2/3. `search()` uses negated semver tuple for descending sort. `fetch_remote()` via urllib.request (30s timeout, non-fatal cache write). `load_index()` 3-source fallback chain.
- `services/module_search_cli.py`: argparse front-end with query positional + `--registry` + `--json`. Exit codes 0/2. sys.path setup mirrors Phase 49 pattern.
- `gsd-tools.cjs`: `'search'` added to `KNOWN_ACTIONS` Set, search action dispatch added with `stdio:'inherit'`, usage string updated.
- 18 tests: 5 tier tests, 6 ordering tests (including case-insensitive and maintainer-after-name), 2 load_index tests, 3 fetch_remote error tests, 2 CLI integration tests.

## Task Commits

1. **Task 57-02-01 (TK-1436): services/module_search.py** — `b7570d9`
2. **Task 57-02-02 (TK-1437): services/module_search_cli.py + gsd-tools.cjs** — `b2f999a`
3. **Task 57-02-03 (TK-1438): tests/test_module_search.py** — `0aab898`

## Files Created/Modified
- `services/module_search.py` — ranking logic, fetch_remote, load_index, SearchError (134 lines)
- `services/module_search_cli.py` — argparse CLI front-end (70 lines)
- `tests/test_module_search.py` — 18-test suite (191 lines)
- `get-shit-done/bin/gsd-tools.cjs` — KNOWN_ACTIONS + search dispatch + usage update (+17 lines)

## Decisions Made
- `stdio:'inherit'` for search spawnSync so JSON output passes through unmodified (vs `encoding:'utf8'` used by lifecycle dispatch which captures stdout for re-emit).
- Negated semver tuple `(-major, -minor, -patch)` is the cleanest descending-sort key in a multi-key Python sort — avoids needing `reverse=True` which doesn't compose with multi-key sorts.
- 18 tests instead of 12: added case-insensitive matching test, maintainer-ranked-after-name-test, and JSON decode error test for completeness.

## Deviations from Plan

### Auto-fixed Issues

**1. sys.path setup required in module_search_cli.py**
- **Found during:** Task 57-02-02 (CLI smoke test)
- **Issue:** `python3 services/module_search_cli.py example --json` raised `ModuleNotFoundError: No module named 'services'` when invoked with repo root as cwd.
- **Fix:** Added `_HERE/_REPO_ROOT sys.path.insert(0, _REPO_ROOT)` at module top, mirroring the established Phase 49 `module_lifecycle_cli.py` pattern exactly.
- **Files modified:** services/module_search_cli.py
- **Verification:** `python3 services/module_search_cli.py example --json` exits 0 with valid JSON.
- **Committed in:** b2f999a (Task 57-02-02 commit)

---

**Total deviations:** 1 auto-fixed (1 missing path setup — same pattern as Phase 49 precedent)
**Impact on plan:** Necessary for subprocess invocation compatibility. No scope creep.

## Issues Encountered
- Homebrew `pytest` binary does not add cwd to sys.path (affects all Phase 57 tests, not just 57-02). `python3 -m pytest` is the accepted invocation — consistent with 57-01 behavior. All 18 tests pass.

## Next Phase Readiness
- Phase 57 is 2/3 plans complete. 57-03 (URL install) is the remaining plan.
- `services/module_search.py` exports `SearchError` + `_REGISTRY_ERROR_CODES` usage pattern for 57-03.
- All Phase 57-01 surfaces (RegistryIndex schema, _REGISTRY_ERROR_CODES, services/module_registry.py) unchanged.

---
*Phase: 57-module-marketplace*
*Completed: 2026-05-14*
