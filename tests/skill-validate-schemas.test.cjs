'use strict';
/**
 * Phase 53 POLISH-01: validateJsonSchemaShape Node integration tests.
 * File: tests/skill-validate-schemas.test.cjs
 *
 * Tests the validateJsonSchemaShape helper exported from scripts/skill-compiler.cjs
 * and verifies that canonical SKILL.md files (without input_schema/output_schema)
 * still validate cleanly after the Phase 53 POLISH-01 extension.
 *
 * Run: node --test tests/skill-validate-schemas.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { validateJsonSchemaShape, validate } = require(path.join(ROOT, 'scripts', 'skill-compiler.cjs'));

// ── Test 1: null / undefined return null (optional fields absent) ──────────────

test('validateJsonSchemaShape returns null for null', () => {
  const result = validateJsonSchemaShape(null, 'input_schema');
  assert.strictEqual(result, null);
});

test('validateJsonSchemaShape returns null for undefined', () => {
  const result = validateJsonSchemaShape(undefined, 'output_schema');
  assert.strictEqual(result, null);
});

// ── Test 2: valid object schema returns null ───────────────────────────────────

test('validateJsonSchemaShape accepts valid object schema', () => {
  const result = validateJsonSchemaShape({ type: 'object' }, 'input_schema');
  assert.strictEqual(result, null);
});

test('validateJsonSchemaShape accepts all 7 valid JSON Schema types', () => {
  const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  for (const t of validTypes) {
    const result = validateJsonSchemaShape({ type: t }, 'test_field');
    assert.strictEqual(result, null, `Expected null for type=${t}`);
  }
});

// ── Test 3: missing 'type' field returns error string ─────────────────────────

test('validateJsonSchemaShape rejects missing type field', () => {
  const result = validateJsonSchemaShape({ properties: { foo: {} } }, 'input_schema');
  assert.ok(typeof result === 'string', `Expected error string, got ${typeof result}`);
  assert.ok(
    result.includes("missing required 'type' field"),
    `Expected 'missing required type field' in error, got: ${result}`
  );
});

// ── Test 4: invalid type value returns error string with "must be one of" ─────

test('validateJsonSchemaShape rejects invalid type value', () => {
  const result = validateJsonSchemaShape({ type: 'banana' }, 'input_schema');
  assert.ok(typeof result === 'string', `Expected error string, got ${typeof result}`);
  assert.ok(
    result.includes('must be one of'),
    `Expected 'must be one of' in error, got: ${result}`
  );
});

// ── Test 5: non-object input returns error string with "must be a JSON Schema object" ──

test('validateJsonSchemaShape rejects non-object (string)', () => {
  const result = validateJsonSchemaShape('not a dict', 'input_schema');
  assert.ok(typeof result === 'string', `Expected error string, got ${typeof result}`);
  assert.ok(
    result.includes('must be a JSON Schema object'),
    `Expected 'must be a JSON Schema object' in error, got: ${result}`
  );
});

test('validateJsonSchemaShape rejects array input', () => {
  const result = validateJsonSchemaShape(['not', 'a', 'dict'], 'output_schema');
  assert.ok(typeof result === 'string', `Expected error string, got ${typeof result}`);
  assert.ok(
    result.includes('must be a JSON Schema object'),
    `Expected 'must be a JSON Schema object' in error, got: ${result}`
  );
});

// ── Test 6: canonical SKILL.md files pass validate() without schema errors ─────

test('validate() accepts plan-phase SKILL.md (no input_schema/output_schema)', () => {
  const result = validate(path.join(ROOT, 'get-shit-done/skills/plan-phase'));
  assert.strictEqual(result.ok, true, `plan-phase errors: ${JSON.stringify(result.errors)}`);
  // Ensure no schema-related errors (backward-compat check)
  const schemaErrors = result.errors.filter(e =>
    e.includes('input_schema') || e.includes('output_schema')
  );
  assert.deepStrictEqual(schemaErrors, [], `Unexpected schema errors: ${JSON.stringify(schemaErrors)}`);
});

test('validate() accepts execute-phase SKILL.md (no input_schema/output_schema)', () => {
  const result = validate(path.join(ROOT, 'get-shit-done/skills/execute-phase'));
  assert.strictEqual(result.ok, true, `execute-phase errors: ${JSON.stringify(result.errors)}`);
  const schemaErrors = result.errors.filter(e =>
    e.includes('input_schema') || e.includes('output_schema')
  );
  assert.deepStrictEqual(schemaErrors, [], `Unexpected schema errors: ${JSON.stringify(schemaErrors)}`);
});

test('validate() accepts discuss-phase SKILL.md (no input_schema/output_schema)', () => {
  const result = validate(path.join(ROOT, 'get-shit-done/skills/discuss-phase'));
  assert.strictEqual(result.ok, true, `discuss-phase errors: ${JSON.stringify(result.errors)}`);
  const schemaErrors = result.errors.filter(e =>
    e.includes('input_schema') || e.includes('output_schema')
  );
  assert.deepStrictEqual(schemaErrors, [], `Unexpected schema errors: ${JSON.stringify(schemaErrors)}`);
});
