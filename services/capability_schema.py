#!/usr/bin/env python3
"""
Capability Schema — Pydantic CapabilityCatalog model for Phase 60 TOOL-01.

Field declaration order is LOCKED, mirroring services/agent_schema.py /
services/module_schema.py lineage: try/except pydantic import with
_HAS_PYDANTIC flag, model_config = {"extra": "forbid"}, field_validator /
model_validator(mode="after"), and a minimal __init__-based fallback branch
when pydantic is unavailable (validates required keys + enum membership).

Entry `name` is a STABLE ID consumed by the Phase 67 PreToolUse hook as its
deterministic allowlist: renaming or removing a name requires a
catalog_version bump (see CapabilityCatalog docstring).

LOCKED 9-field CapabilityEntry declaration order:
    name, kind, target, auth, security_class, owner, grants, added_at, notes

Auth stores method + env-var NAME only, never secret values —
model_config = {"extra": "forbid"} on CapabilityAuth guarantees no
token/password/value key can ever be accepted.

Dual-runtime discipline (Phase 60 TOOL-01): this file's load_capability_catalog()
is the Python mirror of loadCapabilityCatalog() in get-shit-done/bin/gsd-tools.cjs.
Both read the SAME get-shit-done/config/capability-catalog.json file.
"""

import json
import logging
import os
import re
import sys
from typing import Dict, List, Optional

log = logging.getLogger("amauta.capability_schema")

# ─── Import-safety: pydantic (mirrors agent_schema.py / module_schema.py) ─────

try:
    from pydantic import BaseModel, Field, field_validator, model_validator
    _HAS_PYDANTIC = True
except ImportError:
    print("[capability_schema] pydantic not available; using dataclass fallback", file=sys.stderr)
    _HAS_PYDANTIC = False
    BaseModel = object  # noqa: N818

    def Field(*args, **kwargs):  # noqa: N802
        return None

    def field_validator(*args, **kwargs):
        def decorator(fn):
            return fn
        return decorator

    def model_validator(*args, **kwargs):
        def decorator(fn):
            return fn
        return decorator

# ─── Module-level constants (exact values — LOCKED) ───────────────────────────

CATALOG_VERSION = "1.0"
KIND_VALUES = ("curl-endpoint", "ssh-host", "pg", "redis", "k3s")
SECURITY_CLASS_VALUES = ("read-only", "read-write", "secret-bearing", "destructive")
AUTH_METHOD_VALUES = ("none", "bearer-env", "basic-env", "dsn-env", "ssh-key")
_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ─── CapabilityAuth ────────────────────────────────────────────────────────────

class CapabilityAuth(BaseModel):
    """Auth method + env-var NAME only — extra=forbid NEVER accepts secret
    values (no token/password/value keys possible on this model)."""

    if _HAS_PYDANTIC:
        model_config = {"extra": "forbid"}

        method: str = Field(..., description="One of AUTH_METHOD_VALUES")
        env: Optional[str] = Field(default=None, description="Env-var NAME (required for *-env methods)")
        key_ref: Optional[str] = Field(default=None, description="SSH key path reference (required for ssh-key)")

        @field_validator("method")
        @classmethod
        def _v_method(cls, v: str) -> str:
            if v not in AUTH_METHOD_VALUES:
                raise ValueError(f"auth method '{v}' must be one of {AUTH_METHOD_VALUES}")
            return v

        @model_validator(mode="after")
        def _v_cross_field(self) -> "CapabilityAuth":
            if self.method.endswith("-env") and not self.env:
                raise ValueError(f"auth method '{self.method}' requires 'env' field")
            if self.method == "ssh-key" and not self.key_ref:
                raise ValueError("auth method 'ssh-key' requires 'key_ref' field")
            return self

    else:
        def __init__(self, method: str = "", env: Optional[str] = None, key_ref: Optional[str] = None, **kwargs):
            if kwargs:
                raise ValueError(f"unexpected auth field(s): {sorted(kwargs)}")
            self.method = method
            self.env = env
            self.key_ref = key_ref

            errs = []
            if method not in AUTH_METHOD_VALUES:
                errs.append(f"auth method '{method}' must be one of {AUTH_METHOD_VALUES}")
            if method.endswith("-env") and not env:
                errs.append(f"auth method '{method}' requires 'env' field")
            if method == "ssh-key" and not key_ref:
                errs.append("auth method 'ssh-key' requires 'key_ref' field")
            if errs:
                raise ValueError("; ".join(errs))


# ─── CapabilityEntry ───────────────────────────────────────────────────────────
# NOTE: field declaration order is LOCKED (Phase 60 TOOL-01 / Phase 67 hook
# contract): name, kind, target, auth, security_class, owner, grants,
# added_at, notes. `name` is a STABLE ID consumed by the future PreToolUse
# hook as its deterministic allowlist — renaming or removing a `name`
# requires a catalog_version bump.

class CapabilityEntry(BaseModel):
    """One system the harness may reach. LOCKED 9-field declaration order."""

    if _HAS_PYDANTIC:
        model_config = {"extra": "forbid"}

        name: str = Field(..., description="STABLE ID (Phase 67 PreToolUse hook contract)")
        kind: str = Field(..., description="One of KIND_VALUES")
        target: str = Field(..., description="URL / host / DSN-alias env-var name")
        auth: CapabilityAuth
        security_class: str = Field(..., description="One of SECURITY_CLASS_VALUES")
        owner: str = Field(...)
        grants: List[str] = Field(default_factory=list, description="Agent names or 'gsd-executor-*' wildcard")
        added_at: str = Field(..., description="YYYY-MM-DD")
        notes: str = ""

        @field_validator("name")
        @classmethod
        def _v_name(cls, v: str) -> str:
            if not _NAME_RE.match(v):
                raise ValueError(f"name '{v}' must match ^[a-z][a-z0-9-]{{1,63}}$")
            return v

        @field_validator("kind")
        @classmethod
        def _v_kind(cls, v: str) -> str:
            if v not in KIND_VALUES:
                raise ValueError(f"kind '{v}' must be one of {KIND_VALUES}")
            return v

        @field_validator("target")
        @classmethod
        def _v_target(cls, v: str) -> str:
            if not v.strip():
                raise ValueError("target must be non-empty")
            return v

        @field_validator("security_class")
        @classmethod
        def _v_security_class(cls, v: str) -> str:
            if v not in SECURITY_CLASS_VALUES:
                raise ValueError(f"security_class '{v}' must be one of {SECURITY_CLASS_VALUES}")
            return v

        @field_validator("added_at")
        @classmethod
        def _v_added_at(cls, v: str) -> str:
            if not _DATE_RE.match(v):
                raise ValueError(f"added_at '{v}' must match YYYY-MM-DD")
            return v

    else:
        def __init__(
            self,
            name: str = "",
            kind: str = "",
            target: str = "",
            auth: Optional[dict] = None,
            security_class: str = "",
            owner: str = "",
            grants: Optional[List[str]] = None,
            added_at: str = "",
            notes: str = "",
            **kwargs,
        ):
            if kwargs:
                raise ValueError(f"unexpected entry field(s): {sorted(kwargs)}")
            self.name = name
            self.kind = kind
            self.target = target
            self.auth = auth if isinstance(auth, CapabilityAuth) else CapabilityAuth(**(auth or {}))
            self.security_class = security_class
            self.owner = owner
            self.grants = grants if grants is not None else []
            self.added_at = added_at
            self.notes = notes

            errs = []
            if not _NAME_RE.match(self.name):
                errs.append(f"name '{self.name}' must match ^[a-z][a-z0-9-]{{1,63}}$")
            if self.kind not in KIND_VALUES:
                errs.append(f"kind '{self.kind}' must be one of {KIND_VALUES}")
            if not str(self.target).strip():
                errs.append("target must be non-empty")
            if self.security_class not in SECURITY_CLASS_VALUES:
                errs.append(f"security_class '{self.security_class}' must be one of {SECURITY_CLASS_VALUES}")
            if not _DATE_RE.match(self.added_at):
                errs.append(f"added_at '{self.added_at}' must match YYYY-MM-DD")
            if errs:
                raise ValueError("; ".join(errs))


# ─── CapabilityCatalog ─────────────────────────────────────────────────────────

class CapabilityCatalog(BaseModel):
    """Top-level catalog: catalog_version + list of CapabilityEntry.

    Entry `name` values are STABLE IDs (Phase 67 PreToolUse hook contract):
    renaming or removing a name requires a catalog_version bump.
    """

    if _HAS_PYDANTIC:
        model_config = {"extra": "forbid"}

        catalog_version: str = Field(...)
        entries: List[CapabilityEntry] = Field(default_factory=list)

        @model_validator(mode="after")
        def _v_no_duplicates(self) -> "CapabilityCatalog":
            seen = set()
            for entry in self.entries:
                if entry.name in seen:
                    raise ValueError(f"duplicate entry name: '{entry.name}'")
                seen.add(entry.name)
            return self

    else:
        def __init__(self, catalog_version: str = "", entries: Optional[list] = None, **kwargs):
            if kwargs:
                raise ValueError(f"unexpected catalog field(s): {sorted(kwargs)}")
            self.catalog_version = catalog_version
            raw_entries = entries if entries is not None else []
            self.entries = [
                e if isinstance(e, CapabilityEntry) else CapabilityEntry(**e)
                for e in raw_entries
            ]
            seen = set()
            for entry in self.entries:
                if entry.name in seen:
                    raise ValueError(f"duplicate entry name: '{entry.name}'")
                seen.add(entry.name)


# ─── load_capability_catalog / validate_catalog ───────────────────────────────

_CATALOG_CACHE = None
_CATALOG_WARNED = False
_CATALOG_VERSION_WARNED = False


def load_capability_catalog(force_reload: bool = False) -> dict:
    """Load the capability catalog dict from disk.

    GSD_CAPABILITY_CATALOG_PATH (test/hook seam) is checked FIRST and, when
    set, is AUTHORITATIVE: no fallthrough to the repo-local or ~/.claude
    candidates happens when the env var is set but its path is missing or
    unparseable — that is the deterministic test-seam contract (a test
    forcing a specific/nonexistent path must never silently pick up the
    real repo catalog). When the env var is unset, candidate paths IN
    ORDER are:
      1. <this file's dir>/../get-shit-done/config/capability-catalog.json
      2. ~/.claude/get-shit-done/config/capability-catalog.json

    Module-level cache; silent fall-through on read/parse error between
    the repo-local/~/.claude candidates; on total miss: one-time stderr
    warning and return {"catalog_version": CATALOG_VERSION, "entries": []}
    (EMPTY catalog — never a fabricated stand-in list, security-appropriate
    default).

    If the loaded dict has catalog_version != CATALOG_VERSION, print a
    one-time stderr warning naming both versions (loud, never silent
    tolerance) but still return the data.
    """
    global _CATALOG_CACHE, _CATALOG_WARNED, _CATALOG_VERSION_WARNED

    if _CATALOG_CACHE is not None and not force_reload:
        return _CATALOG_CACHE

    env_override = os.environ.get("GSD_CAPABILITY_CATALOG_PATH")
    if env_override:
        candidates = [env_override]
    else:
        here = os.path.dirname(os.path.abspath(__file__))
        candidates = [
            os.path.join(here, "..", "get-shit-done", "config", "capability-catalog.json"),
            os.path.join(os.environ.get("HOME", ""), ".claude", "get-shit-done", "config", "capability-catalog.json"),
        ]

    for p in candidates:
        if not p:
            continue
        try:
            if os.path.exists(p):
                with open(p, "r") as f:
                    data = json.load(f)
                if data.get("catalog_version") != CATALOG_VERSION and not _CATALOG_VERSION_WARNED:
                    print(
                        f"[capability_schema] capability-catalog version "
                        f"{data.get('catalog_version')} != supported {CATALOG_VERSION} — "
                        f"entries may not be interpreted correctly",
                        file=sys.stderr,
                    )
                    _CATALOG_VERSION_WARNED = True
                _CATALOG_CACHE = data
                return _CATALOG_CACHE
        except Exception:
            continue  # fall through to next candidate

    if not _CATALOG_WARNED:
        print(
            "[capability_schema] capability-catalog.json not found — using EMPTY catalog (all systems unlisted)",
            file=sys.stderr,
        )
        _CATALOG_WARNED = True
    _CATALOG_CACHE = {"catalog_version": CATALOG_VERSION, "entries": []}
    return _CATALOG_CACHE


def validate_catalog(data: dict):
    """Validate a catalog dict against CapabilityCatalog.

    Pops a top-level '_comment' key (tag-rules.json precedent) then
    validates via CapabilityCatalog. Raises ValueError with a structured
    message 'capability_catalog_invalid: <detail>' on any violation.
    Returns the validated CapabilityCatalog (or dict in the no-pydantic
    fallback).
    """
    payload = dict(data)
    payload.pop("_comment", None)
    try:
        catalog = CapabilityCatalog(**payload)
    except ValueError as e:
        raise ValueError(f"capability_catalog_invalid: {e}") from e
    return catalog
