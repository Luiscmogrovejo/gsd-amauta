#!/usr/bin/env python3
"""Tests for _inherit_parent_spec() in amauta.py (Plan 12-04-01).

Covers:
  1. task_inherits_from_parent_story -- basic parent chain, SC-ID assignment
  2. task_with_no_parent -- returns empty, no inherited_spec
  3. task_with_empty_criteria_parent -- walks past empty story to epic
  4. cap_at_10_criteria -- caps at 10, truncation message, truncated flag
  5. kill_switch_disables -- GSD_T_SPEC_INHERIT=false returns empty
  6. sc_id_assignment -- SC-01, SC-02, SC-03 assigned in order
  7. never_raises_on_bad_data -- nonexistent parent, empty items list
  8. metadata_caching -- idempotent after second call

Run: python3 -m pytest tests/test_phase12_inherit_spec.py -v
"""
import os
import sys
import unittest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import amauta


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_item(item_id, itype, title, parent=None, success_criteria=None):
    """Build a minimal item dict using _new_item for proper schema, then patch fields."""
    item = amauta._new_item(itype, title)
    item["id"] = item_id
    item["parent"] = parent
    if success_criteria is not None:
        item["success_criteria"] = success_criteria
    return item


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestInheritParentSpec(unittest.TestCase):

    def test_task_inherits_from_parent_story(self):
        """Task with parent story that has criteria inherits them."""
        story = _make_item(
            "ST-0001", "story", "My Story",
            parent=None,
            success_criteria=["Given A", "When B", "Then C"]
        )
        task = _make_item("TK-0001", "task", "My Task", parent="ST-0001")
        items = [story, task]

        result = amauta._inherit_parent_spec(task, items)

        self.assertNotEqual(result, "", "Expected non-empty block string")
        self.assertIn("[INHERITED SPEC from ST-0001", result)

        meta = task.get("metadata", {})
        inherited = meta.get("inherited_spec")
        self.assertIsNotNone(inherited, "metadata.inherited_spec should be set")
        self.assertEqual(inherited["source"], "ST-0001")

        criteria = inherited["criteria"]
        self.assertEqual(len(criteria), 3)
        self.assertEqual(criteria[0]["id"], "SC-01")

    def test_task_with_no_parent(self):
        """Task with parent=None returns empty string, no inherited_spec."""
        task = _make_item("TK-0002", "task", "No Parent Task", parent=None)
        items = [task]

        result = amauta._inherit_parent_spec(task, items)

        self.assertEqual(result, "")
        meta = task.get("metadata", {})
        self.assertIsNone(meta.get("inherited_spec"))

    def test_task_with_empty_criteria_parent(self):
        """Walks past story with empty criteria to epic with non-empty criteria."""
        epic = _make_item(
            "EP-0001", "epic", "My Epic",
            parent=None,
            success_criteria=["Epic criterion A"]
        )
        story = _make_item(
            "ST-0002", "story", "My Story",
            parent="EP-0001",
            success_criteria=[]  # empty -- should be skipped
        )
        task = _make_item("TK-0003", "task", "My Task", parent="ST-0002")
        items = [epic, story, task]

        result = amauta._inherit_parent_spec(task, items)

        self.assertNotEqual(result, "", "Expected non-empty block string after walking to epic")
        self.assertIn("[INHERITED SPEC from EP-0001", result)

    def test_cap_at_10_criteria(self):
        """Parent with 15 criteria gets capped at 10, truncation message appears."""
        story = _make_item(
            "ST-0003", "story", "Big Story",
            parent=None,
            success_criteria=[f"Criterion {i}" for i in range(1, 16)]  # 15 items
        )
        task = _make_item("TK-0004", "task", "Capped Task", parent="ST-0003")
        items = [story, task]

        result = amauta._inherit_parent_spec(task, items)

        self.assertNotEqual(result, "")
        meta = task.get("metadata", {})
        inherited = meta.get("inherited_spec")
        self.assertIsNotNone(inherited)
        self.assertEqual(len(inherited["criteria"]), 10)
        self.assertIn("5 criteria truncated", result)
        self.assertTrue(inherited["truncated"])

    def test_kill_switch_disables(self):
        """GSD_T_SPEC_INHERIT=false causes function to return empty string."""
        os.environ["GSD_T_SPEC_INHERIT"] = "false"
        try:
            story = _make_item(
                "ST-0004", "story", "KS Story",
                parent=None,
                success_criteria=["Given X", "When Y"]
            )
            task = _make_item("TK-0005", "task", "KS Task", parent="ST-0004")
            items = [story, task]

            result = amauta._inherit_parent_spec(task, items)

            self.assertEqual(result, "")
        finally:
            del os.environ["GSD_T_SPEC_INHERIT"]

    def test_sc_id_assignment(self):
        """Criteria get sequential SC-01, SC-02, SC-03 IDs."""
        story = _make_item(
            "ST-0005", "story", "ID Story",
            parent=None,
            success_criteria=["Alpha criterion", "Beta criterion", "Gamma criterion"]
        )
        task = _make_item("TK-0006", "task", "ID Task", parent="ST-0005")
        items = [story, task]

        amauta._inherit_parent_spec(task, items)

        meta = task.get("metadata", {})
        inherited = meta.get("inherited_spec")
        self.assertIsNotNone(inherited)
        criteria = inherited["criteria"]
        self.assertEqual(criteria[0]["id"], "SC-01")
        self.assertEqual(criteria[1]["id"], "SC-02")
        self.assertEqual(criteria[2]["id"], "SC-03")

    def test_never_raises_on_bad_data(self):
        """Nonexistent parent ID with empty items list returns empty string without raising."""
        task = _make_item("TK-0007", "task", "Bad Parent Task", parent="NONEXISTENT")
        items = []  # empty -- NONEXISTENT won't be found

        try:
            result = amauta._inherit_parent_spec(task, items)
        except Exception as exc:
            self.fail(f"_inherit_parent_spec raised unexpectedly: {exc}")

        self.assertEqual(result, "")

    def test_metadata_caching(self):
        """Calling _inherit_parent_spec twice is idempotent; result cached on item."""
        story = _make_item(
            "ST-0006", "story", "Cache Story",
            parent=None,
            success_criteria=["Cache criterion A", "Cache criterion B"]
        )
        task = _make_item("TK-0008", "task", "Cache Task", parent="ST-0006")
        items = [story, task]

        # First call
        result1 = amauta._inherit_parent_spec(task, items)
        self.assertNotEqual(result1, "")
        meta_after_first = task.get("metadata", {})
        self.assertIn("inherited_spec", meta_after_first)
        inherited_after_first = meta_after_first["inherited_spec"]

        # Second call -- should be idempotent
        result2 = amauta._inherit_parent_spec(task, items)
        self.assertEqual(result1, result2)
        meta_after_second = task.get("metadata", {})
        self.assertIn("inherited_spec", meta_after_second)
        # Source should remain consistent
        self.assertEqual(
            meta_after_second["inherited_spec"]["source"],
            inherited_after_first["source"]
        )


if __name__ == "__main__":
    unittest.main()
