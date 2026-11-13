'use strict';
/**
 * A test process that leaves behind something that LOOKS like a daemon and that
 * nothing registered (plan 89-15). Deliberately NOT named *.test.cjs, so the
 * default test glob never runs it; tests/89-15-process-registry.test.cjs drives
 * it through scripts/run-tests.cjs.
 *
 * It is the shape of a daemon started through a product path rather than
 * `startFixtureDaemon`: the command line is a daemon's
 * (`<interpreter> <dir>/services/amauta-daemon.py run`), NO registry line
 * names it, and it does not register itself. The runner must report it and
 * never signal it — a process that only LOOKS like one of ours is exactly what
 * the operator's live daemon is.
 *
 * The "daemon" is a node stand-in: `GSD_8915_LOOKALIKE_DIR` is a throw-away
 * directory the driving test created, holding `services/amauta-daemon.py` with
 * one line of JavaScript in it. No product process is started.
 *
 * It prints `UNREGISTERED_PID=<pid>` and exits, leaving the stand-in to the
 * driving test, which stops it by that exact pid.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = process.env.GSD_8915_LOOKALIKE_DIR;
if (!dir) {
  fs.writeSync(2, 'unregistered-daemon: GSD_8915_LOOKALIKE_DIR is not set\n');
  process.exit(2);
}

// Detached, with no pipe back to this process, so it outlives it on every
// platform; and with none of the run's variables, as a process started through
// a scrubbed environment would have none.
const child = spawn(process.execPath, [path.join(dir, 'services', 'amauta-daemon.py'), 'run'], {
  detached: true,
  stdio: 'ignore',
  env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' },
});
child.unref();

const line = 'UNREGISTERED_PID=' + child.pid + '\n';
fs.writeSync(1, line);
fs.writeSync(2, line);
// Long enough for the stand-in to be a live process with its final command
// line when the runner reads the process table, short enough to stay cheap.
setTimeout(() => process.exit(0), 1000);
