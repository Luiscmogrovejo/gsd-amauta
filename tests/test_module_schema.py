#!/usr/bin/env python3
"""tests/test_module_schema.py — Phase 48 MOD-01

Tests for services/module_schema.py: ModuleManifest field-order regression lock,
valid/invalid manifest assertions, _HAS_PYDANTIC + _HAS_YAML import-safety smoke.

Run: pytest tests/test_module_schema.py -q --no-header

Tests:
    1. test_schema_field_order_locked        — SC4 regression lock
    2. test_schema_class_field_definitions   — Pydantic model_fields key order
    3. test_valid_manifest_accepts_core_fixture
    4. test_valid_manifest_accepts_feature_fixture
    5. test_invalid_name_rejected
    6. test_invalid_version_rejected
    7. test_self_dependency_rejected
    8. test_empty_module_rejected
    9. test_invalid_requires_range_rejected
    10. test_extra_field_rejected_when_pydantic
    11. test_pydantic_or_fallback_loadable
"""

import os
import sys

import pytest

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from services.module_schema import (
    ModuleManifest,
    SCHEMA_FIELD_ORDER,
    load_module_manifest,
    _HAS_PYDANTIC,
    _HAS_YAML,
)

# ── Fixture paths ─────────────────────────────────────────────────────────────
_CORE_FIXTURE = os.path.join(_ROOT, "tests/fixtures/modules/core-1.2.0/module.yaml")
_FEATURE_FIXTURE = os.path.join(_ROOT, "tests/fixtures/modules/feature-requires-core/module.yaml")

# ── Shared helper: minimal valid manifest kwargs ──────────────────────────────
def _minimal_kwargs(**overrides):
    """Return a dict of valid ModuleManifest kwargs (all 8 fields, no deps)."""
    base = {
        "name": "my-module",
        "version": "1.0.0",
        "description": "A valid test module",
        "requires": {},
        "migrations": ["migrations/001-init.sql"],
        "services": {},
        "agents": [],
        "skills": [],
    }
    base.update(overrides)
    return base


# ─────────────────────────────────────────────────────────────────────────────
# 1. Field-order regression lock (SC4)
# ─────────────────────────────────────────────────────────────────────────────

def test_schema_field_order_locked():
    """SC4: SCHEMA_FIELD_ORDER is the frozen 8-tuple in locked declaration order.

    If any new field is added or the order changes, this test fails the build.
    """
    expected = (
        "name", "version", "description", "requires",
        "migrations", "services", "agents", "skills"
    )
    assert SCHEMA_FIELD_ORDER == expected, (
        f"SCHEMA_FIELD_ORDER drift! Got {SCHEMA_FIELD_ORDER!r}, expected {expected!r}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 2. Pydantic model_fields key order
# ─────────────────────────────────────────────────────────────────────────────

def test_schema_class_field_definitions():
    """Pydantic model_fields keys match SCHEMA_FIELD_ORDER when pydantic is available."""
    if not _HAS_PYDANTIC:
        pytest.skip("pydantic not installed — fallback __init__ used; key-order introspection skipped")

    assert list(ModuleManifest.model_fields.keys()) == list(SCHEMA_FIELD_ORDER), (
        f"ModuleManifest.model_fields key order {list(ModuleManifest.model_fields.keys())!r} "
        f"does not match SCHEMA_FIELD_ORDER {list(SCHEMA_FIELD_ORDER)!r}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Valid manifest: core fixture
# ─────────────────────────────────────────────────────────────────────────────

def test_valid_manifest_accepts_core_fixture():
    """load_module_manifest accepts the committed core-1.2.0 fixture."""
    m = load_module_manifest(_CORE_FIXTURE)
    assert m.name == "core"
    assert m.version == "1.2.0"
    assert m.requires == {}
    assert m.migrations == ["migrations/000-fixture-core-init.sql"]


# ─────────────────────────────────────────────────────────────────────────────
# 4. Valid manifest: feature fixture
# ─────────────────────────────────────────────────────────────────────────────

def test_valid_manifest_accepts_feature_fixture():
    """load_module_manifest accepts the committed feature-requires-core fixture."""
    m = load_module_manifest(_FEATURE_FIXTURE)
    assert m.name == "feature-requires-core"
    assert m.requires == {"core": "^1.0.0"}
    assert "feature-worker" in m.services


# ─────────────────────────────────────────────────────────────────────────────
# 5. Invalid name rejected
# ─────────────────────────────────────────────────────────────────────────────

def test_invalid_name_rejected():
    """Uppercase + underscore name fails kebab-case regex validation."""
    kwargs = _minimal_kwargs(name="Bad_Name")
    with pytest.raises(Exception):
        ModuleManifest(**kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# 6. Invalid version rejected
# ─────────────────────────────────────────────────────────────────────────────

def test_invalid_version_rejected():
    """Version string '1.2' (missing patch) fails semver validation."""
    kwargs = _minimal_kwargs(version="1.2")
    with pytest.raises(Exception):
        ModuleManifest(**kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# 7. Self-dependency rejected
# ─────────────────────────────────────────────────────────────────────────────

def test_self_dependency_rejected():
    """A module that requires itself (self-dependency) is rejected."""
    kwargs = _minimal_kwargs(
        name="core",
        requires={"core": "^1.0.0"},
    )
    with pytest.raises(Exception):
        ModuleManifest(**kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# 8. Empty module rejected (at-least-one-ships rule)
# ─────────────────────────────────────────────────────────────────────────────

def test_empty_module_rejected():
    """A module with all of migrations/services/agents/skills empty is rejected."""
    kwargs = _minimal_kwargs(
        migrations=[],
        services={},
        agents=[],
        skills=[],
    )
    with pytest.raises(Exception) as exc_info:
        ModuleManifest(**kwargs)
    # Error message must mention "at least one of"
    assert "at least one of" in str(exc_info.value).lower()


# ─────────────────────────────────────────────────────────────────────────────
# 9. Invalid requires range rejected
# ─────────────────────────────────────────────────────────────────────────────

def test_invalid_requires_range_rejected():
    """A requires entry with an unparseable range string is rejected."""
    kwargs = _minimal_kwargs(
        requires={"other-mod": "not-a-range"},
    )
    with pytest.raises(Exception):
        ModuleManifest(**kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# 10. Extra field rejected when pydantic (extra="forbid")
# ─────────────────────────────────────────────────────────────────────────────

def test_extra_field_rejected_when_pydantic():
    """When pydantic is available (extra='forbid'), unknown fields raise validation error."""
    if not _HAS_PYDANTIC:
        pytest.skip("pydantic not installed — extra-field check skipped for fallback __init__")

    kwargs = _minimal_kwargs(unknown_field="x")
    with pytest.raises(Exception):
        ModuleManifest(**kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# 11. Import smoke: module importable regardless of pydantic/yaml presence
# ─────────────────────────────────────────────────────────────────────────────

def test_pydantic_or_fallback_loadable():
    """Importing services.module_schema does not crash and exports the required names."""
    # If we got here without ImportError, the import succeeded.
    # Assert all three key names are importable.
    assert ModuleManifest is not None
    assert load_module_manifest is not None
    assert SCHEMA_FIELD_ORDER is not None
    # SCHEMA_FIELD_ORDER must be a tuple of 8 strings
    assert isinstance(SCHEMA_FIELD_ORDER, tuple)
    assert len(SCHEMA_FIELD_ORDER) == 8
