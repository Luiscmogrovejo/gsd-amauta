#!/usr/bin/env python3
"""
Agent Schema — Pydantic AgentDefinition model for Phase 52 Agent Compilation.
Phase 52 / COMPILE-01. Field declaration order is locked per
52-CONTEXT.md §Area 1 + §Area 3:
  name, description, tools, color, memory, skills

Grep contract (enforced by tests/test_agent_schema.py):
  - name field MUST appear before description field
  - description field MUST appear before tools field
  - tools field MUST appear before color field
  - color field MUST appear before memory field
  - memory field MUST appear before skills field
  - sections keys MUST appear in SECTION_KEY_ORDER tuple exactly

LOCKED 10 section keys (in SECTION_KEY_ORDER declaration order):
  role_and_identity, domain_knowledge, patterns_and_practices,
  workflow_and_process, tools_and_resources, quality_gates,
  output_format, error_handling, examples, metadata

body_preamble: verbatim Markdown text captured between frontmatter closing '---'
and the first '## ' heading. 16 of 17 agents at HEAD have a '# Agent: <name>'
H1 here; gsd-executor-data.md has none (body_preamble = None).
"""

import logging
import re
import sys
from typing import Dict, List, Optional

log = logging.getLogger("amauta.agent_schema")

# ─── Import-safety: pydantic (mirrors skill_schema.py L22-36) ────────────────

try:
    from pydantic import BaseModel, Field, field_validator
    _HAS_PYDANTIC = True
except ImportError:
    print("[agent_schema] pydantic not available; using dataclass fallback", file=sys.stderr)
    _HAS_PYDANTIC = False
    BaseModel = object  # noqa: N818

    def Field(*args, **kwargs):  # noqa: N802
        return None

    def field_validator(*args, **kwargs):
        def decorator(fn):
            return fn
        return decorator

# ─── Import-safety: yaml (mirrors skill_schema.py L40-45) ────────────────────

try:
    import yaml as _yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False
    _yaml = None

# ─── Validation regexes ───────────────────────────────────────────────────────

_NAME_RE = re.compile(r'^[a-z][a-z0-9-]{1,63}$')
_COLOR_RE = re.compile(r'^[a-z]+$')      # color is a single lowercase word
_MEMORY_VALUES = frozenset(['user', 'project', 'none'])

# ─── SECTION_KEY_ORDER ────────────────────────────────────────────────────────
# 10 locked snake_case section keys in declaration order.
# Consumers (compiler, validator) MUST iterate this tuple to emit/check
# declaration order. Reordering without updating this constant + tests is rejected.

SECTION_KEY_ORDER = (
    'role_and_identity',
    'domain_knowledge',
    'patterns_and_practices',
    'workflow_and_process',
    'tools_and_resources',
    'quality_gates',
    'output_format',
    'error_handling',
    'examples',
    'metadata',
)

# ─── AgentDefinition ──────────────────────────────────────────────────────────
# NOTE: frontmatter field declaration order is LOCKED:
#   name: → description: → tools: → color: → memory: → skills:
# grep contract above ensures this order is maintained.


class AgentDefinition(BaseModel):
    """Canonical agent definition. 6-field locked frontmatter + body_preamble + sections.

    Frontmatter fields in LOCKED declaration order:
      name, description, tools, color, memory, skills
    Phase 52 COMPILE-01 grep contract: name < description < tools < color < memory < skills.

    body_preamble: Optional verbatim Markdown text between frontmatter '---' and
    first '## ' heading. 16/17 agents have '# Agent: <name>' H1 here;
    gsd-executor-data.md has none (body_preamble = None). Empty string
    is treated as None by the compiler.

    sections: exactly 10 keys per SECTION_KEY_ORDER. Each value is raw Markdown
    body text (may be empty string).

    When pydantic unavailable, falls back to __init__-based validation.
    """

    if _HAS_PYDANTIC:
        model_config = {"populate_by_name": True, "extra": "forbid"}

        # LOCKED field order: name: → description: → tools: → color: → memory: → skills:
        name: str = Field(..., description="Agent identifier, kebab-case")
        description: str = Field(..., min_length=10, max_length=500)
        tools: List[str] = Field(..., description="List of canonical tool names")
        color: str = Field(..., description="Single lowercase color word")
        memory: str = Field(..., description="Memory scope: user | project | none")
        skills: List[str] = Field(default_factory=list)
        body_preamble: Optional[str] = Field(
            default=None,
            description=(
                "Verbatim Markdown text between frontmatter closing '---' and "
                "first '## ' heading. Typically '# Agent: <name>' H1. "
                "None when no text is present (e.g. gsd-executor-data.md)."
            ),
        )
        sections: Dict[str, str] = Field(
            ...,
            description=(
                "Exactly 10 section bodies keyed by SECTION_KEY_ORDER. "
                "Values are raw Markdown body text."
            ),
        )

        @field_validator("name")
        @classmethod
        def _v_name(cls, v: str) -> str:
            if not _NAME_RE.match(v):
                raise ValueError(f"name '{v}' must match ^[a-z][a-z0-9-]{{1,63}}$")
            return v

        @field_validator("color")
        @classmethod
        def _v_color(cls, v: str) -> str:
            if not _COLOR_RE.match(v):
                raise ValueError(
                    f"color '{v}' must be a single lowercase word (no hyphens/digits)"
                )
            return v

        @field_validator("memory")
        @classmethod
        def _v_memory(cls, v: str) -> str:
            if v not in _MEMORY_VALUES:
                raise ValueError(
                    f"memory '{v}' must be one of {sorted(_MEMORY_VALUES)}"
                )
            return v

        @field_validator("tools")
        @classmethod
        def _v_tools(cls, v: List[str]) -> List[str]:
            if not v:
                raise ValueError("tools must be non-empty")
            return v

        @field_validator("sections")
        @classmethod
        def _v_sections(cls, v: Dict[str, str]) -> Dict[str, str]:
            expected = set(SECTION_KEY_ORDER)
            given = set(v.keys())
            missing = expected - given
            extra = given - expected
            errs = []
            if missing:
                errs.append(f"missing section keys: {sorted(missing)}")
            if extra:
                errs.append(f"extra section keys: {sorted(extra)}")
            if errs:
                raise ValueError("; ".join(errs))
            return v

    else:
        def __init__(
            self,
            name: str = '',
            description: str = '',
            tools: Optional[List[str]] = None,
            color: str = '',
            memory: str = '',
            skills: Optional[List[str]] = None,
            body_preamble: Optional[str] = None,
            sections: Optional[Dict[str, str]] = None,
            **kwargs,
        ):
            # LOCKED field order: name: → description: → tools: → color: → memory: → skills:
            self.name = name
            self.description = description
            self.tools = tools or []
            self.color = color
            self.memory = memory
            self.skills = skills if skills is not None else []
            self.body_preamble = body_preamble
            self.sections = sections or {}

            errs = []
            if not _NAME_RE.match(self.name):
                errs.append(f"name '{self.name}' invalid (must match ^[a-z][a-z0-9-]{{1,63}}$)")
            if not (10 <= len(self.description) <= 500):
                errs.append(
                    f"description length {len(self.description)} not in [10, 500]"
                )
            if not self.tools:
                errs.append("tools must be non-empty")
            if not _COLOR_RE.match(self.color):
                errs.append(
                    f"color '{self.color}' must be a single lowercase word (no hyphens/digits)"
                )
            if self.memory not in _MEMORY_VALUES:
                errs.append(
                    f"memory '{self.memory}' must be one of {sorted(_MEMORY_VALUES)}"
                )
            # sections validation
            expected = set(SECTION_KEY_ORDER)
            given = set(self.sections.keys())
            missing = expected - given
            extra = given - expected
            if missing:
                errs.append(f"missing section keys: {sorted(missing)}")
            if extra:
                errs.append(f"extra section keys: {sorted(extra)}")
            if errs:
                raise ValueError("; ".join(errs))


# ─── _parse_yaml_minimal ──────────────────────────────────────────────────────

def _parse_yaml_minimal(text: str) -> dict:
    """Minimal YAML-like parser (fallback when yaml not available).

    Handles:
      - Scalar values (quoted or unquoted)
      - Indented list items (  - item)
      - Inline list ([item1, item2])
      - Nested dicts for 'sections' and 'frontmatter' top-level keys
      - Block literal '|' style strings (single-line only for fallback)
      - # comment lines + blank lines

    NOTE: This fallback is tested ONLY on YAML using inline scalars.
    AGENT.yaml with block literal '|' sections requires _HAS_YAML = True.
    """
    result = {}
    lines = text.splitlines()
    i = 0
    n = len(lines)

    def parse_scalar(val: str) -> str:
        if (val.startswith('"') and val.endswith('"')) or \
           (val.startswith("'") and val.endswith("'")):
            return val[1:-1]
        return val

    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            i += 1
            continue

        # Top-level key match (no leading whitespace)
        m = re.match(r'^([a-zA-Z_-]+):\s*(.*)$', line)
        if m:
            key = m.group(1)
            val = m.group(2).strip()

            if val == '' or val == '|':
                # Could be nested dict or indented list or block literal
                items = []
                sub = {}
                j = i + 1
                is_list = False
                is_dict = False
                block_lines = []

                while j < n:
                    child = lines[j]
                    child_stripped = child.strip()
                    if not child_stripped or child_stripped.startswith('#'):
                        j += 1
                        continue
                    # Check indentation level
                    indent = len(child) - len(child.lstrip())
                    if indent == 0:
                        break
                    if indent >= 2:
                        if re.match(r'^\s{2}-\s', child):
                            is_list = True
                            items.append(
                                child.strip()[2:].strip().strip('"').strip("'")
                            )
                        elif re.match(r'^\s{2}[a-zA-Z_-]+:\s', child):
                            is_dict = True
                            dm = re.match(r'^\s{2}([a-zA-Z_-]+):\s*(.*)', child)
                            if dm:
                                sk = dm.group(1)
                                sv = dm.group(2).strip()
                                if sv == '' or sv == '|':
                                    # Gather block literal body
                                    bk = j + 1
                                    blk = []
                                    while bk < n:
                                        bl = lines[bk]
                                        if not bl.strip() and bk + 1 < n and len(lines[bk + 1]) - len(lines[bk + 1].lstrip()) < 4:
                                            break
                                        if len(bl) - len(bl.lstrip()) < 4 and bl.strip():
                                            break
                                        blk.append(bl[4:] if bl[:4] == '    ' else bl.lstrip())
                                        bk += 1
                                    sub[sk] = '\n'.join(blk)
                                    j = bk
                                    continue
                                else:
                                    sub[sk] = parse_scalar(sv)
                        else:
                            block_lines.append(child[2:] if child[:2] == '  ' else child.lstrip())
                    j += 1

                if is_list:
                    result[key] = items
                elif is_dict:
                    result[key] = sub
                elif block_lines:
                    result[key] = '\n'.join(block_lines)
                else:
                    result[key] = {}
                i = j
                continue

            elif val.startswith('[') and val.endswith(']'):
                result[key] = [
                    x.strip().strip('"').strip("'")
                    for x in val[1:-1].split(',') if x.strip()
                ]
            else:
                result[key] = parse_scalar(val)
        i += 1

    return result


# ─── load_agent_definition ───────────────────────────────────────────────────

def load_agent_definition(path: str) -> 'AgentDefinition':
    """Read an AGENT.yaml file at path and return an AgentDefinition model.

    The AGENT.yaml format has a top-level 'frontmatter' mapping, optional
    'body_preamble' scalar, and 'sections' mapping with exactly 10 keys.

    Args:
        path: Path to AGENT.yaml file.

    Returns:
        AgentDefinition instance (Pydantic or fallback).

    Raises:
        ValueError: If the YAML is malformed or fails validation.
        FileNotFoundError: If path does not exist.
    """
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    if _HAS_YAML:
        data = _yaml.safe_load(content) or {}
    else:
        data = _parse_yaml_minimal(content)

    fm = data.get('frontmatter', {})
    body_preamble = data.get('body_preamble', None)
    # Normalize empty string to None
    if body_preamble is not None and str(body_preamble).strip() == '':
        body_preamble = None

    sections_raw = data.get('sections', {})
    # Ensure all section values are strings
    sections = {k: str(v) if v is not None else '' for k, v in sections_raw.items()}

    # Normalize tools: may be a list or comma-separated string
    tools = fm.get('tools', [])
    if isinstance(tools, str):
        tools = [t.strip() for t in tools.split(',') if t.strip()]

    skills = fm.get('skills', [])
    if isinstance(skills, str):
        skills = [s.strip() for s in skills.split(',') if s.strip()]

    if _HAS_PYDANTIC:
        return AgentDefinition(
            name=fm.get('name', ''),
            description=fm.get('description', ''),
            tools=tools,
            color=fm.get('color', ''),
            memory=fm.get('memory', ''),
            skills=skills,
            body_preamble=body_preamble,
            sections=sections,
        )
    else:
        return AgentDefinition(
            name=fm.get('name', ''),
            description=fm.get('description', ''),
            tools=tools,
            color=fm.get('color', ''),
            memory=fm.get('memory', ''),
            skills=skills,
            body_preamble=body_preamble,
            sections=sections,
        )
