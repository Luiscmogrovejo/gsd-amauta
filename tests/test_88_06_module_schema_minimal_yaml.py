#!/usr/bin/env python3
"""tests/test_88_06_module_schema_minimal_yaml.py -- plan 88-06

Regression for services/module_schema._parse_yaml_minimal, the fallback used when PyYAML is not installed.

It stored an indented block mapping (``services:\\n  name: {}``) as ``[]``. With pydantic present that failed
validation ("Input should be a valid dictionary"), which is how the GitHub macOS runner (python3 + pydantic, no
PyYAML) failed module-validate / module-lifecycle tests.

Run: pytest tests/test_88_06_module_schema_minimal_yaml.py -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

import module_schema  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "modules")


def test_block_mapping_with_empty_value_parses_to_a_dict():
    """`services:` followed by an indented `name: {}` is a mapping, not an empty list."""
    text = "name: demo\nservices:\n  test-service: {}\nagents:\n  - agents/a.md\n"
    parsed = module_schema._parse_yaml_minimal(text)
    assert parsed["services"] == {"test-service": {}}
    assert parsed["agents"] == ["agents/a.md"]


def test_nested_block_mapping_with_scalar_values():
    """Two levels (`services: / worker: / image: x`) and `requires: / core: ^1.0.0` both parse."""
    text = (
        "requires:\n  core: ^1.0.0\n"
        "services:\n  feature-worker:\n    image: ghcr.io/example/feature:0.1.0\n"
        "agents: []\n"
    )
    parsed = module_schema._parse_yaml_minimal(text)
    assert parsed["requires"] == {"core": "^1.0.0"}
    assert parsed["services"] == {"feature-worker": {"image": "ghcr.io/example/feature:0.1.0"}}
    assert parsed["agents"] == []


def test_key_with_nothing_after_it_is_still_an_empty_list():
    """Unchanged behaviour: a bare key followed by another top-level key is an empty list."""
    parsed = module_schema._parse_yaml_minimal("migrations:\nservices: {}\n")
    assert parsed["migrations"] == []
    assert parsed["services"] == {}


def test_fixtures_load_through_the_fallback_parser(monkeypatch):
    """Every module fixture validates when PyYAML is unavailable (the macOS runner's situation)."""
    monkeypatch.setattr(module_schema, "_HAS_YAML", False)
    for name in sorted(os.listdir(FIXTURES)):
        path = os.path.join(FIXTURES, name, "module.yaml")
        manifest = module_schema.load_module_manifest(path)
        assert manifest.name, name
