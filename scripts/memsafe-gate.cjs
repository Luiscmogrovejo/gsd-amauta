#!/usr/bin/env node
/**
 * MEMSAFE gate runner — the single entry point for CI and for local repro.
 *
 * Runs both halves of the memory-safety suite and fails the process if either
 * half fails:
 *
 *   1. tests/85-01-memsafe-containment.test.cjs  (node:test — no DB, no daemon)
 *   2. tests/test_85_memsafe_counter_proofs.py   (pytest — its OWN ephemeral DB)
 *
 * Exit-code discipline. Every child is run with execFileSync and its status is
 * checked explicitly; nothing is piped anywhere, because a gate in this repo has
 * twice been read through `| tail` and reported the exit status of `tail`
 * instead of the gate. `stdio: 'inherit'` means the output the reader sees is
 * the output the status came from.
 *
 * Environment:
 *   GSD_MEMSAFE_REQUIRE_PG=1  make an unreachable PostgreSQL a FAILURE rather
 *                             than a skip. CI sets this so an unrun suite can
 *                             never present itself as a green gate.
 *   GSD_MEMSAFE_PYTHON        python interpreter (default: python3)
 *
 * Usage:
 *   node scripts/memsafe-gate.cjs
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PYTHON = process.env.GSD_MEMSAFE_PYTHON || 'python3';

const NODE_TEST = 'tests/85-01-memsafe-containment.test.cjs';
const PY_TEST = 'tests/test_85_memsafe_counter_proofs.py';

/**
 * Run one child and return its exit status. Never throws for a non-zero exit.
 *
 * @param {string} label human name for the report line
 * @param {string} cmd executable
 * @param {string[]} args argv
 * @returns {number} exit status (127 if the executable is missing)
 */
function run(label, cmd, args) {
  process.stdout.write(`\n=== MEMSAFE gate: ${label} ===\n$ ${cmd} ${args.join(' ')}\n`);
  try {
    execFileSync(cmd, args, { cwd: REPO, stdio: 'inherit', env: process.env });
    return 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(`[memsafe-gate] ${cmd} not found on PATH\n`);
      return 127;
    }
    // execFileSync reports the child's exit code on .status; a signal death
    // has status null, which must NOT be read as success.
    return typeof err.status === 'number' ? err.status : 1;
  }
}

const results = [
  ['containment + debounce (node:test)', run('containment + debounce (node:test)',
    process.execPath, ['--test', NODE_TEST])],
  ['counter-proofs CP1-CP5 (pytest)', run('counter-proofs CP1-CP5 (pytest)',
    PYTHON, ['-m', 'pytest', PY_TEST, '-v', '-p', 'no:cacheprovider'])],
];

process.stdout.write('\n=== MEMSAFE gate summary ===\n');
let failed = 0;
for (const [label, status] of results) {
  process.stdout.write(`${status === 0 ? 'PASS' : 'FAIL'}  ${label}  (exit ${status})\n`);
  if (status !== 0) failed += 1;
}

if (failed > 0) {
  process.stderr.write(`\nMEMSAFE gate FAILED (${failed}/${results.length} suites red)\n`);
  process.exit(1);
}
process.stdout.write('\nMEMSAFE gate PASSED\n');
process.exit(0);
