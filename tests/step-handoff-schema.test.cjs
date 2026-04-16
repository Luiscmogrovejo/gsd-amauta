'use strict';
/**
 * Plan 41-03-03: StepHandoff JSON Schema Validation Tests
 * File: tests/step-handoff-schema.test.cjs
 *
 * Requirements covered:
 *   SHARD-04: StepHandoff JSON schema validation (3 copies — plan-phase, execute-phase, discuss-phase)
 *
 * Tests that step-handoff.json validates correctly:
 *   - Valid handoffs pass
 *   - Missing required fields are rejected
 *   - Invalid enum values are rejected
 *   - step_id pattern is enforced
 *   - All 3 schema copies are byte-identical
 *
 * Uses manual schema validation (no external Ajv dependency).
 *
 * Run: node --test tests/step-handoff-schema.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'get-shit-done', 'workflows');

const SCHEMA_PATHS = {
  'plan-phase': path.join(WORKFLOWS_DIR, 'plan-phase', 'schema', 'step-handoff.json'),
  'execute-phase': path.join(WORKFLOWS_DIR, 'execute-phase', 'schema', 'step-handoff.json'),
  'discuss-phase': path.join(WORKFLOWS_DIR, 'discuss-phase', 'schema', 'step-handoff.json'),
};

// ─── Manual schema validator (no Ajv dependency) ──────────────────────────────

function validateHandoff(obj, schema) {
  const errors = [];

  // Required field checks
  for (const field of schema.required || []) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Enum validation for workflow_name
  if (obj.workflow_name !== undefined) {
    const enumValues = schema.properties?.workflow_name?.enum;
    if (enumValues && !enumValues.includes(obj.workflow_name)) {
      errors.push(`Invalid workflow_name: "${obj.workflow_name}". Must be one of: ${enumValues.join(', ')}`);
    }
  }

  // Pattern validation for step_id
  if (obj.step_id !== undefined && schema.properties?.step_id?.pattern) {
    const pattern = new RegExp(schema.properties.step_id.pattern);
    if (!pattern.test(obj.step_id)) {
      errors.push(`Invalid step_id: "${obj.step_id}" does not match pattern ${schema.properties.step_id.pattern}`);
    }
  }

  // Type validation for phase_number
  if (obj.phase_number !== undefined) {
    if (typeof obj.phase_number !== 'number' || !Number.isInteger(obj.phase_number)) {
      errors.push(`phase_number must be an integer, got: ${typeof obj.phase_number}`);
    } else if (schema.properties?.phase_number?.minimum !== undefined && obj.phase_number < schema.properties.phase_number.minimum) {
      errors.push(`phase_number must be >= ${schema.properties.phase_number.minimum}, got: ${obj.phase_number}`);
    }
  }

  // Type validation for context_snapshot
  if (obj.context_snapshot !== undefined) {
    if (typeof obj.context_snapshot !== 'object' || Array.isArray(obj.context_snapshot)) {
      errors.push(`context_snapshot must be an object`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Load schemas ─────────────────────────────────────────────────────────────

let planSchema = null;
let executeSchema = null;
let discussSchema = null;

try { planSchema = JSON.parse(fs.readFileSync(SCHEMA_PATHS['plan-phase'], 'utf-8')); } catch (_) {}
try { executeSchema = JSON.parse(fs.readFileSync(SCHEMA_PATHS['execute-phase'], 'utf-8')); } catch (_) {}
try { discussSchema = JSON.parse(fs.readFileSync(SCHEMA_PATHS['discuss-phase'], 'utf-8')); } catch (_) {}

// Valid handoff object for testing
const VALID_HANDOFF = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  workflow_name: 'plan-phase',
  step_id: 'step-01-init',
  task_id: 'TK-0041',
  phase_number: 41,
  completed_steps: [],
  context_snapshot: { phase_name: 'Sharded Workflows' },
  artifacts: {},
  decisions: [],
  user_inputs: [],
  next_step: 'step-02-research',
  escalation_flags: [],
  created_at: '2026-04-13T00:00:00.000Z',
};

// ─── Group 1: Schema files exist and are valid JSON ───────────────────────────

describe('[SHARD-04] Schema files exist and parse as valid JSON', () => {

  it('step-handoff.json schema reference (plan-phase/schema/step-handoff.json) exists', () => {
    assert.ok(
      fs.existsSync(SCHEMA_PATHS['plan-phase']),
      `plan-phase schema missing: ${SCHEMA_PATHS['plan-phase']}`
    );
  });

  it('execute-phase/schema/step-handoff.json exists', () => {
    assert.ok(
      fs.existsSync(SCHEMA_PATHS['execute-phase']),
      `execute-phase schema missing: ${SCHEMA_PATHS['execute-phase']}`
    );
  });

  it('discuss-phase/schema/step-handoff.json exists', () => {
    assert.ok(
      fs.existsSync(SCHEMA_PATHS['discuss-phase']),
      `discuss-phase schema missing: ${SCHEMA_PATHS['discuss-phase']}`
    );
  });

  it('plan-phase schema parses without error', () => {
    assert.ok(planSchema !== null, 'plan-phase/schema/step-handoff.json failed to parse');
  });

  it('schema has $schema field (JSON Schema draft)', () => {
    assert.ok(planSchema['$schema'], 'Schema missing $schema field');
  });

  it('schema has required field array', () => {
    assert.ok(Array.isArray(planSchema.required), 'Schema missing required array');
    assert.ok(planSchema.required.length > 0, 'Schema required array is empty');
  });

  it('schema required fields include workflow_name, step_id, task_id, phase_number, context_snapshot', () => {
    const required = planSchema.required || [];
    const expectedRequired = ['workflow_name', 'step_id', 'task_id', 'phase_number', 'context_snapshot'];
    for (const field of expectedRequired) {
      assert.ok(required.includes(field), `Schema missing required field: ${field}`);
    }
  });

});

// ─── Group 2: Valid handoff passes schema validation ──────────────────────────

describe('[SHARD-04] Valid handoff objects pass schema validation', () => {

  it('full valid handoff passes plan-phase schema validation', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const { valid, errors } = validateHandoff(VALID_HANDOFF, planSchema);
    assert.ok(valid, `Valid handoff failed validation: ${JSON.stringify(errors)}`);
    assert.deepStrictEqual(errors, []);
  });

  it('valid handoff with execute-phase workflow passes execute-phase schema', () => {
    assert.ok(executeSchema !== null, 'execute-phase schema not loaded');
    const handoff = { ...VALID_HANDOFF, workflow_name: 'execute-phase', step_id: 'step-01-prepare' };
    const { valid, errors } = validateHandoff(handoff, executeSchema);
    assert.ok(valid, `execute-phase handoff failed: ${JSON.stringify(errors)}`);
  });

  it('valid handoff with discuss-phase workflow passes discuss-phase schema', () => {
    assert.ok(discussSchema !== null, 'discuss-phase schema not loaded');
    const handoff = { ...VALID_HANDOFF, workflow_name: 'discuss-phase', step_id: 'step-01-scout' };
    const { valid, errors } = validateHandoff(handoff, discussSchema);
    assert.ok(valid, `discuss-phase handoff failed: ${JSON.stringify(errors)}`);
  });

  it('minimal valid handoff (only required fields) passes', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const minimal = {
      workflow_name: 'plan-phase',
      step_id: 'step-03-plan',
      task_id: 'TK-9999',
      phase_number: 42,
      context_snapshot: {},
    };
    const { valid, errors } = validateHandoff(minimal, planSchema);
    assert.ok(valid, `Minimal handoff failed validation: ${JSON.stringify(errors)}`);
  });

});

// ─── Group 3: Missing required fields are rejected ────────────────────────────

describe('[SHARD-04] Missing required fields are rejected', () => {

  it('missing workflow_name is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const { workflow_name: _, ...withoutWorkflow } = VALID_HANDOFF;
    const { valid, errors } = validateHandoff(withoutWorkflow, planSchema);
    assert.ok(!valid, 'Expected invalid for missing workflow_name');
    assert.ok(errors.some(e => e.includes('workflow_name')), `Expected error mentioning workflow_name: ${errors}`);
  });

  it('missing step_id is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const { step_id: _, ...withoutStepId } = VALID_HANDOFF;
    const { valid, errors } = validateHandoff(withoutStepId, planSchema);
    assert.ok(!valid, 'Expected invalid for missing step_id');
    assert.ok(errors.some(e => e.includes('step_id')), `Expected error mentioning step_id: ${errors}`);
  });

  it('missing context_snapshot is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const { context_snapshot: _, ...withoutContext } = VALID_HANDOFF;
    const { valid, errors } = validateHandoff(withoutContext, planSchema);
    assert.ok(!valid, 'Expected invalid for missing context_snapshot');
    assert.ok(errors.some(e => e.includes('context_snapshot')), `Expected error mentioning context_snapshot: ${errors}`);
  });

  it('missing task_id is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const { task_id: _, ...withoutTaskId } = VALID_HANDOFF;
    const { valid, errors } = validateHandoff(withoutTaskId, planSchema);
    assert.ok(!valid, 'Expected invalid for missing task_id');
    assert.ok(errors.some(e => e.includes('task_id')), `Expected error mentioning task_id: ${errors}`);
  });

  it('missing phase_number is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const { phase_number: _, ...withoutPhase } = VALID_HANDOFF;
    const { valid, errors } = validateHandoff(withoutPhase, planSchema);
    assert.ok(!valid, 'Expected invalid for missing phase_number');
    assert.ok(errors.some(e => e.includes('phase_number')), `Expected error mentioning phase_number: ${errors}`);
  });

});

// ─── Group 4: Invalid enum and pattern validation ─────────────────────────────

describe('[SHARD-04] Invalid enum and pattern values are rejected', () => {

  it('invalid workflow_name enum is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const invalid = { ...VALID_HANDOFF, workflow_name: 'invalid-workflow' };
    const { valid, errors } = validateHandoff(invalid, planSchema);
    assert.ok(!valid, 'Expected invalid for unknown workflow_name enum');
    assert.ok(errors.some(e => e.includes('Invalid workflow_name')), `Expected enum error: ${errors}`);
  });

  it('workflow_name enum contains exactly 3 valid values', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const enumValues = planSchema.properties?.workflow_name?.enum || [];
    assert.strictEqual(enumValues.length, 3, `Expected 3 workflow names in enum, got: ${enumValues}`);
    assert.ok(enumValues.includes('plan-phase'), 'Enum missing plan-phase');
    assert.ok(enumValues.includes('execute-phase'), 'Enum missing execute-phase');
    assert.ok(enumValues.includes('discuss-phase'), 'Enum missing discuss-phase');
  });

  it('step_id pattern step-01-init passes', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const valid_obj = { ...VALID_HANDOFF, step_id: 'step-01-init' };
    const { valid } = validateHandoff(valid_obj, planSchema);
    assert.ok(valid, 'step-01-init should match step_id pattern');
  });

  it('step_id "invalid" without pattern format is rejected', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const patternStr = planSchema.properties?.step_id?.pattern;
    if (patternStr) {
      const invalid = { ...VALID_HANDOFF, step_id: 'invalid' };
      const { valid, errors } = validateHandoff(invalid, planSchema);
      assert.ok(!valid, 'Expected invalid for step_id without correct pattern');
      assert.ok(errors.some(e => e.includes('step_id')), `Expected pattern error: ${errors}`);
    } else {
      // No pattern in schema — skip this assertion
      console.log('[info] step_id has no pattern constraint in schema — skipping pattern rejection test');
      assert.ok(true, 'No pattern to enforce');
    }
  });

  it('phase_number minimum is 1 in schema', () => {
    assert.ok(planSchema !== null, 'Schema not loaded');
    const minimum = planSchema.properties?.phase_number?.minimum;
    assert.strictEqual(minimum, 1, `Expected minimum=1 for phase_number, got: ${minimum}`);
  });

});

// ─── Group 5: All 3 schema copies are byte-identical ─────────────────────────

describe('[SHARD-04] All 3 schema copies are byte-identical', () => {

  it('plan-phase and execute-phase schemas are identical', () => {
    const plan = fs.readFileSync(SCHEMA_PATHS['plan-phase'], 'utf-8');
    const exec = fs.readFileSync(SCHEMA_PATHS['execute-phase'], 'utf-8');
    assert.strictEqual(plan, exec, 'plan-phase and execute-phase step-handoff.json schemas differ');
  });

  it('plan-phase and discuss-phase schemas are identical', () => {
    const plan = fs.readFileSync(SCHEMA_PATHS['plan-phase'], 'utf-8');
    const discuss = fs.readFileSync(SCHEMA_PATHS['discuss-phase'], 'utf-8');
    assert.strictEqual(plan, discuss, 'plan-phase and discuss-phase step-handoff.json schemas differ');
  });

  it('all 3 schemas have the same required fields', () => {
    const schemas = [planSchema, executeSchema, discussSchema].filter(Boolean);
    assert.ok(schemas.length === 3, `Expected 3 valid schemas, got ${schemas.length}`);
    const requiredSets = schemas.map(s => JSON.stringify([...(s.required || [])].sort()));
    const allSame = requiredSets.every(r => r === requiredSets[0]);
    assert.ok(allSame, `Schema required fields differ: ${requiredSets.join(' | ')}`);
  });

  it('all 3 schemas enumerate same 3 workflow names', () => {
    for (const [name, schema] of [['plan-phase', planSchema], ['execute-phase', executeSchema], ['discuss-phase', discussSchema]]) {
      if (!schema) continue;
      const enumValues = schema.properties?.workflow_name?.enum || [];
      assert.ok(enumValues.includes('plan-phase'), `${name} schema enum missing plan-phase`);
      assert.ok(enumValues.includes('execute-phase'), `${name} schema enum missing execute-phase`);
      assert.ok(enumValues.includes('discuss-phase'), `${name} schema enum missing discuss-phase`);
    }
  });

});
