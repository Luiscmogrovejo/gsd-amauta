'use strict';
/**
 * tests/62-01-telemetry-ingest.test.cjs — Phase 62 TEL-03 evidence.
 *
 * Bounded buffer cap (oldest-dropped), dead-sink never blocks, mock-sink
 * drain, min-interval throttle, fire-and-forget shape. Same sandbox
 * discipline as tests/62-01-telemetry-consent.test.cjs: tmp
 * GSD_TELEMETRY_CONFIG_PATH + AMAUTA_DATA_DIR (+ GSD_TELEMETRY_BUFFER_CAP
 * where noted). Never touches the repo's real .planning/config.json or
 * data/.
 *
 * Run: node --test tests/62-01-telemetry-ingest.test.cjs
 *      node scripts/run-tests.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const TELEMETRY_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'telemetry.cjs');

const DEAD_SINK_URL = 'http://127.0.0.1:9/ingest'; // closed port -- ECONNREFUSED fast

function makeSandbox(initialConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-ingest-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(initialConfig === undefined ? {} : initialConfig));
  const dataDir = path.join(dir, 'data');
  return { dir, configPath, dataDir };
}

/** Set the telemetry env vars for the sandbox, run fn(), always restore. */
function withEnv(sandbox, extraEnv, fn) {
  const keys = ['GSD_TELEMETRY_CONFIG_PATH', 'AMAUTA_DATA_DIR', 'GSD_TELEMETRY', 'GSD_TELEMETRY_BUFFER_CAP'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];

  process.env.GSD_TELEMETRY_CONFIG_PATH = sandbox.configPath;
  process.env.AMAUTA_DATA_DIR = sandbox.dataDir;
  delete process.env.GSD_TELEMETRY;
  delete process.env.GSD_TELEMETRY_BUFFER_CAP;
  Object.assign(process.env, extraEnv || {});

  delete require.cache[require.resolve(TELEMETRY_CJS)];
  const t = require(TELEMETRY_CJS);

  const restore = () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };

  try {
    return fn(t, restore);
  } catch (err) {
    restore();
    throw err;
  }
}

function bufferLines(sandbox) {
  const bPath = path.join(sandbox.dataDir, 'telemetry-buffer.jsonl');
  if (!fs.existsSync(bPath)) return [];
  return fs.readFileSync(bPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

// ─── Case 1: BOUNDED CAP OLDEST-DROPPED ────────────────────────────────────

describe('[TEL-03] Bounded buffer cap: oldest lines dropped first', () => {
  test('GSD_TELEMETRY_BUFFER_CAP=10, emit 15 -> exactly 10 lines, first kept is seq=5', () => {
    const sandbox = makeSandbox({ telemetry: { enabled: true, salt: 'abcdef0123456789', sink_url: null } });
    withEnv(sandbox, { GSD_TELEMETRY_BUFFER_CAP: '10' }, (t, restore) => {
      try {
        for (let i = 0; i < 15; i++) {
          const r = t.emit('phase_start', { seq: i });
          assert.equal(r.emitted, true);
        }
        const lines = bufferLines(sandbox);
        assert.equal(lines.length, 10);
        const first = JSON.parse(lines[0]);
        assert.equal(first.payload.seq, 5);
        const last = JSON.parse(lines[lines.length - 1]);
        assert.equal(last.payload.seq, 14);
      } finally {
        restore();
      }
    });
  });
});

// ─── Case 2: DEAD SINK NEVER BLOCKS EMIT ───────────────────────────────────

describe('[TEL-03] Dead sink never blocks emit()', () => {
  test('emit() against a closed-port sink completes in <100ms and returns emitted:true', () => {
    const sandbox = makeSandbox({ telemetry: { enabled: true, salt: 'abcdef0123456789', sink_url: DEAD_SINK_URL } });
    withEnv(sandbox, {}, (t, restore) => {
      try {
        const start = Date.now();
        const r = t.emit('phase_start', {});
        const elapsed = Date.now() - start;
        assert.equal(r.emitted, true);
        assert.ok(elapsed < 100, `emit() took ${elapsed}ms, expected <100ms (no network I/O inside emit)`);
      } finally {
        restore();
      }
    });
  });
});

// ─── Case 3: DEAD SINK FLUSH IS FAST + LOSSLESS ────────────────────────────

describe('[TEL-03] Dead sink: flushNow() is fast and leaves the buffer byte-identical', () => {
  test('flushNow() against a closed port resolves <5000ms, flushed:0 + error, buffer untouched', async () => {
    const sandbox = makeSandbox({ telemetry: { enabled: true, salt: 'abcdef0123456789', sink_url: DEAD_SINK_URL } });
    const { before, after } = await new Promise((resolve, reject) => {
      withEnv(sandbox, {}, async (t, restore) => {
        try {
          t.emit('phase_start', {});
          const bPath = path.join(sandbox.dataDir, 'telemetry-buffer.jsonl');
          const before = fs.readFileSync(bPath, 'utf8');

          const start = Date.now();
          const result = await t.flushNow();
          const elapsed = Date.now() - start;

          assert.ok(elapsed < 5000, `flushNow() took ${elapsed}ms, expected <5000ms`);
          assert.equal(result.flushed, 0);
          assert.ok(result.error, 'expected an error code on the failure result');

          const after = fs.readFileSync(bPath, 'utf8');
          resolve({ before, after });
        } catch (err) {
          reject(err);
        } finally {
          restore();
        }
      });
    });
    assert.equal(before, after, 'buffer must be byte-identical before/after a failed flush');
  });
});

// ─── Case 4 + 5: MOCK SINK DRAIN, then MIN-INTERVAL THROTTLE ───────────────

describe('[TEL-03] Mock sink drain + min-interval throttle', () => {
  let sandbox;
  let capturedBody = null;
  let server;
  let sinkUrl;

  test('setup: start an in-test node:http server on port 0 capturing the POST body', async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        capturedBody = raw;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    sinkUrl = `http://127.0.0.1:${port}/ingest`;
    sandbox = makeSandbox({ telemetry: { enabled: true, salt: 'abcdef0123456789', sink_url: sinkUrl } });
  });

  test('MOCK SINK DRAIN: flushNow() delivers ONE request with all buffered events, drains buffer, records ok flush-state', async () => {
    await withEnv(sandbox, {}, async (t, restore) => {
      try {
        t.emit('phase_start', { seq: 1 });
        t.emit('phase_complete', { seq: 2 });
        const bufferedBefore = t.bufferedCount();
        assert.equal(bufferedBefore, 2);

        const result = await t.flushNow();
        assert.equal(result.flushed, 2);
        assert.equal(result.remaining, 0);

        assert.ok(capturedBody, 'server must have received a POST body');
        const parsedBody = JSON.parse(capturedBody);
        assert.equal(parsedBody.schema_version, '1.0');
        assert.equal(parsedBody.events.length, 2);

        assert.equal(t.bufferedCount(), 0);

        const flushState = JSON.parse(fs.readFileSync(t.flushStatePath(), 'utf8'));
        assert.ok(flushState.last_flush_at);
        assert.equal(flushState.last_result, 'ok');
      } finally {
        restore();
      }
    });
  });

  test('MIN-INTERVAL THROTTLE: immediately after a successful flush, shouldFlush() is false until the interval elapses', async () => {
    await withEnv(sandbox, {}, async (t, restore) => {
      try {
        t.emit('phase_start', { seq: 3 });
        assert.equal(t.shouldFlush(), false, 'interval has not elapsed since the successful flush above');

        const flushState = JSON.parse(fs.readFileSync(t.flushStatePath(), 'utf8'));
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        fs.writeFileSync(t.flushStatePath(), JSON.stringify({ ...flushState, last_flush_at: tenMinutesAgo }, null, 2));

        assert.equal(t.shouldFlush(), true, 'shouldFlush() must return true once FLUSH_MIN_INTERVAL_MS has elapsed');
      } finally {
        restore();
      }
    });
  });

  test('teardown: close the mock sink server', async () => {
    await new Promise((resolve) => server.close(resolve));
  });
});

// ─── Case 6: FIRE-AND-FORGET SHAPE ──────────────────────────────────────────

describe('[TEL-03] maybeScheduleFlush() fire-and-forget shape', () => {
  test('when shouldFlush() is true, returns true in <100ms wall-clock (spawn+unref, never awaited)', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(200); res.end('{}'); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const sandbox = makeSandbox({ telemetry: { enabled: true, salt: 'abcdef0123456789', sink_url: `http://127.0.0.1:${port}/ingest` } });

    try {
      withEnv(sandbox, {}, (t, restore) => {
        try {
          t.emit('phase_start', {});
          assert.equal(t.shouldFlush(), true);

          const start = Date.now();
          const scheduled = t.maybeScheduleFlush();
          const elapsed = Date.now() - start;

          assert.equal(scheduled, true);
          assert.ok(elapsed < 100, `maybeScheduleFlush() took ${elapsed}ms, expected <100ms`);
        } finally {
          restore();
        }
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
