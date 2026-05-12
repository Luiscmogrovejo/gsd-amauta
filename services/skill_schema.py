#!/usr/bin/env python3
"""
Skill Schema — Pydantic SkillFrontmatter model + depends_on graph walker.
Phase 43 / SKILL-01 / SKILL-03. Field declaration order is locked per
43-CONTEXT.md §Area 1 + §Area 5:
  name, description, category, version, security_class, allowed-tools, depends_on
security_class MUST appear BEFORE allowed-tools: the downstream Semgrep rule
`skill-read-only-no-write` (Plan 43-03-02) uses a regex of the form
``(?ms)^security_class:\\s*read-only.*?^allowed-tools:`` which only matches when
security_class appears BEFORE allowed-tools in the frontmatter.
"""

import logging
import re
import sys
from typing import List, Optional

log = logging.getLogger("amauta.skill_schema")

# ─── Import-safety: pydantic (mirrors step-orchestrator.py) ─────────────────

try:
    from pydantic import BaseModel, Field, field_validator
    _HAS_PYDANTIC = True
except ImportError:
    print("[skill_schema] pydantic not available; using dataclass fallback", file=sys.stderr)
    _HAS_PYDANTIC = False
    BaseModel = object  # noqa: N818

    def Field(*args, **kwargs):  # noqa: N802
        return None

    def field_validator(*args, **kwargs):
        def decorator(fn):
            return fn
        return decorator

# ─── Import-safety: yaml ─────────────────────────────────────────────────────

try:
    import yaml as _yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False
    _yaml = None

# ─── Validation regexes ───────────────────────────────────────────────────────

_NAME_RE = re.compile(r'^[a-z][a-z0-9-]{1,63}$')
_CATEGORY_RE = re.compile(r'^[a-z][a-z0-9-]{1,32}$')
_VERSION_RE = re.compile(r'^\d+\.\d+\.\d+$')
_DEPENDS_ENTRY_RE = re.compile(r'^[a-z][a-z0-9-]+(@\d+\.\d+\.\d+|@latest)?$')
_SECURITY_CLASSES = frozenset(['read-only', 'read-write', 'admin'])


# ─── CycleError ──────────────────────────────────────────────────────────────

class CycleError(Exception):
    """Raised by walk_depends_on when a cycle is detected."""
    def __init__(self, cycle: list):
        self.cycle = cycle
        super().__init__(f"Dependency cycle detected: {' -> '.join(cycle)}")


# ─── parse_depends_on_entry ───────────────────────────────────────────────────

def parse_depends_on_entry(entry: str):
    """Split 'plan-phase@1.0.0' -> ('plan-phase', '1.0.0').

    Returns (name, version_pin) where version_pin is None if absent.
    """
    if '@' in entry:
        name, pin = entry.split('@', 1)
        return (name, pin)
    return (entry, None)


# ─── walk_depends_on ──────────────────────────────────────────────────────────

def walk_depends_on(graph: dict) -> list:
    """DFS topological sort. Raises CycleError on any cycle.

    Args:
        graph: {node: [dep, ...]} — deps may use <name>@<version> form.

    Returns:
        Topological order list (dependencies first, dependents last).
    """
    normalized: dict = {}
    for node, deps in graph.items():
        n, _ = parse_depends_on_entry(node)
        normalized[n] = [parse_depends_on_entry(d)[0] for d in deps]

    visited: set = set()
    in_progress: set = set()
    finish_order: list = []

    def dfs(node: str, path: list):
        if node in in_progress:
            raise CycleError(cycle=path[path.index(node):] + [node])
        if node in visited:
            return
        in_progress.add(node)
        path.append(node)
        for dep in normalized.get(node, []):
            dfs(dep, path)
        path.pop()
        in_progress.discard(node)
        visited.add(node)
        finish_order.append(node)

    for node in normalized:
        if node not in visited:
            dfs(node, [])

    return finish_order


# ─── SkillFrontmatter ────────────────────────────────────────────────────────
# NOTE: security_class declared BEFORE allowed-tools — required by Semgrep rule order (Plan 43-03-02).

class SkillFrontmatter(BaseModel):
    """Canonical SKILL.md frontmatter. 7 fields in LOCKED declaration order:
    name, description, category, version, security_class, allowed-tools, depends_on.

    security_class: MUST appear BEFORE allowed-tools (Semgrep contract — Plan 43-03-02).
    When pydantic unavailable, falls back to __init__-based validation.
    """

    if _HAS_PYDANTIC:
        model_config = {"populate_by_name": True, "extra": "forbid"}

        name: str = Field(..., description="Skill identifier, kebab-case")
        description: str = Field(..., min_length=10, max_length=500)
        category: str = Field(..., description="Category, kebab-case")
        version: str = Field(..., description="Semver x.y.z")
        # NOTE: security_class declared BEFORE allowed-tools — required by Semgrep rule order (Plan 43-03-02).
        security_class: str = Field(..., description="read-only | read-write | admin")
        allowed_tools: List[str] = Field(..., alias="allowed-tools")
        depends_on: List[str] = Field(default_factory=list)

        @field_validator("name")
        @classmethod
        def _v_name(cls, v: str) -> str:
            if not _NAME_RE.match(v):
                raise ValueError(f"name '{v}' must match ^[a-z][a-z0-9-]{{1,63}}$")
            return v

        @field_validator("category")
        @classmethod
        def _v_category(cls, v: str) -> str:
            if not _CATEGORY_RE.match(v):
                raise ValueError(f"category '{v}' must match ^[a-z][a-z0-9-]{{1,32}}$")
            return v

        @field_validator("version")
        @classmethod
        def _v_version(cls, v: str) -> str:
            if not _VERSION_RE.match(v):
                raise ValueError(f"version '{v}' must be semver x.y.z")
            return v

        @field_validator("security_class")
        @classmethod
        def _v_security_class(cls, v: str) -> str:
            if v not in _SECURITY_CLASSES:
                raise ValueError(f"security_class '{v}' must be one of {sorted(_SECURITY_CLASSES)}")
            return v

        @field_validator("allowed_tools")
        @classmethod
        def _v_allowed_tools(cls, v: List[str]) -> List[str]:
            if not v:
                raise ValueError("allowed-tools must be non-empty")
            return v

        @field_validator("depends_on")
        @classmethod
        def _v_depends_on(cls, v: List[str]) -> List[str]:
            for entry in v:
                if not _DEPENDS_ENTRY_RE.match(entry):
                    raise ValueError(f"depends_on entry '{entry}' is invalid")
            return v

    else:
        def __init__(self, name: str = '', description: str = '',
                     category: str = '', version: str = '',
                     security_class: str = '',
                     allowed_tools: Optional[List[str]] = None,
                     depends_on: Optional[List[str]] = None, **kwargs):
            if 'allowed-tools' in kwargs:
                allowed_tools = kwargs.pop('allowed-tools')
            self.name = name
            self.description = description
            self.category = category
            self.version = version
            # NOTE: security_class declared BEFORE allowed-tools — required by Semgrep rule order (Plan 43-03-02).
            self.security_class = security_class
            self.allowed_tools = allowed_tools or []
            self.depends_on = depends_on if depends_on is not None else []

            errs = []
            if not _NAME_RE.match(self.name):
                errs.append(f"name '{self.name}' invalid")
            if not (10 <= len(self.description) <= 500):
                errs.append(f"description length {len(self.description)} not in [10,500]")
            if not _CATEGORY_RE.match(self.category):
                errs.append(f"category '{self.category}' invalid")
            if not _VERSION_RE.match(self.version):
                errs.append(f"version '{self.version}' must be semver x.y.z")
            if self.security_class not in _SECURITY_CLASSES:
                errs.append(f"security_class '{self.security_class}' invalid")
            if not self.allowed_tools:
                errs.append("allowed-tools must be non-empty")
            for e in self.depends_on:
                if not _DEPENDS_ENTRY_RE.match(e):
                    errs.append(f"depends_on entry '{e}' invalid")
            if errs:
                raise ValueError("; ".join(errs))


# ─── load_skill_frontmatter ───────────────────────────────────────────────────

def _parse_frontmatter_minimal(text: str) -> dict:
    """Minimal YAML-like parser (yaml not available fallback)."""
    result = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.strip().startswith('#'):
            i += 1
            continue
        m = re.match(r'^([a-zA-Z_-]+):\s*(.*)$', line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if val in ('', '[]'):
                items = []
                j = i + 1
                while j < len(lines) and lines[j].startswith('  - '):
                    items.append(lines[j].strip()[2:].strip())
                    j += 1
                result[key] = items
                i = j
                continue
            elif val.startswith('[') and val.endswith(']'):
                result[key] = [
                    x.strip().strip('"').strip("'")
                    for x in val[1:-1].split(',') if x.strip()
                ]
                i += 1
                continue
            else:
                if (val.startswith('"') and val.endswith('"')) or \
                   (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                result[key] = val
        i += 1
    return result


def load_skill_frontmatter(path: str) -> SkillFrontmatter:
    """Read SKILL.md, extract YAML frontmatter, return SkillFrontmatter model."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    parts = content.split('---')
    if len(parts) < 3:
        raise ValueError(f"No valid YAML frontmatter found in {path}")
    fm_text = parts[1].strip()
    data = (_yaml.safe_load(fm_text) or {}) if _HAS_YAML else _parse_frontmatter_minimal(fm_text)
    if data.get('depends_on') is None:
        data['depends_on'] = []
    if _HAS_PYDANTIC:
        return SkillFrontmatter(**{
            'name': data.get('name', ''),
            'description': data.get('description', ''),
            'category': data.get('category', ''),
            'version': data.get('version', ''),
            'security_class': data.get('security_class', ''),
            'allowed-tools': data.get('allowed-tools', data.get('allowed_tools', [])),
            'depends_on': data.get('depends_on', []),
        })
    else:
        return SkillFrontmatter(
            name=data.get('name', ''),
            description=data.get('description', ''),
            category=data.get('category', ''),
            version=data.get('version', ''),
            security_class=data.get('security_class', ''),
            allowed_tools=data.get('allowed-tools', data.get('allowed_tools', [])),
            depends_on=data.get('depends_on', []),
        )
