'use strict';
/**
 * A test file that leaks one process AND skips something unlisted (plan 88-19).
 * Not named *.test.cjs, so the default glob never runs it.
 *
 * It records a detached sleeper in the run's process ledger and never stops it, so
 * `scripts/run-tests.cjs` reports STRAY PROCESS and sets status 5. The driving test
 * reaps the pid by number in a `finally`. A plain sleeper is used instead of a
 * fixture daemon on purpose: the point here is the STATUS, not the daemon, and the
 * runner's kill pass touches only processes its `identify()` recognises — so this
 * one is reported and left for its owner, which is exactly the contract.
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

test('88-19 fixture: leak a process into the run ledger', () => {
  const ledger = process.env.GSD_PROCESS_LEDGER;
  assert.ok(ledger, 'GSD_PROCESS_LEDGER must be set by the runner');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  fs.appendFileSync(
    ledger,
    JSON.stringify({ event: 'started', kind: 'daemon', pid: child.pid, port: null, dataDir: null }) + '\n'
  );
  fs.writeSync(1, 'LEAKED_PID=' + child.pid + '\n');
  fs.writeSync(2, 'LEAKED_PID=' + child.pid + '\n');
});

test('88-19 fixture: and skip something unlisted at the same time', (t) => {
  t.skip('deliberate 88-19 mutation: an unlisted skip beside a leaked process');
});
