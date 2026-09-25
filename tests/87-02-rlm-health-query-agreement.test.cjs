#!/usr/bin/env node
/**
 * TK-2384 / RLM-AGREE — `gsd-rlm health` and `gsd-rlm query` may not disagree
 * about whether the RLM is up, and a fallback must name the condition that fired.
 *
 * The defect: the CLI held two definitions of "up" three hundred lines apart.
 *   isServiceRunning()  required HTTP 200 AND body.status === 'ok'
 *   cmdHealth()         printed "running (PID …)" for any response that did not
 *                       throw — it read neither the status code nor the body
 * so a service answering 503, or 200 with status != ok, made `health` say running
 * and `query` say "RLM service unavailable" in the same second. The same single
 * sentence was also printed for RLM-disabled-in-config, for a refused connection
 * mid-request and for a query that merely exceeded its timeout: one claim for
 * four conditions, three of which are false of a service that is up.
 *
 * Everything here runs against STATIC PROBE http servers on ephemeral ports, in
 * their own child process (spawnSync in this process would block the event loop
 * and the probe would time out answering itself). The live RLM on 18798 is
 * shared and is never contacted, started or stopped.
 *
 * ARMING: RLM-AGREE-00 asserts that a HEALTHY probe reads as up. Without it every
 * assertion below ("degraded reads as down") would also pass against a CLI that
 * calls everything down, and the file would be a gate that cannot see.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RLM_CLI = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-rlm.cjs');

// One server per scenario, each on its own ephemeral port, all in one child.
const PROBE_SERVER_SRC = `
const http = require('http');
const fs = require('fs');
const out = process.argv[1];
const SCENARIOS = {
  healthy:        { code: 200, body: { status: 'ok', service: 'rlm-service', pid: 4242, port: 0, cache_size: 7, cache_max: 200, max_chunk_chars: 4000 } },
  degraded:       { code: 200, body: { status: 'degraded', service: 'rlm-service', pid: 4242, error: 'index lock held' } },
  unavailable503: { code: 503, body: { status: 'error', error: 'reindex in progress' } },
};
const ports = {};
let left = Object.keys(SCENARIOS).length + 1;   // +1 for the black hole below
for (const [name, s] of Object.entries(SCENARIOS)) {
  const srv = http.createServer((req, res) => {
    const payload = JSON.stringify(s.body);
    res.writeHead(s.code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  srv.listen(0, '127.0.0.1', () => {
    ports[name] = srv.address().port;
    if (--left === 0) fs.writeFileSync(out, JSON.stringify(ports));
  });
}
// The black hole: completes the TCP connection, reads the request, and never
// answers. This is the shape the live RLM took on 2026-09-14 and again on
// 2026-09-24 -- /health 200 ok on one call, zero bytes and no return on the next.
const hole = http.createServer(() => { /* deliberately no response, ever */ });
hole.listen(0, '127.0.0.1', () => {
  ports.blackhole = hole.address().port;
  if (--left === 0) fs.writeFileSync(out, JSON.stringify(ports));
});
`;

/** Synchronous sleep that does not need a subprocess. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let probeChild;
let tmpDir;
let PORTS;
let fakeBinDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk2384-probe-'));
  const portsFile = path.join(tmpDir, 'ports.json');
  probeChild = spawn(process.execPath, ['-e', PROBE_SERVER_SRC, portsFile], { stdio: 'ignore' });

  for (let i = 0; i < 200 && !fs.existsSync(portsFile); i++) sleepSync(25);
  assert.ok(fs.existsSync(portsFile), 'probe server child never reported its ports');
  PORTS = JSON.parse(fs.readFileSync(portsFile, 'utf-8'));
  for (const [name, p] of Object.entries(PORTS)) {
    assert.notEqual(p, 18798, `probe ${name} must never take the shared RLM port`);
  }

  // A python3 that does nothing, so the CLI's "service not running, starting..."
  // path cannot spawn a real rlm-service.py onto a probe's port.
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk2384-bin-'));
  const fake = path.join(fakeBinDir, 'python3');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fake, 0o755);
});

after(() => {
  if (probeChild) probeChild.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fakeBinDir) fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

/** Run the CLI against one probe port. */
function cli(scenario, args, opts = {}) {
  return spawnSync(process.execPath, [RLM_CLI, ...args], {
    encoding: 'utf-8',
    timeout: 60000,
    cwd: opts.cwd || os.tmpdir(),
    env: {
      ...process.env,
      GSD_RLM_PORT: String(PORTS[scenario]),
      GSD_RLM_HOST: '127.0.0.1',
      GSD_RLM_HEALTH_TIMEOUT_MS: '2000',
      // Every case is deadline-bounded: startService()'s 25-iteration poll costs
      // 25 x (200ms + health timeout), which against a black hole is 55s. A test
      // file that can hang is not a test file.
      GSD_RLM_DEADLINE_MS: String(opts.deadlineMs !== undefined ? opts.deadlineMs : 12000),
      ...(opts.fakePython ? { PATH: `${fakeBinDir}:${process.env.PATH}` } : {}),
    },
  });
}

/** Call the health predicate directly, in a child with the probe port set. */
function predicate(scenario) {
  const res = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(RLM_CLI)});
    m.rlmHealthProbe().then(p => { process.stdout.write(JSON.stringify(p)); });
  `], {
    encoding: 'utf-8',
    timeout: 60000,
    env: { ...process.env, GSD_RLM_PORT: String(PORTS[scenario]), GSD_RLM_HOST: '127.0.0.1', GSD_RLM_HEALTH_TIMEOUT_MS: '2000' },
  });
  assert.equal(res.status, 0, `probe child failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

describe('RLM-AGREE-00: arming', () => {
  it('a HEALTHY static probe reads as up — otherwise this file cannot see', () => {
    const p = predicate('healthy');
    assert.equal(p.up, true, `the predicate calls a 200/status=ok service down: ${p.reason}`);
    const h = cli('healthy', ['health']);
    assert.equal(h.status, 0, `health exited ${h.status} against a healthy probe: ${h.stdout}${h.stderr}`);
    assert.match(h.stdout, /running/);
    assert.doesNotMatch(h.stdout, /not running/);
  });
});

describe('RLM-AGREE-01: health and the query predicate cannot disagree', () => {
  for (const name of ['healthy', 'degraded', 'unavailable503']) {
    it(`${name}: \`health\` rc and the predicate agree`, () => {
      const p = predicate(name);
      const h = cli(name, ['health']);
      const healthSaysUp = h.status === 0;
      assert.equal(healthSaysUp, p.up,
        `health says up=${healthSaysUp} while the query path says up=${p.up} (${p.reason}) — this is TK-2384`);
    });
  }

  it('degraded: health refuses, and says what it measured', () => {
    const h = cli('degraded', ['health']);
    assert.equal(h.status, 1);
    assert.match(h.stdout, /not running/);
    assert.match(h.stdout, /status="degraded"/, `health did not name the field it read: ${h.stdout}`);
  });

  it('503: health refuses, and names the status code', () => {
    const h = cli('unavailable503', ['health']);
    assert.equal(h.status, 1);
    assert.match(h.stdout, /HTTP 503/, `health did not name the status code: ${h.stdout}`);
  });

  it('health --json carries the verdict and the reason, not just the body', () => {
    const h = cli('degraded', ['health', '--json']);
    const j = JSON.parse(h.stdout);
    assert.equal(j.up, false);
    assert.ok(typeof j.reason === 'string' && j.reason.length > 0);
    assert.equal(j.status_code, 200);
  });
});

describe('RLM-AGREE-02: a fallback names the condition that fired', () => {
  it('config-disabled says so, and does NOT claim the service is unavailable', () => {
    // The service here is a HEALTHY probe. Before TK-2384 this path printed
    // "RLM service unavailable" about a service that was up and answering.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tk2384-cfg-'));
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'),
      JSON.stringify({ amauta: { rlm_enabled: false, rlm_fallback_to_full_files: true } }, null, 2));
    try {
      const q = cli('healthy', ['query', 'anything', '--dir', cwd], { cwd });
      assert.equal(q.status, 0, 'fallback is a documented degradation and still exits 0');
      assert.match(q.stderr, /disabled by configuration/, q.stderr);
      assert.doesNotMatch(q.stderr, /RLM service unavailable/,
        'the CLI still claims the service is unavailable while it is up and healthy');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a service that answers but is not ok is reported as that, not as "unavailable"', () => {
    const q = cli('unavailable503', ['query', 'anything', '--dir', os.tmpdir()], { fakePython: true });
    assert.equal(q.status, 0);
    assert.match(q.stderr, /Reason:/, q.stderr);
    assert.match(q.stderr, /HTTP 503/, `the fallback did not carry the measured reason: ${q.stderr}`);
  });
});

describe('RLM-AGREE-03: a stall ends the command, non-zero, and does not fall back', () => {
  // Measured against the live RLM on 2026-09-24 (daemon pid 92805, RLM pid 50196,
  // /health 200 status=ok, index_size 163 020, rlm_restarts_lifetime 21):
  //   gsd-rlm query ... --dir ~/Code/barerouter  ->  ZERO bytes, still running at
  //   30s, killed by SIGALRM (rc 142).
  // A socket timeout does not cover that: the command can stall in the health
  // probe, in startService()'s 25-iteration poll (silent on stdout, 80s worst
  // case), or between them. The bound is wall-clock over the whole command.
  // Strictly SHORTER than GSD_RLM_HEALTH_TIMEOUT_MS (2000) on purpose. With the
  // two equal, the deadline and the health timeout come due in the same tick and
  // the order is undefined -- measured: two identical invocations, one exiting 3
  // and the other printing the fallback. The deadline guarantees the command
  // ENDS; it does not promise to win a tie against a legitimate degradation.
  const DEADLINE = 1200;

  it('ARMING: a healthy probe under the same deadline still exits 0', () => {
    // Without this, a deadline that fired unconditionally would satisfy every
    // assertion below and this block would be a gate that cannot see.
    const h = cli('healthy', ['health'], { deadlineMs: DEADLINE });
    assert.equal(h.status, 0, `the deadline fires on a service that answers: ${h.stderr}`);
    assert.doesNotMatch(h.stderr, /timed out after/);
  });

  it('query against a black hole exits 3 and says "RLM: timed out after Ns"', () => {
    const started = Date.now();
    const q = cli('blackhole', ['query', 'anything', '--dir', os.tmpdir()], { deadlineMs: DEADLINE, fakePython: true });
    const elapsed = Date.now() - started;
    assert.notEqual(q.status, 0, 'a stalled query must not exit 0');
    assert.equal(q.status, 3, `expected the deadline exit code 3, got ${q.status}: ${q.stderr}`);
    assert.match(q.stderr, /RLM: timed out after \d+s/, q.stderr);
    assert.ok(elapsed < 20000, `the deadline did not bound the command: ${elapsed}ms`);
  });

  it('and it does NOT degrade a stall to the file-reference fallback', () => {
    const q = cli('blackhole', ['query', 'anything', '--dir', os.tmpdir()], { deadlineMs: DEADLINE, fakePython: true });
    // Grep for the fallback's OWN banner and its stdout block. An earlier version
    // of this assertion matched /falling back to file references/, which the
    // deadline message itself contained -- the test failed on the wording of the
    // fix rather than on its behaviour.
    assert.doesNotMatch(q.stderr, /RLM query not served/,
      'a stall printed the fallback banner, which is how it used to exit 0');
    assert.doesNotMatch(q.stdout, /Suggested files/,
      'a stall printed file suggestions, so it degraded instead of ending');
  });

  it('health against a black hole is bounded too, not just query', () => {
    const h = cli('blackhole', ['health'], { deadlineMs: DEADLINE });
    assert.notEqual(h.status, 0);
    assert.match(h.stderr + h.stdout, /timed out after \d+s|not running/, h.stderr + h.stdout);
  });

  it('GSD_RLM_DEADLINE_MS=0 disables the deadline, so the opt-out exists', () => {
    // Bounded by the health probe (2000ms) instead of by the deadline.
    const h = cli('blackhole', ['health'], { deadlineMs: 0 });
    assert.doesNotMatch(h.stderr, /timed out after/, 'the deadline fired although it was disabled');
  });
});
