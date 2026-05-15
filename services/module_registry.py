"""Phase 57 MARK-01: Versioned signed registry index schema.

Defines Pydantic v2 models for `registry/index.json` — the static module
marketplace catalog. Each entry pairs a Phase 48 ModuleManifest sha256 with
an ed25519 signature so install-time verification can fail closed on
tampering.

Frozen schema (do not reorder fields):
    RegistryIndex.registry_version  = "1.0"
    RegistryEntry: name → version → sha256 → manifest_url → maintainer
                   → signed_by → signature

8 frozen error tokens (also imported by services/module_url_installer.py):
    unsupported_install_source, download_failed, manifest_invalid,
    sha256_mismatch, unknown_signer, signature_invalid,
    registry_not_found, registry_unreachable
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Tuple

try:
    from pydantic import BaseModel, Field, field_validator
    _HAS_PYDANTIC = True
except ImportError:  # graceful fallback (mirrors Phase 48 _HAS_PYDANTIC pattern)
    _HAS_PYDANTIC = False

# Re-export the Phase 49 manifest hash helper so 57-02 + 57-03 import from one place.
from services.module_lifecycle import compute_manifest_hash  # noqa: F401

SCHEMA_VERSION = "1.0"

# Frozen 8-token error vocabulary — imported by services/module_url_installer.py (plan 57-03).
# DO NOT add new tokens in this phase. Phase 58+ may extend; not 57.
_REGISTRY_ERROR_CODES: Tuple[str, ...] = (
    "unsupported_install_source",
    "download_failed",
    "manifest_invalid",
    "sha256_mismatch",
    "unknown_signer",
    "signature_invalid",
    "registry_not_found",
    "registry_unreachable",
)


if _HAS_PYDANTIC:
    class RegistryEntry(BaseModel):
        """One module entry in the registry index. Field order LOCKED."""
        model_config = {"extra": "forbid"}

        name: str
        version: str
        sha256: str
        manifest_url: str
        maintainer: str
        signed_by: str
        signature: str

        @field_validator("sha256")
        @classmethod
        def _sha256_hex(cls, v: str) -> str:
            if len(v) != 64 or not all(c in "0123456789abcdef" for c in v.lower()):
                raise ValueError(f"sha256 must be 64 lowercase hex chars, got {len(v)}")
            return v.lower()

        @field_validator("signature")
        @classmethod
        def _signature_hex(cls, v: str) -> str:
            if len(v) != 128 or not all(c in "0123456789abcdef" for c in v.lower()):
                raise ValueError(f"signature must be 128 lowercase hex chars, got {len(v)}")
            return v.lower()

        @field_validator("manifest_url")
        @classmethod
        def _https_url(cls, v: str) -> str:
            if not v.startswith(("https://", "http://localhost")):
                raise ValueError(f"manifest_url must be https:// (or http://localhost for tests), got {v[:20]}")
            return v


    class RegistryIndex(BaseModel):
        """Top-level registry index. Schema version frozen at '1.0' for Phase 57."""
        model_config = {"extra": "forbid"}

        registry_version: str
        entries: List[RegistryEntry]

        @field_validator("registry_version")
        @classmethod
        def _version_lock(cls, v: str) -> str:
            if v != SCHEMA_VERSION:
                raise ValueError(f"registry_version must be '{SCHEMA_VERSION}' (Phase 57)")
            return v
else:
    # Fallback: bare dict round-trip with manual validation.
    class RegistryEntry:  # type: ignore[no-redef]
        def __init__(self, **kw):
            for k in ("name", "version", "sha256", "manifest_url", "maintainer", "signed_by", "signature"):
                if k not in kw:
                    raise ValueError(f"RegistryEntry missing field: {k}")
                setattr(self, k, kw[k])

    class RegistryIndex:  # type: ignore[no-redef]
        def __init__(self, registry_version: str, entries: list):
            if registry_version != SCHEMA_VERSION:
                raise ValueError(f"registry_version must be '{SCHEMA_VERSION}'")
            self.registry_version = registry_version
            self.entries = [RegistryEntry(**e) if isinstance(e, dict) else e for e in entries]


def load_registry_index(path: str | Path) -> RegistryIndex:
    """Load + validate a registry/index.json file. Raises ValueError on schema mismatch."""
    text = Path(path).read_text(encoding="utf-8")
    data = json.loads(text)
    if _HAS_PYDANTIC:
        return RegistryIndex(**data)
    return RegistryIndex(
        registry_version=data["registry_version"],
        entries=data["entries"],
    )
