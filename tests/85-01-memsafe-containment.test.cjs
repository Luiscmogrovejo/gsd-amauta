/**
 * MEMSAFE-01 containment gate + the debounce-class regression (commit fa0e6f3).
 *
 * Two things are pinned here.
 *
 * 1. CONTAINMENT, both arms. With GSD_MEMORY_AUTO_DISTILL=1 an instrumented
 *    run of maybeAutoDistill() makes network calls; with it unset the gate
 *    returns before any network activity at all. The negative arm is worthless
 *    without the positive one beside it — a probe that reports zero has to be
 *    able to report non-zero.
 *
 * 2. THE DEBOUNCE CLASS, which is the mechanism nobody had a test for.
 *    `let _lastAutoDistillAt = 0` is a module-level variable in a ONE-SHOT CLI
 *    process. It is re-initialised to 0 on every invocation, so
 *    `now - _lastAutoDistillAt < COOLDOWN` was false for any real clock and the
 *    five-minute cooldown never fired once in its life. That is why a write
 *    triggered a full destructive merge every single time. The test below
 *    demonstrates it: two consecutive processes, a ten-minute cooldown, and the
 *    second process still goes to the network.
 *
 * No live daemon and no database are needed: the CLI is pointed at a fake HTTP
 * server on an ephemeral port, and GSD_AMAUTA_NO_AUTO_START=1 stops the module
 * reading the repo .env (which carries a real GSD_AMAUTA_PORT). Neither the
 * `store`, `learn` nor `distill` CLI command is invoked.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const SRC = fs.readFileSync(CLI, 'utf-8');

/** The real daemon's default port. The fake must never collide with it. */
const REAL_DAEMON_PORT = 18799;

/**
 * Start a request-recording fake daemon on an ephemeral port.
 *
 * @returns {Promise<{port:number, requests:string[], close:function():Promise<void>}>}
 */
function startFakeDaemon() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/api/memory/distill-status')) {
        // needs_distill:true so the ENABLED arm proceeds past the threshold
        // check — otherwise the positive arm would prove nothing.
        res.end(JSON.stringify({ total: 9999, needs_distill: true, threshold: 100 }));
        return;
      }
      if (req.url.startsWith('/api/memory/list')) {
        // Empty page: the run terminates here without merging or deleting.
        res.end(JSON.stringify({ memories: [], entries: [], total: 0 }));
        return;
      }
      res.end('{}');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      assert.notStrictEqual(port, REAL_DAEMON_PORT,
        'fake daemon landed on the real daemon port — refusing to run');
      resolve({
        port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Run maybeAutoDistill() in a fresh child process — one shot, exactly as the
 * CLI runs it. Env is applied at spawn so the module-load-time constants
 * (AUTO_DISTILL_ENABLED, AUTO_DISTILL_COOLDOWN_MS) are computed under it.
 *
 * The child is spawned ASYNCHRONOUSLY on purpose. execFileSync blocks this
 * process's event loop, so the fake daemon — which lives here — would never
 * accept the connection, the CLI would time out into file mode, and the
 * request log would read empty for the wrong reason.
 *
 * @param {number} port fake daemon port
 * @param {object} extraEnv variables to add; a value of null deletes the key
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runInstrumented(port, extraEnv) {
  const env = { ...process.env };
  // Containment: never inherit an auto-distill setting from the ambient shell,
  // and never let the module read the repo .env (it carries the REAL port).
  delete env.GSD_MEMORY_AUTO_DISTILL;
  delete env.GSD_MEMORY_AUTO_DISTILL_CONFIRM;
  env.GSD_AMAUTA_NO_AUTO_START = '1';
  env.GSD_AMAUTA_HOST = '127.0.0.1';
  env.GSD_AMAUTA_PORT = String(port);
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (v === null) delete env[k]; else env[k] = String(v);
  }
  assert.notStrictEqual(env.GSD_AMAUTA_PORT, String(REAL_DAEMON_PORT),
    'instrumented run would target the real daemon');

  const harness = `
    const cli = require(${JSON.stringify(CLI)});
    if (typeof cli._test_maybeAutoDistill !== 'function') {
      console.error('NO_EXPORT'); process.exit(3);
    }
    cli._test_maybeAutoDistill()
      .then(() => { console.log('DONE'); })
      .catch((e) => { console.log('THREW ' + (e && e.message)); });
  `;
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', harness], {
      env, encoding: 'utf-8', timeout: 25000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr });
    });
  });
}

test('MEMSAFE-01 positive arm: enabled, the instrument CAN return non-zero', async () => {
  const d = await startFakeDaemon();
  try {
    const r = await runInstrumented(d.port, { GSD_MEMORY_AUTO_DISTILL: '1' });
    assert.ok(!r.stdout.includes('NO_EXPORT'),
      '_test_maybeAutoDistill is not exported — the gate cannot be measured');
    assert.ok(d.requests.length > 0,
      `enabled arm made no network calls (stdout=${r.stdout} stderr=${r.stderr}) — ` +
      'the instrument cannot detect activity, so the zero in the negative arm ' +
      'would prove nothing');
    assert.ok(d.requests.some((x) => x.includes('/api/memory/distill-status')),
      `expected a distill-status probe, saw ${JSON.stringify(d.requests)}`);
  } finally {
    await d.close();
  }
});

test('MEMSAFE-01 negative arm: unset, the gate returns before any network act', async () => {
  const d = await startFakeDaemon();
  try {
    const r = await runInstrumented(d.port, { GSD_MEMORY_AUTO_DISTILL: null });
    assert.ok(r.stdout.includes('DONE'),
      `harness did not complete cleanly: ${r.stdout} ${r.stderr}`);
    assert.deepStrictEqual(d.requests, [],
      'auto-distill reached the network with GSD_MEMORY_AUTO_DISTILL unset — ' +
      'the containment gate is gone. This is the incident.');
  } finally {
    await d.close();
  }
});

test('MEMSAFE-01 the gate is the FIRST statement of maybeAutoDistill', () => {
  const i = SRC.indexOf('async function maybeAutoDistill()');
  assert.notStrictEqual(i, -1, 'maybeAutoDistill was renamed — repin this test');
  const body = SRC.slice(i, i + 400);
  const firstStatement = body
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*'))[0];
  assert.strictEqual(firstStatement, 'if (!AUTO_DISTILL_ENABLED) return;',
    'the containment gate is no longer the first thing the function does; ' +
    `saw: ${firstStatement}`);
  assert.ok(/const AUTO_DISTILL_ENABLED = process\.env\.GSD_MEMORY_AUTO_DISTILL === '1'/.test(SRC),
    'the gate no longer defaults to OFF');
});

test('DEBOUNCE CLASS: the cooldown does not survive the process it limits', async () => {
  // The incident mechanism, demonstrated rather than asserted from source.
  // A 10-minute cooldown, two invocations seconds apart. If the debounce were
  // real, the second process would make zero requests.
  const d = await startFakeDaemon();
  try {
    const env = { GSD_MEMORY_AUTO_DISTILL: '1', GSD_MEMORY_DISTILL_COOLDOWN: '600000' };
    await runInstrumented(d.port, env);
    const afterFirst = d.requests.length;
    assert.ok(afterFirst > 0, 'first invocation made no calls — nothing to debounce');

    await runInstrumented(d.port, env);
    const secondRunCalls = d.requests.length - afterFirst;

    assert.ok(secondRunCalls > 0,
      'the second process was debounced. If a cooldown held across separate ' +
      'CLI invocations the mechanism here would have changed and this test ' +
      'must be rewritten — but as written, _lastAutoDistillAt is a module ' +
      'global in a one-shot process and CANNOT hold.');
  } finally {
    await d.close();
  }
});

test('DEBOUNCE CLASS: process-local rate-limit state forces default-off containment', () => {
  // The invariant that would have prevented the incident: EITHER the debounce
  // state survives the process, OR auto-distill must be off by default. It is
  // never acceptable for a destructive side effect to be gated only by a
  // counter that resets every invocation.
  const declaresProcessLocal = /let\s+_lastAutoDistillAt\s*=\s*0\s*;/.test(SRC);
  const persisted = /_lastAutoDistillAt\s*=\s*(?!now)[^;]*(readFileSync|process\.env|await|require\()/
    .test(SRC);

  if (declaresProcessLocal && !persisted) {
    assert.ok(/if \(!AUTO_DISTILL_ENABLED\) return;/.test(SRC),
      'the only rate limit on a destructive side effect is a module-level ' +
      'variable in a one-shot process (it resets to 0 every invocation, so it ' +
      'has never once fired), and the default-off containment gate is gone. ' +
      'That combination is the 5,306-row incident.');
    assert.ok(/GSD_MEMORY_AUTO_DISTILL === '1'/.test(SRC),
      'containment must require an explicit opt-in, not merely a truthy value');
  } else {
    assert.ok(persisted,
      'the debounce declaration changed shape; re-derive whether its state ' +
      'now survives the process before trusting it');
  }
});

test('MEMSAFE-04: the destructive path requires --confirm-destructive', () => {
  assert.ok(/const dryRun = askedDry \|\| !confirmed;/.test(SRC),
    'distill no longer forces dry-run in the absence of --confirm-destructive');
  assert.ok(/'confirm-destructive',/.test(SRC),
    "'confirm-destructive' is not registered in BOOLEAN_FLAGS — the tokenizer " +
    'would eat the next argv token and the gate would read as unset');
});
