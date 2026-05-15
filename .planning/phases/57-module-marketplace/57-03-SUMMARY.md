---
phase: 57-module-marketplace
plan: 57-03
subsystem: api
tags: [python, urllib, ed25519, registry, module-installer, marketplace]

# Dependency graph
requires:
  - phase: 57-01
    provides: _REGISTRY_ERROR_CODES, RegistryEntry, RegistryIndex, compute_manifest_hash, load_trusted_key, verify, generate_keypair
  - phase: 57-02
    provides: load_index, CACHE_PATH, REPO_INDEX_PATH for registry: scheme lookup
  - phase: 49
    provides: install(manifest_path, *, dry_run, force, json_output) -> LifecycleResult.to_dict()
  - phase: 48
    provides: _parse_yaml_minimal for manifest name/version extraction
provides:
  - services/module_url_installer.py: 3-scheme URL resolver + verify-before-install pipeline
  - ERROR_CODES: re-export of 8 frozen tokens for call-site introspection
  - gsd-tools.cjs module install URL dispatch (https://, github:, registry:, and any :// scheme)
  - 15 tests covering scheme resolution, fail-closed paths, temp cleanup, phase49 not called on failure
affects: [58-public-launch, module-marketplace, gsd-tools]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - verify-before-install fail-closed pipeline (download -> sha256 -> registry -> sig -> Phase49)
    - InstallError defense-in-depth: constructor validates error_code against frozen vocab
    - isUrlShape via includes('://') in Node.js dispatch to catch all URL-like sources

key-files:
  created:
    - services/module_url_installer.py
    - tests/test_module_url_installer.py
  modified:
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "Phase 49 entry point is install() not lifecycle_install_from_manifest_path (plan assumption wrong; grepped before writing import)"
  - "LifecycleResult.to_dict() used for JSON dict conversion (not asdict or __dict__)"
  - "_parse_yaml_minimal lives in services.module_schema (not module_lifecycle as plan implied)"
  - "isUrlShape uses source.includes('://') to catch all URL-schemed sources including ftp:// for correct unsupported_install_source error"
  - "urllib.request.urlopen mocked with MagicMock().__enter__ = BytesIO for context manager compatibility"

patterns-established:
  - "Fail-closed installer: any verification failure raises InstallError and cleans temp; Phase 49 never called"
  - "Defense-in-depth error vocab: InstallError.__init__ validates code against frozen tuple at construction time"
  - "Test isolation: TRUST_STORE_DIR + REPO_INDEX_PATH + CACHE_PATH all patched per-test in TemporaryDirectory"

requirements-completed: [MARK-04]

# Metrics
duration: 25min
completed: 2026-05-14
---

# Phase 57-03: Module URL Installer Summary

**3-scheme URL installer (https/github/registry) with verify-before-install ed25519 pipeline, 8 frozen error tokens, defense-in-depth InstallError, and 15 fail-closed tests**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-14T01:15:00Z
- **Completed:** 2026-05-14T01:40:00Z
- **Tasks:** 3 (TK-1439, TK-1440, TK-1441)
- **Files modified:** 3 (1 created, 1 modified, 1 test created)

## Accomplishments
- Created `services/module_url_installer.py` with `install_from_url`, `resolve_source`, `download_to_temp`, `InstallError`, `ERROR_CODES`
- Wired URL dispatch into `gsd-tools.cjs` `case 'module': install` action — URL-shaped sources routed to new Python installer; local paths continue to Phase 49
- Created `tests/test_module_url_installer.py` with 15 tests: 4 scheme resolution, 3 error vocab lock, 2 download, 6 fail-closed pipeline (including phase49_not_called_on_sha256_failure)

## Task Commits

1. **Task 57-03-01: services/module_url_installer.py** - `4c8ccbe` (feat)
2. **Task 57-03-02: gsd-tools.cjs URL dispatch** - `c288ca3` (feat)
3. **Task 57-03-03: tests/test_module_url_installer.py** - `6621ac6` (feat)

## Files Created/Modified
- `services/module_url_installer.py` - 3-scheme resolver + verify-before-install pipeline + ERROR_CODES export
- `get-shit-done/bin/gsd-tools.cjs` - URL-shape detection inserted before Phase 49 lifecycle dispatch in install handler
- `tests/test_module_url_installer.py` - 15 tests, real ed25519, no network, no real trust store

## Decisions Made

1. **Phase 49 entry point is `install()` not `lifecycle_install_from_manifest_path`** — plan used an assumed name; grepped before writing import as required. Actual signature: `install(manifest_path, *, dry_run=False, force=False, json_output=False) -> LifecycleResult`. Used `result.to_dict()` for dict conversion.

2. **`_parse_yaml_minimal` is in `services.module_schema`** — plan implied `module_lifecycle`; the function is at `services/module_schema.py:241`.

3. **`isUrlShape` uses `source.includes('://')` not `startsWith('https://')`** — plan's acceptance criterion requires `ftp://invalid/x.yaml` to produce `unsupported_install_source`. That requires routing ftp:// to the URL installer (which raises the error) rather than Phase 49. `includes('://')` catches all protocol-schemed URLs.

4. **Real `mock.MagicMock()` for urlopen context manager** — `BytesIO` alone fails since `urlopen` is used as `with urlopen(...) as resp:`. Used `MagicMock().__enter__ = BytesIO` pattern.

## Deviations from Plan

### Documented Deviations (not auto-fixes — expected discoveries per Risks §1)

**1. Phase 49 install entry point name**
- **Expected:** `lifecycle_install_from_manifest_path`
- **Actual:** `install` (confirmed via `grep -nE "^def install\b"`)
- **Import used:** `from services.module_lifecycle import install as _lifecycle_install`
- **Return handling:** `result.to_dict()` (LifecycleResult dataclass has `to_dict()` method)

**2. `_parse_yaml_minimal` location**
- **Expected (plan comment):** could be in module_lifecycle
- **Actual:** `services/module_schema.py:241`
- **Import used:** `from services.module_schema import _parse_yaml_minimal`

**3. isUrlShape broadened to catch ftp:// and other schemes**
- **Plan template:** `startsWith('https://')`
- **Actual:** `source.includes('://')` to satisfy AC requiring ftp:// -> unsupported_install_source

---

**Total deviations:** 3 documented (all expected per Risks §1 + AC analysis)
**Impact on plan:** Correctness-only deviations. No scope creep. Phase 57 delivered complete.

## Issues Encountered
None — all divergences were pre-anticipated in the plan's Risks section and AC.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 57 COMPLETE — all 3 plans shipped (57-01 schema+signing, 57-02 search, 57-03 URL install)
- Phase 58 Public Launch can proceed: marketplace story is complete, signed URL install works end-to-end
- Trust store population (`~/.gsd-amauta/trusted-keys/<key_id>.pub`) is operator responsibility before production use

---
*Phase: 57-module-marketplace*
*Completed: 2026-05-14*
