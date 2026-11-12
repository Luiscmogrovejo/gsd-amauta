'use strict';
/**
 * Hermetic connection guard for Node tests (Phase 88, plans 88-01 and 88-16-03).
 *
 * Loaded into every test child through `NODE_OPTIONS=--require`.
 *
 * ## What changed in 88-16-03, and why
 *
 * Until this plan the guard was a **deny-list of four ports** on
 * `net.Socket.prototype.connect`. It had no idea what host it was dialling, it
 * wrote no log the Python side could share, and it read its allow-list once at
 * install time. Three claims rested on that and all three were vacuous:
 * `GSD_HERMETIC_GUARD_ALLOW_HOSTS` "allowed" something nothing had denied;
 * "the API host was never contacted, asserted on the guard log" had no
 * producer; and a per-test fixture that set an allow-list after the guard had
 * armed changed nothing.
 *
 * It is now **default-deny for every non-loopback destination**:
 *
 *   - **Loopback is permitted** and is defined before anything is denied:
 *     `localhost`, anything in `127.0.0.0/8`, `::1`, an absent or empty host,
 *     and any AF_UNIX/named-pipe connection (an `options.path`). Six `.cjs`
 *     tests connect to `localhost` and both fixture services bind ephemeral
 *     loopback ports, so getting this wrong breaks the harness, not a test.
 *   - **Loopback is still subject to the live-port block.** Allowing a port
 *     never unblocks 18799, 18798, 6379 or 5433; asking for one makes the
 *     guard REFUSE TO ARM rather than silently permit it. An allowed *host* of
 *     `localhost`/`127.0.0.1` is refused for the same reason: the host
 *     allowance exists for outbound third-party calls, not as a back door.
 *   - **A raw non-loopback IP is denied inside `connect` itself**, not only at
 *     name resolution. Wrapping the DNS path alone would leave
 *     `socket.connect({host: '93.184.216.34', port: 443})` straight through,
 *     which is a one-line bypass of the whole property.
 *   - **Every refusal appends one line** to `GSD_HERMETIC_GUARD_LOG` (TSV:
 *     ISO time, pid, mode, host, port, reason, argv). `scripts/run-tests.cjs`
 *     now sets that variable; it did not before.
 *   - **The allow-lists are read at CHECK time**, so a fixture that sets
 *     `GSD_HERMETIC_GUARD_ALLOW_HOSTS` for one test and restores it afterwards
 *     actually works.
 *
 * ## Environment
 *
 *   GSD_HERMETIC_GUARD=off                no patch (used by exactly one self-test)
 *   GSD_HERMETIC_GUARD_MODE=log           report refusals, do not throw (the
 *                                         rollout mode used to inventory what
 *                                         the suite really reaches). Anything
 *                                         else, including unset, means enforce.
 *   GSD_HERMETIC_GUARD_BLOCK_PORTS=a,b    extra blocked ports (lets a self-test
 *                                         block a port it owns)
 *   GSD_HERMETIC_GUARD_ALLOW_PORTS=a,b    loopback ports exempted from an extra
 *                                         block; never a live port
 *   GSD_HERMETIC_GUARD_ALLOW_HOSTS=h1,h2  non-loopback hosts this test may reach
 *   GSD_HERMETIC_GUARD_LOG=<file>         append one line per refusal
 *
 * Documented gap: `curl` / `psql` subprocesses and C-extension clients bypass
 * an in-process JavaScript patch. The guard is the alarm; the environment
 * scrub in `scripts/run-tests.cjs` and the fixture services are the control.
 *
 * @module tests/support/hermetic-guard
 */

const fs = require('fs');

/** Ports of the operator's live services. Never allowable. */
const LIVE_PORTS = [18799, 18798, 6379, 5433];

/**
 * Parse a comma-separated list of integers, dropping anything invalid.
 * @param {string|undefined} raw
 * @returns {number[]}
 */
function parsePorts(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Parse a comma-separated list of host names, lower-cased and trimmed.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseHosts(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this host the local machine?
 *
 * Written down before anything is denied, because every fixture in the suite
 * depends on the answer. An absent host is loopback: `net.connect({port})`
 * defaults to `localhost`.
 *
 * @param {string|null|undefined} host
 * @returns {boolean}
 * @example
 *   isLoopbackHost('127.0.0.1')  // true
 *   isLoopbackHost('::1')        // true
 *   isLoopbackHost(undefined)    // true
 *   isLoopbackHost('api.voyageai.com') // false
 */
function isLoopbackHost(host) {
  if (host === undefined || host === null) return true;
  let h = String(host).trim().toLowerCase();
  if (h === '') return true;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === 'localhost.' || h === 'localhost.localdomain') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Does this string look like a literal IP address rather than a name?
 * @param {string} host
 * @returns {boolean}
 */
function isIpLiteral(host) {
  const h = String(host).trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return h.includes(':') && /^[0-9a-f:.]+$/i.test(h);
}

/**
 * Why the guard must not arm with this environment, or null when it may.
 *
 * Returning a message rather than permitting the request is the point: an
 * allow-list that quietly drops the dangerous entries is worse than one that
 * stops the run, because the test then proves something nobody asked for.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function armRefusal(env) {
  const live = new Set(LIVE_PORTS);
  const asked = parsePorts(env.GSD_HERMETIC_GUARD_ALLOW_PORTS).filter((p) => live.has(p));
  if (asked.length > 0) {
    return (
      'HERMETIC GUARD REFUSES TO ARM: GSD_HERMETIC_GUARD_ALLOW_PORTS asks for live ' +
      'service port(s) ' + asked.join(',') + '. 18799 (daemon), 18798 (RLM), 6379 ' +
      '(Redis) and 5433 (the operator\'s PostgreSQL) can never be allowed.'
    );
  }
  const hosts = parseHosts(env.GSD_HERMETIC_GUARD_ALLOW_HOSTS).filter((h) => isLoopbackHost(h));
  if (hosts.length > 0) {
    return (
      'HERMETIC GUARD REFUSES TO ARM: GSD_HERMETIC_GUARD_ALLOW_HOSTS asks for ' +
      'loopback host(s) ' + hosts.join(',') + '. Loopback is already permitted and ' +
      'stays subject to the live-port block; allowing it by name would be a back door.'
    );
  }
  return null;
}

/**
 * Addresses an ALLOWED host resolved to, so the connection that follows the
 * lookup is permitted too. A client that resolves a name and then connects BY
 * ADDRESS would otherwise pass the lookup and be refused one line later —
 * measured on 2026-11-12 against the Voyage client, which connected to
 * 34.144.236.5 after resolving api.voyageai.com. Only addresses an allowed
 * host actually resolved to are remembered, and the allowance still expires
 * with the host: `decide` re-checks that the mapped host is CURRENTLY allowed.
 * @type {Map<string, string>}
 */
const RESOLVED_FOR_ALLOWED = new Map();

/**
 * Record that an allowed host resolved to these addresses.
 * @param {string} host
 * @param {Array<string>} addresses
 * @returns {void}
 */
function rememberResolution(host, addresses) {
  for (const address of addresses) {
    if (address) RESOLVED_FOR_ALLOWED.set(String(address), String(host).trim().toLowerCase());
  }
}

/**
 * Decide whether one destination may be reached. Read at CHECK time.
 *
 * @param {{host: *, port: *, isUnix?: boolean, env?: NodeJS.ProcessEnv}} target
 * @returns {{allowed: boolean, reason: string, host: string, port: number|null}}
 */
function decide(target) {
  const env = target.env || process.env;
  const port = target.port === undefined || target.port === null ? null : Number(target.port);
  const host = target.host === undefined || target.host === null ? '' : String(target.host);

  if (target.isUnix) return { allowed: true, reason: 'af-unix', host, port };

  const blocked = new Set(LIVE_PORTS);
  for (const p of parsePorts(env.GSD_HERMETIC_GUARD_BLOCK_PORTS)) blocked.add(p);
  // An allowance may lift an EXTRA block, never a live port: armRefusal() has
  // already stopped the run if someone asked for one.
  for (const p of parsePorts(env.GSD_HERMETIC_GUARD_ALLOW_PORTS)) {
    if (!LIVE_PORTS.includes(p)) blocked.delete(p);
  }

  if (port !== null && blocked.has(port)) {
    return { allowed: false, reason: 'live-port', host, port };
  }
  if (isLoopbackHost(host)) return { allowed: true, reason: 'loopback', host, port };

  const allowHosts = parseHosts(env.GSD_HERMETIC_GUARD_ALLOW_HOSTS);
  if (allowHosts.includes(host.trim().toLowerCase())) {
    return { allowed: true, reason: 'allow-host', host, port };
  }
  const origin = RESOLVED_FOR_ALLOWED.get(host);
  if (origin !== undefined && allowHosts.includes(origin)) {
    return { allowed: true, reason: 'allow-host-ip', host, port };
  }
  return {
    allowed: false,
    reason: isIpLiteral(host) ? 'non-loopback-ip' : 'non-loopback-host',
    host,
    port,
  };
}

/**
 * Append one line to the refusal log, best effort.
 * @param {{host: string, port: number|null, reason: string}} verdict
 * @param {string} mode
 * @param {NodeJS.ProcessEnv} env
 * @returns {void}
 */
function logRefusal(verdict, mode, env) {
  const file = env.GSD_HERMETIC_GUARD_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(
      file,
      [
        new Date().toISOString(),
        process.pid,
        mode,
        'node',
        verdict.host || '(none)',
        verdict.port === null ? '(none)' : verdict.port,
        verdict.reason,
        process.argv.slice(1).join(' '),
      ].join('\t') + '\n'
    );
  } catch (_e) {
    /* best effort: the throw below is the real signal */
  }
}

/**
 * Build the error a refusal raises.
 * @param {{host: string, port: number|null, reason: string}} verdict
 * @returns {Error}
 */
function refusalError(verdict) {
  const where = (verdict.host || '(no host)') + ':' + (verdict.port === null ? '?' : verdict.port);
  const msg =
    verdict.reason === 'live-port'
      // The first clause is a GOLDEN STRING pinned by
      // tests/88-01-hermetic-guard.test.cjs; 88-16-03 appends to it and
      // changes nothing before the semicolon.
      ? 'HERMETIC GUARD: test tried to connect to live service port ' + verdict.port +
        '; use the fixture daemon (tests/support/fixture-daemon.cjs), the fixture RLM ' +
        '(tests/support/fixture-rlm.cjs) or the disposable Postgres DSN from ' +
        'tests/support/pg-fixture.cjs. Target was ' + where + '.'
      : 'HERMETIC GUARD: test tried to reach the network at ' + where +
        '. Tests are default-deny for every non-loopback destination. If this one ' +
        'legitimately must call out, allow exactly that host for exactly that test ' +
        'with GSD_HERMETIC_GUARD_ALLOW_HOSTS (see tests/support/guard-allow-host.cjs).';
  return Object.assign(new Error(msg), {
    code: 'EHERMETIC',
    port: verdict.port,
    host: verdict.host,
    guardReason: verdict.reason,
  });
}

/**
 * Resolve `{host, port, isUnix}` from every `connect(...)` call form Node uses.
 *
 * `connect(options, cb)`, `connect(port, host, cb)`, `connect(port, cb)`,
 * `connect(path, cb)` and the internal normalised `[options, cb]` array.
 *
 * @param {Array} args
 * @returns {{host: *, port: *, isUnix: boolean}}
 */
function targetOf(args) {
  let a = args;
  if (Array.isArray(a[0])) a = a[0];
  const first = a[0];
  if (first && typeof first === 'object') {
    if (first.path) return { host: null, port: null, isUnix: true };
    return { host: first.host, port: first.port, isUnix: false };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const second = a[1];
    return { host: typeof second === 'string' ? second : undefined, port: Number(first), isUnix: false };
  }
  // connect('/tmp/x.sock', cb) — a path, i.e. AF_UNIX / a named pipe.
  if (typeof first === 'string') return { host: null, port: null, isUnix: true };
  return { host: undefined, port: null, isUnix: false };
}

/**
 * Install the guard.
 *
 * @param {object} [opts]
 * @param {object} [opts.net] the `net` module to patch (injectable so a
 *   mutation test can patch a spy instead of the real one and prove the
 *   refusal without opening a socket)
 * @param {object} [opts.dns] the `dns` module whose `lookup` is wrapped
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {boolean} true when the guard is installed (now or earlier)
 * @throws {Error} when the allow-lists ask for something that can never be
 *   allowed — the guard refuses to arm rather than silently permit it
 * @example
 *   require('tests/support/hermetic-guard.cjs'); // auto-installs
 */
function install(opts = {}) {
  const env = opts.env || process.env;
  if (String(env.GSD_HERMETIC_GUARD || '').trim().toLowerCase() === 'off') return false;

  const refusal = armRefusal(env);
  if (refusal) throw Object.assign(new Error(refusal), { code: 'EHERMETICARM' });

  const netModule = opts.net || require('net');
  const dnsModule = opts.dns === undefined ? require('dns') : opts.dns;
  const mode = String(env.GSD_HERMETIC_GUARD_MODE || '').trim().toLowerCase() === 'log'
    ? 'log'
    : 'enforce';

  const proto = netModule.Socket && netModule.Socket.prototype;
  if (!proto || !proto.connect) return false;
  if (proto.connect._gsdHermetic) return true;

  const original = proto.connect;
  const guarded = function connect(...args) {
    let verdict;
    try {
      const t = targetOf(args);
      verdict = decide({ host: t.host, port: t.port, isUnix: t.isUnix, env });
    } catch (_e) {
      verdict = { allowed: true, reason: 'unparsed', host: '', port: null };
    }
    if (!verdict.allowed) {
      logRefusal(verdict, mode, env);
      if (mode === 'enforce') throw refusalError(verdict);
    }
    return original.apply(this, args);
  };
  guarded._gsdHermetic = true;
  proto.connect = guarded;

  // Belt and braces: refuse the NAME RESOLUTION of a non-loopback host too, so
  // a client that resolves before it connects is stopped one step earlier and
  // the log names the host rather than an address.
  if (dnsModule && typeof dnsModule.lookup === 'function' && !dnsModule.lookup._gsdHermetic) {
    const originalLookup = dnsModule.lookup;
    const guardedLookup = function lookup(hostname, ...rest) {
      const verdict = decide({ host: hostname, port: null, env });
      if (!verdict.allowed && verdict.reason !== 'live-port') {
        logRefusal({ ...verdict, reason: verdict.reason + '/dns' }, mode, env);
        if (mode === 'enforce') {
          const err = refusalError(verdict);
          const cb = rest[rest.length - 1];
          if (typeof cb === 'function') return cb(err);
          throw err;
        }
      }
      // The lookup was permitted; if it was permitted BECAUSE the host is
      // allow-listed, the connection that follows must be permitted too.
      const allowed = parseHosts(env.GSD_HERMETIC_GUARD_ALLOW_HOSTS)
        .includes(String(hostname).trim().toLowerCase());
      const cb = rest[rest.length - 1];
      if (allowed && typeof cb === 'function') {
        const wrapped = function wrappedLookup(err, address, family) {
          if (!err && address) {
            rememberResolution(hostname, Array.isArray(address) ? address.map((a) => a.address) : [address]);
          }
          return cb(err, address, family);
        };
        return originalLookup.call(this, hostname, ...rest.slice(0, -1), wrapped);
      }
      return originalLookup.call(this, hostname, ...rest);
    };
    guardedLookup._gsdHermetic = true;
    dnsModule.lookup = guardedLookup;
  }

  return true;
}

module.exports = {
  LIVE_PORTS,
  RESOLVED_FOR_ALLOWED,
  rememberResolution,
  armRefusal,
  decide,
  install,
  isIpLiteral,
  isLoopbackHost,
  parseHosts,
  parsePorts,
  refusalError,
  targetOf,
};

// Auto-install when loaded through NODE_OPTIONS=--require. A deliberate
// refusal to arm propagates (it must stop the run); nothing else does.
if (!process.env.GSD_HERMETIC_GUARD_NO_AUTOINSTALL) {
  try {
    install();
  } catch (err) {
    if (err && err.code === 'EHERMETICARM') throw err;
    /* never throw at load time for anything else */
  }
}
