"""Phase 57 MARK-04: URL install with verify-before-install fail-closed pipeline.

Three source schemes:
    https://<url>                    -- direct manifest URL
    github:owner/repo@tag            -- resolves to https://raw.githubusercontent.com/owner/repo/<tag>/manifest.yaml
    registry:<name>@<version>        -- lookup in cached or in-repo registry index

Verification order (locked decision 8, no short-circuit):
    1. resolve source -> URL
    2. download manifest yaml to temp file (urllib, 30s timeout)
    3. compute_manifest_hash(yaml_text)
    4. find registry entry by (name, version) -- for registry: scheme uses parsed args;
       for https/github: scheme, the downloaded manifest must declare its own
       name+version, which we look up in the registry to find the signature
    5. compare entry.sha256 to computed sha256
    6. load_trusted_key(entry.signed_by) -- must exist
    7. verify(entry.signature, computed sha256, trusted pubkey)
    8. lifecycle.install(temp_file) -- only after ALL pass

Any failure raises InstallError(error_code, detail). Temp file is always cleaned.

Phase 49 install entry point: services.module_lifecycle.install(manifest_path, *, dry_run, force, json_output)
Returns LifecycleResult; call .to_dict() for JSON-serializable output.
"""
from __future__ import annotations

import os
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from services.module_registry import (
    _REGISTRY_ERROR_CODES,
    compute_manifest_hash,
)
from services.module_search import load_index
from services.module_signer import SigningError, load_trusted_key, verify

DOWNLOAD_TIMEOUT_S = 30

# Source scheme prefixes (in dispatch order)
_HTTPS_PREFIX = "https://"
_GITHUB_PREFIX = "github:"
_REGISTRY_PREFIX = "registry:"

# github:owner/repo@tag -- parse with regex
_GITHUB_RE = re.compile(r"^github:([^/@\s]+)/([^/@\s]+)@(.+)$")
# registry:<name>@<version> -- parse with regex
_REGISTRY_RE = re.compile(r"^registry:([^@\s]+)@(.+)$")


class InstallError(Exception):
    """error_code is one of services.module_registry._REGISTRY_ERROR_CODES."""

    def __init__(self, error_code: str, detail: str = ""):
        if error_code not in _REGISTRY_ERROR_CODES:
            # Defense in depth: prevent typo'd token from leaking
            raise ValueError(
                f"InstallError.error_code must be in _REGISTRY_ERROR_CODES, got: {error_code!r}"
            )
        super().__init__(f"{error_code}: {detail}")
        self.error_code = error_code
        self.detail = detail


def resolve_source(source: str) -> tuple[str, Optional[str], Optional[str]]:
    """Resolve a source string to a download URL.

    Returns (url, name, version):
        - url: the https URL to download the manifest yaml from
        - name, version: present for registry: scheme; None for https / github: schemes
          (the latter discover name+version FROM the downloaded manifest yaml)
    """
    if source.startswith(_HTTPS_PREFIX):
        return source, None, None

    m = _GITHUB_RE.match(source)
    if m:
        owner, repo, tag = m.group(1), m.group(2), m.group(3)
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/{tag}/manifest.yaml"
        return url, None, None

    m = _REGISTRY_RE.match(source)
    if m:
        name, version = m.group(1), m.group(2)
        # Look up the entry's manifest_url in the registry index
        try:
            idx = load_index(None)
        except Exception as e:
            raise InstallError("registry_unreachable", f"failed to load index: {e}") from e
        for entry in idx.entries:
            if entry.name == name and entry.version == version:
                return entry.manifest_url, name, version
        raise InstallError("registry_not_found", f"{name}@{version} not in registry")

    raise InstallError(
        "unsupported_install_source",
        f"{source!r} -- supported: https://..., github:owner/repo@tag, registry:<name>@<version>",
    )


def download_to_temp(url: str) -> str:
    """Download a URL to a temp file. Returns path. Raises InstallError(download_failed) on failure."""
    try:
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as resp:
            data = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        raise InstallError("download_failed", f"{url}: {e}") from e

    tmp = tempfile.NamedTemporaryFile(
        prefix="gsd-amauta-manifest-", suffix=".yaml", delete=False, mode="wb"
    )
    try:
        tmp.write(data)
        tmp.close()
    except OSError as e:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise InstallError("download_failed", f"failed to write temp: {e}") from e
    return tmp.name


def _parse_manifest_name_version(yaml_text: str) -> tuple[str, str]:
    """Extract name + version from manifest YAML for registry lookup.

    Uses the Phase 48 _parse_yaml_minimal pattern (simple key-value scan)
    from services.module_schema to avoid a hard PyYAML dependency.
    Raises InstallError(manifest_invalid).
    """
    from services.module_schema import _parse_yaml_minimal
    try:
        data = _parse_yaml_minimal(yaml_text)
    except Exception as e:
        raise InstallError("manifest_invalid", f"yaml parse: {e}") from e
    name = data.get("name")
    version = data.get("version")
    if not name or not version:
        raise InstallError("manifest_invalid", "manifest missing 'name' or 'version' field")
    return name, version


def install_from_url(source: str, conn: Any = None) -> dict:
    """Atomic verify-before-install of a module from a URL source.

    Returns the Phase 49 lifecycle install result dict on success.
    Raises InstallError(error_code) on any failure; temp file is always cleaned.

    Verification order (locked, no short-circuit):
        1. resolve source -> URL
        2. download to temp (30s timeout)
        3. compute sha256
        4. registry lookup (by name+version)
        5. sha256 compare
        6. load trusted pubkey
        7. ed25519 verify
        8. Phase 49 install() -- only after ALL 7 verification steps pass
    """
    # 1-2. Resolve source + download to temp
    url, hint_name, hint_version = resolve_source(source)
    temp_path = download_to_temp(url)

    try:
        # 3. Read + compute sha256
        try:
            yaml_text = Path(temp_path).read_text(encoding="utf-8")
        except OSError as e:
            raise InstallError("download_failed", f"failed to read temp: {e}") from e

        computed_sha256 = compute_manifest_hash(yaml_text)

        # 4. Look up registry entry
        if hint_name is None or hint_version is None:
            # https / github: discover name+version from manifest content
            hint_name, hint_version = _parse_manifest_name_version(yaml_text)

        try:
            idx = load_index(None)
        except Exception as e:
            raise InstallError("registry_unreachable", f"failed to load index for verification: {e}") from e

        entry = None
        for candidate in idx.entries:
            if candidate.name == hint_name and candidate.version == hint_version:
                entry = candidate
                break
        if entry is None:
            raise InstallError("registry_not_found", f"{hint_name}@{hint_version} not in registry")

        # 5. sha256 match
        if entry.sha256 != computed_sha256:
            raise InstallError("sha256_mismatch", f"expected {entry.sha256}, got {computed_sha256}")

        # 6. Load trusted pubkey
        try:
            pubkey_hex = load_trusted_key(entry.signed_by)
        except SigningError as e:
            # SigningError uses the same vocab -- re-wrap as InstallError
            raise InstallError(e.error_code, e.detail) from e

        # 7. Verify signature
        try:
            verify(computed_sha256, entry.signature, pubkey_hex)
        except SigningError as e:
            raise InstallError(e.error_code, e.detail) from e

        # 8. Call Phase 49 lifecycle install -- the only place that writes to disk
        # Entry point: install(manifest_path, *, dry_run, force, json_output) -> LifecycleResult
        from services.module_lifecycle import install as _lifecycle_install
        result = _lifecycle_install(temp_path)
        return result.to_dict()

    finally:
        # Always clean the temp file (try/finally guarantee)
        try:
            os.unlink(temp_path)
        except OSError:
            pass


# Re-export the 8 frozen error codes so call sites can introspect
ERROR_CODES = _REGISTRY_ERROR_CODES
