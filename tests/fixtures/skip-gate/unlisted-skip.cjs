'use strict';
/**
 * A test file with one DELIBERATELY UNLISTED skip (plan 88-19). Not named
 * *.test.cjs, so the default glob never runs it; tests/88-19-skip-gate.test.cjs
 * drives it through scripts/run-tests.cjs to prove the gate turns a green run red.
 */

const { test } = require('node:test');

test('88-19 fixture: this one passes', () => {});

test('88-19 fixture: deliberate unlisted skip', (t) => {
  t.skip('deliberate 88-19 mutation: this skip has no entry in tests/skip-exceptions.d/');
});
