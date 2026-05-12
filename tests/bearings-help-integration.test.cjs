'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const helpPath = path.resolve(__dirname, '..', 'get-shit-done', 'workflows', 'help.md');
const content = fs.readFileSync(helpPath, 'utf8');

test('help.md contains dynamic bearings preamble', () => {
  assert.match(content, /<bearings>/, 'help.md must contain <bearings> block');
  assert.match(content, /gsd-tools\.cjs.*bearings/, 'help.md must reference gsd-tools.cjs bearings');
  assert.match(content, /^## Reference$/m, 'help.md must contain ## Reference header');
});

test('help.md static reference body is preserved', () => {
  assert.match(content, /<reference>/, 'help.md must preserve <reference> opener');
  assert.match(content, /<\/reference>/, 'help.md must preserve </reference> closer');
  assert.match(content, /# GSD-Amauta Command Reference/, 'help.md must preserve GSD-Amauta Command Reference heading');
});

test('## Reference header appears BEFORE the <reference> opener', () => {
  const refHeaderIdx = content.search(/^## Reference$/m);
  const refOpenerIdx = content.indexOf('<reference>');
  assert.ok(refHeaderIdx > -1, '## Reference header missing from help.md');
  assert.ok(refOpenerIdx > -1, '<reference> opener missing from help.md');
  assert.ok(refHeaderIdx < refOpenerIdx, '## Reference must appear BEFORE <reference> opener');
});
