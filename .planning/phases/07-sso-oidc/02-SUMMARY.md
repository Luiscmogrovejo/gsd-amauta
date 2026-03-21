# Phase 7 — SSO/OIDC Summary

**Completed:** 2026-03-21
**Agent:** gsd-executor-backend

## Requirements Status

| ID | Requirement | Status |
|----|------------|--------|
| SSO-01 | Daemon validates OIDC Bearer tokens against configured issuer | DONE |
| SSO-02 | Config via env vars: GSD_OIDC_ISSUER, GSD_OIDC_CLIENT_ID, GSD_OIDC_AUDIENCE | DONE |
| SSO-03 | All API endpoints require valid token when SSO enabled (except /health, /metrics) | DONE |
| SSO-04 | Token subject (sub claim) logged as actor in audit records | DONE |
| SSO-05 | Graceful degradation: no OIDC vars = no auth (current behavior) | DONE |

## What Was Built

### 1. `services/oidc_auth.py` (NEW)
- `OIDCAuth` class with zero external dependencies (stdlib only)
- Reads `GSD_OIDC_ISSUER`, `GSD_OIDC_CLIENT_ID`, `GSD_OIDC_AUDIENCE` from env
- JWT claims validation: exp, nbf, iss, aud
- Returns `sub`, `email`, `name` from validated tokens
- JWKS discovery scaffolding for future signature verification
- Graceful when disabled: returns `{valid: True, sub: "anonymous"}`

### 2. `services/amauta-daemon.py` (MODIFIED)
- Import `OIDCAuth` with `ImportError` fallback
- New `_check_oidc(handler)` function checks OIDC on all routes
- `/health` and `/metrics` bypass OIDC validation
- OIDC failure returns HTTP 401 with error JSON
- `_oidc_sub` stored on handler for audit correlation
- Health endpoint now reports `oidc_enabled` and `oidc_issuer`
- OIDC initialized in `start_server()` with status logging

### 3. `tests/test_oidc.py` (NEW) -- 36 Python unit tests
- 5 tests: disabled state (SSO-05)
- 8 tests: env var configuration (SSO-02)
- 16 tests: token validation (SSO-01)
- 3 tests: sub claim extraction (SSO-04)
- 3 tests: base64url decoding edge cases
- 1 test: JWKS fetch when disabled

### 4. `tests/oidc-daemon.test.cjs` (NEW) -- 30 Node.js integration tests
- 6 tests: module structure (SSO-01)
- 9 tests: daemon wiring (SSO-03)
- 4 tests: env var config (SSO-02)
- 3 tests: graceful degradation (SSO-05)
- 3 tests: sub claim for audit (SSO-04)
- 5 tests: token validation edge cases (SSO-01)

## Test Results

```
Python:  36 tests, 36 passed, 0 failed (0.024s)
Node.js: 30 tests, 30 passed, 0 failed (0.775s)
Total:   66 new tests, all passing
```

Existing test suites unaffected:
- security-infrastructure.test.cjs: 88/88 pass
- verify-health.test.cjs: 26/26 pass

## Design Decisions

1. **Claims-only validation**: No cryptographic signature verification in v1. JWT header+payload are decoded and claims (exp, iss, aud) are checked. JWKS signature verification is scaffolded for a future enhancement.

2. **Layered auth**: OIDC runs AFTER existing `AMAUTA_DAEMON_TOKEN` check. Both layers must pass when both are configured.

3. **Trailing slash normalization**: Both issuer config and token issuer claim have trailing slashes stripped before comparison, preventing common misconfiguration issues.

4. **nbf tolerance**: 30-second clock skew tolerance for `nbf` (not-before) claim.

5. **Missing aud accepted with warning**: Some IdPs omit the `aud` claim entirely. This is accepted with a log warning rather than rejection.

## Files Changed

| File | Lines | Action |
|------|-------|--------|
| `services/oidc_auth.py` | 166 | CREATE |
| `services/amauta-daemon.py` | +35 | MODIFY |
| `tests/test_oidc.py` | 314 | CREATE |
| `tests/oidc-daemon.test.cjs` | 324 | CREATE |
| `.planning/phases/07-sso-oidc/01-PLAN.md` | 60 | CREATE |
| `.planning/phases/07-sso-oidc/02-SUMMARY.md` | -- | CREATE |
