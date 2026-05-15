"""Phase 57 MARK-03: ed25519 sign + verify + trust store loader.

Trust store layout (locked decision 3):
    ~/.gsd-amauta/trusted-keys/<key_id>.pub
Each file contains one ed25519 public key, hex-encoded (64 chars = 32 raw bytes).
Missing directory → fail closed with `unknown_signer`.

Used by services/module_url_installer.py (Phase 57 plan 57-03) to verify
registry entry signatures before invoking Phase 49 lifecycle install.
"""
from __future__ import annotations

from pathlib import Path
from typing import Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

TRUST_STORE_DIR: Final[Path] = Path.home() / ".gsd-amauta" / "trusted-keys"
KEY_HEX_LEN: Final[int] = 64       # 32 bytes raw
SIG_HEX_LEN: Final[int] = 128      # 64 bytes raw


class SigningError(Exception):
    """Raised when signing or verification fails. error_code matches _REGISTRY_ERROR_CODES."""
    def __init__(self, error_code: str, detail: str = ""):
        super().__init__(f"{error_code}: {detail}")
        self.error_code = error_code
        self.detail = detail


def generate_keypair() -> tuple[str, str]:
    """Generate a fresh ed25519 keypair. Returns (privkey_hex, pubkey_hex). For test fixtures."""
    priv = Ed25519PrivateKey.generate()
    priv_bytes = priv.private_bytes_raw()
    pub_bytes = priv.public_key().public_bytes_raw()
    return priv_bytes.hex(), pub_bytes.hex()


def sign_sha256(sha256_hex: str, privkey_hex: str) -> str:
    """Sign a sha256 hex string. Returns 128-char hex signature.

    The message-to-sign is the sha256 itself, as utf-8 bytes (consistent across
    verify path — locked decision 8 step 6).
    """
    if len(sha256_hex) != KEY_HEX_LEN:
        raise SigningError("manifest_invalid", f"sha256 must be {KEY_HEX_LEN} hex chars, got {len(sha256_hex)}")
    if len(privkey_hex) != KEY_HEX_LEN:
        raise SigningError("manifest_invalid", f"privkey must be {KEY_HEX_LEN} hex chars")
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(privkey_hex))
    msg = sha256_hex.encode("utf-8")
    sig = priv.sign(msg)
    return sig.hex()


def verify(sha256_hex: str, signature_hex: str, pubkey_hex: str) -> None:
    """Verify an ed25519 signature over a sha256 hex string.

    Raises SigningError(signature_invalid) on failure. Returns None on success.
    """
    if len(sha256_hex) != KEY_HEX_LEN:
        raise SigningError("manifest_invalid", f"sha256 length {len(sha256_hex)} != {KEY_HEX_LEN}")
    if len(signature_hex) != SIG_HEX_LEN:
        raise SigningError("signature_invalid", f"signature length {len(signature_hex)} != {SIG_HEX_LEN}")
    if len(pubkey_hex) != KEY_HEX_LEN:
        raise SigningError("unknown_signer", f"pubkey length {len(pubkey_hex)} != {KEY_HEX_LEN}")

    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey_hex))
        pub.verify(bytes.fromhex(signature_hex), sha256_hex.encode("utf-8"))
    except (InvalidSignature, ValueError) as e:
        raise SigningError("signature_invalid", str(e)) from e


def load_trusted_key(key_id: str) -> str:
    """Load a trusted ed25519 pubkey by key_id. Returns hex string.

    Raises SigningError(unknown_signer) when the trust store dir or the keyfile
    is missing (fail-closed semantics — locked decision 3).
    """
    if not TRUST_STORE_DIR.exists():
        raise SigningError("unknown_signer", f"trust store not configured: {TRUST_STORE_DIR}")
    key_path = TRUST_STORE_DIR / f"{key_id}.pub"
    if not key_path.exists():
        raise SigningError("unknown_signer", f"trusted key not found: {key_id}")
    pubkey_hex = key_path.read_text(encoding="utf-8").strip()
    if len(pubkey_hex) != KEY_HEX_LEN:
        raise SigningError("unknown_signer", f"trusted key {key_id} has invalid length {len(pubkey_hex)}")
    return pubkey_hex
