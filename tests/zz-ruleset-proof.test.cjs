'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Throwaway: proves the branch ruleset blocks a red pull request. Never merged.
test('ruleset block proof: deliberately failing', () => { assert.equal(1, 2); });
