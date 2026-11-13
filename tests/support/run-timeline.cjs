'use strict';
/**
 * Run timeline (Phase 89, plan 89-15): which test file was running when.
 *
 * Preloaded into every node process of a run through `NODE_OPTIONS` by
 * `scripts/run-tests.cjs`. A process whose entry script lives under `tests/`
 * appends one `file-start` line to `GSD_RUN_TIMELINE` when it starts and one
 * `file-end` line when it exits, and names itself in `GSD_TEST_OWNER` for the
 * processes it goes on to start; every other process does nothing at all.
 *
 * The stray-process report uses it to name the test files that were running at
 * the moment a process NOBODY registered was created — a daemon started
 * through a product path rather than a fixture has no registry line, its
 * parents are usually gone by the end of the run, and its creation time is the
 * one fact left to attribute it by.
 *
 * It must never break the process it is loaded into: every failure is swallowed.
 *
 * @module tests/support/run-timeline
 */

const fs = require('fs');
const path = require('path');

(function arm() {
  const file = process.env.GSD_RUN_TIMELINE;
  const entry = process.argv[1];
  // NODE_TEST_CONTEXT marks a process `node --test` started for ONE test file.
  // The `node --test` process itself carries every file on its command line —
  // its argv[1] is merely the first of them — and must not pass for that file.
  if (!file || !entry || !process.env.NODE_TEST_CONTEXT) return;
  try {
    const testsDir = path.resolve(__dirname, '..');
    const rel = path.relative(testsDir, path.resolve(entry));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const name = 'tests/' + rel.split(path.sep).join('/');
    const write = (event) => {
      try {
        fs.appendFileSync(file, JSON.stringify({ event, file: name, pid: process.pid, at: Date.now() }) + '\n');
      } catch (_e) {
        /* the run directory is already gone: nothing to record into */
      }
    };
    write('file-start');
    process.on('exit', () => write('file-end'));
    // Whatever this test file starts — directly, or three processes down through
    // a CLI — inherits its name, so a daemon that registers ITSELF
    // (tests/support/pythonpath/sitecustomize.py) can say which file it was
    // started under. Only the first test-file process on the way down sets it.
    if (!process.env.GSD_TEST_OWNER) process.env.GSD_TEST_OWNER = name;
  } catch (_e) {
    /* never break the process this is preloaded into */
  }
})();
