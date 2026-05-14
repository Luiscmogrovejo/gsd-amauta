"""
tests/test_a2a_registry.py — Phase 55 A2A-02: a2a_registry programmatic API tests.

Verifies the capability registry without requiring a live PG connection.
Structural tests only (mirrors test_agent_schema.py pattern).
Never skips. No PG required.
"""

import json
import os
import subprocess
import sys
import unittest

_REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.a2a_registry import (
    get_capabilities,
    list_agents,
    all_capabilities,
    AgentNotFoundError,
    RegistryError,
    SCHEMA_VERSION,
)

# Known 17-agent roster (Phase 52 COMPILE-01 SC1 agent list)
KNOWN_AGENTS_17 = frozenset([
    "gsd-architect", "gsd-checker", "gsd-debugger",
    "gsd-executor-backend", "gsd-executor-data", "gsd-executor-frontend",
    "gsd-executor-general", "gsd-executor-infra", "gsd-operator",
    "gsd-planner", "gsd-qa", "gsd-researcher", "gsd-reviewer",
    "gsd-roadmapper", "gsd-security", "gsd-tester", "gsd-validator",
])

A2A_REGISTRY_CLI = os.path.join(_REPO_ROOT, "services", "a2a_registry_cli.py")


class TestSchemaVersion(unittest.TestCase):
    def test_schema_version_is_1_0(self):
        """SCHEMA_VERSION is locked to '1.0' for Phase 55."""
        self.assertEqual(SCHEMA_VERSION, "1.0")


class TestListAgents(unittest.TestCase):
    def test_list_agents_returns_exactly_17(self):
        """list_agents() returns exactly 17 compiled AGENT.yaml entries."""
        agents = list_agents()
        self.assertEqual(len(agents), 17,
            f"Expected 17 agents (Phase 52 roster), got {len(agents)}: {sorted(agents)}")

    def test_list_agents_returns_sorted_list(self):
        """list_agents() returns alphabetically sorted list."""
        agents = list_agents()
        self.assertEqual(agents, sorted(agents))

    def test_list_agents_contains_known_roster(self):
        """list_agents() includes all 17 known Phase 52 agents."""
        agents = set(list_agents())
        missing = KNOWN_AGENTS_17 - agents
        self.assertEqual(missing, set(), f"Missing agents from registry: {missing}")


class TestGetCapabilities(unittest.TestCase):
    def test_gsd_reviewer_has_empty_capabilities_at_baseline(self):
        """gsd-reviewer has no capabilities declared at Phase 55 baseline — returns []."""
        caps = get_capabilities("gsd-reviewer")
        self.assertIsInstance(caps, list)
        # At Phase 55 baseline, all agents have empty capabilities (backfill is Phase 56+)
        self.assertEqual(caps, [],
            "At Phase 55 baseline, gsd-reviewer capabilities should be [] (not yet backfilled)")

    def test_unknown_agent_raises_agent_not_found(self):
        """get_capabilities() raises AgentNotFoundError for unknown agent name."""
        with self.assertRaises(AgentNotFoundError):
            get_capabilities("nonexistent-agent-xyzzy")

    def test_all_known_agents_return_list(self):
        """get_capabilities() returns a list for every known Phase 52 agent."""
        for name in KNOWN_AGENTS_17:
            caps = get_capabilities(name)
            self.assertIsInstance(caps, list,
                f"get_capabilities('{name}') must return list, got {type(caps)}")


class TestAllCapabilities(unittest.TestCase):
    def test_all_capabilities_returns_17_entries(self):
        """all_capabilities() returns a dict with exactly 17 entries."""
        all_caps = all_capabilities()
        self.assertEqual(len(all_caps), 17,
            f"Expected 17 agents in all_capabilities(), got {len(all_caps)}")

    def test_all_capabilities_values_are_lists(self):
        """all_capabilities() values are all lists."""
        for name, caps in all_capabilities().items():
            self.assertIsInstance(caps, list, f"all_capabilities['{name}'] must be list")


class TestRegistryCLI(unittest.TestCase):
    """Round-trip CLI tests via subprocess."""

    def _run_cli(self, *args):
        result = subprocess.run(
            [sys.executable, A2A_REGISTRY_CLI, *args],
            capture_output=True, text=True,
            cwd=_REPO_ROOT,
        )
        return result

    def test_capabilities_json_roundtrip(self):
        """CLI capabilities --json returns valid JSON with agent + capabilities keys."""
        result = self._run_cli("capabilities", "gsd-reviewer", "--json")
        self.assertEqual(result.returncode, 0, f"CLI failed: {result.stderr}")
        data = json.loads(result.stdout)
        self.assertIn("agent", data)
        self.assertIn("capabilities", data)
        self.assertEqual(data["agent"], "gsd-reviewer")
        self.assertIsInstance(data["capabilities"], list)

    def test_capabilities_unknown_agent_exits_1(self):
        """CLI capabilities for unknown agent exits 1."""
        result = self._run_cli("capabilities", "nonexistent-agent-xyzzy", "--json")
        self.assertEqual(result.returncode, 1)
        data = json.loads(result.stdout)
        self.assertIn("error", data)

    def test_list_json_roundtrip(self):
        """CLI list --json returns valid JSON with 'agents' list of 17."""
        result = self._run_cli("list", "--json")
        self.assertEqual(result.returncode, 0, f"CLI failed: {result.stderr}")
        data = json.loads(result.stdout)
        self.assertIn("agents", data)
        self.assertEqual(len(data["agents"]), 17)


if __name__ == "__main__":
    unittest.main()
