#!/usr/bin/env node
/**
 * Phase 20 HANDOFF-05: Context handoff integration tests.
 *
 * Verifies that gsd-amauta.cjs has the compactRpetdContext function wired
 * correctly into the RPETD pipeline, following the best-effort pattern.
 *
 * Run: node --test tests/20-context-handoff.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read the source file for static analysis
const AMAUTA_PATH = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const AMAUTA = fs.readFileSync(AMAUTA_PATH, 'utf8');

describe('Phase 20: Context Handoff Wiring', () => {

  test('compactRpetdContext function exists', () => {
    assert.ok(
      AMAUTA.includes('async function compactRpetdContext'),
      'gsd-amauta.cjs must contain the compactRpetdContext function'
    );
  });

  test('compact endpoint path is /api/context/compact', () => {
    assert.ok(
      AMAUTA.includes('/api/context/compact'),
      'gsd-amauta.cjs must reference the /api/context/compact endpoint'
    );
  });

  test('compactRpetdContext is called from cmdRpetd', () => {
    // Find the cmdRpetd function body and check for the call
    const cmdRpetdStart = AMAUTA.indexOf('async function cmdRpetd');
    const cmdRpetdEnd = AMAUTA.indexOf('\nasync function', cmdRpetdStart + 1);
    const cmdRpetdBody = AMAUTA.substring(cmdRpetdStart, cmdRpetdEnd > cmdRpetdStart ? cmdRpetdEnd : cmdRpetdStart + 2000);
    assert.ok(
      cmdRpetdBody.includes('compactRpetdContext'),
      'cmdRpetd must call compactRpetdContext'
    );
  });

  test('compact call is guarded by useDaemon check', () => {
    // The call should be inside a useDaemon conditional
    const compactCallIdx = AMAUTA.indexOf('await compactRpetdContext');
    assert.ok(compactCallIdx > -1, 'Must have await compactRpetdContext call');
    // Check nearby lines for useDaemon guard
    const nearbyCode = AMAUTA.substring(Math.max(0, compactCallIdx - 200), compactCallIdx);
    assert.ok(
      nearbyCode.includes('useDaemon'),
      'compactRpetdContext call must be guarded by useDaemon check'
    );
  });

  test('compact call is guarded by exitCode === 0 check', () => {
    const compactCallIdx = AMAUTA.indexOf('await compactRpetdContext');
    assert.ok(compactCallIdx > -1);
    const nearbyCode = AMAUTA.substring(Math.max(0, compactCallIdx - 200), compactCallIdx);
    assert.ok(
      nearbyCode.includes('exitCode === 0') || nearbyCode.includes('exitCode == 0'),
      'compactRpetdContext call must be guarded by exitCode === 0 check'
    );
  });

  test('compactRpetdContext has try-catch for best-effort pattern', () => {
    const fnStart = AMAUTA.indexOf('async function compactRpetdContext');
    assert.ok(fnStart > -1);
    const fnBody = AMAUTA.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('try {') || fnBody.includes('try{'),
      'compactRpetdContext must use try/catch for best-effort error handling'
    );
    assert.ok(
      fnBody.includes('catch'),
      'compactRpetdContext must have a catch block'
    );
  });

  test('compact builds messages array with task and phase content', () => {
    const fnStart = AMAUTA.indexOf('async function compactRpetdContext');
    assert.ok(fnStart > -1);
    const fnBody = AMAUTA.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('messages') && fnBody.includes('role'),
      'compactRpetdContext must build a messages array with role fields'
    );
  });

  test('HANDOFF-05 phase comment is present', () => {
    assert.ok(
      AMAUTA.includes('HANDOFF-05'),
      'gsd-amauta.cjs must contain HANDOFF-05 requirement reference'
    );
  });

});

describe('Phase 20: No Regressions in Existing RPETD Wiring', () => {

  test('cmdRpetd still calls autoLearnFromRpetd', () => {
    const cmdRpetdStart = AMAUTA.indexOf('async function cmdRpetd');
    const cmdRpetdEnd = AMAUTA.indexOf('\nasync function', cmdRpetdStart + 1);
    const cmdRpetdBody = AMAUTA.substring(cmdRpetdStart, cmdRpetdEnd > cmdRpetdStart ? cmdRpetdEnd : cmdRpetdStart + 2000);
    assert.ok(
      cmdRpetdBody.includes('autoLearnFromRpetd'),
      'cmdRpetd must still call autoLearnFromRpetd (existing behavior preserved)'
    );
  });

  test('VALID_PHASES set still contains all 5 phases', () => {
    assert.ok(AMAUTA.includes("'R'"), 'VALID_PHASES must include R');
    assert.ok(AMAUTA.includes("'P'"), 'VALID_PHASES must include P');
    assert.ok(AMAUTA.includes("'E'"), 'VALID_PHASES must include E');
    assert.ok(AMAUTA.includes("'T'"), 'VALID_PHASES must include T');
    assert.ok(AMAUTA.includes("'D'"), 'VALID_PHASES must include D');
  });

});
