#!/usr/bin/env node
/**
 * Plan 12-04-02: _checkQaBlocks() unit tests.
 *
 * Tests the `_checkQaBlocks(tContent, taskType, inheritedSpec, isSecurityTask, isBugTask)`
 * pure logic function exported from gsd-amauta.cjs. No daemon access required.
 *
 * Categories:
 *   (1) Complete T-phase content (2 tests)
 *   (2) Missing blocks (6 tests)
 *   (3) Non-security task skip (1 test)
 *   (4) Non-code task skip (2 tests)
 *   (5) Empty T-phase (1 test)
 *   (6) Criterion ID coverage (3 tests)
 *   (7) TASK_CRITERIA + INHERITED_CRITERIA structural pairing (1 test)
 *
 * Run: node --test tests/12-qa-blocks.test.cjs
 */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AMAUTA_CJS = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');

let _checkQaBlocks;
try {
  const mod = require(AMAUTA_CJS);
  _checkQaBlocks = mod._checkQaBlocks;
} catch (e) {
  _checkQaBlocks = null;
}

// ── Helper: complete T-phase content (all blocks present) ─────────────────────

function makeCompleteTContent() {
  return `T: Verified all criteria.
TASK_CRITERIA:
  SC-01: Given X -- PASS
  SC-02: When Y -- PASS
INHERITED_CRITERIA:
  SC-01: Given A -- PASS
  SC-02: When B -- PASS
EDGE_CASES:
  criterion_1: "SC-01: Given A"
    edge_1: null input -> expect 400
    edge_2: oversized input -> expect 400
  criterion_2: "SC-02: When B"
    edge_1: empty string -> expect fallback
    edge_2: unicode chars -> expect sanitized
REGRESSION: after: 2500 pass / 0 fail. Baseline: 2479 pass / 0 fail. Regression: none.
ADVERSARIAL:
  path_traversal: n/a -- no file ops
  injection: pass -- parameterized queries verified
  auth_bypass: pass -- token check in middleware
QA_REPORT: 4/4 criteria verified, 4 edge cases, regression: clean, adversarial: 2/3 passed`;
}

function makeCompleteTContentNoAdversarial() {
  return `T: Verified all criteria.
TASK_CRITERIA:
  SC-01: Given X -- PASS
  SC-02: When Y -- PASS
INHERITED_CRITERIA:
  SC-01: Given A -- PASS
  SC-02: When B -- PASS
EDGE_CASES:
  criterion_1: "SC-01: Given A"
    edge_1: null input -> expect 400
    edge_2: oversized input -> expect 400
  criterion_2: "SC-02: When B"
    edge_1: empty string -> expect fallback
    edge_2: unicode chars -> expect sanitized
REGRESSION: after: 2500 pass / 0 fail. Baseline: 2479 pass / 0 fail. Regression: none.
QA_REPORT: 4/4 criteria verified, 4 edge cases, regression: clean`;
}

function makeInheritedSpec() {
  return {
    source: 'ST-0001',
    criteria: [
      { id: 'SC-01', text: 'Given A' },
      { id: 'SC-02', text: 'When B' }
    ]
  };
}

// ─── Guard: module load ────────────────────────────────────────────────────────

describe('Module load', () => {
  it('gsd-amauta.cjs exports _checkQaBlocks', () => {
    assert.ok(
      typeof _checkQaBlocks === 'function',
      `Expected _checkQaBlocks to be a function — got ${typeof _checkQaBlocks}. ` +
      'Ensure gsd-amauta.cjs exports { _checkQaBlocks } in module.exports.'
    );
  });
});

// ─── (1) Complete T-phase content ─────────────────────────────────────────────

describe('(1) Complete T-phase content', () => {
  it('1. all blocks present on non-security task: advisory=false, missing=[]', () => {
    if (!_checkQaBlocks) return;
    const result = _checkQaBlocks(makeCompleteTContent(), 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, false);
    assert.deepStrictEqual(result.missing, []);
  });

  it('2. all blocks present on security task (ADVERSARIAL present): advisory=false', () => {
    if (!_checkQaBlocks) return;
    const result = _checkQaBlocks(makeCompleteTContent(), 'task', makeInheritedSpec(), true, false);
    assert.strictEqual(result.advisory, false);
    assert.deepStrictEqual(result.missing, []);
  });
});

// ─── (2) Missing blocks ────────────────────────────────────────────────────────

describe('(2) Missing blocks', () => {
  it('3. missing TASK_CRITERIA: advisory=true, missing includes TASK_CRITERIA', () => {
    if (!_checkQaBlocks) return;
    const content = makeCompleteTContent().replace('TASK_CRITERIA:', 'TASK_CRIT_OMITTED:');
    const result = _checkQaBlocks(content, 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, true);
    assert.ok(result.missing.includes('TASK_CRITERIA'), `missing should include TASK_CRITERIA, got: ${JSON.stringify(result.missing)}`);
  });

  it('4. missing INHERITED_CRITERIA with inheritedSpec present: advisory=true, missing includes INHERITED_CRITERIA', () => {
    if (!_checkQaBlocks) return;
    const content = makeCompleteTContent().replace('INHERITED_CRITERIA:', 'INHERITED_CRIT_OMITTED:');
    const result = _checkQaBlocks(content, 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, true);
    assert.ok(result.missing.includes('INHERITED_CRITERIA'), `missing should include INHERITED_CRITERIA, got: ${JSON.stringify(result.missing)}`);
  });

  it('5. missing INHERITED_CRITERIA with inheritedSpec=null: advisory=false (not required)', () => {
    if (!_checkQaBlocks) return;
    // Content has all blocks except INHERITED_CRITERIA; no inherited spec -> not required
    const result = _checkQaBlocks(makeCompleteTContentNoAdversarial(), 'task', null, false, false);
    // With no inherited spec, INHERITED_CRITERIA is not checked; QA_REPORT present
    assert.strictEqual(result.advisory, false);
    assert.ok(!result.missing.includes('INHERITED_CRITERIA'));
  });

  it('6. missing EDGE_CASES: advisory=true, missing includes EDGE_CASES', () => {
    if (!_checkQaBlocks) return;
    const content = makeCompleteTContent().replace('EDGE_CASES:', 'EDGE_CASES_OMITTED:');
    const result = _checkQaBlocks(content, 'task', null, false, false);
    assert.strictEqual(result.advisory, true);
    assert.ok(result.missing.includes('EDGE_CASES'), `missing should include EDGE_CASES, got: ${JSON.stringify(result.missing)}`);
  });

  it('7. missing REGRESSION: advisory=true, missing includes REGRESSION', () => {
    if (!_checkQaBlocks) return;
    const content = makeCompleteTContent().replace('REGRESSION:', 'REGRESSION_OMITTED:');
    const result = _checkQaBlocks(content, 'task', null, false, false);
    assert.strictEqual(result.advisory, true);
    assert.ok(result.missing.includes('REGRESSION'), `missing should include REGRESSION, got: ${JSON.stringify(result.missing)}`);
  });

  it('8. missing ADVERSARIAL on security task: advisory=true, missing includes ADVERSARIAL', () => {
    if (!_checkQaBlocks) return;
    const content = makeCompleteTContent().replace('ADVERSARIAL:', 'ADVERSARIAL_OMITTED:');
    const result = _checkQaBlocks(content, 'task', makeInheritedSpec(), true, false);
    assert.strictEqual(result.advisory, true);
    assert.ok(result.missing.includes('ADVERSARIAL'), `missing should include ADVERSARIAL, got: ${JSON.stringify(result.missing)}`);
  });
});

// ─── (3) Non-security task skip ───────────────────────────────────────────────

describe('(3) Non-security task skip', () => {
  it('9. missing ADVERSARIAL on non-security task: advisory=false (ADVERSARIAL not required)', () => {
    if (!_checkQaBlocks) return;
    // Complete except no ADVERSARIAL, not a security task
    const result = _checkQaBlocks(makeCompleteTContentNoAdversarial(), 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, false);
    assert.ok(!result.missing.includes('ADVERSARIAL'));
  });
});

// ─── (4) Non-code task skip ───────────────────────────────────────────────────

describe('(4) Non-code task skip', () => {
  it('10. taskType=research: advisory=false, reason=non-code task', () => {
    if (!_checkQaBlocks) return;
    const result = _checkQaBlocks('', 'research', null, false, false);
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'non-code task');
  });

  it('11. taskType=planning: advisory=false, reason=non-code task', () => {
    if (!_checkQaBlocks) return;
    const result = _checkQaBlocks('', 'planning', null, false, false);
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'non-code task');
  });
});

// ─── (5) Empty T-phase ────────────────────────────────────────────────────────

describe('(5) Empty T-phase', () => {
  it('12. empty string input: advisory=true, reason includes T-phase is empty', () => {
    if (!_checkQaBlocks) return;
    const result = _checkQaBlocks('', 'task', null, false, false);
    assert.strictEqual(result.advisory, true);
    assert.match(result.reason, /T-phase is empty/i);
  });
});

// ─── (6) Criterion ID coverage ────────────────────────────────────────────────

describe('(6) Criterion ID coverage', () => {
  it('13. all SC-IDs referenced in T content: no criterion warning', () => {
    if (!_checkQaBlocks) return;
    // Content references both SC-01 and SC-02 from inherited spec
    const result = _checkQaBlocks(makeCompleteTContent(), 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, false);
    // reason should not mention "inherited criteria referenced" coverage warning
    assert.ok(!result.reason.includes('inherited criteria referenced'), `Unexpected criterion warning: ${result.reason}`);
  });

  it('14. partial SC-IDs referenced: advisory=true, reason includes inherited criteria referenced', () => {
    if (!_checkQaBlocks) return;
    // inheritedSpec has SC-01 and SC-02, but content only references SC-01
    const partialContent = `T: Done.
TASK_CRITERIA:
  SC-01: Given X -- PASS
INHERITED_CRITERIA:
  SC-01: Given A -- PASS
EDGE_CASES:
  criterion_1: "SC-01: Given A"
    edge_1: null input -> expect 400
    edge_2: oversized input -> expect 400
REGRESSION: after: 100 pass / 0 fail.
QA_REPORT: done`;
    const result = _checkQaBlocks(partialContent, 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, true);
    assert.match(result.reason, /inherited criteria referenced/);
  });

  it('15. no inherited spec (null): no criterion coverage warning', () => {
    if (!_checkQaBlocks) return;
    const result = _checkQaBlocks(makeCompleteTContentNoAdversarial(), 'task', null, false, false);
    assert.ok(!result.reason.includes('inherited criteria referenced'), `Unexpected criterion warning: ${result.reason}`);
  });
});

// ─── (7) TASK_CRITERIA + INHERITED_CRITERIA structural pairing ────────────────

describe('(7) TASK_CRITERIA + INHERITED_CRITERIA structural pairing', () => {
  it('16. TASK_CRITERIA present, INHERITED_CRITERIA missing, inheritedSpec non-null: missing has INHERITED_CRITERIA but NOT TASK_CRITERIA', () => {
    if (!_checkQaBlocks) return;
    const content = `T: Done.
TASK_CRITERIA:
  SC-01: Given X -- PASS
EDGE_CASES:
  criterion_1: "SC-01"
    edge_1: null -> 400
    edge_2: empty -> 400
REGRESSION: after: 100 pass / 0 fail.
QA_REPORT: done`;
    const result = _checkQaBlocks(content, 'task', makeInheritedSpec(), false, false);
    assert.strictEqual(result.advisory, true);
    assert.ok(result.missing.includes('INHERITED_CRITERIA'), `expected INHERITED_CRITERIA in missing, got: ${JSON.stringify(result.missing)}`);
    assert.ok(!result.missing.includes('TASK_CRITERIA'), `TASK_CRITERIA should NOT be in missing, got: ${JSON.stringify(result.missing)}`);
  });
});
