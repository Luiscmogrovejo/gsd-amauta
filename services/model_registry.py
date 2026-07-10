#!/usr/bin/env python3
"""services/model_registry.py — Python entry point for resolving Claude model
aliases (fable | opus | sonnet | haiku) to their CURRENT canonical model ids.

Backed by the SAME source of truth the JS runtime reads:
get-shit-done/bin/lib/model-registry.json (MODL-01 currency, MODL-06
centralization). No claude-* literal should live in Python callers — call
resolve_model_id() instead.

Fable degrades to the latest Opus when unavailable (operator directive:
"if no fable, back up into the latest opus"). Availability defaults to True and
is forced off with GSD_FABLE_AVAILABLE in {0,false,off,no}, or per call via the
fable_available argument.

Every function is defensive: a missing/corrupt registry falls back to the
last-known-good ids so fail-open callers (memory classifier) never break.
"""

import json
import os

# Last-known-good defaults (mirror model-registry.json). Used only if the JSON
# is unreadable so this module never raises at import or resolve time.
_FALLBACK_ALIASES = {
    "fable": "claude-fable-5",
    "opus": "claude-opus-4-8",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5-20251001",
}
_FALLBACK_FALLBACK = {"fable": "opus"}

# services/model_registry.py -> ../get-shit-done/bin/lib/model-registry.json
_REGISTRY_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "get-shit-done", "bin", "lib", "model-registry.json",
)

_cache = None


def _load():
    global _cache
    if _cache is not None:
        return _cache
    try:
        with open(_REGISTRY_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        _cache = {
            "aliases": raw.get("aliases") or _FALLBACK_ALIASES,
            "fallback": raw.get("fallback") or _FALLBACK_FALLBACK,
        }
    except Exception:
        _cache = {"aliases": dict(_FALLBACK_ALIASES), "fallback": dict(_FALLBACK_FALLBACK)}
    return _cache


def _fable_available():
    v = os.environ.get("GSD_FABLE_AVAILABLE", "").strip().lower()
    return v not in ("0", "false", "off", "no")


def resolve_model_alias(alias, fable_available=None):
    """Return the alias amauta should USE, honoring the fable->opus fallback."""
    reg = _load()
    key = str(alias if alias is not None else "").strip().lower()
    if key == "fable":
        avail = _fable_available() if fable_available is None else fable_available
        if not avail:
            return reg["fallback"].get("fable", "opus")
    return key or alias


def resolve_model_id(alias, fable_available=None):
    """Resolve an alias (or raw id) to the CURRENT canonical model id, honoring
    the fable->opus fallback. Unknown values pass through unchanged."""
    reg = _load()
    key = str(alias if alias is not None else "").strip().lower()
    if key not in reg["aliases"]:
        return alias  # concrete id or unknown -> pass through
    resolved = resolve_model_alias(key, fable_available=fable_available)
    return reg["aliases"].get(resolved) or reg["aliases"][key]


def aliases():
    return dict(_load()["aliases"])
