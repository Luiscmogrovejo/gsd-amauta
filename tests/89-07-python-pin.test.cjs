/**
 * Phase 89 plan 89-07: an explicit `GSD_PYTHON` is never silently replaced.
 *
 * Plan 89-04 routed the `test (windows-latest, node 20)` stray-process flake
 * here: the suite reported `fail 0` and then the runner's stray check found a
 * live `services/amauta-daemon.py run` plus its `rlm-service.py` child, both
 * spawned by `C:\hostedtoolcache\windows\Python\3.15.2\x64\python.exe` while
 * the job exports `GSD_PYTHON=…\Python\3.12.10\x64\python.exe`. Re-measured on
 * this plan's own run 43354540890, same cell, same mismatch.
 *
 * 3.15.2 is the newest Python in the runner's tool cache, which is exactly what
 * `py -3` selects — the SECOND candidate of the Windows order. So the resolver
 * had abandoned the pin, and the only way it does that is a probe that failed.
 * Under a `node --test` fan-out on a Windows runner a Python start-up can
 * exceed the 10 s probe budget, and a timeout says nothing about the
 * interpreter.
 *
 * The fix, pinned here: an INCONCLUSIVE probe (timeout, or a kill by signal) of
 * the explicit pin is retried with a longer budget and then trusted; a
 * CONCLUSIVE rejection still falls through, so a wrong `GSD_PYTHON` is still
 * caught. Nothing here spawns a real interpreter: the probe seam is injected.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const platform = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));

const OK3 = { status: 0, stdout: '3\n' };
const PINNED = 'C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe';

/** A probe that timed out: `error.code === 'ETIMEDOUT'` and a kill signal. */
const TIMED_OUT = {
  status: null,
  stdout: '',
  signal: 'SIGTERM',
  error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
};

/** A probe that answered: the file is not there. */
const NOT_THERE = {
  status: 127,
  stdout: '',
  error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
};

/**
 * A recording probe seam.
 *
 * @param {object} table - command -> result.
 * @returns {Function} the probe, with a `.calls` array.
 */
function probeTable(table) {
  const fn = (command, args) => {
    fn.calls.push([command, ...args].join(' '));
    return table[command] === undefined ? NOT_THERE : table[command];
  };
  fn.calls = [];
  return fn;
}

describe('89-07 GSD_PYTHON is a declaration, not a hint', () => {
  test('a timed-out probe of the pin does NOT hand the caller `py -3`', () => {
    const probe = probeTable({ [PINNED]: TIMED_OUT, py: OK3, python: OK3, python3: OK3 });
    const got = platform.resolvePython({
      probe, noCache: true, platform: 'win32', env: { GSD_PYTHON: PINNED },
    });
    assert.deepStrictEqual(got, { command: PINNED, args: [] },
      'the pinned interpreter must be returned, not the tool cache\'s newest Python');
    assert.ok(!probe.calls.some((c) => c.startsWith('py -3')),
      'and `py -3`, whose answer is 3.15.2 on that runner, is never even probed: '
      + probe.calls.join(' | '));
  });

  test('the pin is retried once with a longer budget before it is trusted', () => {
    const probe = probeTable({ [PINNED]: TIMED_OUT });
    platform.resolvePython({ probe, noCache: true, platform: 'win32', env: { GSD_PYTHON: PINNED } });
    const pinCalls = probe.calls.filter((c) => c.startsWith(PINNED));
    assert.strictEqual(pinCalls.length, 2, 'probed twice: ' + probe.calls.join(' | '));
  });

  test('a probe killed by a signal counts as inconclusive too', () => {
    const killed = { status: null, stdout: '', signal: 'SIGKILL', error: null };
    const probe = probeTable({ [PINNED]: killed, py: OK3 });
    assert.deepStrictEqual(
      platform.resolvePython({ probe, noCache: true, platform: 'win32', env: { GSD_PYTHON: PINNED } }),
      { command: PINNED, args: [] },
    );
  });

  test('a CONCLUSIVE rejection still falls through, so a wrong pin is still caught', () => {
    for (const answer of [
      NOT_THERE,
      { status: 9009, stdout: '' },        // the Microsoft Store stub
      { status: 0, stdout: '2\n' },        // a Python 2
      { status: 0, stdout: 'banana\n' },   // not a version at all
    ]) {
      const probe = probeTable({ [PINNED]: answer, py: OK3 });
      assert.deepStrictEqual(
        platform.resolvePython({ probe, noCache: true, platform: 'win32', env: { GSD_PYTHON: PINNED } }),
        { command: 'py', args: ['-3'] },
        'a pin the probe REJECTED must not be used: ' + JSON.stringify(answer),
      );
    }
  });

  test('an inconclusive probe of an UNPINNED candidate is still a rejection', () => {
    // Only the explicit pin earns the benefit of the doubt. A PATH candidate
    // that times out is simply skipped, as before.
    const probe = probeTable({ python3: TIMED_OUT, python: OK3 });
    assert.deepStrictEqual(
      platform.resolvePython({ probe, noCache: true, platform: 'darwin', env: {} }),
      { command: 'python', args: [] },
    );
  });

  test('a verified pin behaves exactly as it did before, on all three platforms', () => {
    for (const plat of ['darwin', 'linux', 'win32']) {
      const probe = probeTable({ [PINNED]: OK3, py: OK3, python: OK3, python3: OK3 });
      assert.deepStrictEqual(
        platform.resolvePython({ probe, noCache: true, platform: plat, env: { GSD_PYTHON: PINNED } }),
        { command: PINNED, args: [] },
        plat,
      );
      assert.strictEqual(probe.calls.length, 1, plat + ': one probe, no fall-through');
    }
  });

  test('with no pin, nothing about the old order changed', () => {
    const probe = probeTable({ py: OK3, python: OK3, python3: OK3 });
    assert.deepStrictEqual(
      platform.resolvePython({ probe, noCache: true, platform: 'win32', env: {} }),
      { command: 'py', args: ['-3'] },
    );
    const posix = probeTable({ python: OK3, python3: OK3 });
    assert.deepStrictEqual(
      platform.resolvePython({ probe: posix, noCache: true, platform: 'darwin', env: {} }),
      { command: 'python3', args: [] },
    );
  });

  test('the workflow still pins GSD_PYTHON, which is what makes this fix reachable', () => {
    const fs = require('fs');
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
    assert.ok(wf.includes('GSD_PYTHON=$PY'),
      'the `Pin GSD_PYTHON to the setup-python interpreter` step is the pin this '
      + 'resolver must honour; if it is gone, re-measure before trusting this test');
  });
});
