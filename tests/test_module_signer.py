"""Phase 57 MARK-03: ed25519 signer + trust store tests. Real crypto, no mocks."""
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.module_signer import (
    SigningError,
    TRUST_STORE_DIR,
    KEY_HEX_LEN,
    SIG_HEX_LEN,
    generate_keypair,
    sign_sha256,
    verify,
    load_trusted_key,
)


def _sha(data: bytes = b"phase57-fixture-manifest") -> str:
    return hashlib.sha256(data).hexdigest()


class TestSignerConstants(unittest.TestCase):
    def test_key_hex_len_64(self):
        self.assertEqual(KEY_HEX_LEN, 64)

    def test_sig_hex_len_128(self):
        self.assertEqual(SIG_HEX_LEN, 128)

    def test_trust_store_in_home(self):
        self.assertTrue(str(TRUST_STORE_DIR).endswith(".gsd-amauta/trusted-keys"))


class TestRoundTrip(unittest.TestCase):
    def test_real_ed25519_round_trip(self):
        sha = _sha()
        priv, pub = generate_keypair()
        sig = sign_sha256(sha, priv)
        self.assertEqual(len(sig), SIG_HEX_LEN)
        verify(sha, sig, pub)  # should not raise

    def test_wrong_pubkey_fails(self):
        sha = _sha()
        priv1, _ = generate_keypair()
        _, pub2 = generate_keypair()
        sig = sign_sha256(sha, priv1)
        with self.assertRaises(SigningError) as ctx:
            verify(sha, sig, pub2)
        self.assertEqual(ctx.exception.error_code, "signature_invalid")

    def test_tampered_sha_fails(self):
        sha1 = _sha(b"original")
        sha2 = _sha(b"tampered")
        priv, pub = generate_keypair()
        sig = sign_sha256(sha1, priv)
        with self.assertRaises(SigningError) as ctx:
            verify(sha2, sig, pub)
        self.assertEqual(ctx.exception.error_code, "signature_invalid")


class TestTrustStore(unittest.TestCase):
    def test_missing_trust_store_raises_unknown_signer(self):
        with tempfile.TemporaryDirectory() as td:
            fake_home = Path(td) / "home"
            fake_home.mkdir()
            with mock.patch("services.module_signer.TRUST_STORE_DIR", fake_home / ".gsd-amauta" / "trusted-keys"):
                with self.assertRaises(SigningError) as ctx:
                    load_trusted_key("any-key")
                self.assertEqual(ctx.exception.error_code, "unknown_signer")

    def test_load_existing_trusted_key(self):
        with tempfile.TemporaryDirectory() as td:
            store = Path(td) / "trusted-keys"
            store.mkdir()
            _, pub = generate_keypair()
            (store / "test-key.pub").write_text(pub)
            with mock.patch("services.module_signer.TRUST_STORE_DIR", store):
                loaded = load_trusted_key("test-key")
                self.assertEqual(loaded, pub)


if __name__ == "__main__":
    unittest.main()
