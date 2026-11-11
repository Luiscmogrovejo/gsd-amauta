#!/usr/bin/env python3
"""
services/module_schema.py — Phase 48 MOD-01

Module manifest (YAML) schema: Pydantic ModuleManifest model with import-safety
fallback. Mirrors Phase 43 services/skill_schema.py _HAS_PYDANTIC/_HAS_YAML
discipline + declaration-order locking.

8-field LOCKED declaration order:
    name, version, description, requires, migrations, services, agents, skills

Field order LOCKED (Phase 48 MOD-01) — a regression test in tests/test_module_schema.py
introspects SCHEMA_FIELD_ORDER and asserts exact equality. Re-ordering fields without
updating the constant + test is rejected at CI time.

Migration-file on-disk existence check: DEFERRED to Phase 49 install logic.
Phase 48 validates manifest structure only; migration-path resolution against
module root is install-time context (not load_module_manifest context).
"""

import logging
import re
import sys
from typing import Dict, List, Optional

log = logging.getLogger("amauta.module_schema")

# ─── Import-safety: pydantic (mirrors Phase 43 skill_schema.py L22-36) ─────────

try:
    from pydantic import BaseModel, Field, field_validator, model_validator
    _HAS_PYDANTIC = True
except ImportError:
    print("[module_schema] pydantic not available; using dataclass fallback", file=sys.stderr)
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

# ─── Import-safety: yaml (mirrors Phase 47 agent_hydrator.py _HAS_REDIS pattern) ──

try:
    import yaml as _yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False
    _yaml = None

# ─── Validation regexes ───────────────────────────────────────────────────────

# kebab-case module name: starts with lowercase, 2-64 chars total
_NAME_RE = re.compile(r'^[a-z][a-z0-9-]{1,63}$')

# semver MAJOR.MINOR.PATCH with optional pre-release + build metadata
# matches scripts/skill-compiler.cjs L291 family precedent
_VERSION_RE = re.compile(
    r'^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$'
)

# semver range token: optional operator (^ or ~) + MAJOR.MINOR.PATCH or MAJOR.MINOR or MAJOR
# permissive — exact parsing and range algebra happen in module_resolver.py
_SEMVER_RANGE_RE = re.compile(
    r'^(\^|~)?\d+(\.\d+){0,2}(-[a-z0-9.-]+)?$'
)

# ─── SCHEMA_FIELD_ORDER ────────────────────────────────────────────────────────

# Used by tests/test_module_schema.py to regression-lock the 8-field declaration order.
# This tuple MUST stay in sync with the ModuleManifest class body below.
SCHEMA_FIELD_ORDER = (
    "name", "version", "description", "requires",
    "migrations", "services", "agents", "skills"
)


# ─── ModuleManifest ───────────────────────────────────────────────────────────

class ModuleManifest(BaseModel):
    """Module manifest (module.yaml). 8 fields in LOCKED declaration order.

    Phase 48 MOD-01. Field order LOCKED — grep-verified by regression test.
    name, version, description, requires, migrations, services, agents, skills.

    When pydantic unavailable, falls back to __init__-based validation;
    same validation rules apply (name regex, version regex, range regex,
    self-dependency check, at-least-one-ships rule).
    """

    if _HAS_PYDANTIC:
        model_config = {"populate_by_name": True, "extra": "forbid"}

        # Field order LOCKED (Phase 48 MOD-01): name, version, description, requires, migrations, services, agents, skills
        name: str = Field(..., description="Module identifier, kebab-case")
        version: str = Field(..., description="Semver MAJOR.MINOR.PATCH")
        description: str = Field(..., min_length=1, max_length=500)
        requires: Dict[str, str] = Field(default_factory=dict)
        migrations: List[str] = Field(default_factory=list)
        services: Dict[str, dict] = Field(default_factory=dict)
        agents: List[str] = Field(default_factory=list)
        skills: List[str] = Field(default_factory=list)

        @field_validator("name")
        @classmethod
        def _v_name(cls, v: str) -> str:
            if not _NAME_RE.match(v):
                raise ValueError(
                    f"name '{v}' must match ^[a-z][a-z0-9-]{{1,63}}$"
                )
            return v

        @field_validator("version")
        @classmethod
        def _v_version(cls, v: str) -> str:
            if not _VERSION_RE.match(v):
                raise ValueError(
                    f"version '{v}' must be semver MAJOR.MINOR.PATCH "
                    f"(optional pre-release/build-metadata allowed)"
                )
            return v

        @field_validator("requires")
        @classmethod
        def _v_requires(cls, v: Dict[str, str]) -> Dict[str, str]:
            for dep_name, range_str in v.items():
                if not _NAME_RE.match(dep_name):
                    raise ValueError(
                        f"requires key '{dep_name}' must be kebab-case "
                        f"matching ^[a-z][a-z0-9-]{{1,63}}$"
                    )
                if not _SEMVER_RANGE_RE.match(range_str):
                    raise ValueError(
                        f"requires range '{range_str}' for '{dep_name}' is invalid; "
                        f"must be one of: ^MAJOR.MINOR.PATCH, ~MAJOR.MINOR.PATCH, MAJOR.MINOR.PATCH, ^MAJOR"
                    )
            return v

        @field_validator("migrations")
        @classmethod
        def _v_migrations(cls, v: List[str]) -> List[str]:
            return v

        @model_validator(mode="after")
        def _v_cross_field(self) -> "ModuleManifest":
            # self-dependency check: requires MUST NOT reference the module's own name
            if self.name in (self.requires or {}):
                raise ValueError(
                    f"self-dependency banned: module '{self.name}' cannot require itself"
                )
            # at-least-one-ships rule: a module that ships nothing is rejected
            if (
                not self.migrations
                and not self.services
                and not self.agents
                and not self.skills
            ):
                raise ValueError(
                    "module must ship at least one of migrations, services, agents, skills"
                )
            return self

    else:
        # ─── Non-pydantic __init__-based fallback ──────────────────────────────
        # Same 8-field signature. Same validation rules. Raises ValueError with
        # joined error list (mirrors Phase 43 SkillFrontmatter fallback L186-219).

        def __init__(
            self,
            name: str = "",
            version: str = "",
            description: str = "",
            requires: Optional[Dict[str, str]] = None,
            migrations: Optional[List[str]] = None,
            services: Optional[Dict[str, dict]] = None,
            agents: Optional[List[str]] = None,
            skills: Optional[List[str]] = None,
            **kwargs,
        ):
            self.name = name
            self.version = version
            self.description = description
            self.requires = requires if requires is not None else {}
            self.migrations = migrations if migrations is not None else []
            self.services = services if services is not None else {}
            self.agents = agents if agents is not None else []
            self.skills = skills if skills is not None else []

            errs = []
            if not _NAME_RE.match(self.name):
                errs.append(
                    f"name '{self.name}' must match ^[a-z][a-z0-9-]{{1,63}}$"
                )
            if not _VERSION_RE.match(self.version):
                errs.append(
                    f"version '{self.version}' must be semver MAJOR.MINOR.PATCH"
                )
            if not (1 <= len(self.description) <= 500):
                errs.append(
                    f"description length {len(self.description)} not in [1, 500]"
                )
            for dep_name, range_str in self.requires.items():
                if not _NAME_RE.match(dep_name):
                    errs.append(
                        f"requires key '{dep_name}' invalid kebab-case"
                    )
                if not _SEMVER_RANGE_RE.match(range_str):
                    errs.append(
                        f"requires range '{range_str}' for '{dep_name}' invalid"
                    )
            # self-dependency check
            if self.name in self.requires:
                errs.append(
                    f"self-dependency banned: module '{self.name}' cannot require itself"
                )
            # at-least-one-ships rule
            if (
                not self.migrations
                and not self.services
                and not self.agents
                and not self.skills
            ):
                errs.append(
                    "module must ship at least one of migrations, services, agents, skills"
                )
            if errs:
                raise ValueError("; ".join(errs))


# ─── Minimal YAML parser (yaml not available fallback) ───────────────────────

def _parse_yaml_minimal(text: str) -> dict:
    """Minimal pure-Python YAML parser for simple flat + shallow YAML.

    Handles top-level YAML (no --- frontmatter split — module.yaml is pure YAML).
    Supports: scalar values, block sequences (- item), inline sequences ([a, b]),
    block mappings under a key ({} or indented key: val pairs).

    This is a best-effort fallback; PyYAML is strongly preferred.
    """
    result: dict = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            i += 1
            continue
        m = re.match(r'^([a-zA-Z_-]+):\s*(.*)$', line)
        if not m:
            i += 1
            continue
        key, val = m.group(1), m.group(2).strip()

        # Empty value or explicit {}
        if val in ('', '{}'):
            # Check if next lines are indented block sequence
            items = []
            j = i + 1
            while j < len(lines) and (lines[j].startswith('  - ') or lines[j].startswith('  ')):
                inner = lines[j].strip()
                if inner.startswith('- '):
                    items.append(inner[2:].strip())
                    j += 1
                else:
                    # Key: value pair inside a mapping
                    break
            if items:
                result[key] = items
                i = j
            else:
                # empty list or dict; treat as empty dict if {} else empty list
                result[key] = {} if val == '{}' else []
                i += 1
            continue

        # Explicit []
        if val == '[]':
            result[key] = []
            i += 1
            continue

        # Inline list [a, b, ...]
        if val.startswith('[') and val.endswith(']'):
            inner = val[1:-1]
            result[key] = [
                x.strip().strip('"').strip("'")
                for x in inner.split(',') if x.strip()
            ] if inner.strip() else []
            i += 1
            continue

        # Inline mapping {k: v, ...} — simplified: treat as empty dict
        if val.startswith('{') and val.endswith('}'):
            inner = val[1:-1].strip()
            if not inner:
                result[key] = {}
            else:
                # Parse simple {key: val, ...} — best effort
                mapping: dict = {}
                for pair in inner.split(','):
                    pair = pair.strip()
                    if ':' in pair:
                        k2, v2 = pair.split(':', 1)
                        mapping[k2.strip()] = v2.strip().strip('"').strip("'")
                result[key] = mapping
            i += 1
            continue

        # Scalar: strip quotes
        if (val.startswith('"') and val.endswith('"')) or \
           (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        result[key] = val
        i += 1

    return result


# ─── load_module_manifest ─────────────────────────────────────────────────────

def load_module_manifest(path: str) -> "ModuleManifest":
    """Read a module.yaml file and return a validated ModuleManifest instance.

    Args:
        path: Filesystem path to the module.yaml file.

    Returns:
        ModuleManifest instance (pydantic or fallback depending on _HAS_PYDANTIC).

    Raises:
        FileNotFoundError: if path does not exist (caller handles as exit code 2).
        ValueError: if YAML is malformed or manifest fails validation.
        pydantic.ValidationError: if pydantic is available and validation fails.
    """
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    if _HAS_YAML:
        data = _yaml.safe_load(text) or {}
    else:
        data = _parse_yaml_minimal(text)

    # Coerce defaults for absent optional fields
    data.setdefault("requires", {})
    data.setdefault("migrations", [])
    data.setdefault("services", {})
    data.setdefault("agents", [])
    data.setdefault("skills", [])

    return ModuleManifest(**data)
