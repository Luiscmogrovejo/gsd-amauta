"""
Unit tests for services/oidc_auth.py — OIDC token validation.

Tests SSO-01 through SSO-05:
  - OIDCAuth disabled when env vars not set (SSO-05)
  - Token format validation (SSO-01)
  - Expiry check (SSO-01)
  - Issuer validation (SSO-01)
  - Audience validation (SSO-01)
  - Sub claim extraction (SSO-04)
  - Config via env vars (SSO-02)
  - Graceful degradation (SSO-05)
"""

import base64
import json
import os
import sys
import time
import unittest

# Add services/ to path so we can import oidc_auth
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services"))

# ── Helper: build a fake JWT ─────────────────────────────────────────────────


def _b64encode(data):
    """Base64url encode a dict as JSON."""
    raw = json.dumps(data).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_jwt(header=None, payload=None, signature="fakesig"):
    """Build a fake 3-part JWT string."""
    h = header or {"alg": "RS256", "typ": "JWT"}
    p = payload or {}
    return f"{_b64encode(h)}.{_b64encode(p)}.{signature}"


# ═══════════════════════════════════════════════════════════════════════════════
# SSO-05: Disabled by default (no env vars)
# ═══════════════════════════════════════════════════════════════════════════════


class TestOIDCDisabled(unittest.TestCase):
    """When GSD_OIDC_ISSUER or GSD_OIDC_CLIENT_ID are not set, OIDC is disabled."""

    def setUp(self):
        # Clear OIDC env vars
        for key in ("GSD_OIDC_ISSUER", "GSD_OIDC_CLIENT_ID", "GSD_OIDC_AUDIENCE"):
            os.environ.pop(key, None)
        # Re-import to pick up env changes
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        self.auth = OIDCAuth()

    def test_is_enabled_returns_false(self):
        self.assertFalse(self.auth.is_enabled())

    def test_validate_token_returns_valid_anonymous(self):
        result = self.auth.validate_token("anything")
        self.assertTrue(result["valid"])
        self.assertEqual(result["sub"], "anonymous")
        self.assertIsNone(result["email"])

    def test_validate_token_with_none(self):
        result = self.auth.validate_token(None)
        self.assertTrue(result["valid"])

    def test_validate_token_with_empty(self):
        result = self.auth.validate_token("")
        self.assertTrue(result["valid"])

    def test_fetch_jwks_returns_none(self):
        result = self.auth.fetch_jwks()
        self.assertIsNone(result)


# ═══════════════════════════════════════════════════════════════════════════════
# SSO-02: Configuration via env vars
# ═══════════════════════════════════════════════════════════════════════════════


class TestOIDCConfig(unittest.TestCase):
    """Verify OIDCAuth reads configuration from environment variables."""

    def setUp(self):
        os.environ["GSD_OIDC_ISSUER"] = "https://auth.example.com"
        os.environ["GSD_OIDC_CLIENT_ID"] = "gsd-client"
        os.environ.pop("GSD_OIDC_AUDIENCE", None)
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        self.auth = OIDCAuth()

    def tearDown(self):
        for key in ("GSD_OIDC_ISSUER", "GSD_OIDC_CLIENT_ID", "GSD_OIDC_AUDIENCE"):
            os.environ.pop(key, None)

    def test_is_enabled_returns_true(self):
        self.assertTrue(self.auth.is_enabled())

    def test_issuer_read_from_env(self):
        self.assertEqual(self.auth.issuer, "https://auth.example.com")

    def test_client_id_read_from_env(self):
        self.assertEqual(self.auth.client_id, "gsd-client")

    def test_audience_defaults_to_client_id(self):
        self.assertEqual(self.auth.audience, "gsd-client")

    def test_audience_override(self):
        os.environ["GSD_OIDC_AUDIENCE"] = "custom-audience"
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        auth = OIDCAuth()
        self.assertEqual(auth.audience, "custom-audience")
        os.environ.pop("GSD_OIDC_AUDIENCE", None)

    def test_issuer_trailing_slash_stripped(self):
        os.environ["GSD_OIDC_ISSUER"] = "https://auth.example.com/"
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        auth = OIDCAuth()
        self.assertEqual(auth.issuer, "https://auth.example.com")

    def test_only_issuer_set_not_enabled(self):
        os.environ.pop("GSD_OIDC_CLIENT_ID", None)
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        auth = OIDCAuth()
        self.assertFalse(auth.is_enabled())

    def test_only_client_id_set_not_enabled(self):
        os.environ.pop("GSD_OIDC_ISSUER", None)
        os.environ["GSD_OIDC_CLIENT_ID"] = "gsd-client"
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        auth = OIDCAuth()
        self.assertFalse(auth.is_enabled())


# ═══════════════════════════════════════════════════════════════════════════════
# SSO-01: Token validation
# ═══════════════════════════════════════════════════════════════════════════════


class TestOIDCTokenValidation(unittest.TestCase):
    """Test JWT token validation when OIDC is enabled."""

    def setUp(self):
        os.environ["GSD_OIDC_ISSUER"] = "https://auth.example.com"
        os.environ["GSD_OIDC_CLIENT_ID"] = "gsd-client"
        os.environ.pop("GSD_OIDC_AUDIENCE", None)
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        self.auth = OIDCAuth()

    def tearDown(self):
        for key in ("GSD_OIDC_ISSUER", "GSD_OIDC_CLIENT_ID", "GSD_OIDC_AUDIENCE"):
            os.environ.pop(key, None)

    def test_valid_token(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "email": "user@example.com",
            "name": "Test User",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])
        self.assertEqual(result["sub"], "user-123")
        self.assertEqual(result["email"], "user@example.com")
        self.assertEqual(result["name"], "Test User")

    def test_expired_token_rejected(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() - 60,  # expired 1 minute ago
        })
        result = self.auth.validate_token(token)
        self.assertFalse(result["valid"])
        self.assertIn("expired", result["error"].lower())

    def test_invalid_issuer_rejected(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://evil.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertFalse(result["valid"])
        self.assertIn("issuer", result["error"].lower())

    def test_invalid_audience_rejected(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": "wrong-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertFalse(result["valid"])
        self.assertIn("audience", result["error"].lower())

    def test_audience_list_accepted(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": ["gsd-client", "other-client"],
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])

    def test_audience_list_rejected_when_not_present(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": ["other-client", "another-client"],
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertFalse(result["valid"])
        self.assertIn("audience", result["error"].lower())

    def test_invalid_jwt_format_two_parts(self):
        result = self.auth.validate_token("header.payload")
        self.assertFalse(result["valid"])
        self.assertIn("format", result["error"].lower())

    def test_invalid_jwt_format_one_part(self):
        result = self.auth.validate_token("not-a-jwt")
        self.assertFalse(result["valid"])
        self.assertIn("format", result["error"].lower())

    def test_empty_token_rejected(self):
        result = self.auth.validate_token("")
        self.assertFalse(result["valid"])

    def test_none_token_rejected(self):
        result = self.auth.validate_token(None)
        self.assertFalse(result["valid"])

    def test_malformed_base64_rejected(self):
        result = self.auth.validate_token("!!!.@@@.###")
        self.assertFalse(result["valid"])

    def test_no_exp_claim_accepted(self):
        """Tokens without exp are accepted (some IdPs omit it for service accounts)."""
        token = make_jwt(payload={
            "sub": "service-account",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
        })
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])
        self.assertEqual(result["sub"], "service-account")

    def test_nbf_in_future_rejected(self):
        """Token with nbf far in the future is rejected."""
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 7200,
            "nbf": time.time() + 3600,  # not valid for 1 hour
        })
        result = self.auth.validate_token(token)
        self.assertFalse(result["valid"])
        self.assertIn("nbf", result["error"].lower())

    def test_nbf_in_past_accepted(self):
        """Token with nbf in the past is accepted."""
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
            "nbf": time.time() - 60,
        })
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])

    def test_missing_sub_defaults_to_unknown(self):
        token = make_jwt(payload={
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])
        self.assertEqual(result["sub"], "unknown")

    def test_issuer_trailing_slash_match(self):
        """Token issuer with trailing slash should match configured issuer."""
        token = make_jwt(payload={
            "sub": "user-123",
            "iss": "https://auth.example.com/",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])

    def test_payload_included_in_result(self):
        payload = {
            "sub": "user-123",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
            "custom_claim": "my_value",
        }
        token = make_jwt(payload=payload)
        result = self.auth.validate_token(token)
        self.assertTrue(result["valid"])
        self.assertEqual(result["payload"]["custom_claim"], "my_value")


# ═══════════════════════════════════════════════════════════════════════════════
# SSO-04: Sub claim extraction
# ═══════════════════════════════════════════════════════════════════════════════


class TestOIDCSubClaim(unittest.TestCase):
    """Verify sub claim is extracted for audit logging."""

    def setUp(self):
        os.environ["GSD_OIDC_ISSUER"] = "https://auth.example.com"
        os.environ["GSD_OIDC_CLIENT_ID"] = "gsd-client"
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        self.auth = OIDCAuth()

    def tearDown(self):
        for key in ("GSD_OIDC_ISSUER", "GSD_OIDC_CLIENT_ID"):
            os.environ.pop(key, None)

    def test_sub_extracted_from_valid_token(self):
        token = make_jwt(payload={
            "sub": "admin@corp.com",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertEqual(result["sub"], "admin@corp.com")

    def test_uuid_sub_extracted(self):
        token = make_jwt(payload={
            "sub": "550e8400-e29b-41d4-a716-446655440000",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertEqual(result["sub"], "550e8400-e29b-41d4-a716-446655440000")

    def test_email_extracted(self):
        token = make_jwt(payload={
            "sub": "user-123",
            "email": "test@example.com",
            "iss": "https://auth.example.com",
            "aud": "gsd-client",
            "exp": time.time() + 3600,
        })
        result = self.auth.validate_token(token)
        self.assertEqual(result["email"], "test@example.com")


# ═══════════════════════════════════════════════════════════════════════════════
# Base64 edge cases
# ═══════════════════════════════════════════════════════════════════════════════


class TestBase64Decode(unittest.TestCase):
    """Test the base64url decoding helper."""

    def setUp(self):
        os.environ.pop("GSD_OIDC_ISSUER", None)
        os.environ.pop("GSD_OIDC_CLIENT_ID", None)
        if "oidc_auth" in sys.modules:
            del sys.modules["oidc_auth"]
        from oidc_auth import OIDCAuth

        self.auth = OIDCAuth()

    def test_standard_base64url(self):
        data = json.dumps({"key": "value"}).encode("utf-8")
        encoded = base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")
        decoded = self.auth._b64decode(encoded)
        self.assertEqual(json.loads(decoded), {"key": "value"})

    def test_padding_with_one_pad(self):
        """Strings requiring 1 padding char."""
        data = b"abc"  # base64url = "YWJj" (no padding needed)
        encoded = base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")
        decoded = self.auth._b64decode(encoded)
        self.assertEqual(decoded, data)

    def test_padding_with_two_pads(self):
        """Strings requiring 2 padding chars."""
        data = b"ab"  # base64url = "YWI" (needs = padding)
        encoded = base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")
        decoded = self.auth._b64decode(encoded)
        self.assertEqual(decoded, data)


if __name__ == "__main__":
    unittest.main()
