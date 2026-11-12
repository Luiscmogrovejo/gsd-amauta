'use strict';
/**
 * Leaky test process (plan 88-12). Deliberately NOT named *.test.cjs, so the default
 * test glob never runs it; tests/88-12-stray-process.test.cjs drives it through
 * scripts/run-tests.cjs.
 *
 * It starts a fixture daemon, prints LEAKED_PID=<pid> and then dies with SIGKILL
 * before any `finally` could stop the daemon: the case the process ledger exists
 * to catch. The spawned daemon survives its parent.
 */

const fs = require('fs');
const path = require('path');
const { startFixtureDaemon } = require(path.join(__dirname, '..', '..', 'support', 'fixture-daemon.cjs'));

(async () => {
  // Windows: a non-detached child dies with its parent (libuv job object), so the leak could not
  // happen; detach the daemon there so it survives the SIGKILL below, as it does on POSIX.
  const h = await startFixtureDaemon({ detached: process.platform === 'win32' });
  const line = 'LEAKED_PID=' + h.proc.pid + ' LEAKED_PORT=' + h.port + '\n';
  // Synchronous writes: the next statement kills this process.
  fs.writeSync(1, line);
  fs.writeSync(2, line);
  process.kill(process.pid, 'SIGKILL');
})();
