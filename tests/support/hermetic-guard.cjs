'use strict';
/**
 * Hermetic connection guard (Phase 88, plan 88-01).
 *
 * Loaded into every test child through `NODE_OPTIONS=--require`. Its only side
 * effect is patching `net.Socket.prototype.connect` so that a connection to one
 * of the operator's live service ports throws instead of opening a socket:
 *
 *   18799  live Amauta daemon
 *   18798  live RLM service
 *   6379   live Redis
 *   5433   live Postgres
 *
 * Environment:
 *   GSD_HERMETIC_GUARD=off               no patch (used by exactly one self-test)
 *   GSD_HERMETIC_GUARD_BLOCK_PORTS=a,b   extra blocked ports (lets a self-test
 *                                        block a port it owns)
 *   GSD_HERMETIC_GUARD_ALLOW_PORTS=a,b   ports removed from the set; applied
 *                                        after the block list, so allow wins.
 *                                        The only escape hatch.
 *   GSD_HERMETIC_GUARD_LOG=<file>        append one line per blocked attempt:
 *                                        <ISO time>\t<pid>\t<port>\t<argv>
 *
 * Documented gap: `curl` / `psql` subprocesses and C-extension clients bypass an
 * in-process JavaScript patch. The guard is the alarm; the environment scrub in
 * scripts/run-tests.cjs and the fixture daemon are the primary control.
 *
 * The module never throws at load time and exports nothing.
 */

try {
  const fs = require('fs');
  const net = require('net');

  /**
   * Parse a comma-separated list of integers, dropping anything invalid.
   * @param {string|undefined} raw
   * @returns {number[]}
   */
  const parsePorts = (raw) =>
    String(raw || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

  if (process.env.GSD_HERMETIC_GUARD !== 'off') {
    const BLOCKED = new Set([18799, 18798, 6379, 5433]);
    for (const p of parsePorts(process.env.GSD_HERMETIC_GUARD_BLOCK_PORTS)) BLOCKED.add(p);
    for (const p of parsePorts(process.env.GSD_HERMETIC_GUARD_ALLOW_PORTS)) BLOCKED.delete(p);

    const proto = net.Socket.prototype;
    if (!proto.connect || !proto.connect._gsdHermetic) {
      const original = proto.connect;

      /**
       * Resolve the target port from `connect(options, cb)`, `connect(port, host, cb)`
       * and the normalised array form Node uses internally.
       * @param {Array} args
       * @returns {number|null}
       */
      const resolvePort = (args) => {
        let a = args;
        if (Array.isArray(a[0])) a = a[0]; // internal normalised form [options, cb]
        const first = a[0];
        if (first && typeof first === 'object') {
          return first.port !== undefined && first.port !== null ? Number(first.port) : null;
        }
        if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
          return Number(first);
        }
        return null;
      };

      const guarded = function connect(...args) {
        let port = null;
        try {
          port = resolvePort(args);
        } catch (_e) {
          port = null;
        }
        if (port !== null && BLOCKED.has(port)) {
          const msg =
            'HERMETIC GUARD: test tried to connect to live service port ' +
            port +
            '; use the fixture daemon (tests/support/fixture-daemon.cjs)';
          const logFile = process.env.GSD_HERMETIC_GUARD_LOG;
          if (logFile) {
            try {
              fs.appendFileSync(
                logFile,
                [new Date().toISOString(), process.pid, port, process.argv.slice(1).join(' ')].join('\t') + '\n'
              );
            } catch (_e) {
              /* best effort: the throw below is the real signal */
            }
          }
          throw Object.assign(new Error(msg), { code: 'EHERMETIC', port });
        }
        return original.apply(this, args);
      };
      guarded._gsdHermetic = true;
      proto.connect = guarded;
    }
  }
} catch (_e) {
  /* never throw at load time */
}
