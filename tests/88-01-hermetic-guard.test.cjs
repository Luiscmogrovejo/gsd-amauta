/**
 * Phase 88 plan 88-01: the hermetic guard fails loudly.
 *
 * Phase success criterion 2: a deliberate test that opens a connection to the live
 * daemon port fails with a clear message.
 *
 * Safety: nothing in this file ever opens a socket to 18799, 18798, 6379 or 5433.
 * The throw-path assertions never call through to the real socket. The block/allow
 * behaviour is proven on a listener this test binds on a free port. No live port
 * is ever allow-listed.
 */

'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tests', 'support', 'hermetic-guard.cjs');
const { freePort } = require(path.join(ROOT, 'scripts', 'run-tests.cjs'));

/**
 * Run `node -e <code>` with the guard preloaded.
 * @param {string} code
 * @param {object} [extraEnv]
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function runGuarded(code, extraEnv = {}) {
  const env = { ...process.env, NODE_OPTIONS: '--require ' + GUARD, ...extraEnv };
  return spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf-8', timeout: 15000 });
}

describe('hermetic guard (Node)', () => {
  for (const port of [18799, 18798, 6379, 5433]) {
    test('connecting to live port ' + port + ' fails with HERMETIC GUARD', () => {
      const r = runGuarded("require('net').connect(" + port + ",'127.0.0.1')");
      assert.notStrictEqual(r.status, 0, 'child must exit non-zero');
      assert.ok(
        r.stderr.includes('HERMETIC GUARD: test tried to connect to live service port ' + port),
        'stderr: ' + r.stderr.slice(0, 400)
      );
    });
  }

  test('the message names the live daemon port exactly', () => {
    const r = runGuarded("require('net').connect(18799,'127.0.0.1')");
    assert.ok(
      r.stderr.includes('HERMETIC GUARD: test tried to connect to live service port 18799; use the fixture daemon'),
      r.stderr.slice(0, 400)
    );
  });

  test('the Socket.connect(port, host) call shape is blocked too', () => {
    const r = runGuarded("new (require('net').Socket)().connect(18799,'127.0.0.1')");
    assert.notStrictEqual(r.status, 0);
    assert.ok(r.stderr.includes('HERMETIC GUARD'), r.stderr.slice(0, 400));
  });

  test('a port that is not blocked is not touched by the guard', () => {
    const port = freePort(); // nothing listens here: ECONNREFUSED is the correct outcome
    const r = runGuarded("require('net').connect(" + port + ",'127.0.0.1').on('error',e=>{console.error(e.code);process.exit(1)})");
    assert.ok(!r.stderr.includes('HERMETIC GUARD'), r.stderr.slice(0, 400));
    assert.ok(r.stderr.includes('ECONNREFUSED'), r.stderr.slice(0, 400));
  });

  describe('block and allow on a port this test owns', () => {
    let listener;
    let P;
    let connections = 0;

    test('setup: bind a listener on a free port', async () => {
      listener = net.createServer((s) => {
        connections += 1;
        s.end();
      });
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      P = listener.address().port;
      assert.ok(![18799, 18798, 6379, 5433].includes(P));
    });

    test('GSD_HERMETIC_GUARD_BLOCK_PORTS blocks it', () => {
      const before = connections;
      const r = runGuarded("require('net').connect(" + P + ",'127.0.0.1')", {
        GSD_HERMETIC_GUARD_BLOCK_PORTS: String(P),
      });
      assert.notStrictEqual(r.status, 0);
      assert.ok(
        r.stderr.includes('HERMETIC GUARD: test tried to connect to live service port ' + P),
        r.stderr.slice(0, 400)
      );
      assert.strictEqual(connections, before, 'a blocked attempt must not reach the listener');
    });

    test('GSD_HERMETIC_GUARD_ALLOW_PORTS wins over the block list', async () => {
      const child = spawn(
        process.execPath,
        ['-e', "const c=require('net').connect(" + P + ",'127.0.0.1',()=>c.end())"],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: '--require ' + GUARD,
            GSD_HERMETIC_GUARD_BLOCK_PORTS: String(P),
            GSD_HERMETIC_GUARD_ALLOW_PORTS: String(P),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      const code = await new Promise((resolve) => child.on('exit', resolve));
      assert.strictEqual(code, 0, stderr.slice(0, 400));
      assert.ok(!stderr.includes('HERMETIC GUARD'));
      assert.strictEqual(connections >= 1, true, 'the listener must have seen the connection');
    });

    test('GSD_HERMETIC_GUARD=off disables the patch', async () => {
      const before = connections;
      const child = spawn(
        process.execPath,
        ['-e', "const c=require('net').connect(" + P + ",'127.0.0.1',()=>c.end())"],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: '--require ' + GUARD,
            GSD_HERMETIC_GUARD: 'off',
            GSD_HERMETIC_GUARD_BLOCK_PORTS: String(P),
          },
          stdio: 'ignore',
        }
      );
      const code = await new Promise((resolve) => child.on('exit', resolve));
      assert.strictEqual(code, 0);
      assert.ok(connections > before);
    });

    after(async () => {
      if (listener) await new Promise((resolve) => listener.close(resolve));
    });
  });

  test('a blocked attempt is appended to GSD_HERMETIC_GUARD_LOG', () => {
    const fs = require('fs');
    const os = require('os');
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-log-')), 'guard.log');
    runGuarded("require('net').connect(18799,'127.0.0.1')", { GSD_HERMETIC_GUARD_LOG: log });
    const line = fs.readFileSync(log, 'utf-8').split('\n')[0].split('\t');
    // Plan 88-16-03 widened the line from 4 columns (time, pid, port, argv) to
    // 8: the guard is default-deny for non-loopback destinations now, so a
    // reader of the log needs the MODE it was running in, which RUNTIME wrote
    // the line (the Python guard writes the same shape, and had no log at all
    // before), the HOST and the machine-readable REASON. Deliberate format
    // change, recorded in 88-16-RECORD.md; the property the old assertion
    // guarded — "the refused port is in the line" — is kept and strengthened.
    assert.strictEqual(line.length, 8, 'line: ' + JSON.stringify(line));
    assert.strictEqual(line[2], 'enforce');
    assert.strictEqual(line[3], 'node');
    assert.strictEqual(line[4], '127.0.0.1');
    assert.strictEqual(line[5], '18799');
    assert.strictEqual(line[6], 'live-port');
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  });
});
