'use strict';
/**
 * The ONE PostgreSQL opt-in for Node tests (Phase 88, plan 88-16).
 *
 * Before this module three different variables decided whether a Postgres test
 * ran — `GSD_TEST_POSTGRES_URL`, `GSD_POSTGRES_URL` and `GSD_PG_INTEGRATION` —
 * and twenty-one test files invented a default DSN aimed at the operator's
 * LIVE database (port 5433 — written here without the path separator so this
 * file does not itself match the "no test aims at the live Postgres" scan).
 * psycopg2 and `psql` are outside the in-process socket guard, so those
 * defaults were not harmless: a probe that "skips when PG is unavailable"
 * dialled the operator's database to find out. Every Node probe goes through
 * `pgSkip()` / `postgresDsn()` here, and the Python side goes through
 * `tests/conftest.py`'s `postgres_dsn` fixture. There is no default: a test with
 * no DSN skips with one standard reason.
 *
 * `scripts/run-tests.cjs` deliberately keeps deleting `GSD_POSTGRES_URL` and
 * `DATABASE_URL` from every child, so the only way a child reaches a database is
 * `pgChildEnv()`, which writes the validated test DSN into the child's
 * environment explicitly.
 *
 * @module tests/support/pg-fixture
 */

/** Ports of the operator's live services; a test DSN must never name one. */
const LIVE_PORTS = new Set([18799, 18798, 6379, 5433]);

/**
 * The single skip reason for "there is no disposable Postgres here".
 * `tests/conftest.py` carries the same sentence for the Python suite.
 */
const SKIP_REASON =
  'no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test ' +
  '(CI provides one; the operator machine deliberately has none)';

/**
 * Extract the TCP port from a PostgreSQL DSN.
 *
 * @param {string} dsn a `postgresql://user:pass@host:port/db` URL
 * @returns {number|null} the port, or null when the DSN names none or cannot be parsed
 * @example
 *   portOfDsn('postgresql://u:p@127.0.0.1:5434/db') // 5434
 */
function portOfDsn(dsn) {
  if (typeof dsn !== 'string' || dsn.trim() === '') return null;
  try {
    const u = new URL(dsn);
    if (!u.port) return null;
    const n = Number(u.port);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (_e) {
    const m = /:(\d{2,5})\//.exec(dsn);
    return m ? Number(m[1]) : null;
  }
}

/**
 * Throw when a DSN points at one of the operator's live services.
 *
 * This is the whole safety story for the Postgres work: CI hands a DSN in, and
 * nothing downstream is allowed to assume it is harmless.
 *
 * @param {string} dsn the DSN to check
 * @param {string} [where] a label used in the error message
 * @returns {string} the same DSN, when it is safe
 * @throws {Error} with code `EHERMETICDSN` when the DSN's port is a live port
 */
function assertNotLiveDsn(dsn, where = 'pg-fixture') {
  const port = portOfDsn(dsn);
  if (port !== null && LIVE_PORTS.has(port)) {
    throw Object.assign(
      new Error(
        `${where}: refusing a test DSN on live service port ${port}. ` +
          '18799 (daemon), 18798 (RLM), 6379 (Redis) and 5433 (the operator\'s ' +
          'PostgreSQL) are never test ports; give the disposable database a ' +
          'different port.'
      ),
      { code: 'EHERMETICDSN', port }
    );
  }
  return dsn;
}

/**
 * The disposable test database's DSN, or null when none was provided.
 *
 * @returns {string|null} the validated DSN from `GSD_TEST_POSTGRES_URL`
 * @throws {Error} `EHERMETICDSN` when the supplied DSN names a live port
 * @example
 *   const dsn = postgresDsn();
 *   if (!dsn) return; // the caller used pgSkip() to declare the skip
 */
function postgresDsn() {
  const raw = (process.env.GSD_TEST_POSTGRES_URL || '').trim();
  if (!raw) return null;
  return assertNotLiveDsn(raw, 'pg-fixture.postgresDsn');
}

/**
 * The value a `node:test` `{ skip: … }` option wants.
 *
 * @param {string} [extra] an additional condition's reason; when given and the
 *   DSN exists, that reason is returned instead
 * @returns {false|string} `false` when the test may run, otherwise the reason
 * @example
 *   const PG_SKIP = pgSkip();
 *   it('round-trips through PostgreSQL', { skip: PG_SKIP }, () => { … });
 */
function pgSkip(extra) {
  if (postgresDsn() === null) return SKIP_REASON;
  return extra || false;
}

/**
 * Child-process environment that may reach the disposable database.
 *
 * The runner scrubs `GSD_POSTGRES_URL` and `DATABASE_URL` from every test
 * child. A Node test that drives a Python helper against Postgres puts them
 * back for that one child, and only after the DSN has been validated.
 *
 * @param {NodeJS.ProcessEnv} [base] environment to start from (default `process.env`)
 * @returns {NodeJS.ProcessEnv} a new environment carrying the test DSN
 * @throws {Error} when no DSN is configured, or it names a live port
 * @example
 *   const r = spawnSync(cmd, args, { env: pgChildEnv() });
 */
function pgChildEnv(base = process.env) {
  const dsn = postgresDsn();
  if (!dsn) throw new Error('pg-fixture.pgChildEnv: ' + SKIP_REASON);
  const env = { ...base };
  env.GSD_POSTGRES_URL = dsn;
  env.DATABASE_URL = dsn;
  const port = portOfDsn(dsn);
  if (port !== null) {
    const allowed = String(env.GSD_HERMETIC_GUARD_ALLOW_PORTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(String(port))) allowed.push(String(port));
    env.GSD_HERMETIC_GUARD_ALLOW_PORTS = allowed.join(',');
  }
  return env;
}

/**
 * Replace the database name in a DSN.
 * @param {string} dsn
 * @param {string} name the new database name
 * @returns {string}
 */
function dsnWithDatabase(dsn, name) {
  const u = new URL(dsn);
  u.pathname = '/' + name;
  return u.toString();
}

/**
 * Create a FRESH database on the test server, with every migration applied.
 *
 * Isolation by construction, not by ordering (plan 88-16-09). `node --test`
 * runs test FILES in parallel processes, so the four party suites were writing
 * party_sessions rows into one database at the same time and
 * `e2e-status-sorted-by-updated-at-desc` read a sibling file's session at the
 * top of "most recently updated" (measured, run 43181201335, idx=5).
 * `scripts/run-tests.cjs`'s `LAST_TESTS` ordering was the old mitigation, and
 * its own comment — "shared-PG data conflicts" — is the evidence that ordering
 * is not isolation.
 *
 * The work happens in a Python child because psycopg2 is the only PostgreSQL
 * client guaranteed on every cell, and `services/migrate_runner.py` is the one
 * path that applies this repository's schema.
 *
 * @param {string} label a short, file-identifying label (`[a-z0-9_]`)
 * @returns {string|null} the DSN of the new database, or null when no
 *   disposable server is configured
 * @throws {Error} when creation or migration fails, with the child's output
 * @example
 *   const dsn = createIsolatedDatabase('party_e2e');
 *   after(() => dropIsolatedDatabase(dsn));
 */
function createIsolatedDatabase(label) {
  const base = postgresDsn();
  if (!base) return null;
  const path = require('path');
  const crypto = require('crypto');
  const platform = require('../../get-shit-done/bin/lib/platform.cjs');
  const name = 'gsd_t_' + String(label).replace(/[^a-z0-9_]/gi, '_').toLowerCase() +
    '_' + crypto.randomBytes(4).toString('hex');
  const admin = dsnWithDatabase(base, 'postgres');
  const target = dsnWithDatabase(base, name);
  const repo = path.resolve(__dirname, '..', '..');
  const script = [
    'import sys',
    'import psycopg2',
    'from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT',
    'sys.path.insert(0, sys.argv[3])',
    'c = psycopg2.connect(sys.argv[1], connect_timeout=10)',
    'c.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)',
    'cur = c.cursor()',
    'cur.execute(\'CREATE DATABASE "%s"\' % sys.argv[4])',
    'c.close()',
    'from services import migrate_runner',
    'migrate_runner.apply_migrations(dsn=sys.argv[2], log=lambda *a: None)',
    'print("ISOLATED_OK")',
  ].join('\n');
  const r = platform.spawnPython(['-c', script, admin, target, repo, name], {
    encoding: 'utf8',
    timeout: 180000,
    cwd: repo,
  });
  if (!String(r.stdout || '').includes('ISOLATED_OK')) {
    throw new Error(
      'pg-fixture.createIsolatedDatabase(' + label + ') failed (status ' + r.status + ')\n' +
        '--- stdout ---\n' + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || '')
    );
  }
  return target;
}

/**
 * Drop a database created by {@link createIsolatedDatabase}. Best effort.
 *
 * @param {string|null} dsn the DSN returned by `createIsolatedDatabase`
 * @returns {void}
 */
function dropIsolatedDatabase(dsn) {
  if (!dsn) return;
  const path = require('path');
  const platform = require('../../get-shit-done/bin/lib/platform.cjs');
  const name = new URL(dsn).pathname.replace(/^\//, '');
  if (!/^gsd_t_/.test(name)) return; // never drop anything this module did not make
  const script = [
    'import sys',
    'import psycopg2',
    'from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT',
    'c = psycopg2.connect(sys.argv[1], connect_timeout=10)',
    'c.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)',
    'cur = c.cursor()',
    'cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity '
      + 'WHERE datname = %s AND pid <> pg_backend_pid()", (sys.argv[2],))',
    'cur.execute(\'DROP DATABASE IF EXISTS "%s"\' % sys.argv[2])',
    'c.close()',
  ].join('\n');
  try {
    platform.spawnPython(['-c', script, dsnWithDatabase(dsn, 'postgres'), name], {
      encoding: 'utf8',
      timeout: 60000,
      cwd: path.resolve(__dirname, '..', '..'),
    });
  } catch (_e) {
    /* best effort: the server is disposable */
  }
}

module.exports = {
  LIVE_PORTS,
  SKIP_REASON,
  assertNotLiveDsn,
  createIsolatedDatabase,
  dropIsolatedDatabase,
  dsnWithDatabase,
  pgChildEnv,
  pgSkip,
  portOfDsn,
  postgresDsn,
};
