'use strict';
/**
 * Plan 41-03-05: HALT Enforcement Tests (3-layer verification)
 * File: tests/sharded-workflow-halt.test.cjs
 *
 * Requirements covered:
 *   SHARD-01, SHARD-02, SHARD-03: 3-layer HALT enforcement system
 *
 * Tests:
 *   Layer 1 (Architectural): Next step content NOT in context window — step files are
 *     separate filesystem entries, not embedded in workflow.md
 *   Layer 2 (Prompt-based): Each step file contains STOP/HALT/Do not proceed instruction
 *   Layer 3 (Operator verification): Router workflow.md verifies PG handoff before advancing
 *     (checks for api/steps reference and conditional handoff verification logic)
 *
 * All tests are pure filesystem reads — no daemon needed, no Python subprocess.
 *
 * Run: node --test tests/sharded-workflow-halt.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'get-shit-done', 'workflows');

// Step definitions — matches WORKFLOW_STEPS in step-orchestrator.py
const WORKFLOW_STEPS = {
  'plan-phase': ['step-01-init', 'step-02-research', 'step-03-plan', 'step-04-check', 'step-05-approve'],
  'execute-phase': ['step-01-prepare', 'step-02-route', 'step-03-execute', 'step-04-verify', 'step-05-validate', 'step-06-close'],
  'discuss-phase': ['step-01-scout', 'step-02-analyze', 'step-03-discuss', 'step-04-commit'],
};

// Helper: read a step file
function readStep(workflow, step) {
  return fs.readFileSync(
    path.join(WORKFLOWS_DIR, workflow, 'steps', `${step}.md`),
    'utf-8'
  );
}

// Helper: read a workflow router file
function readRouter(workflow) {
  return fs.readFileSync(
    path.join(WORKFLOWS_DIR, workflow, 'workflow.md'),
    'utf-8'
  );
}

// ─── Group 1: Layer 2 — Prompt-based HALT in every step file ─────────────────

describe('[SHARD-01-03] Layer 2 (Prompt-based): Every step file contains HALT instruction', () => {

  // Test all 15 step files across 3 workflows
  for (const [wf, steps] of Object.entries(WORKFLOW_STEPS)) {
    for (const step of steps) {
      it(`${wf}/${step}.md contains STOP or HALT instruction`, () => {
        const content = readStep(wf, step);
        const hasHalt = (
          content.includes('STOP') ||
          content.includes('HALT') ||
          content.includes('Do not proceed')
        );
        assert.ok(
          hasHalt,
          `${wf}/${step}.md is missing HALT instruction (STOP/HALT/Do not proceed)`
        );
      });
    }
  }

});

// ─── Group 2: Layer 1 — Architectural isolation (step files are separate) ─────

describe('[SHARD-01-03] Layer 1 (Architectural): Step files are separate — not embedded in workflow.md', () => {

  it('plan-phase/workflow.md does NOT contain full step-01-init content', () => {
    const router = readRouter('plan-phase');
    const step01 = readStep('plan-phase', 'step-01-init');
    // The router should reference the file but NOT contain its full content
    // Check for a signature phrase from step-01-init that is NOT a brief mention
    const step01BodyLine = 'Load all context in one call (paths only to minimize orchestrator context)';
    assert.ok(
      !router.includes(step01BodyLine),
      'plan-phase/workflow.md appears to contain step-01-init body content (Layer 1 violation)'
    );
  });

  it('execute-phase/workflow.md does NOT contain full step-01-prepare content', () => {
    const router = readRouter('execute-phase');
    // Check for a phrase that would only be in the step file body
    const stepContent = fs.readFileSync(
      path.join(WORKFLOWS_DIR, 'execute-phase', 'steps', 'step-01-prepare.md'), 'utf-8'
    );
    // Get first paragraph of the step body (after the <process> tag)
    const processMatch = stepContent.match(/<process>([\s\S]*?)<\/process>/);
    if (processMatch) {
      // Take a 50-char snippet from the process section to check it's not in the router
      const snippet = processMatch[1].trim().slice(0, 50);
      if (snippet.length >= 30) {
        assert.ok(
          !router.includes(snippet),
          `execute-phase/workflow.md contains step-01-prepare body content (Layer 1 violation): "${snippet}"`
        );
      }
    }
    // Structural check: router is much shorter than all steps combined
    const totalStepSize = WORKFLOW_STEPS['execute-phase'].reduce((sum, step) => {
      return sum + fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase', 'steps', `${step}.md`), 'utf-8').length;
    }, 0);
    assert.ok(
      router.length < totalStepSize / 3,
      `execute-phase/workflow.md is suspiciously large (${router.length} chars vs ${totalStepSize} chars for all steps)`
    );
  });

  it('each workflow has a separate steps/ subdirectory (architectural isolation)', () => {
    for (const wf of Object.keys(WORKFLOW_STEPS)) {
      const stepsDir = path.join(WORKFLOWS_DIR, wf, 'steps');
      assert.ok(
        fs.existsSync(stepsDir),
        `${wf}/steps/ directory does not exist (Layer 1 architectural isolation missing)`
      );
    }
  });

  it('total step file count is exactly 15 across all workflows', () => {
    let totalStepCount = 0;
    for (const [wf, steps] of Object.entries(WORKFLOW_STEPS)) {
      const stepsDir = path.join(WORKFLOWS_DIR, wf, 'steps');
      const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
      totalStepCount += files.length;
    }
    assert.strictEqual(totalStepCount, 15, `Expected 15 total step files, got ${totalStepCount}`);
  });

});

// ─── Group 3: Layer 3 — Router verifies PG handoff before advancing ───────────

describe('[SHARD-01-03] Layer 3 (Operator): Router workflow.md checks PG handoff before advancing', () => {

  it('plan-phase/workflow.md references api/steps (PG check)', () => {
    const router = readRouter('plan-phase');
    assert.ok(
      router.includes('api/steps'),
      'plan-phase/workflow.md missing api/steps reference (Layer 3 PG check)'
    );
  });

  it('execute-phase/workflow.md references api/steps (PG check)', () => {
    const router = readRouter('execute-phase');
    assert.ok(
      router.includes('api/steps'),
      'execute-phase/workflow.md missing api/steps reference (Layer 3 PG check)'
    );
  });

  it('discuss-phase/workflow.md references api/steps (PG check)', () => {
    const router = readRouter('discuss-phase');
    assert.ok(
      router.includes('api/steps'),
      'discuss-phase/workflow.md missing api/steps reference (Layer 3 PG check)'
    );
  });

  it('plan-phase router has HALT instruction for missing handoff', () => {
    const router = readRouter('plan-phase');
    assert.ok(
      router.includes('HALT'),
      'plan-phase/workflow.md missing HALT instruction for failed handoff verification'
    );
  });

  it('execute-phase router has HALT instruction for missing handoff', () => {
    const router = readRouter('execute-phase');
    assert.ok(
      router.includes('HALT'),
      'execute-phase/workflow.md missing HALT instruction for failed handoff verification'
    );
  });

  it('discuss-phase router has HALT instruction for missing handoff', () => {
    const router = readRouter('discuss-phase');
    assert.ok(
      router.includes('HALT'),
      'discuss-phase/workflow.md missing HALT instruction for failed handoff verification'
    );
  });

});

// ─── Group 4: Step file naming convention ─────────────────────────────────────

describe('[SHARD-01-03] Step file naming: all step files match step-NN-name.md pattern', () => {

  const stepPattern = /^step-\d{2}-[a-z]+\.md$/;

  it('plan-phase step files all match step-NN-name.md', () => {
    const stepsDir = path.join(WORKFLOWS_DIR, 'plan-phase', 'steps');
    const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      assert.ok(stepPattern.test(file), `plan-phase step file doesn't match pattern: ${file}`);
    }
  });

  it('execute-phase step files all match step-NN-name.md', () => {
    const stepsDir = path.join(WORKFLOWS_DIR, 'execute-phase', 'steps');
    const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      assert.ok(stepPattern.test(file), `execute-phase step file doesn't match pattern: ${file}`);
    }
  });

  it('discuss-phase step files all match step-NN-name.md', () => {
    const stepsDir = path.join(WORKFLOWS_DIR, 'discuss-phase', 'steps');
    const files = fs.readdirSync(stepsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      assert.ok(stepPattern.test(file), `discuss-phase step file doesn't match pattern: ${file}`);
    }
  });

  it('step numbers are sequential (no gaps) within each workflow', () => {
    for (const [wf, steps] of Object.entries(WORKFLOW_STEPS)) {
      for (let i = 0; i < steps.length; i++) {
        const expected = String(i + 1).padStart(2, '0');
        const actual = steps[i].slice(5, 7); // extract NN from step-NN-name
        assert.strictEqual(
          actual,
          expected,
          `${wf} step ${i + 1} has number ${actual}, expected ${expected} (${steps[i]})`
        );
      }
    }
  });

});

// ─── Group 5: Router files reference all their steps ─────────────────────────

describe('[SHARD-01-03] Router files mention all step names', () => {

  it('plan-phase/workflow.md mentions all 5 step names', () => {
    const router = readRouter('plan-phase');
    for (const step of WORKFLOW_STEPS['plan-phase']) {
      assert.ok(
        router.includes(step),
        `plan-phase/workflow.md missing reference to step: ${step}`
      );
    }
  });

  it('execute-phase/workflow.md mentions all 6 step names', () => {
    const router = readRouter('execute-phase');
    for (const step of WORKFLOW_STEPS['execute-phase']) {
      assert.ok(
        router.includes(step),
        `execute-phase/workflow.md missing reference to step: ${step}`
      );
    }
  });

  it('discuss-phase/workflow.md mentions all 4 step names', () => {
    const router = readRouter('discuss-phase');
    for (const step of WORKFLOW_STEPS['discuss-phase']) {
      assert.ok(
        router.includes(step),
        `discuss-phase/workflow.md missing reference to step: ${step}`
      );
    }
  });

  it('routers describe 3-layer HALT enforcement', () => {
    for (const wf of Object.keys(WORKFLOW_STEPS)) {
      const router = readRouter(wf);
      assert.ok(
        router.includes('Layer 1') || router.includes('layer 1') || router.includes('3-layer'),
        `${wf}/workflow.md missing 3-layer HALT enforcement description`
      );
    }
  });

});
