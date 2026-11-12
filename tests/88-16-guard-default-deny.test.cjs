'use strict';
/**
 * 88-16-03: the hermetic guard is default-deny for non-loopback destinations.
 *
 * SAFETY, and it is the whole reason this file is shaped the way it is: a
 * mutation test of a guard must never prove itself by DIALLING the thing the
 * guard protects: with the guard off, "connect and expect a refusal" would be a
 * real request to the operator's live services. Every case below either
 *
 *   (a) installs the guard over an injected `net`-shaped double whose
 *       `Socket.prototype.connect` is a SPY, and asserts on whether the spy was
 *       reached — no socket is ever opened; or
 *   (b) uses a listener this test opened itself on a free loopback port.
 *
 * The literals 18799 and `localhost` appear below only inside refuse-to-arm
 * assertions, where the point is that asking for them stops the run.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const GUARD = path.join(__dirname, 'support', 'hermetic-guard.cjs');
const guard = require(GUARD);

/** A `net`-shaped double whose connect records calls instead of opening a socket. */
function spyNet() {
  const calls = [];
  function Socket() {}
  Socket.prototype.connect = function connect(...args) {
    calls.push(args);
    return this;
  };
  return { module: { Socket }, calls };
}

/** A `dns`-shaped double. */
function spyDns() {
  const calls = [];
  return {
    module: {
      lookup(hostname, ...rest) {
        calls.push(hostname);
        const cb = rest[rest.length - 1];
        if (typeof cb === 'function') return cb(null, '203.0.113.9', 4);
        return undefined;
      },
    },
    calls,
  };
}

/** A temporary file path for the refusal log. */
function logPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-log-'));
  return path.join(dir, label + '.tsv');
}

// ── Mutation 1: a non-loopback HOST is refused, and a log line is written ─────

test('88-16-03 M1: a non-loopback host is refused and the refusal is logged', () => {
  const { module: fakeNet, calls } = spyNet();
  const log = logPath('m1');
  const env = { GSD_HERMETIC_GUARD_LOG: log };

  assert.equal(guard.install({ net: fakeNet, dns: null, env }), true);

  const sock = new fakeNet.Socket();
  assert.throws(
    () => sock.connect({ host: 'api.voyageai.com', port: 443 }),
    (err) => err.code === 'EHERMETIC' && /api\.voyageai\.com:443/.test(err.message),
    'a connection to a non-loopback host must be refused by default'
  );
  assert.equal(calls.length, 0, 'the guard must refuse BEFORE the underlying connect runs');

  const lines = fs.readFileSync(log, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 1, `expected exactly one refusal line, got: ${lines}`);
  const fields = lines[0].split('\t');
  assert.equal(fields[2], 'enforce');
  assert.equal(fields[3], 'node');
  assert.equal(fields[4], 'api.voyageai.com');
  assert.equal(fields[5], '443');
  assert.equal(fields[6], 'non-loopback-host');
});

// ── Mutation 2: the same host passes when allow-listed, read at CHECK time ────

test('88-16-03 M2: the allow-list is read at check time, so a per-test fixture works', () => {
  const { module: fakeNet, calls } = spyNet();
  const env = { GSD_HERMETIC_GUARD_LOG: logPath('m2') };

  // Armed with an EMPTY allow-list on purpose: if the guard snapshotted it at
  // install time — which both guards did before this plan — the allowance set
  // afterwards would silently do nothing and this test would prove nothing.
  guard.install({ net: fakeNet, dns: null, env });

  const sock = new fakeNet.Socket();
  assert.throws(() => sock.connect({ host: 'api.voyageai.com', port: 443 }), /HERMETIC GUARD/);

  env.GSD_HERMETIC_GUARD_ALLOW_HOSTS = 'api.voyageai.com';
  sock.connect({ host: 'api.voyageai.com', port: 443 });
  assert.equal(calls.length, 1, 'the allow-listed host must reach the underlying connect');
});

// ── Mutation 3: the allowance does not leak to the next test ─────────────────

test('88-16-03 M3: an allowance restored after a test blocks the host again', () => {
  const { module: fakeNet, calls } = spyNet();
  const env = { GSD_HERMETIC_GUARD_LOG: logPath('m3') };
  guard.install({ net: fakeNet, dns: null, env });
  const sock = new fakeNet.Socket();

  // "test one" allows the host...
  env.GSD_HERMETIC_GUARD_ALLOW_HOSTS = 'api.voyageai.com';
  sock.connect({ host: 'api.voyageai.com', port: 443 });
  assert.equal(calls.length, 1);

  // ...and the fixture restores the variable when it ends.
  delete env.GSD_HERMETIC_GUARD_ALLOW_HOSTS;
  assert.throws(
    () => sock.connect({ host: 'api.voyageai.com', port: 443 }),
    /HERMETIC GUARD/,
    'the allowance leaked into the next test'
  );
  assert.equal(calls.length, 1, 'no second connect may have reached the socket');
});

// ── Mutation 4: a RAW non-loopback IP is refused inside connect itself ───────

test('88-16-03 M4: a raw non-loopback IP is refused, and removing the check lets it through', () => {
  const { module: fakeNet, calls } = spyNet();
  const env = { GSD_HERMETIC_GUARD_LOG: logPath('m4') };
  guard.install({ net: fakeNet, dns: null, env });
  const sock = new fakeNet.Socket();

  // 203.0.113.0/24 is TEST-NET-3 (RFC 5737): documentation-only, never routed.
  assert.throws(
    () => sock.connect(443, '203.0.113.9'),
    (err) => err.code === 'EHERMETIC' && err.guardReason === 'non-loopback-ip',
    'a raw IP must be refused inside connect, not only at name resolution'
  );
  assert.equal(calls.length, 0);

  // THE MUTATION: a guard whose decision only knows about names — i.e. one that
  // wrapped getaddrinfo/dns.lookup and nothing else — lets the same raw IP
  // straight through. This is the one-line bypass the in-connect check closes.
  const nameOnlyDecide = (t) =>
    guard.isIpLiteral(String(t.host)) ? { allowed: true, reason: 'mutant' } : guard.decide(t);
  assert.equal(
    nameOnlyDecide({ host: '203.0.113.9', port: 443, env }).allowed,
    true,
    'the mutant must demonstrate the bypass, otherwise case 4 proves nothing'
  );
  assert.equal(
    guard.decide({ host: '203.0.113.9', port: 443, env }).allowed,
    false,
    'the real decision must still refuse it'
  );
});

// ── Mutation 5: the guard refuses to ARM for a live port or for loopback ─────

test('88-16-03 M5: allowing a live port or loopback by name makes the guard refuse to arm', () => {
  // Live port. The literal is here because the assertion is "asking for this
  // stops the run"; nothing in this test opens a socket at all.
  const portRefusal = guard.armRefusal({ GSD_HERMETIC_GUARD_ALLOW_PORTS: '18799' });
  assert.match(portRefusal || '', /REFUSES TO ARM/);
  assert.match(portRefusal || '', /18799/, 'the refusal must name the port it refused');
  assert.throws(
    () => guard.install({ net: spyNet().module, dns: null, env: { GSD_HERMETIC_GUARD_ALLOW_PORTS: '18799' } }),
    (err) => err.code === 'EHERMETICARM'
  );

  // Loopback by name.
  const hostRefusal = guard.armRefusal({ GSD_HERMETIC_GUARD_ALLOW_HOSTS: 'localhost' });
  assert.match(hostRefusal || '', /REFUSES TO ARM/);
  assert.throws(
    () => guard.install({ net: spyNet().module, dns: null, env: { GSD_HERMETIC_GUARD_ALLOW_HOSTS: 'localhost' } }),
    (err) => err.code === 'EHERMETICARM'
  );

  // And a sane environment still arms.
  assert.equal(guard.armRefusal({}), null);

  // An allowance can never lift a live-port block even if armRefusal is bypassed.
  const verdict = guard.decide({ host: '127.0.0.1', port: 18798, env: { GSD_HERMETIC_GUARD_ALLOW_PORTS: '18798' } });
  assert.equal(verdict.allowed, false, 'loopback stays subject to the live-port block');
  assert.equal(verdict.reason, 'live-port');
});

// ── Mutation 6: loopback on an ephemeral port still works ────────────────────

test('88-16-03 M6: a real loopback connection to an ephemeral port still succeeds', async () => {
  // The real guard is already installed in this process through NODE_OPTIONS.
  // This is the case that breaks the harness if the loopback definition is
  // wrong: both fixture services bind exactly like this.
  const server = net.createServer((c) => c.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await new Promise((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port }, () => {
        c.end();
        resolve();
      });
      c.on('error', reject);
    });
    // ...and through the default host, which is also loopback.
    await new Promise((resolve, reject) => {
      const c = net.connect(port, () => {
        c.end();
        resolve();
      });
      c.on('error', reject);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(true, 'loopback to an ephemeral port is permitted');
});

// ── The loopback definition, written down and pinned ─────────────────────────

test('88-16-03: the loopback definition is exactly what the plan states', () => {
  for (const h of [undefined, null, '', 'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(guard.isLoopbackHost(h), true, `${String(h)} must count as loopback`);
  }
  for (const h of ['api.voyageai.com', '203.0.113.9', '0.0.0.0', '10.0.0.1', '::2']) {
    assert.equal(guard.isLoopbackHost(h), false, `${h} must NOT count as loopback`);
  }
  // AF_UNIX / named pipes are permitted and are detected from the call shape.
  assert.equal(guard.targetOf([{ path: '/run/x.sock' }]).isUnix, true);
  assert.equal(guard.decide({ host: null, port: null, isUnix: true }).allowed, true);
});

// ── The host is resolved BEFORE the connection ───────────────────────────────

test('88-16-03: a non-loopback name lookup is refused before any connection', () => {
  const { module: fakeNet } = spyNet();
  const { module: fakeDns, calls } = spyDns();
  const env = { GSD_HERMETIC_GUARD_LOG: logPath('dns') };
  guard.install({ net: fakeNet, dns: fakeDns, env });

  let seen = null;
  fakeDns.lookup('api.voyageai.com', (err) => { seen = err; });
  assert.ok(seen && seen.code === 'EHERMETIC', 'the lookup must be refused');
  assert.equal(calls.length, 0, 'the underlying resolver must not have run');

  // Loopback names resolve normally.
  let ok = 'untouched';
  fakeDns.lookup('localhost', (err) => { ok = err; });
  assert.equal(ok, null);
  assert.deepEqual(calls, ['localhost']);
});

// ── Log-only mode records without stopping the run ───────────────────────────

test('88-16-03: log-only mode records the refusal and lets the call through', () => {
  const { module: fakeNet, calls } = spyNet();
  const log = logPath('logmode');
  const env = { GSD_HERMETIC_GUARD_LOG: log, GSD_HERMETIC_GUARD_MODE: 'log' };
  guard.install({ net: fakeNet, dns: null, env });

  new fakeNet.Socket().connect({ host: 'api.voyageai.com', port: 443 });
  assert.equal(calls.length, 1, 'log-only mode must not block');
  const fields = fs.readFileSync(log, 'utf-8').trim().split('\t');
  assert.equal(fields[2], 'log');
});

// ── The runner refuses a DSN on a live port ──────────────────────────────────

test('88-16-03: the runner refuses a test DSN whose port is a live service port', () => {
  const runner = require(path.join(__dirname, '..', 'scripts', 'run-tests.cjs'));
  // 5434 is the disposable database's port in CI: accepted.
  assert.equal(runner.testPostgresPort('postgresql://u:p@127.0.0.1:5434/db'), 5434);
  assert.equal(runner.testPostgresPort(''), null);
  assert.equal(runner.testPostgresPort(undefined), null);
  for (const livePort of [18799, 18798, 6379, 5433]) { // each must be refused
    assert.throws(
      () => runner.testPostgresPort(`postgresql://u:p@127.0.0.1:${livePort}/db`),
      new RegExp(`live service port ${livePort}`),
      `a DSN on ${livePort} must be refused`
    );
  }
});
