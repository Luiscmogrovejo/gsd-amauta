'use strict';
/**
 * Leaky test process for the fixture RLM (plan 88-16-05). Deliberately NOT
 * named `*.test.cjs`, so the default test glob never runs it;
 * `tests/88-12-stray-process.test.cjs` drives its daemon sibling the same way,
 * and the plan's leak proof drives this one through `scripts/run-tests.cjs`.
 *
 * It starts a fixture RLM, prints `LEAKED_PID=<pid>` and then dies with
 * SIGKILL before any `finally` could stop it: the case the process ledger
 * exists to catch. Plan 88-16-05 requires the ledger to cover the RLM, not
 * only the daemon — a fixture that leaks a process is the incident this phase
 * already had once.
 */

const fs = require('fs');
const path = require('path');
const { startFixtureRlm } = require(path.join(__dirname, '..', '..', 'support', 'fixture-rlm.cjs'));

(async () => {
  // Windows: a non-detached child dies with its parent (libuv job object), so
  // the leak could not happen; detach there so it survives, as it does on POSIX.
  const h = await startFixtureRlm({ detached: process.platform === 'win32' });
  const line = 'LEAKED_PID=' + h.proc.pid + ' LEAKED_PORT=' + h.port + '\n';
  // Synchronous writes: the next statement kills this process.
  fs.writeSync(1, line);
  fs.writeSync(2, line);
  process.kill(process.pid, 'SIGKILL');
})();
