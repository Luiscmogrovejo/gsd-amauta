#!/usr/bin/env node
// HARDEN-05 behavioral test runner (plan 13.1-05-01)
//
// Runs every test file under tests/ matching /\.integration\.test\.cjs$/.
// Each file is invoked in its own child process via `node --test <file>`.
// Exit code: 0 if every file exits 0, non-zero otherwise.
//
// Failure diagnostics contract (HARDEN-05):
//   Behavioral tests preserve temp directories on failure at /tmp/gsd-13.1-*.
//   This runner does NOT clean them up — they are the post-mortem payload.
//   CI uploads them as `behavioral-failure-artifacts`. Locally, clean up with:
//     rm -rf /tmp/gsd-13.1-*
//
// This runner is deliberately thin. The first invocation (before any
// integration test file exists) is expected to print `Behavioral: 0/0 passed`
// and exit 0 — the acceptance criterion for plan 13.1-05-01 grep-checks for
// the "Behavioral:" string, not for a non-empty test set.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = path.join(__dirname, '..', 'tests');
const PATTERN = /\.integration\.test\.cjs$/;

function findTests() {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => PATTERN.test(f))
    .sort()
    .map((f) => path.join(TEST_DIR, f));
}

function runTest(filePath) {
  const result = spawnSync(process.execPath, ['--test', filePath], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  return result;
}

function main() {
  const tests = findTests();
  let failed = 0;
  for (const t of tests) {
    process.stdout.write(`\n--- ${path.relative(process.cwd(), t)} ---\n`);
    const result = runTest(t);
    if (result.status !== 0) failed++;
  }
  const passed = tests.length - failed;
  console.log(`Behavioral: ${passed}/${tests.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
