#!/usr/bin/env python3
"""tests/test_module_resolver.py — Phase 48 MOD-02

Tests for services/module_resolver.py: semver subset operators (caret, tilde, exact,
caret-zero-major), conflict detection, missing dependency detection, cycle detection,
deterministic install_order, and ResolveResult shape assertions.

Includes committed-fixture conflict test so Phase 49 + downstream phases inherit
a stable on-disk conflict scenario (tests/fixtures/modules/core-1.2.0/module.yaml +
tests/fixtures/modules/feature-wants-core-v2/module.yaml).

Run: pytest tests/test_module_resolver.py -q --no-header

Tests:
    1.  test_empty_input_returns_ok
    2.  test_two_module_satisfiable_fixture_resolves
    3.  test_committed_conflict_fixture_pair_surfaces_conflict
    4.  test_two_module_conflict_when_core_pinned_to_2
    5.  test_missing_dep_reported
    6.  test_cycle_detected_and_install_order_none
    7.  test_install_order_deterministic_alphabetical
    8.  test_semver_caret_range
    9.  test_semver_caret_zero_major
    10. test_semver_tilde_range
    11. test_semver_exact_range
    12. test_resolve_is_deterministic
    13. test_schema_version_present
"""

import json
import os
import sys

import pytest

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from services.module_resolver import (
    resolve,
    SCHEMA_VERSION,
    _parse_range,
    _range_contains,
    _range_to_interval,
    _ranges_overlap,
)
from services.module_schema import ModuleManifest, load_module_manifest

# ── Fixture paths ─────────────────────────────────────────────────────────────
_CORE_FIXTURE = os.path.join(_ROOT, "tests/fixtures/modules/core-1.2.0/module.yaml")
_FEATURE_FIXTURE = os.path.join(_ROOT, "tests/fixtures/modules/feature-requires-core/module.yaml")
_CONFLICT_FIXTURE = os.path.join(_ROOT, "tests/fixtures/modules/feature-wants-core-v2/module.yaml")


# ── Helper: build minimal ModuleManifest programmatically ────────────────────
def _mk(name: str, version: str = "1.0.0", requires: dict = None, migrations: list = None) -> ModuleManifest:
    """Build a minimal ModuleManifest instance for unit tests.

    Uses migrations=["dummy.sql"] by default so the "must ship something" rule passes.
    """
    if requires is None:
        requires = {}
    if migrations is None:
        migrations = ["dummy.sql"]

    return ModuleManifest(
        name=name,
        version=version,
        description=f"Test module {name}",
        requires=requires,
        migrations=migrations,
        services={},
        agents=[],
        skills=[],
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Empty input
# ─────────────────────────────────────────────────────────────────────────────

def test_empty_input_returns_ok():
    """resolve([]) returns a valid ok=True result with empty collections."""
    r = resolve([])
    assert r["schema_version"] == "1.0"
    assert r["ok"] is True
    assert r["install_order"] == []
    assert r["conflicts"] == []
    assert r["missing"] == []
    assert r["cycle"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 2. Satisfiable two-module fixture pair
# ─────────────────────────────────────────────────────────────────────────────

def test_two_module_satisfiable_fixture_resolves():
    """Core-1.2.0 + feature-requires-core (^1.0.0) resolve cleanly.

    Expected install_order: ["core", "feature-requires-core"] (dependency first,
    then dependent — alphabetical tiebreak on ready set).
    """
    core = load_module_manifest(_CORE_FIXTURE)
    feature = load_module_manifest(_FEATURE_FIXTURE)
    r = resolve([core, feature])

    assert r["ok"] is True
    assert r["install_order"] == ["core", "feature-requires-core"]
    assert r["conflicts"] == []
    assert r["missing"] == []
    assert r["cycle"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 3. Committed conflict fixture pair (Phase 49 stable reference)
# ─────────────────────────────────────────────────────────────────────────────

def test_committed_conflict_fixture_pair_surfaces_conflict():
    """core-1.2.0 + feature-wants-core-v2 (^2.0.0) — load from disk, resolve, conflict.

    This test exercises the committed on-disk conflict fixture so Phase 49 +
    downstream phases inherit a stable deterministic conflict scenario without
    constructing manifests at runtime.
    """
    core = load_module_manifest(_CORE_FIXTURE)
    feature_v2 = load_module_manifest(_CONFLICT_FIXTURE)
    r = resolve([core, feature_v2])

    assert r["ok"] is False
    assert len(r["conflicts"]) >= 1
    assert r["install_order"] is None

    # At least one conflict must reference "core" as the requested module
    requested_modules = {c["requested_module"] for c in r["conflicts"]}
    assert "core" in requested_modules


# ─────────────────────────────────────────────────────────────────────────────
# 4. Conflict when core pinned to 2.0.0 vs feature requiring ^1.0.0
# ─────────────────────────────────────────────────────────────────────────────

def test_two_module_conflict_when_core_pinned_to_2():
    """core at 2.0.0 + feature requiring core@^1.0.0 → conflict report."""
    core_v2 = _mk("core", version="2.0.0")
    feature = _mk("feature", version="0.1.0", requires={"core": "^1.0.0"})
    r = resolve([core_v2, feature])

    assert r["ok"] is False
    assert len(r["conflicts"]) >= 1
    assert r["install_order"] is None

    # Conflict must reference "core" as the requested module
    conflict = r["conflicts"][0]
    assert conflict["requested_module"] == "core"

    # One range must be ^1.0.0 (the requester's range)
    ranges = {conflict["range_a"], conflict["range_b"]}
    assert "^1.0.0" in ranges or any("1.0.0" in rng for rng in ranges)

    # module_a and module_b identify the requester names
    participants = {conflict["module_a"], conflict["module_b"]}
    assert "feature" in participants or "core" in participants


# ─────────────────────────────────────────────────────────────────────────────
# 5. Missing dependency reported
# ─────────────────────────────────────────────────────────────────────────────

def test_missing_dep_reported():
    """A feature requiring 'core' when only feature is in the set → missing=["core"]."""
    feature = _mk("feature", requires={"core": "^1.0.0"})
    r = resolve([feature])

    assert r["ok"] is False
    assert r["missing"] == ["core"]
    assert r["conflicts"] == []
    assert r["cycle"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 6. Cycle detection
# ─────────────────────────────────────────────────────────────────────────────

def test_cycle_detected_and_install_order_none():
    """A -> B -> A cycle: ok=False, cycle is non-None, install_order is None."""
    a = _mk("alpha", requires={"beta": "^1.0.0"})
    b = _mk("beta", requires={"alpha": "^1.0.0"})
    r = resolve([a, b])

    assert r["ok"] is False
    assert r["cycle"] is not None
    assert set(r["cycle"]) >= {"alpha", "beta"}
    assert r["install_order"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 7. Deterministic alphabetical install order for independent modules
# ─────────────────────────────────────────────────────────────────────────────

def test_install_order_deterministic_alphabetical():
    """Three independent modules (no deps) → alphabetical install order."""
    r = resolve([_mk("zebra"), _mk("alpha"), _mk("middle")])

    assert r["ok"] is True
    assert r["install_order"] == ["alpha", "middle", "zebra"]


# ─────────────────────────────────────────────────────────────────────────────
# 8. Semver caret range (^)
# ─────────────────────────────────────────────────────────────────────────────

def test_semver_caret_range():
    """Caret operator: ^1.2.3 covers >=1.2.3, <2.0.0."""
    # Within range
    assert _range_contains("^", (1, 2, 3), (1, 5, 0)) is True
    # Upper boundary: exactly 2.0.0 is excluded
    assert _range_contains("^", (1, 2, 3), (2, 0, 0)) is False
    # Lower boundary: 1.2.2 is below base
    assert _range_contains("^", (1, 2, 3), (1, 2, 2)) is False
    # Exact base satisfies
    assert _range_contains("^", (1, 2, 3), (1, 2, 3)) is True


# ─────────────────────────────────────────────────────────────────────────────
# 9. Semver caret zero-major (npm-compatible)
# ─────────────────────────────────────────────────────────────────────────────

def test_semver_caret_zero_major():
    """Caret zero-major: ^0.1.2 covers >=0.1.2, <0.2.0 (npm-compatible)."""
    # Within range
    assert _range_contains("^", (0, 1, 2), (0, 1, 5)) is True
    # Upper boundary: 0.2.0 excluded
    assert _range_contains("^", (0, 1, 2), (0, 2, 0)) is False
    # Exact base satisfies
    assert _range_contains("^", (0, 1, 2), (0, 1, 2)) is True
    # Lower bound: 0.1.1 is below base
    assert _range_contains("^", (0, 1, 2), (0, 1, 1)) is False


# ─────────────────────────────────────────────────────────────────────────────
# 10. Semver tilde range (~)
# ─────────────────────────────────────────────────────────────────────────────

def test_semver_tilde_range():
    """Tilde operator: ~1.2.3 covers >=1.2.3, <1.3.0."""
    # Within range
    assert _range_contains("~", (1, 2, 3), (1, 2, 9)) is True
    # Upper boundary: 1.3.0 excluded
    assert _range_contains("~", (1, 2, 3), (1, 3, 0)) is False
    # Exact base satisfies
    assert _range_contains("~", (1, 2, 3), (1, 2, 3)) is True
    # Below base: 1.2.2 excluded
    assert _range_contains("~", (1, 2, 3), (1, 2, 2)) is False


# ─────────────────────────────────────────────────────────────────────────────
# 11. Semver exact range
# ─────────────────────────────────────────────────────────────────────────────

def test_semver_exact_range():
    """Empty operator (exact): only the exact version satisfies."""
    assert _range_contains("", (1, 2, 3), (1, 2, 3)) is True
    assert _range_contains("", (1, 2, 3), (1, 2, 4)) is False
    assert _range_contains("", (1, 2, 3), (1, 2, 2)) is False
    assert _range_contains("", (1, 2, 3), (1, 3, 3)) is False


# ─────────────────────────────────────────────────────────────────────────────
# 12. Determinism: same input → identical JSON output
# ─────────────────────────────────────────────────────────────────────────────

def test_resolve_is_deterministic():
    """resolve() with the same inputs twice produces byte-identical JSON output."""
    manifests = [
        _mk("beta", requires={"gamma": "^1.0.0"}),
        _mk("alpha"),
        _mk("gamma"),
    ]
    r1 = resolve(manifests)
    r2 = resolve(manifests)

    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


# ─────────────────────────────────────────────────────────────────────────────
# 13. schema_version present in every result
# ─────────────────────────────────────────────────────────────────────────────

def test_schema_version_present():
    """Every resolve() return includes schema_version == "1.0"."""
    # Empty input
    r = resolve([])
    assert r["schema_version"] == SCHEMA_VERSION
    assert r["schema_version"] == "1.0"

    # Single module
    r2 = resolve([_mk("solo")])
    assert r2["schema_version"] == "1.0"

    # With conflict
    r3 = resolve([
        _mk("mod-a", requires={"dep": "^1.0.0"}),
        _mk("mod-b", requires={"dep": "^2.0.0"}),
    ])
    assert r3["schema_version"] == "1.0"
