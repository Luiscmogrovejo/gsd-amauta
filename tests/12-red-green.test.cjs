#!/usr/bin/env node
/**
 * Plan 12-04-03: _checkRedGreenOrder() unit tests.
 *
 * Tests the `_checkRedGreenOrder(gitLogOutput, bugId)` pure logic function
 * exported from gsd-amauta.cjs. No daemon access required.
 *
 * 7 test cases covering: correct order, wrong order, missing RED, missing GREEN,
 * no commits, case insensitive matching, null input.
 *
 * Run: node --test tests/12-red-green.test.cjs
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AMAUTA_CJS = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');

let _checkRedGreenOrder;
try {
  const mod = require(AMAUTA_CJS);
  _checkRedGreenOrder = mod._checkRedGreenOrder;
} catch (e) {
  _checkRedGreenOrder = null;
}

// ─── Guard: module load ────────────────────────────────────────────────────────

describe('Module load', () => {
  it('gsd-amauta.cjs exports _checkRedGreenOrder', () => {
    assert.ok(
      typeof _checkRedGreenOrder === 'function',
      `Expected _checkRedGreenOrder to be a function — got ${typeof _checkRedGreenOrder}. ` +
      'Ensure gsd-amauta.cjs exports { _checkRedGreenOrder } in module.exports.'
    );
  });
});

// ─── RED-GREEN commit order detection ────────────────────────────────────────

describe('RED-GREEN commit order detection', () => {
  it('1. correct RED-before-GREEN order', () => {
    if (!_checkRedGreenOrder) return;
    const input = 'abc1234 test(red): reproduce BG-0042 -- null check missing\ndef5678 fix: intermediate\nghi9012 fix(green): resolve BG-0042 -- add null guard';
    const result = _checkRedGreenOrder(input, 'BG-0042');
    assert.strictEqual(result.hasRed, true);
    assert.strictEqual(result.hasGreen, true);
    assert.strictEqual(result.correctOrder, true);
    assert.match(result.reason, /correct/i);
  });

  it('2. wrong GREEN-before-RED order', () => {
    if (!_checkRedGreenOrder) return;
    const input = 'abc1234 fix(green): resolve BG-0042 -- add null guard\ndef5678 test(red): reproduce BG-0042 -- null check';
    const result = _checkRedGreenOrder(input, 'BG-0042');
    assert.strictEqual(result.hasRed, true);
    assert.strictEqual(result.hasGreen, true);
    assert.strictEqual(result.correctOrder, false);
    assert.match(result.reason, /wrong order/i);
  });

  it('3. missing RED commit', () => {
    if (!_checkRedGreenOrder) return;
    const input = 'abc1234 fix(green): resolve BG-0042 -- add null guard';
    const result = _checkRedGreenOrder(input, 'BG-0042');
    assert.strictEqual(result.hasRed, false);
    assert.strictEqual(result.hasGreen, true);
    assert.strictEqual(result.correctOrder, false);
    assert.match(result.reason, /RED commit/i);
  });

  it('4. missing GREEN commit', () => {
    if (!_checkRedGreenOrder) return;
    const input = 'abc1234 test(red): reproduce BG-0042 -- null check';
    const result = _checkRedGreenOrder(input, 'BG-0042');
    assert.strictEqual(result.hasRed, true);
    assert.strictEqual(result.hasGreen, false);
    assert.strictEqual(result.correctOrder, false);
    assert.match(result.reason, /GREEN commit/i);
  });

  it('5. no commits at all', () => {
    if (!_checkRedGreenOrder) return;
    const result = _checkRedGreenOrder('', 'BG-0042');
    assert.strictEqual(result.hasRed, false);
    assert.strictEqual(result.hasGreen, false);
    assert.strictEqual(result.correctOrder, false);
    assert.match(result.reason, /no red\/green commits/i);
  });

  it('6. case insensitive matching', () => {
    if (!_checkRedGreenOrder) return;
    const input = 'abc1234 TEST(RED): reproduce BG-0042\ndef5678 FIX(GREEN): resolve BG-0042';
    const result = _checkRedGreenOrder(input, 'BG-0042');
    assert.strictEqual(result.hasRed, true);
    assert.strictEqual(result.hasGreen, true);
    assert.strictEqual(result.correctOrder, true);
  });

  it('7. null input', () => {
    if (!_checkRedGreenOrder) return;
    const result = _checkRedGreenOrder(null, 'BG-0042');
    assert.strictEqual(result.hasRed, false);
    assert.strictEqual(result.hasGreen, false);
    assert.strictEqual(result.correctOrder, false);
  });
});
