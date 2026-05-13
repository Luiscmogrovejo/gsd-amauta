#!/usr/bin/env python3
"""
services/module_resolver.py — Phase 48 MOD-02

Pure-Python semver dependency resolver for ModuleManifest instances.
No I/O, no global state — resolve() is a pure function: same input → same output.

Semver subset implemented (v3.2 scope):
    - Caret: ^1.2.3  → >=1.2.3, <2.0.0
    - Caret zero-major: ^0.1.2 → >=0.1.2, <0.2.0  (npm-compatible)
    - Tilde: ~1.2.3  → >=1.2.3, <1.3.0
    - Exact: 1.2.3   → ==1.2.3
    - Caret-major: ^1 → >=1.0.0, <2.0.0  (bare major, zero-padded)

Pre-release ordering deferred to v3.3+ — pre-release tags parse but compare
as equal to release version. e.g. "1.0.0-beta" is treated as "1.0.0" for
range comparisons.

Frozen ResolveResult shape (schema_version "1.0" — Phase 48 → 49 contract):
    {
        "schema_version": "1.0",
        "ok": bool,
        "install_order": list[str] | None,   # topological + alphabetical tiebreak
        "conflicts": [
            {
                "module_a": str, "range_a": str,
                "module_b": str, "range_b": str,
                "requested_module": str,
            }
        ],
        "missing": list[str],                # required modules absent from input
        "cycle": list[str] | None,           # cycle node names if detected, else None
    }

- ok is False if ANY of (conflicts non-empty, missing non-empty, cycle non-None).
- When cycle is non-None: install_order=None, ok=False.
- Resolver fails-closed via return-dict, NEVER raises.
"""

import sys
from typing import Dict, List, Optional, Tuple

# ── Import ModuleManifest (top-level; no circular dependency risk) ────────────

try:
    from services.module_schema import ModuleManifest  # type: ignore
except ImportError:
    try:
        import os as _os
        _here = _os.path.dirname(_os.path.abspath(__file__))
        _root = _os.path.dirname(_here)
        if _root not in sys.path:
            sys.path.insert(0, _root)
        from services.module_schema import ModuleManifest  # type: ignore
    except ImportError:
        ModuleManifest = None  # type: ignore

# ── Frozen module-level constant ──────────────────────────────────────────────

SCHEMA_VERSION = "1.0"


# ── Semver parsing helpers ─────────────────────────────────────────────────────

def _parse_version(v: str) -> Tuple[int, int, int]:
    """Parse semver string to (major, minor, patch) tuple.

    Strips any pre-release suffix (-alpha, -beta.1, etc.) and build metadata
    (+build) before parsing. Pre-release ordering deferred — pre-release tags
    parse but compare as equal to release version.

    Raises:
        ValueError: if the version string is not parseable as semver.
    """
    # Strip build metadata first
    v = v.split('+', 1)[0]
    # Strip pre-release suffix
    v = v.split('-', 1)[0]
    parts = v.split('.')
    if len(parts) != 3:
        raise ValueError(f"version '{v}' is not parseable as MAJOR.MINOR.PATCH")
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        raise ValueError(f"version '{v}' has non-integer component")


def _parse_range(r: str) -> Tuple[str, Tuple[int, int, int]]:
    """Parse a semver range string to (operator, (major, minor, patch)).

    operator ∈ {'^', '~', ''} where '' means exact match.

    Bare versions like '^1' or '^1.2' are zero-padded to '^1.0.0' / '^1.2.0'.

    Raises:
        ValueError: if the range string is not parseable.
    """
    r = r.strip()
    if r.startswith('^'):
        op = '^'
        rest = r[1:]
    elif r.startswith('~'):
        op = '~'
        rest = r[1:]
    else:
        op = ''
        rest = r

    # Strip pre-release from range base (pre-release ordering deferred)
    rest = rest.split('+', 1)[0]
    rest = rest.split('-', 1)[0]

    parts = rest.split('.')
    # Zero-pad missing minor and patch
    while len(parts) < 3:
        parts.append('0')

    try:
        base = (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        raise ValueError(f"range '{r}' has non-integer version component")

    return (op, base)


def _range_to_interval(
    op: str, base: Tuple[int, int, int]
) -> Tuple[Tuple[int, int, int], Tuple[int, int, int]]:
    """Convert (operator, base) to (lo_inclusive, hi_exclusive) half-open interval.

    Returns:
        (lo, hi) where lo is inclusive and hi is exclusive.
        hi is a sentinel (999, 0, 0) for "no upper bound" (should not occur
        given our subset, but defined defensively).
    """
    major, minor, patch = base
    if op == '^':
        lo = base
        if major > 0:
            hi = (major + 1, 0, 0)
        else:
            # npm-compatible zero-major: ^0.1.2 → >=0.1.2, <0.2.0
            hi = (0, minor + 1, 0)
    elif op == '~':
        lo = base
        hi = (major, minor + 1, 0)
    else:
        # exact: only the exact version satisfies the range
        lo = base
        hi = (major, minor, patch + 1)  # exclusive upper bound one patch above
    return (lo, hi)


def _range_contains(
    operator: str, base: Tuple[int, int, int], version: Tuple[int, int, int]
) -> bool:
    """Return True if version satisfies the range defined by (operator, base).

    Rules:
        ^ with base[0] > 0:  version >= base AND version < (base[0]+1, 0, 0)
        ^ with base[0] == 0: version >= base AND version < (0, base[1]+1, 0)
        ~:                   version >= base AND version < (base[0], base[1]+1, 0)
        (exact):             version == base
    """
    lo, hi = _range_to_interval(operator, base)
    return lo <= version < hi


def _ranges_overlap(
    op_a: str, base_a: Tuple[int, int, int],
    op_b: str, base_b: Tuple[int, int, int],
) -> bool:
    """Return True iff there exists any version satisfying BOTH ranges.

    Computed as: intervals [lo_a, hi_a) and [lo_b, hi_b) overlap iff
        lo_a < hi_b AND lo_b < hi_a
    """
    lo_a, hi_a = _range_to_interval(op_a, base_a)
    lo_b, hi_b = _range_to_interval(op_b, base_b)
    return lo_a < hi_b and lo_b < hi_a


# ── Topological sort (Kahn's algorithm) ──────────────────────────────────────

def _topo_sort(graph: Dict[str, List[str]]) -> Optional[List[str]]:
    """Kahn's algorithm topological sort with alphabetical tiebreak.

    Args:
        graph: {node: [dep_names_in_graph]} — only edges within the node set.

    Returns:
        Sorted list (deps first, dependents last), or None if cycle detected.
        Alphabetical tiebreak on the ready queue ensures determinism.
    """
    all_nodes = sorted(graph.keys())  # alphabetical base order
    in_degree: Dict[str, int] = {n: 0 for n in all_nodes}
    for node in all_nodes:
        for dep in graph[node]:
            if dep in in_degree:
                in_degree[node] += 1  # node depends on dep → dep must come first

    # Wait — in Kahn's algorithm, in_degree counts incoming edges in the
    # dependency direction (dep → dependent). Re-build correctly:
    # edge direction: dep → dependent (dep must install BEFORE dependent).
    in_degree = {n: 0 for n in all_nodes}
    for node in all_nodes:
        for dep in graph[node]:
            if dep in in_degree:
                # node has an incoming edge from dep's perspective: dep → node
                # so node's in_degree increases
                in_degree[node] += 1

    # Actually: in_degree[node] = number of deps node has (within the graph).
    # A node with in_degree 0 has no remaining prerequisites.
    ready = sorted([n for n in all_nodes if in_degree[n] == 0])
    result: List[str] = []

    while ready:
        # Pick alphabetically smallest ready node (deterministic tiebreak)
        node = ready.pop(0)
        result.append(node)
        # For every node that depends on this one, decrement its in_degree
        for dependent in all_nodes:
            if node in graph[dependent]:
                in_degree[dependent] -= 1
                if in_degree[dependent] == 0:
                    # Insert in sorted order for alphabetical tiebreak
                    import bisect
                    bisect.insort(ready, dependent)

    if len(result) != len(all_nodes):
        return None  # cycle detected
    return result


# ── Cycle detection (DFS with in-progress set) ────────────────────────────────

def _detect_cycle(graph: Dict[str, List[str]]) -> Optional[List[str]]:
    """DFS cycle detection. Returns first cycle found as list of node names, or None.

    Mirrors services/skill_schema.py::walk_depends_on DFS pattern.
    Returns the list of nodes forming the cycle (e.g. ["alpha", "beta", "alpha"]).
    """
    visited: set = set()
    in_progress: set = set()

    def dfs(node: str, path: List[str]) -> Optional[List[str]]:
        if node in in_progress:
            # Cycle found — extract the cycle path
            cycle_start = path.index(node)
            return path[cycle_start:] + [node]
        if node in visited:
            return None
        in_progress.add(node)
        path.append(node)
        for dep in sorted(graph.get(node, [])):  # sorted for determinism
            cycle = dfs(dep, path)
            if cycle is not None:
                return cycle
        path.pop()
        in_progress.discard(node)
        visited.add(node)
        return None

    for node in sorted(graph.keys()):  # sorted for determinism
        if node not in visited:
            cycle = dfs(node, [])
            if cycle is not None:
                return cycle
    return None


# ── resolve() — public entry-point ────────────────────────────────────────────

def resolve(manifests: list) -> dict:
    """Resolve a set of ModuleManifest instances into a ResolveResult dict.

    Pure function: no I/O, no global state. Identical input → identical output.
    Fails-closed via return-dict — never raises.

    Args:
        manifests: list of ModuleManifest instances (or any object with .name,
                   .version, .requires attributes). Empty list is valid.

    Returns:
        ResolveResult dict with schema_version "1.0":
            {
                "schema_version": SCHEMA_VERSION,
                "ok": bool,
                "install_order": list[str] | None,
                "conflicts": [...],
                "missing": [...],
                "cycle": list[str] | None,
            }
    """
    # ── Empty input fast-path ─────────────────────────────────────────────────
    if not manifests:
        return {
            "schema_version": SCHEMA_VERSION,
            "ok": True,
            "install_order": [],
            "conflicts": [],
            "missing": [],
            "cycle": None,
        }

    # ── Step a: Build by_name dict; detect duplicates ─────────────────────────
    by_name: Dict[str, object] = {}
    conflicts: List[dict] = []

    for m in manifests:
        name = m.name
        if name in by_name:
            # Duplicate module name → emit synthetic conflict
            conflicts.append({
                "module_a": name,
                "range_a": by_name[name].version,  # type: ignore
                "module_b": name,
                "range_b": m.version,
                "requested_module": "<duplicate>",
            })
        else:
            by_name[name] = m

    # ── Step b: Compute missing ────────────────────────────────────────────────
    missing_set: set = set()
    for m in manifests:
        for dep_name in (m.requires or {}).keys():
            if dep_name not in by_name:
                missing_set.add(dep_name)
    missing: List[str] = sorted(missing_set)

    # ── Step c: Compute conflicts from range incompatibilities ────────────────
    # Collect all (requester_name, dep_name, range_str) triples grouped by dep_name
    # Structure: {dep_name: [(requester_name, range_str), ...]}
    deps_map: Dict[str, List[Tuple[str, str]]] = {}
    for m in manifests:
        for dep_name, range_str in (m.requires or {}).items():
            deps_map.setdefault(dep_name, []).append((m.name, range_str))

    for dep_name, requesters in sorted(deps_map.items()):
        # Check pairwise range overlap for 2+ requesters of same dep
        if len(requesters) >= 2:
            for i in range(len(requesters)):
                for j in range(i + 1, len(requesters)):
                    req_a, range_a = requesters[i]
                    req_b, range_b = requesters[j]
                    try:
                        op_a, base_a = _parse_range(range_a)
                        op_b, base_b = _parse_range(range_b)
                        overlap = _ranges_overlap(op_a, base_a, op_b, base_b)
                    except ValueError:
                        overlap = False  # unparseable range → treat as non-overlapping

                    if not overlap:
                        # Alphabetical order for determinism
                        if req_a > req_b:
                            req_a, range_a, req_b, range_b = req_b, range_b, req_a, range_a
                        conflicts.append({
                            "module_a": req_a,
                            "range_a": range_a,
                            "module_b": req_b,
                            "range_b": range_b,
                            "requested_module": dep_name,
                        })

        # Also check: if dep_name is present in by_name, verify each requester's
        # range is satisfied by the actual version present
        if dep_name in by_name:
            actual_version_str = by_name[dep_name].version  # type: ignore
            try:
                actual_ver = _parse_version(actual_version_str)
            except ValueError:
                actual_ver = None

            if actual_ver is not None:
                for requester_name, range_str in requesters:
                    try:
                        op, base = _parse_range(range_str)
                        satisfied = _range_contains(op, base, actual_ver)
                    except ValueError:
                        satisfied = False

                    if not satisfied:
                        conflicts.append({
                            "module_a": requester_name,
                            "range_a": range_str,
                            "module_b": dep_name,
                            "range_b": f"={actual_version_str}",
                            "requested_module": dep_name,
                        })

    # ── Step d: Build dependency graph + detect cycle ─────────────────────────
    # Graph: {module_name: [dep_names that exist in by_name]}
    graph: Dict[str, List[str]] = {}
    for name, m in sorted(by_name.items()):
        graph[name] = [
            dep_name
            for dep_name in (m.requires or {}).keys()  # type: ignore
            if dep_name in by_name
        ]

    cycle = _detect_cycle(graph)

    # ── Step e: Compute install_order (only if clean) ─────────────────────────
    install_order: Optional[List[str]] = None
    if not conflicts and not missing and cycle is None:
        install_order = _topo_sort(graph)
        if install_order is None:
            # Should not happen (cycle already detected above), but be safe
            cycle = ["<cycle-detected-by-topo>"]

    # ── Step f: ok ────────────────────────────────────────────────────────────
    ok = (not conflicts) and (not missing) and (cycle is None)

    # ── Step g: Return ResolveResult ──────────────────────────────────────────
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": ok,
        "install_order": install_order,
        "conflicts": conflicts,
        "missing": sorted(set(missing)),
        "cycle": cycle,
    }
