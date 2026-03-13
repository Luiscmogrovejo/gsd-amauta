#!/usr/bin/env node
// Cross-platform test runner — resolves test file globs via Node
// instead of relying on shell expansion (which fails on Windows PowerShell/cmd).
// Propagates NODE_V8_COVERAGE so c8 collects coverage from the child process.
'use strict';

const { readdirSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');

const testDir = join(__dirname, '..', 'tests');
// Sort test files alphabetically, but ensure integration tests (e2e, gsd-amauta,
// degradation) run last in stable order to avoid shared-PG data conflicts.
const LAST_TESTS = ['degradation.test.cjs', 'e2e-lifecycle.test.cjs', 'gsd-amauta.test.cjs'];
const allFiles = readdirSync(testDir).filter(f => f.endsWith('.test.cjs'));
const unitTests = allFiles.filter(f => !LAST_TESTS.includes(f)).sort();
const integrationTests = LAST_TESTS.filter(f => allFiles.includes(f));
const files = [...unitTests, ...integrationTests].map(f => join('tests', f));

if (files.length === 0) {
  console.error('No test files found in tests/');
  process.exit(1);
}

try {
  execFileSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: { ...process.env },
  });
} catch (err) {
  process.exit(err.status || 1);
}
