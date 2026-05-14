#!/usr/bin/env python3
"""
services/a2a_registry.py — Phase 55 A2A-02: capability negotiation registry.

Reads capabilities from Phase 52 AGENT.yaml files (get-shit-done/agents/gsd-*/AGENT.yaml).
Capabilities are STATIC — declared at agent compile time via the 'capabilities' frontmatter
field added by Phase 55. No runtime registration in this phase (deferred to v3.4).

SCHEMA_VERSION = "1.0" — locked for this phase.

Key functions:
  get_capabilities(agent_name) -> list[str]
  list_agents() -> list[str]
  all_capabilities() -> dict[str, list[str]]

Error vocabulary:
  RegistryError — base
  AgentNotFoundError(RegistryError) — raised when agent_name has no AGENT.yaml

References:
  - services/agent_schema.py (load_agent_definition)
  - get-shit-done/agents/gsd-*/AGENT.yaml (Phase 52 canonical source)
"""

import glob
import os
import sys
from typing import Dict, List

SCHEMA_VERSION = "1.0"

# ── Import-safety: agent_schema ───────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)

# Ensure repo root on sys.path for import
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services.agent_schema import load_agent_definition  # type: ignore
    _HAS_SCHEMA = True
except Exception:
    try:
        from agent_schema import load_agent_definition  # type: ignore
        _HAS_SCHEMA = True
    except Exception:
        _HAS_SCHEMA = False
        load_agent_definition = None  # type: ignore


# ── Exceptions ────────────────────────────────────────────────────────────────

class RegistryError(Exception):
    """Base class for a2a_registry errors."""
    pass


class AgentNotFoundError(RegistryError):
    """Raised when no AGENT.yaml exists for the requested agent name.

    The registry is static (file-backed). If an agent has no compiled
    AGENT.yaml in get-shit-done/agents/<name>/AGENT.yaml, it is unknown
    to the A2A capability registry.
    """
    pass


# ── Registry root path ────────────────────────────────────────────────────────

def _agents_root() -> str:
    """Return the path to get-shit-done/agents/ from repo root."""
    return os.path.join(_REPO_ROOT, "get-shit-done", "agents")


def _yaml_path(agent_name: str) -> str:
    """Return expected AGENT.yaml path for agent_name."""
    return os.path.join(_agents_root(), agent_name, "AGENT.yaml")


# ── Public API ────────────────────────────────────────────────────────────────

def get_capabilities(agent_name: str) -> List[str]:
    """Return the capability list for agent_name.

    Reads get-shit-done/agents/<agent_name>/AGENT.yaml and returns the
    'capabilities' frontmatter field. Returns [] for agents that have no
    capabilities declared (backward compatible with Phase 52 AGENT.yaml files
    written before Phase 55).

    Args:
        agent_name: Agent identifier, e.g. 'gsd-reviewer'. Must match the
            subdirectory name under get-shit-done/agents/.

    Returns:
        List of capability verb strings. Empty list if no capabilities declared.

    Raises:
        AgentNotFoundError: If no AGENT.yaml exists for agent_name.
        RegistryError: If the YAML cannot be parsed (wraps underlying error).
    """
    yaml_path = _yaml_path(agent_name)
    if not os.path.exists(yaml_path):
        raise AgentNotFoundError(
            f"No AGENT.yaml found for agent '{agent_name}' at {yaml_path}"
        )
    if not _HAS_SCHEMA or load_agent_definition is None:
        raise RegistryError(
            "agent_schema not available — cannot load capabilities from AGENT.yaml"
        )
    try:
        defn = load_agent_definition(yaml_path)
    except Exception as exc:
        raise RegistryError(
            f"Failed to parse AGENT.yaml for '{agent_name}': {exc}"
        ) from exc

    return list(getattr(defn, "capabilities", []) or [])


def list_agents() -> List[str]:
    """Return all agent names with compiled AGENT.yaml files.

    Scans get-shit-done/agents/*/AGENT.yaml and returns the directory names
    (which are the canonical agent identifiers).

    Returns:
        Sorted list of agent name strings (e.g. ['gsd-architect', ...]).
        Empty list if agents root does not exist.
    """
    root = _agents_root()
    if not os.path.isdir(root):
        return []
    pattern = os.path.join(root, "*", "AGENT.yaml")
    paths = glob.glob(pattern)
    names = []
    for p in paths:
        # Extract agent name from the directory containing AGENT.yaml
        parts = os.path.normpath(p).split(os.sep)
        # parts[-1] == "AGENT.yaml", parts[-2] == agent name
        if len(parts) >= 2:
            names.append(parts[-2])
    return sorted(names)


def all_capabilities() -> Dict[str, List[str]]:
    """Return a dict mapping every known agent name to its capability list.

    Iterates list_agents() and calls get_capabilities() for each. Agents that
    fail to load are recorded with an empty list and a warning to stderr.

    Returns:
        Dict[agent_name, capabilities_list]. Keys are sorted alphabetically.
        Always returns a dict even when get_capabilities() raises (error
        agents get [] and a warning).
    """
    import sys as _sys
    result: Dict[str, List[str]] = {}
    for name in list_agents():
        try:
            result[name] = get_capabilities(name)
        except RegistryError as exc:
            print(f"[a2a_registry] WARNING: skipping '{name}': {exc}", file=_sys.stderr)
            result[name] = []
    return result
