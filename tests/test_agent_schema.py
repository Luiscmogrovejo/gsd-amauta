#!/usr/bin/env python3
"""tests/test_agent_schema.py — Phase 52 COMPILE-01

Tests for services/agent_schema.py: AgentDefinition Pydantic model
validation, SECTION_KEY_ORDER tuple regression lock, body_preamble
null/non-null handling, and load_agent_definition round-trip.

Run: pytest tests/test_agent_schema.py -v
 or: python3 -m unittest tests.test_agent_schema -v

Tests:
    1.  test_section_key_order_frozen          — tuple equality + immutability
    2.  test_valid_definition                  — construct with all 10 sections
    3.  test_name_validation                   — invalid uppercase rejected
    4.  test_color_validation                  — hyphen color rejected
    5.  test_memory_enum                       — unknown memory value rejected
    6.  test_tools_non_empty                   — empty tools rejected
    7.  test_sections_missing_key              — missing section key raises ValueError
    8.  test_sections_extra_key                — extra section key raises ValueError
    9.  test_load_agent_definition_from_yaml_str — round-trip via temp YAML file
    10. test_pydantic_extra_forbidden          — unknown frontmatter field rejected

Phase 60 TOOL-02 (schema-side declaration hook):
    11. test_capability_grants_default_empty          — defaults to [] when absent
    12. test_capability_grants_roundtrip                — YAML round-trip via load_agent_definition
    13. test_capability_grants_appended_after_capabilities — LOCKED-order structural guard
"""

import os
import sys
import tempfile
import unittest

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from services.agent_schema import (
    AgentDefinition,
    SECTION_KEY_ORDER,
    load_agent_definition,
    _HAS_PYDANTIC,
    _HAS_YAML,
)

# ── Shared helpers ────────────────────────────────────────────────────────────

_ALL_10_SECTIONS = {k: f"Body text for {k}" for k in SECTION_KEY_ORDER}


def _minimal_kwargs(**overrides):
    """Return a dict of valid AgentDefinition kwargs with all 10 sections."""
    base = {
        "name": "gsd-test-agent",
        "description": "A valid test agent for unit testing purposes",
        "tools": ["Read", "Write"],
        "color": "blue",
        "memory": "user",
        "skills": [],
        "body_preamble": "# Agent: gsd-test-agent\n",
        "sections": dict(_ALL_10_SECTIONS),
    }
    base.update(overrides)
    return base


_MINIMAL_AGENT_YAML = """\
frontmatter:
  name: gsd-roundtrip
  description: "A round-trip test agent with valid frontmatter fields"
  tools:
    - Read
    - Write
    - Bash
  color: purple
  memory: project
  skills:
    - gsd-planner-workflow
  capability_grants:
    - amauta-postgres

body_preamble: |
  # Agent: gsd-roundtrip

sections:
  role_and_identity: "Role body text"
  domain_knowledge: "Domain body text"
  patterns_and_practices: "Patterns body text"
  workflow_and_process: "Workflow body text"
  tools_and_resources: "Tools body text"
  quality_gates: "Quality body text"
  output_format: "Output body text"
  error_handling: "Error body text"
  examples: "Examples body text"
  metadata: "version: 3.0.0"
"""


# ── Test cases ────────────────────────────────────────────────────────────────

class TestSectionKeyOrder(unittest.TestCase):
    """Regression-lock the SECTION_KEY_ORDER 10-key tuple."""

    def test_section_key_order_frozen(self):
        """SECTION_KEY_ORDER must be a tuple with exactly the 10 locked keys."""
        expected = (
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
        self.assertIsInstance(SECTION_KEY_ORDER, tuple, "SECTION_KEY_ORDER must be a tuple (immutable), not a list")
        self.assertEqual(len(SECTION_KEY_ORDER), 10, "SECTION_KEY_ORDER must have exactly 10 keys")
        self.assertEqual(SECTION_KEY_ORDER, expected, "SECTION_KEY_ORDER order is locked")


class TestAgentDefinitionValid(unittest.TestCase):
    """Positive validation tests for AgentDefinition."""

    def test_valid_definition(self):
        """Construct AgentDefinition with valid frontmatter + 10 sections; no exception."""
        kwargs = _minimal_kwargs()
        agent = AgentDefinition(**kwargs)
        self.assertEqual(agent.name, "gsd-test-agent")
        self.assertEqual(agent.color, "blue")
        self.assertEqual(agent.memory, "user")
        self.assertEqual(len(agent.sections), 10)

    def test_body_preamble_none_accepted(self):
        """body_preamble=None is a valid default (mirrors gsd-executor-data.md)."""
        kwargs = _minimal_kwargs(body_preamble=None)
        agent = AgentDefinition(**kwargs)
        self.assertIsNone(agent.body_preamble)


class TestAgentDefinitionNameValidation(unittest.TestCase):
    """name field validation."""

    def test_name_validation_uppercase_rejected(self):
        """Invalid name 'GSD-Planner' (uppercase) raises ValueError."""
        with self.assertRaises((ValueError, Exception)):
            AgentDefinition(**_minimal_kwargs(name="GSD-Planner"))

    def test_name_validation_valid(self):
        """Valid kebab-case name 'gsd-planner' succeeds."""
        agent = AgentDefinition(**_minimal_kwargs(name="gsd-planner"))
        self.assertEqual(agent.name, "gsd-planner")


class TestAgentDefinitionColorValidation(unittest.TestCase):
    """color field validation."""

    def test_color_validation_hyphen_rejected(self):
        """color 'neon-green' (hyphen breaks _COLOR_RE) raises ValueError."""
        with self.assertRaises((ValueError, Exception)):
            AgentDefinition(**_minimal_kwargs(color="neon-green"))

    def test_color_validation_valid(self):
        """Single lowercase color word 'green' succeeds."""
        agent = AgentDefinition(**_minimal_kwargs(color="green"))
        self.assertEqual(agent.color, "green")


class TestAgentDefinitionMemoryEnum(unittest.TestCase):
    """memory field validation."""

    def test_memory_enum_invalid_rejected(self):
        """memory 'shared' (not in {user, project, none}) raises ValueError."""
        with self.assertRaises((ValueError, Exception)):
            AgentDefinition(**_minimal_kwargs(memory="shared"))

    def test_memory_enum_user_valid(self):
        """memory='user' succeeds."""
        agent = AgentDefinition(**_minimal_kwargs(memory="user"))
        self.assertEqual(agent.memory, "user")

    def test_memory_enum_project_valid(self):
        """memory='project' succeeds."""
        agent = AgentDefinition(**_minimal_kwargs(memory="project"))
        self.assertEqual(agent.memory, "project")

    def test_memory_enum_none_valid(self):
        """memory='none' succeeds."""
        agent = AgentDefinition(**_minimal_kwargs(memory="none"))
        self.assertEqual(agent.memory, "none")


class TestAgentDefinitionToolsValidation(unittest.TestCase):
    """tools field validation."""

    def test_tools_non_empty(self):
        """Empty tools list raises ValueError."""
        with self.assertRaises((ValueError, Exception)):
            AgentDefinition(**_minimal_kwargs(tools=[]))


class TestAgentDefinitionSectionsValidation(unittest.TestCase):
    """sections field validation."""

    def test_sections_missing_key(self):
        """sections dict missing one of the 10 keys raises ValueError."""
        bad_sections = dict(_ALL_10_SECTIONS)
        del bad_sections['error_handling']
        with self.assertRaises((ValueError, Exception)) as ctx:
            AgentDefinition(**_minimal_kwargs(sections=bad_sections))
        # Error message must name the missing key
        err_str = str(ctx.exception)
        self.assertIn('error_handling', err_str, f"Expected 'error_handling' in error: {err_str}")

    def test_sections_extra_key(self):
        """sections dict with an 11th key raises ValueError naming the extra key."""
        bad_sections = dict(_ALL_10_SECTIONS)
        bad_sections['nonexistent_section'] = "Some extra content"
        with self.assertRaises((ValueError, Exception)) as ctx:
            AgentDefinition(**_minimal_kwargs(sections=bad_sections))
        err_str = str(ctx.exception)
        self.assertIn('nonexistent_section', err_str, f"Expected 'nonexistent_section' in error: {err_str}")


class TestLoadAgentDefinition(unittest.TestCase):
    """load_agent_definition round-trip via temp YAML file."""

    @unittest.skipUnless(_HAS_YAML, "requires pyyaml")
    def test_load_agent_definition_from_yaml_str(self):
        """Write temp YAML, load it, assert round-trip preserves all fields."""
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.yaml', delete=False, encoding='utf-8'
        ) as f:
            f.write(_MINIMAL_AGENT_YAML)
            tmp_path = f.name

        try:
            agent = load_agent_definition(tmp_path)
        finally:
            os.unlink(tmp_path)

        # Frontmatter round-trip
        self.assertEqual(agent.name, "gsd-roundtrip")
        self.assertEqual(agent.description, "A round-trip test agent with valid frontmatter fields")
        self.assertIn("Read", agent.tools)
        self.assertIn("Write", agent.tools)
        self.assertIn("Bash", agent.tools)
        self.assertEqual(agent.color, "purple")
        self.assertEqual(agent.memory, "project")
        self.assertIn("gsd-planner-workflow", agent.skills)

        # All 10 section bodies present
        self.assertEqual(set(agent.sections.keys()), set(SECTION_KEY_ORDER))
        self.assertIn("version: 3.0.0", agent.sections["metadata"])

        # body_preamble captured
        self.assertIsNotNone(agent.body_preamble)
        self.assertIn("gsd-roundtrip", agent.body_preamble)


class TestCapabilityGrants(unittest.TestCase):
    """Phase 60 TOOL-02: capability_grants is the 8th LOCKED optional field.

    Mirrors the Phase 55 `capabilities` precedent (see
    tests/test_agent_schema_capabilities.py). capability_grants is the
    agent-side declaration hook the audit command (Plan 60-03) reads as
    the union's second source.
    """

    def test_capability_grants_default_empty(self):
        """AgentDefinition without capability_grants kwarg defaults to []."""
        agent = AgentDefinition(**_minimal_kwargs())
        self.assertEqual(agent.capability_grants, [])

    @unittest.skipUnless(_HAS_YAML, "requires pyyaml")
    def test_capability_grants_roundtrip(self):
        """load_agent_definition round-trips capability_grants from YAML frontmatter."""
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.yaml', delete=False, encoding='utf-8'
        ) as f:
            f.write(_MINIMAL_AGENT_YAML)
            tmp_path = f.name

        try:
            agent = load_agent_definition(tmp_path)
        finally:
            os.unlink(tmp_path)

        self.assertIn("amauta-postgres", agent.capability_grants)

    def test_capability_grants_appended_after_capabilities(self):
        """Structural guard: capability_grants field is declared AFTER capabilities,
        never inserted mid-order (LOCKED-order risk per 60-RESEARCH.md pitfall #6)."""
        schema_path = os.path.join(_ROOT, "services", "agent_schema.py")
        with open(schema_path, "r", encoding="utf-8") as f:
            source = f.read()
        self.assertGreater(
            source.index("capability_grants: List[str]"),
            source.index("capabilities: List[str]"),
            "capability_grants must be declared after capabilities (never mid-order)",
        )


class TestPydanticExtraForbidden(unittest.TestCase):
    """When pydantic is available, extra=forbid rejects unknown fields."""

    @unittest.skipUnless(_HAS_PYDANTIC, "requires pydantic")
    def test_pydantic_extra_forbidden(self):
        """Constructing AgentDefinition with unknown field 'category' raises ValidationError."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            AgentDefinition(**_minimal_kwargs(), category="workflow")


if __name__ == '__main__':
    unittest.main(verbosity=2)
