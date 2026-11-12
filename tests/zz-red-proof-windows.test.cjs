'use strict';
// THROWAWAY (plan 88-15 task 10, step 3). Proves the newly REQUIRED Windows
// Node cell can actually conclude `failure`. Deleted with the branch.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('RED PROOF: this fails on Windows only', () => {
  assert.notEqual(process.platform, 'win32',
    'deliberate failure: proving test (windows-latest, node N) can go red');
});
