#!/usr/bin/env python3
"""Tests for Phase 53 POLISH-01 — SkillFrontmatter input_schema + output_schema fields.

Verifies:
  - input_schema / output_schema appended at positions 8+9 (plan AC)
  - Phase 43 7-field LOCKED order preserved at positions 1-7
  - _validate_json_schema helper rejects malformed schemas
  - Backward-compat: skills without these fields validate normally

Run:
    pytest tests/test_skill_input_output_schema.py -q
    python3 tests/test_skill_input_output_schema.py
"""

import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
sys.path.insert(0, os.path.join(_ROOT, 'services'))

from skill_schema import (
    SkillFrontmatter,
    _validate_json_schema,
    _HAS_PYDANTIC,
)

# ─── Shared helper: minimal valid SkillFrontmatter kwargs ─────────────────────

_VALID_KWARGS = {
    'name': 'test-skill',
    'description': 'A skill long enough to pass the 10-char minimum length.',
    'category': 'workflow',
    'version': '1.0.0',
    'security_class': 'read-only',
    'allowed-tools': ['Read'],
    'depends_on': [],
}


class TestSkillInputOutputSchemaFields(unittest.TestCase):
    """Phase 53 POLISH-01: input_schema + output_schema optional field tests."""

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_optional_fields_default_to_none(self):
        """SkillFrontmatter without input_schema/output_schema => both fields are None."""
        sf = SkillFrontmatter(**_VALID_KWARGS)
        self.assertIsNone(sf.input_schema)
        self.assertIsNone(sf.output_schema)

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_valid_input_schema_accepted(self):
        """input_schema with type=object and properties is accepted."""
        schema = {'type': 'object', 'properties': {'foo': {'type': 'string'}}}
        sf = SkillFrontmatter(**{**_VALID_KWARGS, 'input_schema': schema})
        self.assertEqual(sf.input_schema, schema)
        self.assertIsNone(sf.output_schema)

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_valid_output_schema_accepted(self):
        """output_schema with type=string is accepted."""
        schema = {'type': 'string'}
        sf = SkillFrontmatter(**{**_VALID_KWARGS, 'output_schema': schema})
        self.assertIsNone(sf.input_schema)
        self.assertEqual(sf.output_schema, schema)

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_malformed_input_schema_missing_type_rejected(self):
        """input_schema without 'type' field raises ValidationError mentioning 'type'."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            SkillFrontmatter(**{**_VALID_KWARGS, 'input_schema': {'properties': {'x': {}}}})
        err_str = str(ctx.exception)
        self.assertIn("type", err_str.lower())

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_malformed_input_schema_wrong_type_value_rejected(self):
        """input_schema with type='invalidtype' raises ValidationError mentioning 'must be one of'."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            SkillFrontmatter(**{**_VALID_KWARGS, 'input_schema': {'type': 'invalidtype'}})
        err_str = str(ctx.exception)
        self.assertIn("must be one of", err_str)

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_malformed_input_schema_not_dict_rejected(self):
        """input_schema=list raises ValidationError (Pydantic rejects non-dict for Optional[dict])."""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            SkillFrontmatter(**{**_VALID_KWARGS, 'input_schema': ["not", "a", "dict"]})
        err_str = str(ctx.exception)
        # Pydantic 2.x raises "Input should be a valid dictionary" for type mismatch;
        # the _validate_json_schema "must be a dict" message is for the helper unit tests.
        self.assertIn("input_schema", err_str.lower())

    @unittest.skipUnless(_HAS_PYDANTIC, "pydantic not available")
    def test_phase_43_locked_order_preserved(self):
        """Phase 43 7-field LOCKED order preserved at positions 1-7 in model_fields."""
        fields = list(SkillFrontmatter.model_fields.keys())
        expected_first7 = [
            'name', 'description', 'category', 'version',
            'security_class', 'allowed_tools', 'depends_on',
        ]
        actual_first7 = fields[:7]
        self.assertEqual(
            actual_first7, expected_first7,
            f"Phase 43 7-field LOCKED order violated. Got positions 1-7: {actual_first7}"
        )
        # Verify new fields appended at positions 8 + 9
        self.assertEqual(fields[7], 'input_schema', f"Position 8 must be input_schema, got {fields[7]}")
        self.assertEqual(fields[8], 'output_schema', f"Position 9 must be output_schema, got {fields[8]}")


class TestValidateJsonSchemaHelper(unittest.TestCase):
    """Unit tests for _validate_json_schema module-level helper (Phase 53 POLISH-01)."""

    def test_none_input_is_noop(self):
        """_validate_json_schema(None, ...) does not raise."""
        # Should be a no-op — returns None implicitly
        _validate_json_schema(None, 'test_field')

    def test_valid_schema_types_accepted(self):
        """All 7 valid JSON Schema types are accepted."""
        for t in ('string', 'number', 'integer', 'boolean', 'array', 'object', 'null'):
            _validate_json_schema({'type': t}, 'test_field')

    def test_missing_type_raises(self):
        """Dict without 'type' raises ValueError mentioning 'type'."""
        with self.assertRaises(ValueError) as ctx:
            _validate_json_schema({'properties': {'x': {}}}, 'test_field')
        self.assertIn('type', str(ctx.exception))

    def test_invalid_type_value_raises(self):
        """Dict with type='banana' raises ValueError mentioning 'must be one of'."""
        with self.assertRaises(ValueError) as ctx:
            _validate_json_schema({'type': 'banana'}, 'test_field')
        self.assertIn('must be one of', str(ctx.exception))

    def test_non_dict_raises(self):
        """Non-dict input raises ValueError mentioning 'must be a dict'."""
        with self.assertRaises(ValueError) as ctx:
            _validate_json_schema(['not', 'a', 'dict'], 'test_field')
        self.assertIn('must be a dict', str(ctx.exception))

    def test_valid_with_extra_properties(self):
        """Schema with type + extra keys (properties, required, etc.) is accepted."""
        _validate_json_schema(
            {'type': 'object', 'properties': {'foo': {'type': 'string'}}, 'required': ['foo']},
            'test_field'
        )


if __name__ == '__main__':
    unittest.main()
