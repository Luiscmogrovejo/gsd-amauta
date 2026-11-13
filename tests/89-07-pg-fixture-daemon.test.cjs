/**
 * Phase 89 plan 89-07: `startFixtureDaemon({postgres: true})` really serves
 * PostgreSQL.
 *
 * Plan 89-02 routed this defect here. `tests/support/fixture-daemon.cjs` set
 * `GSD_TEST_MODE=1` for every mode and then added a DSN, and
 * `services/amauta-daemon.py` `_force_sqlite()` answers TRUE for test mode
 * BEFORE it looks at the DSN or at `GSD_BACKEND` — so every "Postgres mode"
 * fixture daemon served SQLite, on the Linux cells too, and
 * `tests/step-handoff-daemon.test.cjs` and
 * `tests/skill-invocation-store.test.cjs` asserted PostgreSQL behaviour
 * against a SQLite store.
 *
 * The third test here is the one that matters most: it REPRODUCES the defect
 * against the same database, by starting a daemon with master's environment
 * shape, so the fix is pinned by a measurement and not by a comment.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pg = require(path.join(ROOT, 'tests', 'support', 'pg-fixture.cjs'));
const platform = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));
const { startFixtureDaemon, stopFixtureDaemon } = require(path.join(ROOT, 'tests', 'support', 'fixture-daemon.cjs'));
const registry = require(path.join(ROOT, 'tests', 'support', 'process-registry.cjs'));

const SKIP = pg.postgresDsn() ? false : pg.SKIP_REASON;
const READY_TIMEOUT_MS = Number(process.env.GSD_FIXTURE_READY_TIMEOUT_MS) || 60000;

/** @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /health as JSON.
 *
 * @param {number} port
 * @returns {Promise<object|null>}
 */
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Start a daemon with an environment this test chooses, bypassing the fixture.
 *
 * Only used to REPRODUCE master's shape; everything else goes through
 * `startFixtureDaemon`.
 *
 * @param {object} extra - environment entries layered on the hermetic base.
 * @returns {Promise<{port: number, proc: object, dataDir: string}>}
 */
async function rawDaemon(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8907-raw-'));
  const env = { ...process.env };
  for (const k of ['GSD_POSTGRES_URL', 'DATABASE_URL', 'REDIS_URL', 'GSD_DATA_DIR']) delete env[k];
  Object.assign(env, {
    GSD_AMAUTA_PORT: '0',
    GSD_DAEMON_PORT: '0',
    GSD_RLM_PORT: '0',
    GSD_RLM_ENABLED: 'false',
    GSD_REDIS_ENABLED: 'false',
    GSD_AMAUTA_NO_AUTO_START: '1',
    AMAUTA_DATA_DIR: dataDir,
    AMAUTA_AUTO_BACKUP: 'off',
    AMAUTA_MEMORY_DATABASE_URL: '',
    GSD_SQLITE_PATH: path.join(dataDir, 'gsd_amauta.db'),
  }, extra);
  const py = platform.resolvePython();
  const spawnedAt = Date.now();
  const proc = spawn(py.command, [...py.args, path.join(ROOT, 'services', 'amauta-daemon.py'), 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  // Plan 89-15: a daemon started outside `startFixtureDaemon` is still a
  // process of this run, so it goes into the run registry with its owner like
  // any other, and is stopped through the same tree-aware reaper.
  const fx = {
    proc,
    kind: 'daemon',
    fixture: 'rawDaemon',
    dataDir,
    spawnedAt,
    entry: proc.pid ? registry.register({ kind: 'daemon', pid: proc.pid, spawnedAt, fixture: 'rawDaemon', dataDir }) : null,
    members: [],
    graceMs: 5000,
  };
  let out = '';
  let port = null;
  let exited = false;
  proc.stdout.on('data', (c) => {
    out = (out + c.toString()).slice(-8000);
    if (port === null) {
      const m = /^DAEMON_PORT=(\d+)$/m.exec(out);
      if (m) port = Number(m[1]);
    }
  });
  let errBuf = '';
  proc.stderr.on('data', (c) => {
    errBuf = (errBuf + c.toString()).slice(-4000);
  });
  proc.on('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    if (port !== null && (await health(port))) {
      if (fx.entry) registry.annotate(fx.entry, { port });
      return { port, proc, dataDir, fx };
    }
    await sleep(100);
  }
  await registry.reapFixture({ ...fx, hard: true });
  throw new Error('rawDaemon did not become ready (port=' + port + '): ' + errBuf);
}

/**
 * Stop a raw daemon and remove its data dir.
 *
 * @param {object|null} h
 * @returns {Promise<void>}
 */
async function stopRaw(h) {
  if (!h) return;
  const r = await registry.reapFixture({ ...h.fx, port: h.port });
  if (!r.allGone) throw registry.survivorError('rawDaemon', r.survivors, h.dataDir);
  fs.rmSync(h.dataDir, { recursive: true, force: true });
}

describe('89-07 the Postgres fixture daemon', () => {
  let daemon = null;

  before(async () => {
    if (SKIP) return;
    daemon = await startFixtureDaemon({ postgres: true });
  });

  after(async () => {
    if (daemon) await stopFixtureDaemon(daemon);
    daemon = null;
  });

  test('/health says the daemon is on PostgreSQL, not degraded', { skip: SKIP }, async () => {
    const h = await health(daemon.port);
    assert.ok(h, '/health answered');
    assert.strictEqual(h.backend, 'postgresql', JSON.stringify(h));
    assert.strictEqual(h.pg_configured, true, JSON.stringify(h));
    assert.strictEqual(h.degraded, false, JSON.stringify(h));
  });

  test('the handle advertises Postgres mode and hands children the SAME store', { skip: SKIP }, () => {
    assert.strictEqual(daemon.postgres, true);
    assert.strictEqual(daemon.env.GSD_FORCE_SQLITE, '',
      'the handle must not tell a CLI child to force SQLite while the daemon is on PostgreSQL');
    assert.strictEqual(daemon.env.GSD_TEST_MODE, '');
    assert.strictEqual(daemon.env.GSD_POSTGRES_URL, pg.postgresDsn());
    assert.ok(String(daemon.env.GSD_HERMETIC_GUARD_ALLOW_PORTS || '')
      .split(',').includes(String(pg.portOfDsn(pg.postgresDsn()))),
    'the DSN port is allowed through the hermetic guard for that child');
  });

  test("the daemon's SQLite fallback path stays inside the fixture's temp tree", { skip: SKIP }, () => {
    assert.ok(daemon.env.GSD_SQLITE_PATH.startsWith(daemon.dataDir),
      daemon.env.GSD_SQLITE_PATH + ' must be under ' + daemon.dataDir);
  });

  test('a table only PostgreSQL has is reachable through the daemon', { skip: SKIP }, async () => {
    // /api/steps persists to step_handoffs, which exists only in the PostgreSQL
    // schema. On SQLite the route degrades, so a successful round trip here is
    // positive evidence rather than an absence of errors.
    const body = JSON.stringify({
      workflow_name: 'plan-phase',
      step_id: 'step-89-07-fixture',
      task_id: 'daemon-8907-pg-fixture',
      phase_number: 89,
      completed_steps: [],
      context_snapshot: { plan: '89-07' },
      next_step: 'step-89-07-next',
      escalation_flags: [],
    });
    const answer = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: daemon.port,
        path: '/api/steps/plan-phase/89/handoff',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c.toString();
        });
        res.on('end', () => resolve({ code: res.statusCode, text }));
      });
      req.on('error', (e) => resolve({ code: 0, text: e.message }));
      req.end(body);
    });
    assert.strictEqual(answer.code, 201,
      'POST /api/steps/plan-phase/89/handoff answered ' + answer.code + ': ' + answer.text);
    const row = JSON.parse(answer.text);
    assert.ok(row.id, 'the row the PostgreSQL table minted: ' + answer.text);
    assert.ok(row.created_at, answer.text);
  });

  test("master's shape -- test mode ON plus a DSN -- serves SQLITE, which is the defect", { skip: SKIP }, async () => {
    let raw = null;
    try {
      raw = await rawDaemon({
        GSD_TEST_MODE: '1',
        GSD_FORCE_SQLITE: '1',
        GSD_BACKEND: 'postgresql',
        GSD_POSTGRES_URL: pg.postgresDsn(),
        DATABASE_URL: pg.postgresDsn(),
      });
      const h = await health(raw.port);
      assert.ok(h, '/health answered');
      assert.notStrictEqual(h.backend, 'postgresql',
        'if this ever reports postgresql, _force_sqlite() changed and this plan\'s '
        + 'fix is no longer load-bearing -- re-measure before deleting it');
      assert.strictEqual(h.pg_configured, false, JSON.stringify(h));
    } finally {
      await stopRaw(raw);
    }
  });
});
