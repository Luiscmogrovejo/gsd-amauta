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
import glob
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

# The roster changed in f1613b2 (first agents added after the 17 of 9224cbc) and in the
# commits after it, from 17 (Phase 52) to 35 agents. A literal count goes stale every time an
# agent is added (it did: the registry reports 35), so the expectation is derived from the
# source of truth, the agent definition files, and asserted as set equality. Same approach as
# plan 88-05 for the Node suite.
def _agent_files_on_disk():
    """Names of every agents/*.md definition file in the repository."""
    return {
        os.path.basename(p)[: -len(".md")]
        for p in glob.glob(os.path.join(_REPO_ROOT, "agents", "gsd-*.md"))
    }


A2A_REGISTRY_CLI = os.path.join(_REPO_ROOT, "services", "a2a_registry_cli.py")


class TestSchemaVersion(unittest.TestCase):
    def test_schema_version_is_1_0(self):
        """SCHEMA_VERSION is locked to '1.0' for Phase 55."""
        self.assertEqual(SCHEMA_VERSION, "1.0")


class TestListAgents(unittest.TestCase):
    def test_list_agents_returns_exactly_17(self):
        """list_agents() returns exactly one compiled AGENT.yaml per agents/*.md file.

        (Name kept for continuity: the roster was 17 in Phase 52 and is 35 now; see
        _agent_files_on_disk.)"""
        agents = list_agents()
        expected = _agent_files_on_disk()
        self.assertGreaterEqual(len(expected), 17)
        self.assertEqual(set(agents), expected,
            f"registry and agents/*.md disagree: only in registry "
            f"{sorted(set(agents) - expected)}, only on disk {sorted(expected - set(agents))}")
        self.assertEqual(len(agents), len(expected))

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
        """all_capabilities() returns one entry per agents/*.md file (17 in Phase 52, 35 now)."""
        all_caps = all_capabilities()
        expected = _agent_files_on_disk()
        self.assertEqual(set(all_caps), expected,
            f"all_capabilities() keys differ from agents/*.md: only in registry "
            f"{sorted(set(all_caps) - expected)}, only on disk {sorted(expected - set(all_caps))}")

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
            encoding="utf-8",
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
        """CLI list --json returns valid JSON with an 'agents' list matching agents/*.md."""
        result = self._run_cli("list", "--json")
        self.assertEqual(result.returncode, 0, f"CLI failed: {result.stderr}")
        data = json.loads(result.stdout)
        self.assertIn("agents", data)
        # Entries are {"agent": name, "capabilities": [...]} dicts.
        names = [entry["agent"] for entry in data["agents"]]
        self.assertEqual(set(names), _agent_files_on_disk())
        self.assertEqual(len(names), len(_agent_files_on_disk()))


if __name__ == "__main__":
    unittest.main()
