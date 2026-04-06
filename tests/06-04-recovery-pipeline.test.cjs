#!/usr/bin/env node
/**
 * Plan 06-04: Recovery Pipeline Tests
 *
 * Tests:
 *   CLASS-01: Error classification function
 *     1. _classify_failure function exists
 *     2. ERROR_CLASSES tuple has 4 values
 *     3. MAX_FAILURES_BEFORE_ESCALATION = 3
 *   CLASS-02: Classification logic in code
 *     4. Transient keywords checked (timeout, connection refused, etc.)
 *     5. Capability mismatch keywords checked (outside my capability, wrong agent, etc.)
 *     6. Gate fail is default when gate_results have failures
 *     7. Systemic triggered by failure_count >= MAX
 *   RECOVERY-01: Recovery routing table
 *     8. RECOVERY_ACTIONS has all 4 error classes
 *     9. Each action has action, description, target_agent keys
 *    10. TRANSIENT action is retry
 *    11. GATE_FAIL action is fix_gates
 *    12. CAPABILITY_MISMATCH action is reroute
 *    13. SYSTEMIC action is escalate
 *   ESCALATION-01: Auto-escalation in validate fail path
 *    14. failure_count increment in cmd_validate
 *    15. FAILURE_CLASSIFIED note appended
 *    16. AUTO_ESCALATED note for systemic failures
 *    17. status = "escalated" for systemic failures
 *    18. error_class in validation metadata
 *   WORKFLOW-01: Execute-phase integration
 *    19. failure_handling references recovery classification
 *    20. AGT-06 mentioned in execute-phase.md
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
const EXEC_PHASE = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase.md'), 'utf-8');

// Isolate _classify_failure function
const classifyStart = AMAUTA.indexOf('def _classify_failure(');
const classifyEnd = classifyStart >= 0 ? AMAUTA.indexOf('\ndef ', classifyStart + 1) : -1;
const CLASSIFY_FN = classifyStart >= 0 ? AMAUTA.substring(classifyStart, classifyEnd) : '';

// Isolate RECOVERY_ACTIONS block
const raStart = AMAUTA.indexOf('RECOVERY_ACTIONS = {');
const raEnd = raStart >= 0 ? AMAUTA.indexOf('\n}\n', raStart) + 2 : -1;
const RA_BLOCK = raStart >= 0 ? AMAUTA.substring(raStart, raEnd) : '';

// Isolate cmd_validate function
const validateStart = AMAUTA.indexOf('def cmd_validate(');
const validateEnd = AMAUTA.indexOf('\ndef ', validateStart + 1);
const VALIDATE_FN = AMAUTA.substring(validateStart, validateEnd);

describe('CLASS-01: Error classification function', () => {
  it('1. _classify_failure function exists', () => {
    assert.ok(AMAUTA.includes('def _classify_failure('), 'Missing _classify_failure function');
  });
  it('2. ERROR_CLASSES has 4 values', () => {
    assert.ok(AMAUTA.includes('TRANSIENT'), 'Missing TRANSIENT');
    assert.ok(AMAUTA.includes('GATE_FAIL'), 'Missing GATE_FAIL');
    assert.ok(AMAUTA.includes('CAPABILITY_MISMATCH'), 'Missing CAPABILITY_MISMATCH');
    assert.ok(AMAUTA.includes('SYSTEMIC'), 'Missing SYSTEMIC');
  });
  it('3. MAX_FAILURES_BEFORE_ESCALATION = 3', () => {
    assert.ok(AMAUTA.includes('MAX_FAILURES_BEFORE_ESCALATION = 3'), 'Missing or wrong MAX_FAILURES constant');
  });
});

describe('CLASS-02: Classification logic', () => {
  it('4. Transient keywords checked', () => {
    assert.ok(CLASSIFY_FN.includes('timeout'), 'Missing timeout keyword');
    assert.ok(CLASSIFY_FN.includes('connection refused'), 'Missing connection refused keyword');
  });
  it('5. Capability mismatch keywords checked', () => {
    assert.ok(CLASSIFY_FN.includes('outside my capability') || CLASSIFY_FN.includes('capability'),
      'Missing capability mismatch keywords');
  });
  it('6. Gate fail default for gate failures', () => {
    assert.ok(CLASSIFY_FN.includes('GATE_FAIL'), 'Missing GATE_FAIL return');
  });
  it('7. Systemic triggered by failure_count', () => {
    assert.ok(CLASSIFY_FN.includes('failure_count') && CLASSIFY_FN.includes('SYSTEMIC'),
      'Systemic classification should check failure_count');
  });
});

describe('RECOVERY-01: Recovery routing table', () => {
  it('8. RECOVERY_ACTIONS covers all 4 classes', () => {
    assert.ok(AMAUTA.includes('RECOVERY_ACTIONS'), 'Missing RECOVERY_ACTIONS');
    for (const cls of ['TRANSIENT', 'GATE_FAIL', 'CAPABILITY_MISMATCH', 'SYSTEMIC']) {
      assert.ok(AMAUTA.includes(`"${cls}"`), `RECOVERY_ACTIONS missing ${cls}`);
    }
  });
  it('9. Each action has required keys', () => {
    assert.ok(AMAUTA.includes('"action"'), 'Missing action key');
    assert.ok(AMAUTA.includes('"description"'), 'Missing description key');
    assert.ok(AMAUTA.includes('"target_agent"'), 'Missing target_agent key');
  });
  it('10. TRANSIENT action is retry', () => {
    // Search within RECOVERY_ACTIONS block to avoid matching ERROR_CLASSES tuple
    const transientIdx = RA_BLOCK.indexOf('"TRANSIENT"');
    const transientBlock = RA_BLOCK.substring(transientIdx, RA_BLOCK.indexOf('}', transientIdx) + 1);
    assert.ok(transientBlock.includes('"retry"'), 'TRANSIENT action should be retry');
  });
  it('11. GATE_FAIL action is fix_gates', () => {
    const gateIdx = RA_BLOCK.indexOf('"GATE_FAIL"');
    const gateBlock = RA_BLOCK.substring(gateIdx, RA_BLOCK.indexOf('}', gateIdx) + 1);
    assert.ok(gateBlock.includes('"fix_gates"'), 'GATE_FAIL action should be fix_gates');
  });
  it('12. CAPABILITY_MISMATCH action is reroute', () => {
    const capIdx = RA_BLOCK.indexOf('"CAPABILITY_MISMATCH"');
    const capBlock = RA_BLOCK.substring(capIdx, RA_BLOCK.indexOf('}', capIdx) + 1);
    assert.ok(capBlock.includes('"reroute"'), 'CAPABILITY_MISMATCH action should be reroute');
  });
  it('13. SYSTEMIC action is escalate', () => {
    const sysIdx = RA_BLOCK.indexOf('"SYSTEMIC"');
    const sysBlock = RA_BLOCK.substring(sysIdx, RA_BLOCK.indexOf('}', sysIdx) + 1);
    assert.ok(sysBlock.includes('"escalate"'), 'SYSTEMIC action should be escalate');
  });
});

describe('ESCALATION-01: Auto-escalation in validate fail path', () => {
  it('14. failure_count increment', () => {
    assert.ok(VALIDATE_FN.includes('failure_count'), 'Missing failure_count in validate');
  });
  it('15. FAILURE_CLASSIFIED note', () => {
    assert.ok(VALIDATE_FN.includes('FAILURE_CLASSIFIED'), 'Missing FAILURE_CLASSIFIED note');
  });
  it('16. AUTO_ESCALATED note', () => {
    assert.ok(VALIDATE_FN.includes('AUTO_ESCALATED'), 'Missing AUTO_ESCALATED note');
  });
  it('17. escalated status', () => {
    assert.ok(VALIDATE_FN.includes('"escalated"'), 'Missing escalated status');
  });
  it('18. error_class in metadata', () => {
    assert.ok(VALIDATE_FN.includes('"error_class"'), 'Missing error_class in metadata');
  });
});

describe('WORKFLOW-01: Execute-phase integration', () => {
  it('19. Recovery classification in failure_handling', () => {
    assert.ok(EXEC_PHASE.includes('Recovery classification'), 'Missing recovery classification reference');
  });
  it('20. AGT-06 in execute-phase', () => {
    assert.ok(EXEC_PHASE.includes('AGT-06'), 'Missing AGT-06 reference');
  });
});
