/**
 * TEMPORARY — plan 88-19 red proof. This commit is REVERTED in the next one.
 *
 * One deliberately UNLISTED skip, in the default test glob, so every Node cell runs
 * it and the skip gate must turn every one of them red with exit 6. Without this the
 * only evidence that the gate ENFORCES on ubuntu, macOS and Windows would be a local
 * mutation on darwin plus an inference.
 */

'use strict';

const { test } = require('node:test');

test('88-19 red proof: this one passes', () => {});

test('88-19 red proof: a deliberately unlisted skip', (t) => {
  t.skip('88-19 red proof: no entry in tests/skip-exceptions.json; this commit is reverted');
});
