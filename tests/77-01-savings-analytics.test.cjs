'use strict';

/**
 * tests/77-01-savings-analytics.test.cjs — Phase 77 / v3.5 GAIN-01..03 capstone.
 *
 * End-to-end behavioral coverage for the "make the diet visible" plan (77-01):
 *   - GAIN-02: the telemetry taxonomy is a DUAL-RUNTIME byte-identical pair —
 *     services/telemetry.py and get-shit-done/bin/lib/telemetry.cjs both carry
 *     SCHEMA_VERSION 1.1 and both include the 9th event type `compression_run`.
 *   - GAIN-03: emission is metadata-only (four counting keys, NEVER command
 *     text), opt-in (a no-op when telemetry is unconsented), and network-free.
 *   - GAIN-01: `amauta compress gain` reads the LOCAL telemetry buffer and
 *     reports total bytes saved + overall savings %, printing a clean advisory
 *     when no runs exist.
 *
 * Discipline: this suite TESTS the DONE surfaces (telemetry.cjs, gsd-compress.cjs,
 * gsd-amauta.cjs, services/telemetry.py). It never patches them. A failing
 * assertion here is a FINDING about a surface, surfaced to the operator.
 *
 * Idioms (mirroring tests/62-02-telemetry-emit-points.test.cjs and
 * tests/59-01-fidel01-glob-check.test.cjs): fs.mkdtempSync sandboxes cleaned in
 * try/finally, always a COPIED env, spawnSync(process.execPath, ...) (never a
 * bare 'node'), no timers of any kind, and a python3-availability skip.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TELEMETRY_CJS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'telemetry.cjs');
const COMPRESS_CJS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-compress.cjs');
const AMAUTA_CJS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const TELEMETRY_PY = path.join(REPO_ROOT, 'services', 'telemetry.py');

// python3 availability gate — mirror 62-02's runtime-availability skip so the
// dual-runtime parity test degrades to a skip (not a failure) where python3 or
// the Python twin is absent, without ever silently passing.
const PY_EXISTS = (() => {
  try {
    if (!fs.existsSync(TELEMETRY_PY)) return false;
    const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
})();

// A telemetry sandbox: an isolated AMAUTA_DATA_DIR (so the buffer file lives in
// tmp, never the repo's real data dir) plus a copied env with the consent flag
// forced. GSD_TELEMETRY_CONFIG_PATH points at a nonexistent tmp path so config
// resolution never touches the repo's .planning/config.json.
function makeSandbox(telemetryFlag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '77-01-'));
  const env = { ...process.env, AMAUTA_DATA_DIR: dir, GSD_TELEMETRY_CONFIG_PATH: path.join(dir, 'config.json') };
  if (telemetryFlag !== undefined) env.GSD_TELEMETRY = telemetryFlag;
  return { dir, env, bufferPath: path.join(dir, 'telemetry-buffer.jsonl') };
}

function cleanup(sandbox) {
  try { fs.rmSync(sandbox.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ─── GAIN-02: dual-runtime byte-identical taxonomy ──────────────────────────

test('GAIN-02: telemetry.cjs carries SCHEMA_VERSION 1.1 and compression_run in EVENT_TYPES', () => {
  const t = require(TELEMETRY_CJS);
  assert.equal(t.SCHEMA_VERSION, '1.1', 'Node SCHEMA_VERSION must be bumped to 1.1');
  assert.ok(Array.isArray(t.EVENT_TYPES), 'EVENT_TYPES must be an array');
  assert.ok(t.EVENT_TYPES.includes('compression_run'), 'compression_run must be an accepted event type');
  assert.equal(t.EVENT_TYPES.length, 9, 'EVENT_TYPES must be the 9-type frozen taxonomy');
  assert.equal(t.EVENT_TYPES[t.EVENT_TYPES.length - 1], 'compression_run', 'compression_run must be the LAST (appended) type');
});

(PY_EXISTS ? test : test.skip)('GAIN-02: services/telemetry.py is byte-parallel with telemetry.cjs (SCHEMA_VERSION + EVENT_TYPES)', () => {
  const t = require(TELEMETRY_CJS);
  const nodeTypes = [...t.EVENT_TYPES];

  const py = spawnSync(
    'python3',
    ['-c', "import sys,json; sys.path.insert(0,'services'); import telemetry; print(json.dumps([telemetry.SCHEMA_VERSION, list(telemetry.EVENT_TYPES)]))"],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  assert.equal(py.status, 0, `python3 twin readout must exit 0 (stderr: ${py.stderr})`);

  const [pyVersion, pyTypes] = JSON.parse(py.stdout);
  assert.equal(pyVersion, t.SCHEMA_VERSION, 'Python SCHEMA_VERSION must equal the Node one (no dual-runtime drift)');
  assert.equal(pyVersion, '1.1', 'Python SCHEMA_VERSION must be 1.1');
  assert.deepEqual(pyTypes, nodeTypes, 'Python EVENT_TYPES must deep-equal the Node EVENT_TYPES (byte-parallel taxonomy)');
  assert.ok(pyTypes.includes('compression_run'), 'Python twin must include compression_run');
});

// ─── GAIN-03: metadata-only payload, no command leak ────────────────────────

test('GAIN-03: buildCompressionPayload is arity-3 and returns exactly the four metadata keys', () => {
  const c = require(COMPRESS_CJS);
  assert.equal(typeof c.buildCompressionPayload, 'function', 'buildCompressionPayload must be exported');
  assert.equal(c.buildCompressionPayload.length, 3, 'builder must take exactly 3 args (counts + filter id, NO command param)');

  const payload = c.buildCompressionPayload(1000, 200, 'git');
  const keys = Object.keys(payload).sort().join(',');
  assert.equal(keys, 'compressed_bytes,filter_id,raw_bytes,savings_pct', 'payload must have exactly the four metadata keys');
  assert.equal(payload.raw_bytes, 1000);
  assert.equal(payload.compressed_bytes, 200);
  assert.equal(payload.filter_id, 'git');
  assert.equal(payload.savings_pct, 80, 'savings_pct = round((1 - 200/1000)*100, 1) = 80');
});

test('GAIN-03: an emitted compression_run event carries no command substring in the whole serialized buffer line', () => {
  const sandbox = makeSandbox('on');
  try {
    // Emit through the real telemetry surface with a payload built by the real builder.
    const emitProbe = spawnSync(
      process.execPath,
      ['-e', "const t=require(process.argv[1]); const c=require(process.argv[2]); const r=t.emit('compression_run', c.buildCompressionPayload(1000,200,'git')); process.stdout.write(JSON.stringify(r));", TELEMETRY_CJS, COMPRESS_CJS],
      { env: sandbox.env, encoding: 'utf8' }
    );
    assert.equal(emitProbe.status, 0, `emit probe must exit 0 (stderr: ${emitProbe.stderr})`);
    assert.match(emitProbe.stdout, /"emitted":true/, 'emit() must report the event was written when telemetry is on');

    const rawBuffer = fs.readFileSync(sandbox.bufferPath, 'utf8');
    const lastLine = rawBuffer.split('\n').filter((l) => l.trim().length > 0).pop();
    const event = JSON.parse(lastLine);

    assert.equal(event.event_type, 'compression_run', 'buffered event must be a compression_run');
    const payloadKeys = Object.keys(event.payload).sort().join(',');
    assert.equal(payloadKeys, 'compressed_bytes,filter_id,raw_bytes,savings_pct', 'payload must be metadata-only (four keys)');

    // Structural no-leak: the WHOLE serialized line must not contain any command
    // string or command flag. filter_id 'git' is a class label, not the command
    // 'git status --porcelain', so these full-command substrings must be absent.
    assert.ok(!lastLine.includes('git status'), 'serialized event must not contain the command "git status"');
    assert.ok(!lastLine.includes('--porcelain'), 'serialized event must not contain a command flag');
    assert.ok(!lastLine.includes('git diff'), 'serialized event must not contain a wrapped command line');
  } finally {
    cleanup(sandbox);
  }
});

// ─── GAIN-01: `amauta compress gain` reads the local buffer ─────────────────

const SEED_LINE_A = JSON.stringify({
  schema_version: '1.1', event_id: 'a', event_type: 'compression_run',
  ts: '2026-07-06T00:00:00Z', project_hash: '0000000000000000',
  payload: { raw_bytes: 1000, compressed_bytes: 200, filter_id: 'git', savings_pct: 80 },
});
const SEED_LINE_B = JSON.stringify({
  schema_version: '1.1', event_id: 'b', event_type: 'compression_run',
  ts: '2026-07-06T00:00:01Z', project_hash: '0000000000000000',
  payload: { raw_bytes: 500, compressed_bytes: 250, filter_id: 'test', savings_pct: 50 },
});

test('GAIN-01: compress gain --json aggregates a seeded local buffer (runs/raw/compressed/savings_pct)', () => {
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(sandbox.bufferPath, SEED_LINE_A + '\n' + SEED_LINE_B + '\n');

    const res = spawnSync(process.execPath, [AMAUTA_CJS, 'compress', 'gain', '--json'], { env: sandbox.env, encoding: 'utf8' });
    assert.equal(res.status, 0, `compress gain --json must exit 0 (stderr: ${res.stderr})`);

    const agg = JSON.parse(res.stdout);
    assert.equal(agg.runs, 2, 'two seeded compression_run events -> runs === 2');
    assert.equal(agg.raw_bytes, 1500, 'total raw bytes = 1000 + 500');
    assert.equal(agg.compressed_bytes, 450, 'total compressed bytes = 200 + 250');
    // overall = round((1 - 450/1500)*100, 1) = 70
    assert.equal(agg.savings_pct, 70, 'overall savings % is computed on the SUMMED bytes, not averaged');
    assert.equal(agg.by_filter.git.runs, 1, 'per-filter breakdown must attribute the git run');
    assert.equal(agg.by_filter.test.runs, 1, 'per-filter breakdown must attribute the test run');
  } finally {
    cleanup(sandbox);
  }
});

test('GAIN-01: compress gain (human-readable) prints a Savings block with the overall percentage', () => {
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(sandbox.bufferPath, SEED_LINE_A + '\n' + SEED_LINE_B + '\n');

    const res = spawnSync(process.execPath, [AMAUTA_CJS, 'compress', 'gain'], { env: sandbox.env, encoding: 'utf8' });
    assert.equal(res.status, 0, `compress gain must exit 0 (stderr: ${res.stderr})`);
    assert.match(res.stdout, /Savings/, 'human-readable output must contain a Savings section');
    assert.ok(res.stdout.includes('70'), 'human-readable output must report the 70% overall figure');
    assert.ok(res.stdout.includes('1500'), 'human-readable output must report total raw bytes');
    assert.ok(res.stdout.includes('450'), 'human-readable output must report total compressed bytes');
  } finally {
    cleanup(sandbox);
  }
});

// ─── GAIN-03: opt-in + no network egress ────────────────────────────────────

test('GAIN-03: gsd-compress.cjs source declares no http/https network dependency', () => {
  const src = fs.readFileSync(COMPRESS_CJS, 'utf8');
  assert.ok(!/require\(\s*['"]https?['"]\s*\)/.test(src), 'gsd-compress.cjs must not require http or https (no network egress)');
});

test('GAIN-03: opt-in — a disabled emit writes nothing (buffer file is never created)', () => {
  const sandbox = makeSandbox('off');
  try {
    const probe = spawnSync(
      process.execPath,
      ['-e', "const t=require(process.argv[1]); const r=t.emit('compression_run',{raw_bytes:5,compressed_bytes:1,filter_id:'x',savings_pct:80}); process.stdout.write(JSON.stringify(r));", TELEMETRY_CJS],
      { env: sandbox.env, encoding: 'utf8' }
    );
    assert.equal(probe.status, 0, `disabled-emit probe must exit 0 (stderr: ${probe.stderr})`);
    assert.match(probe.stdout, /"emitted":false/, 'emit() must be a no-op when telemetry is unconsented');
    assert.equal(fs.existsSync(sandbox.bufferPath), false, 'zero-collection: no buffer file may be created when telemetry is off');
  } finally {
    cleanup(sandbox);
  }
});

test('GAIN-01: empty buffer -> compress gain prints the "no compression runs" advisory and exits 0', () => {
  const sandbox = makeSandbox();
  try {
    // No buffer file written at all — the missing-file fail-open path.
    const res = spawnSync(process.execPath, [AMAUTA_CJS, 'compress', 'gain'], { env: sandbox.env, encoding: 'utf8' });
    assert.equal(res.status, 0, `empty-buffer compress gain must exit 0 (stderr: ${res.stderr})`);
    assert.match(res.stdout, /no compression runs/i, 'empty buffer must print the clean no-runs advisory');
    assert.equal(fs.existsSync(sandbox.bufferPath), false, 'a read-only gain report must never create the buffer file');
  } finally {
    cleanup(sandbox);
  }
});
