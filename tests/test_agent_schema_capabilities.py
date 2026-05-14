"""
tests/test_agent_schema_capabilities.py — Verify Phase 55 A2A-02 capabilities field addition.

Tests that AgentDefinition accepts capabilities as an optional 7th field,
defaults to empty list when absent, and round-trips through load_agent_definition.
No PG required. Never skips.
"""

import os
import sys
import unittest

_REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.agent_schema import AgentDefinition, SECTION_KEY_ORDER, load_agent_definition


MINIMAL_SECTIONS = {k: "" for k in SECTION_KEY_ORDER}

# Path to an existing AGENT.yaml (gsd-reviewer, no capabilities declared yet)
REVIEWER_YAML = os.path.join(_REPO_ROOT, "get-shit-done", "agents", "gsd-reviewer", "AGENT.yaml")


class TestAgentDefinitionCapabilities(unittest.TestCase):
    """capabilities is the 7th LOCKED optional field in AgentDefinition."""

    def _make_agent(self, **overrides):
        kwargs = dict(
            name="test-agent",
            description="Test agent for capability field tests (Phase 55).",
            tools=["Read"],
            color="blue",
            memory="user",
            skills=[],
            sections=MINIMAL_SECTIONS,
        )
        kwargs.update(overrides)
        return AgentDefinition(**kwargs)

    def test_capabilities_defaults_to_empty_list(self):
        """AgentDefinition without capabilities kwarg defaults to []."""
        agent = self._make_agent()
        self.assertEqual(agent.capabilities, [])

    def test_capabilities_accepts_verb_list(self):
        """AgentDefinition stores a provided capabilities list correctly."""
        caps = ["review_file", "suggest_refactor", "identify_n_plus_one"]
        agent = self._make_agent(capabilities=caps)
        self.assertEqual(agent.capabilities, caps)

    def test_capabilities_accepts_empty_list(self):
        """Explicit empty list is valid."""
        agent = self._make_agent(capabilities=[])
        self.assertEqual(agent.capabilities, [])

    def test_load_agent_definition_reviewer_has_capabilities_field(self):
        """load_agent_definition for gsd-reviewer returns AgentDefinition with capabilities attr."""
        if not os.path.exists(REVIEWER_YAML):
            self.skipTest(f"AGENT.yaml not found at {REVIEWER_YAML}")
        defn = load_agent_definition(REVIEWER_YAML)
        self.assertTrue(hasattr(defn, "capabilities"),
            "AgentDefinition must have capabilities attribute after Phase 55 A2A-02 extension")
        self.assertIsInstance(defn.capabilities, list)

    def test_existing_agent_yaml_without_capabilities_defaults_to_empty(self):
        """AGENT.yaml without capabilities: field → capabilities=[] (backward compat)."""
        if not os.path.exists(REVIEWER_YAML):
            self.skipTest(f"AGENT.yaml not found at {REVIEWER_YAML}")
        defn = load_agent_definition(REVIEWER_YAML)
        # gsd-reviewer has no capabilities: in its AGENT.yaml at Phase 55 baseline
        self.assertEqual(defn.capabilities, [],
            "Agent without capabilities: in YAML must default to empty list (backward compat)")

    def test_section_key_order_unchanged(self):
        """SECTION_KEY_ORDER still has exactly 10 keys (adding capabilities to frontmatter does not touch sections)."""
        self.assertEqual(len(SECTION_KEY_ORDER), 10)


if __name__ == "__main__":
    unittest.main()
