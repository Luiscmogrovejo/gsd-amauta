#!/usr/bin/env node
/**
 * Plan 06-03: RPETD Gate Audit + Force-Reason Persistence Tests
 *
 * Tests:
 *   GATE-R: R-phase substance gate
 *     1. R_PHASE_SUBSTANCE gate exists in _validate_all_gates
 *     2. R-phase 50-char threshold present
 *   GATE-P: P-phase substance gate
 *     3. P_PHASE_SUBSTANCE gate exists in _validate_all_gates
 *     4. P-phase 50-char threshold present (at least 2 occurrences of >= 50 in gates)
 *   GATE-T: Non-code T-phase threshold raised
 *     5. Non-code T-phase uses >= 50 (not > 20)
 *     6. Error message references >=50 chars
 *   PHASE-ORDER: Phase-order warning
 *     7. PHASE_ORDER list exists in rpetd command
 *     8. Warning message for out-of-order phases
 *     9. AGT-04 audit comment present
 *    10. Warning is soft (no sys.exit in phase-order block)
 *   FORCE-01: Force-reason persistence
 *    11. FORCE_OVERRIDE note appended on self-validation override
 *    12. FORCE_OVERRIDE note includes failed gates context
 *    13. force_reason in validation metadata
 *    14. "forced" boolean in validation metadata
 *    15. AGT-05 fix comment present
 *   FORCE-02: Force flag consistency
 *    16. --force-reason argument defined in argparse
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');

// Isolate _validate_all_gates function body
const gatesStart = AMAUTA.indexOf('def _validate_all_gates(');
const gatesEnd = AMAUTA.indexOf('\ndef ', gatesStart + 1);
const GATES_FN = gatesStart >= 0 ? AMAUTA.substring(gatesStart, gatesEnd) : '';

// Isolate cmd_rpetd function body
const rpetdStart = AMAUTA.indexOf('def cmd_rpetd(');
const rpetdEnd = AMAUTA.indexOf('\ndef ', rpetdStart + 1);
const RPETD_FN = rpetdStart >= 0 ? AMAUTA.substring(rpetdStart, rpetdEnd) : '';

// Isolate cmd_validate function body
const validateStart = AMAUTA.indexOf('def cmd_validate(');
const validateEnd = AMAUTA.indexOf('\ndef ', validateStart + 1);
const VALIDATE_FN = validateStart >= 0 ? AMAUTA.substring(validateStart, validateEnd) : '';

describe('GATE-R: R-phase substance gate', () => {
  it('1. R_PHASE_SUBSTANCE gate exists in _validate_all_gates', () => {
    assert.ok(GATES_FN.includes('R_PHASE_SUBSTANCE'), 'Missing R_PHASE_SUBSTANCE gate in _validate_all_gates');
  });

  it('2. R-phase 50-char threshold present', () => {
    assert.ok(
      GATES_FN.includes('>= 50') || GATES_FN.includes('>=50'),
      'Missing >= 50 threshold for R-phase in _validate_all_gates'
    );
  });
});

describe('GATE-P: P-phase substance gate', () => {
  it('3. P_PHASE_SUBSTANCE gate exists in _validate_all_gates', () => {
    assert.ok(GATES_FN.includes('P_PHASE_SUBSTANCE'), 'Missing P_PHASE_SUBSTANCE gate in _validate_all_gates');
  });

  it('4. P-phase 50-char threshold (at least 2 occurrences of >= 50 for R and P)', () => {
    const matches = GATES_FN.match(/>= 50/g) || [];
    assert.ok(
      matches.length >= 2,
      `Expected at least 2 occurrences of ">= 50" in _validate_all_gates, found ${matches.length}`
    );
  });
});

describe('GATE-T: Non-code T-phase threshold raised', () => {
  it('5. Non-code T-phase does not use old > 20 threshold', () => {
    // The non-code T check should use >= 50, not > 20
    assert.ok(
      !GATES_FN.includes('> 20'),
      'Old > 20 threshold still present in _validate_all_gates -- should be >= 50'
    );
  });

  it('6. Error message references >=50 chars', () => {
    assert.ok(
      GATES_FN.includes('>=50 chars') || GATES_FN.includes('>= 50 chars'),
      'T-phase error message should reference >=50 chars'
    );
  });
});

describe('PHASE-ORDER: Phase-order warning', () => {
  it('7. PHASE_ORDER list exists in amauta.py', () => {
    assert.ok(AMAUTA.includes('PHASE_ORDER'), 'Missing PHASE_ORDER list in amauta.py');
  });

  it('8. Warning message for out-of-order phases', () => {
    assert.ok(
      AMAUTA.includes('earlier phases are empty') || RPETD_FN.includes('Warning'),
      'Missing phase-order warning message in amauta.py'
    );
  });

  it('9. AGT-04 audit comment present', () => {
    assert.ok(AMAUTA.includes('AGT-04 audit'), 'Missing AGT-04 audit comment in amauta.py');
  });

  it('10. Warning is soft -- no sys.exit in phase-order check block', () => {
    const orderIdx = RPETD_FN.indexOf('PHASE_ORDER');
    if (orderIdx >= 0) {
      const nearbyCode = RPETD_FN.substring(orderIdx, orderIdx + 500);
      assert.ok(
        !nearbyCode.includes('sys.exit'),
        'Phase-order warning block should not hard-block with sys.exit'
      );
    } else {
      // PHASE_ORDER may be in broader scope -- check entire rpetd function
      assert.ok(
        !RPETD_FN.includes('sys.exit') || RPETD_FN.indexOf('sys.exit') > RPETD_FN.indexOf('PHASE_ORDER') + 500,
        'sys.exit found too close to PHASE_ORDER -- warning should be soft'
      );
    }
  });
});

describe('FORCE-01: Force-reason persistence', () => {
  it('11. FORCE_OVERRIDE note appended on self-validation override', () => {
    assert.ok(
      VALIDATE_FN.includes('FORCE_OVERRIDE'),
      'Missing FORCE_OVERRIDE note in cmd_validate (self-validation path)'
    );
  });

  it('12. FORCE_OVERRIDE includes failed gates context', () => {
    // Second FORCE_OVERRIDE should reference failed gates
    const firstIdx = VALIDATE_FN.indexOf('FORCE_OVERRIDE');
    const secondIdx = VALIDATE_FN.indexOf('FORCE_OVERRIDE', firstIdx + 1);
    assert.ok(
      secondIdx >= 0,
      'Expected at least 2 FORCE_OVERRIDE occurrences in cmd_validate (self-validation + gate failure)'
    );
    const gateOverrideBlock = VALIDATE_FN.substring(secondIdx, secondIdx + 300);
    assert.ok(
      gateOverrideBlock.includes('gate') || gateOverrideBlock.includes('Gate'),
      'Second FORCE_OVERRIDE should reference failed gates'
    );
  });

  it('13. force_reason in validation metadata dict', () => {
    assert.ok(
      VALIDATE_FN.includes('"force_reason"'),
      'Missing "force_reason" key in validation metadata'
    );
  });

  it('14. "forced" boolean in validation metadata', () => {
    assert.ok(
      VALIDATE_FN.includes('"forced"'),
      'Missing "forced" boolean in validation metadata'
    );
  });

  it('15. AGT-05 fix comment present', () => {
    assert.ok(AMAUTA.includes('AGT-05 fix'), 'Missing AGT-05 fix comment in amauta.py');
  });
});

describe('FORCE-02: Force flag consistency', () => {
  it('16. --force-reason argument defined in argparse', () => {
    assert.ok(
      AMAUTA.includes('force-reason') || AMAUTA.includes('force_reason'),
      'Missing --force-reason argument definition in argparse setup'
    );
  });
});
