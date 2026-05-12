#!/usr/bin/env python3
"""Tests for services/skill_schema.py — Phase 43 SKILL-01 / SKILL-03.

Tests SkillFrontmatter Pydantic model, walk_depends_on, CycleError,
parse_depends_on_entry, and load_skill_frontmatter.

Pure-function tests — no PG or daemon dependency.

Run:
    python3 tests/test_skill_schema.py
    pytest tests/test_skill_schema.py -v
"""

import os
import sys
import unittest

# Ensure services/ is on path for direct import
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, 'services'))

from skill_schema import (
    SkillFrontmatter,
    CycleError,
    walk_depends_on,
    parse_depends_on_entry,
    load_skill_frontmatter,
    _HAS_PYDANTIC,
)


class TestSkillSchema(unittest.TestCase):

    def test_module_imports(self):
        """All public symbols importable from skill_schema."""
        self.assertTrue(callable(parse_depends_on_entry))
        self.assertTrue(callable(walk_depends_on))
        self.assertTrue(callable(load_skill_frontmatter))
        self.assertTrue(issubclass(CycleError, Exception))
        # SkillFrontmatter is a class (either Pydantic model or plain class)
        self.assertTrue(isinstance(SkillFrontmatter, type))

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available — skip Pydantic model test")
    def test_valid_frontmatter(self):
        """Instantiate SkillFrontmatter with canonical plan-phase values."""
        m = SkillFrontmatter(**{
            'name': 'plan-phase',
            'description': 'Convert phase CONTEXT.md into PLAN.md files with Wave-grouped tasks.',
            'category': 'workflow',
            'version': '1.0.0',
            'security_class': 'read-write',
            'allowed-tools': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
            'depends_on': [],
        })
        self.assertEqual(m.name, 'plan-phase')
        self.assertEqual(m.version, '1.0.0')
        self.assertEqual(m.security_class, 'read-write')

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available — skip alias test")
    def test_alias_allowed_tools(self):
        """allowed-tools alias maps to allowed_tools attribute."""
        m = SkillFrontmatter(**{
            'name': 'plan-phase',
            'description': 'Convert phase CONTEXT.md into PLAN.md files with Wave-grouped tasks.',
            'category': 'workflow',
            'version': '1.0.0',
            'security_class': 'read-only',
            'allowed-tools': ['Read'],
            'depends_on': [],
        })
        self.assertEqual(m.allowed_tools, ['Read'])

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available — skip validation test")
    def test_invalid_security_class(self):
        """Invalid security_class raises validation error."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            SkillFrontmatter(**{
                'name': 'plan-phase',
                'description': 'Convert phase CONTEXT.md into PLAN.md files with Wave-grouped tasks.',
                'category': 'workflow',
                'version': '1.0.0',
                'security_class': 'super-admin',
                'allowed-tools': ['Read'],
                'depends_on': [],
            })

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available — skip name validation test")
    def test_invalid_name_uppercase(self):
        """name='BadName' (uppercase) raises validation error."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            SkillFrontmatter(**{
                'name': 'BadName',
                'description': 'Convert phase CONTEXT.md into PLAN.md files with Wave-grouped tasks.',
                'category': 'workflow',
                'version': '1.0.0',
                'security_class': 'read-only',
                'allowed-tools': ['Read'],
                'depends_on': [],
            })

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available — skip version validation test")
    def test_invalid_version_non_semver(self):
        """version='1.0' (2-part) raises validation error."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            SkillFrontmatter(**{
                'name': 'plan-phase',
                'description': 'Convert phase CONTEXT.md into PLAN.md files with Wave-grouped tasks.',
                'category': 'workflow',
                'version': '1.0',
                'security_class': 'read-only',
                'allowed-tools': ['Read'],
                'depends_on': [],
            })

    def test_parse_depends_on_with_pin(self):
        """parse_depends_on_entry splits pinned entry correctly."""
        result = parse_depends_on_entry('plan-phase@1.0.0')
        self.assertEqual(result, ('plan-phase', '1.0.0'))

    def test_parse_depends_on_no_pin(self):
        """parse_depends_on_entry returns None pin when absent."""
        result = parse_depends_on_entry('plan-phase')
        self.assertEqual(result, ('plan-phase', None))

    def test_walk_depends_on_topological(self):
        """walk_depends_on returns valid topological order."""
        result = walk_depends_on({'a': ['b'], 'b': ['c'], 'c': []})
        self.assertIn('a', result)
        self.assertIn('b', result)
        self.assertIn('c', result)
        # c must appear before b, b before a
        self.assertLess(result.index('c'), result.index('b'))
        self.assertLess(result.index('b'), result.index('a'))

    def test_walk_depends_on_cycle_raises(self):
        """walk_depends_on raises CycleError on cycle, with cycle in .cycle."""
        with self.assertRaises(CycleError) as ctx:
            walk_depends_on({'a': ['b'], 'b': ['a']})
        self.assertIsInstance(ctx.exception.cycle, list)
        names = ctx.exception.cycle
        self.assertIn('a', names)
        self.assertIn('b', names)

    def test_load_skill_frontmatter_plan_phase(self):
        """load_skill_frontmatter reads plan-phase SKILL.md correctly."""
        skill_path = os.path.join(_ROOT, 'get-shit-done', 'skills', 'plan-phase', 'SKILL.md')
        m = load_skill_frontmatter(skill_path)
        self.assertEqual(m.name, 'plan-phase')

    def test_load_skill_frontmatter_execute_depends(self):
        """load_skill_frontmatter reads execute-phase depends_on correctly."""
        skill_path = os.path.join(_ROOT, 'get-shit-done', 'skills', 'execute-phase', 'SKILL.md')
        m = load_skill_frontmatter(skill_path)
        self.assertIn('plan-phase@1.0.0', m.depends_on)


if __name__ == '__main__':
    unittest.main()
