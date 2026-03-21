# Phase 7 — SSO/OIDC Plan (SSO-01 through SSO-05)

**Created:** 2026-03-21
**Agent:** gsd-executor-backend

## Requirements

| ID | Requirement | Status |
|----|------------|--------|
| SSO-01 | Daemon validates OIDC Bearer tokens against configured issuer | Planned |
| SSO-02 | Config via env vars: GSD_OIDC_ISSUER, GSD_OIDC_CLIENT_ID, GSD_OIDC_AUDIENCE | Planned |
| SSO-03 | All API endpoints require valid token when SSO enabled (except /health) | Planned |
| SSO-04 | Token subject (sub claim) logged as actor in audit records | Planned |
| SSO-05 | Graceful degradation: no OIDC vars = no auth (current behavior) | Planned |

## Architecture

### New Module: `services/oidc_auth.py`

- Pure stdlib implementation (urllib, json, base64, time)
- `OIDCAuth` class with constructor reading env vars
- `is_enabled()` returns True only when both ISSUER and CLIENT_ID are set
- `validate_token(token)` decodes JWT header+payload, checks exp/iss/aud
- Returns `{valid: True, sub, email, name, payload}` or `{valid: False, error}`

### Daemon Wiring: `services/amauta-daemon.py`

- Import `OIDCAuth` with graceful ImportError fallback
- New `_check_oidc(handler)` method on `AmautaHandler`
- Called in `do_GET` and `do_POST` AFTER existing `_check_auth()`
- `/health` and `/metrics` bypass OIDC (already bypass daemon token)
- Token `sub` logged via `log.info("oidc_actor sub=%s", sub)`

### Tests

- `tests/test_oidc.py`: Python unit tests for OIDCAuth class
- `tests/oidc-daemon.test.cjs`: Node integration tests for daemon wiring

## Risks

- JWT signature verification not implemented (claims-only validation) -- acceptable for v1; JWKS verification is a Phase 7.1 enhancement
- No token caching/refresh -- each request re-validates
- No external dependencies means no cryptographic signature verification against JWKS

## Files Changed

| File | Action | Notes |
|------|--------|-------|
| `services/oidc_auth.py` | CREATE | New OIDC validation module |
| `services/amauta-daemon.py` | MODIFY | Wire OIDC auth middleware |
| `tests/test_oidc.py` | CREATE | Python unit tests |
| `tests/oidc-daemon.test.cjs` | CREATE | Node integration tests |
| `.planning/phases/07-sso-oidc/01-PLAN.md` | CREATE | This file |
| `.planning/phases/07-sso-oidc/02-SUMMARY.md` | CREATE | Post-execution summary |
