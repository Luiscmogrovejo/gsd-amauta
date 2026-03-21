"""
OIDC Token Validation for GSD-Amauta Daemon.

Uses OIDC Discovery (/.well-known/openid-configuration) to locate JWKS.
Validates Bearer tokens using only Python stdlib (urllib, json, base64, time).

Environment variables:
    GSD_OIDC_ISSUER     - OIDC issuer URL (e.g., https://auth.example.com/application/o/gsd/)
    GSD_OIDC_CLIENT_ID  - OIDC client ID for audience validation
    GSD_OIDC_AUDIENCE   - OIDC audience (defaults to client_id if not set)

When GSD_OIDC_ISSUER and GSD_OIDC_CLIENT_ID are both set, OIDC validation is enabled.
When either is missing, OIDC is disabled and all requests pass through (current behavior).
"""

import base64
import json
import logging
import os
import time
import urllib.request

log = logging.getLogger("amauta.oidc")


class OIDCAuth:
    """OIDC token validator.  Zero external dependencies."""

    def __init__(self):
        self.issuer = os.environ.get("GSD_OIDC_ISSUER", "").rstrip("/")
        self.client_id = os.environ.get("GSD_OIDC_CLIENT_ID", "")
        self.audience = os.environ.get("GSD_OIDC_AUDIENCE", "") or self.client_id
        self.enabled = bool(self.issuer and self.client_id)
        # JWKS cache (future use when signature verification is added)
        self._jwks = None
        self._jwks_fetched_at = 0
        self._jwks_ttl = 3600  # refresh JWKS hourly

        if self.enabled:
            log.info(
                "oidc_enabled issuer=%s client_id=%s audience=%s",
                self.issuer,
                self.client_id,
                self.audience,
            )
        else:
            log.debug("oidc_disabled (GSD_OIDC_ISSUER or GSD_OIDC_CLIENT_ID not set)")

    # ── Public API ────────────────────────────────────────────────────────

    def is_enabled(self):
        """Return True when OIDC validation is active."""
        return self.enabled

    def validate_token(self, token):
        """Validate a JWT Bearer token.

        Returns a dict:
            On success: {"valid": True, "sub": "...", "email": "...", "name": "...", "payload": {...}}
            On failure: {"valid": False, "error": "..."}
            When disabled: {"valid": True, "sub": "anonymous", "email": None}
        """
        if not self.enabled:
            return {"valid": True, "sub": "anonymous", "email": None}

        if not token or not isinstance(token, str):
            return {"valid": False, "error": "Empty or invalid token"}

        try:
            parts = token.split(".")
            if len(parts) != 3:
                return {"valid": False, "error": "Invalid JWT format: expected 3 parts"}

            header = json.loads(self._b64decode(parts[0]))
            payload = json.loads(self._b64decode(parts[1]))

            # ── Expiry check ──────────────────────────────────────────
            exp = payload.get("exp")
            if exp is not None:
                if not isinstance(exp, (int, float)):
                    return {"valid": False, "error": "Invalid exp claim type"}
                if exp < time.time():
                    return {"valid": False, "error": "Token expired"}

            # ── Not-before check ──────────────────────────────────────
            nbf = payload.get("nbf")
            if nbf is not None:
                if isinstance(nbf, (int, float)) and nbf > time.time() + 30:
                    return {"valid": False, "error": "Token not yet valid (nbf)"}

            # ── Issuer check ──────────────────────────────────────────
            token_iss = (payload.get("iss") or "").rstrip("/")
            if token_iss != self.issuer:
                return {
                    "valid": False,
                    "error": f"Invalid issuer: expected {self.issuer}, got {token_iss}",
                }

            # ── Audience check ────────────────────────────────────────
            aud = payload.get("aud", "")
            if isinstance(aud, list):
                if self.audience not in aud:
                    return {
                        "valid": False,
                        "error": f"Invalid audience: {self.audience} not in {aud}",
                    }
            elif isinstance(aud, str):
                if aud != self.audience:
                    return {
                        "valid": False,
                        "error": f"Invalid audience: expected {self.audience}, got {aud}",
                    }
            # If aud is missing entirely, some IdPs omit it -- allow through
            # but log a warning
            else:
                log.warning("oidc_no_audience token has no aud claim")

            return {
                "valid": True,
                "sub": payload.get("sub", "unknown"),
                "email": payload.get("email"),
                "name": payload.get("name"),
                "payload": payload,
            }

        except json.JSONDecodeError as e:
            return {"valid": False, "error": f"JWT decode error: {e}"}
        except Exception as e:
            return {"valid": False, "error": f"Token validation error: {e}"}

    # ── JWKS Discovery (future: signature verification) ───────────────

    def fetch_jwks(self):
        """Fetch JWKS from the issuer's discovery endpoint.

        Returns the JWKS dict or None on failure.
        Caches for _jwks_ttl seconds.
        """
        if not self.enabled:
            return None

        now = time.time()
        if self._jwks and (now - self._jwks_fetched_at) < self._jwks_ttl:
            return self._jwks

        try:
            discovery_url = f"{self.issuer}/.well-known/openid-configuration"
            req = urllib.request.urlopen(discovery_url, timeout=5)
            config = json.loads(req.read().decode("utf-8"))

            jwks_uri = config.get("jwks_uri")
            if not jwks_uri:
                log.warning("oidc_no_jwks_uri in discovery document")
                return None

            jwks_req = urllib.request.urlopen(jwks_uri, timeout=5)
            self._jwks = json.loads(jwks_req.read().decode("utf-8"))
            self._jwks_fetched_at = now

            log.info(
                "oidc_jwks_fetched keys=%d",
                len(self._jwks.get("keys", [])),
            )
            return self._jwks

        except Exception as e:
            log.warning("oidc_jwks_fetch_failed error=%s", str(e))
            return None

    # ── Internal helpers ──────────────────────────────────────────────

    @staticmethod
    def _b64decode(s):
        """Base64url decode with padding fix."""
        s = s.replace("-", "+").replace("_", "/")
        padding = 4 - len(s) % 4
        if padding != 4:
            s += "=" * padding
        return base64.b64decode(s)
