"""Phase 57 MARK-02: Module marketplace search.

Single-pass tier-ranked scan over a RegistryIndex. Read-only.

Ranking tiers (highest priority first):
    1. Exact name match (case-insensitive)
    2. Substring match on name
    3. Substring match on maintainer (the only other free-text field in registry entry)

Within each tier: semver-descending (latest version first). Stable sort
preserves index order within ties.

Empty query string returns ALL entries, ordered semver-descending only.

Locked decision 5: local cache at ~/.gsd-amauta/registry-cache/index.json
mirrors latest fetched remote. `--registry <url>` overrides; default = local
cache if exists else in-repo `registry/index.json`.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Optional

from services.module_registry import (
    RegistryIndex,
    SCHEMA_VERSION,
    _REGISTRY_ERROR_CODES,
    load_registry_index,
)
from services.module_resolver import _parse_version

CACHE_DIR = Path.home() / ".gsd-amauta" / "registry-cache"
CACHE_PATH = CACHE_DIR / "index.json"
REPO_INDEX_PATH = Path(__file__).resolve().parent.parent / "registry" / "index.json"

DOWNLOAD_TIMEOUT_S = 30


class SearchError(Exception):
    """error_code matches _REGISTRY_ERROR_CODES."""
    def __init__(self, error_code: str, detail: str = ""):
        super().__init__(f"{error_code}: {detail}")
        self.error_code = error_code
        self.detail = detail


def _entry_dict(entry) -> dict:
    """Convert a RegistryEntry to a plain dict (works for Pydantic + fallback)."""
    if hasattr(entry, "model_dump"):
        return entry.model_dump()
    return {
        "name": entry.name, "version": entry.version, "sha256": entry.sha256,
        "manifest_url": entry.manifest_url, "maintainer": entry.maintainer,
        "signed_by": entry.signed_by, "signature": entry.signature,
    }


def _tier(entry, query_lower: str) -> int:
    """Return ranking tier: 0=exact name, 1=name substring, 2=maintainer substring, 3=no match."""
    if not query_lower:
        return 0  # empty query -> all entries in same tier
    name = entry.name.lower()
    if name == query_lower:
        return 0
    if query_lower in name:
        return 1
    if query_lower in entry.maintainer.lower():
        return 2
    return 3


def search(query: str, index: RegistryIndex) -> List[dict]:
    """Return list of entry dicts ranked by relevance to query."""
    query_lower = (query or "").strip().lower()
    scored: list[tuple[int, tuple, dict]] = []
    for i, entry in enumerate(index.entries):
        tier = _tier(entry, query_lower)
        if tier == 3:
            continue  # not a match
        # semver-descending: negate the parsed tuple
        try:
            ver = _parse_version(entry.version)
            ver_key = (-ver[0], -ver[1], -ver[2])
        except (ValueError, AttributeError):
            ver_key = (0, 0, 0)
        scored.append((tier, ver_key, _entry_dict(entry)))
    scored.sort(key=lambda r: (r[0], r[1]))
    return [d for _, _, d in scored]


def fetch_remote(registry_url: str) -> RegistryIndex:
    """Fetch and parse a remote registry index. Raises SearchError(registry_unreachable) on failure."""
    try:
        with urllib.request.urlopen(registry_url, timeout=DOWNLOAD_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        raise SearchError("registry_unreachable", f"{registry_url}: {e}") from e
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise SearchError("manifest_invalid", f"remote registry not valid JSON: {e}") from e

    # Validate schema
    if data.get("registry_version") != SCHEMA_VERSION:
        raise SearchError(
            "manifest_invalid",
            f"registry_version mismatch: expected {SCHEMA_VERSION}, got {data.get('registry_version')!r}",
        )

    # Cache it for future searches
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass  # cache failure is non-fatal

    if hasattr(RegistryIndex, "model_validate"):
        return RegistryIndex.model_validate(data)
    return RegistryIndex(registry_version=data["registry_version"], entries=data["entries"])


def load_index(registry_url: Optional[str] = None) -> RegistryIndex:
    """Load a RegistryIndex from the most specific available source.

    Order: explicit URL -> local cache -> in-repo `registry/index.json`.
    """
    if registry_url:
        return fetch_remote(registry_url)
    if CACHE_PATH.exists():
        return load_registry_index(CACHE_PATH)
    if REPO_INDEX_PATH.exists():
        return load_registry_index(REPO_INDEX_PATH)
    raise SearchError("registry_not_found", "no registry index available (no cache, no in-repo index)")
