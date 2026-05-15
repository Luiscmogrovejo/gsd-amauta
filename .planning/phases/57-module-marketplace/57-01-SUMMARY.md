---
phase: 57-module-marketplace
plan: 57-01
subsystem: backend
tags: [python, pydantic, ed25519, cryptography, registry, signing]

# Dependency graph
requires:
  - phase: 48-module-foundation
    provides: ModuleManifest Pydantic v2 pattern (model_config extra=forbid, field_validator, _HAS_PYDANTIC)
  - phase: 49-module-lifecycle
    provides: compute_manifest_hash(yaml_text) reused via re-export from module_registry.py

provides:
  - RegistryIndex + RegistryEntry Pydantic v2 schema (7-field LOCKED order, registry_version frozen "1.0")
  - _REGISTRY_ERROR_CODES 8-tuple (frozen vocabulary for 57-03 module_url_installer.py)
  - services/module_signer.py — sign_sha256, verify, load_trusted_key, generate_keypair, TRUST_STORE_DIR
  - registry/index.json — structural fixture with 1 placeholder entry
  - 17 passing tests (9 registry schema, 8 signer crypto)

affects:
  - 57-02 (search) — consumes RegistryIndex + RegistryEntry schema
  - 57-03 (URL install) — consumes _REGISTRY_ERROR_CODES, sign_sha256, verify, load_trusted_key
  - 58 (public launch) — marketplace foundation complete

# Tech tracking
tech-stack:
  added: [cryptography>=42.0]
  patterns:
    - _HAS_PYDANTIC graceful-fallback mirror (Phase 48 pattern)
    - ed25519 sign over sha256 hex UTF-8 bytes (locked canonical message)
    - Trust store fail-closed: missing dir → unknown_signer, missing key → unknown_signer
    - compute_manifest_hash re-exported from Phase 49 (not re-implemented)

key-files:
  created:
    - services/module_registry.py
    - services/module_signer.py
    - registry/index.json
    - tests/test_module_registry.py
    - tests/test_module_signer.py
  modified:
    - requirements.txt

key-decisions:
  - "cryptography>=42.0 is the ONLY new pip dep this milestone — no pynacl"
  - "Signature = ed25519 over the sha256 hex string's UTF-8 bytes (locked across sign + verify)"
  - "Trust store path = ~/.gsd-amauta/trusted-keys/<key_id>.pub — fail-closed on missing dir"
  - "registry/index.json placeholder entry uses all-zeros hex (valid lengths) for structural validation"
  - "compute_manifest_hash reused from Phase 49 via re-export (VC9)"

patterns-established:
  - "ed25519 signing: Ed25519PrivateKey.from_private_bytes(bytes.fromhex(hex)).sign(msg) → raw bytes → .hex()"
  - "Pydantic v2 frozen-schema: model_config extra=forbid + @field_validator @classmethod + _HAS_PYDANTIC guard"
  - "8-tuple _REGISTRY_ERROR_CODES declared as module constant for cross-module import by 57-03"

requirements-completed: [MARK-01, MARK-03]

# Metrics
duration: 20min
completed: 2026-05-14
---

# Phase 57-01 Summary

**Pydantic v2 RegistryIndex/RegistryEntry schema (7-field LOCKED) + ed25519 sign/verify infrastructure + TRUST_STORE_DIR fail-closed trust store — foundation for Phase 57 plans 57-02 (search) and 57-03 (URL install)**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-14T00:00:00Z
- **Completed:** 2026-05-14T00:20:00Z
- **Tasks:** 4 (TK-1432..TK-1435)
- **Files modified/created:** 6

## Accomplishments

- requirements.txt now pins `cryptography>=42.0` (sole new pip dep this milestone)
- `services/module_registry.py`: RegistryEntry (7-field LOCKED), RegistryIndex (version "1.0" frozen), 8-tuple `_REGISTRY_ERROR_CODES`, `load_registry_index()`, re-export of Phase 49 `compute_manifest_hash`
- `services/module_signer.py`: `SigningError` with `error_code` attribute, `sign_sha256`/`verify`/`load_trusted_key`/`generate_keypair`, `TRUST_STORE_DIR = ~/.gsd-amauta/trusted-keys`
- `registry/index.json`: structural fixture with 1 valid-hex placeholder entry
- 17 tests pass (9 registry + 8 signer), all using real ed25519 — no crypto mocks

## Task Commits

Each task was committed atomically:

1. **TK-1432: requirements.txt += cryptography>=42.0** — `cd521f8`
2. **TK-1433: services/module_registry.py** — `90d98d2`
3. **TK-1434: services/module_signer.py** — `ac1c6c9`
4. **TK-1435: registry/index.json + tests** — `5dba4d3`

## Files Created/Modified

- `requirements.txt` — appended `cryptography>=42.0` (11 deps total)
- `services/module_registry.py` — RegistryIndex, RegistryEntry, _REGISTRY_ERROR_CODES, load_registry_index, compute_manifest_hash re-export
- `services/module_signer.py` — SigningError, generate_keypair, sign_sha256, verify, load_trusted_key, TRUST_STORE_DIR
- `registry/index.json` — structural fixture, 1 placeholder entry
- `tests/test_module_registry.py` — 9 tests covering constants, field order, schema load/validate/reject
- `tests/test_module_signer.py` — 8 tests covering constants, real ed25519 round-trip, tamper/wrong-key rejection, trust store load/missing

## Decisions Made

- `cryptography>=42.0` is the only new pip dep — pynacl explicitly excluded per must_haves
- Signature canonical message = sha256 hex string as UTF-8 bytes (locked across sign + verify)
- `registry/index.json` placeholder entry uses all-zeros hex — passes length+charset validators but is not cryptographically verifiable; production entries get real signatures via `sign_sha256`
- `compute_manifest_hash` re-exported from `services.module_lifecycle` (Phase 49); VC9 confirmed via `grep -c "def compute_manifest_hash" returns 0` in both new files

## Deviations from Plan

None — plan executed exactly as written. All code blocks from 57-01-PLAN.md used verbatim. All 10 verification criteria pass.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. Trust store is created by user at `~/.gsd-amauta/trusted-keys/` when they want to install signed modules.

## Next Phase Readiness

- **57-02 (module search):** RegistryIndex + RegistryEntry schema available, load_registry_index() helper ready
- **57-03 (URL install):** _REGISTRY_ERROR_CODES 8-tuple, sign_sha256, verify, load_trusted_key all available
- **No blockers**

---
*Phase: 57-module-marketplace*
*Completed: 2026-05-14*
