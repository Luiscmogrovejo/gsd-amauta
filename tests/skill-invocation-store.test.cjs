'use strict';
/**
 * Plan 43-02-05: Skill Invocation Store Tests (Node.js)
 * File: tests/skill-invocation-store.test.cjs
 *
 * Requirements covered:
 *   SKILL-02: PG invocation memory + hybrid retrieval + daemon endpoints
 *
 * Tests:
 *   1. skills list reads canonical skills (hermetic — no daemon)
 *   2. skills invoke missing flags exits non-zero
 *   3. skills complete rejects invalid outcome
 *   4. daemon /api/skills/invoke round-trip (skip if daemon down)
 *   5. daemon /api/skills/complete round-trip (skip if daemon down OR no PG)
 *   6. retrieve_similar p95 < 200ms over 1000-row table (skip if daemon/PG down)
 *   7. RRF math sanity (pure JS replica — no daemon)
 *
 * Run: node --test tests/skill-invocation-store.test.cjs
 * CI:  exits 0 even when daemon/PG are unavailable (tests skip gracefully)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
// Phase 88 plan 88-16-06: the three live round-trips below used to probe the
// OPERATOR'S daemon and skip themselves when it did not answer — which, under
// the hermetic guard, it never could. They start their own fixture daemon in
// POSTGRES MODE (opt-in per call; the runner's SQLite default is untouched)
// and skip only when there is no disposable database to point it at.
const { startFixtureDaemon, stopFixtureDaemon } = require('./support/fixture-daemon.cjs');
const pg = require('./support/pg-fixture.cjs');

let daemon = null;

/** @returns {number} the fixture daemon's port */
function daemonPort() {
  if (!daemon) throw new Error('the fixture daemon has not started yet');
  return daemon.port;
}

const SKIP_PG = pg.postgresDsn() ? false : pg.SKIP_REASON;

before(async () => {
  if (SKIP_PG) return; // nothing to point a Postgres-mode daemon at
  daemon = await startFixtureDaemon({ postgres: true });
});

after(async () => {
  await stopFixtureDaemon(daemon);
  daemon = null;
});
const DAEMON_HOST = '127.0.0.1';

// ─── HTTP helper ───────────────────────────────────────────────────────────────

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: DAEMON_HOST,
      port: daemonPort(),
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── RRF formula (pure JS replica) ───────────────────────────────────────────

function rrfFuse(listA, listB, k = 60) {
  const scores = {};
  for (const [rank, item] of listA.entries()) {
    const id = item.id;
    if (!scores[id]) scores[id] = { id, rrf: 0 };
    scores[id].rrf += 1.0 / (k + rank + 1);
  }
  for (const [rank, item] of listB.entries()) {
    const id = item.id;
    if (!scores[id]) scores[id] = { id, rrf: 0 };
    scores[id].rrf += 1.0 / (k + rank + 1);
  }
  return Object.values(scores).sort((a, b) => b.rrf - a.rrf);
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

test('skills list reads canonical skills', () => {
  // Hermetic — no daemon, no PG required.
  const result = spawnSync(
    'node',
    [TOOLS_PATH, 'skills', 'list', '--source=get-shit-done/skills'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.strictEqual(result.status, 0, `skills list exited ${result.status}: ${result.stderr}`);
  let skills;
  try { skills = JSON.parse(result.stdout); } catch (_) { assert.fail('skills list output is not valid JSON'); }
  assert.ok(Array.isArray(skills), 'skills list output should be an array');
  const names = skills.map(s => s.name || '');
  assert.ok(names.includes('plan-phase'), `expected plan-phase in ${JSON.stringify(names)}`);
  assert.ok(names.includes('execute-phase'), `expected execute-phase in ${JSON.stringify(names)}`);
  assert.ok(names.includes('discuss-phase'), `expected discuss-phase in ${JSON.stringify(names)}`);
});

test('skills invoke missing flags exits non-zero', () => {
  const result = spawnSync(
    'node',
    [TOOLS_PATH, 'skills', 'invoke'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.notStrictEqual(result.status, 0, 'skills invoke with no flags should exit non-zero');
  const output = (result.stdout + result.stderr).toLowerCase();
  assert.ok(
    output.includes('required') || output.includes('usage') || output.includes('error'),
    `expected 'required', 'usage', or 'error' in output: ${output}`
  );
});

test('skills complete rejects invalid outcome', () => {
  const result = spawnSync(
    'node',
    [TOOLS_PATH, 'skills', 'complete', '--id=fake-uuid', '--outcome=bogus'],
    { encoding: 'utf8', cwd: ROOT }
  );
  assert.notStrictEqual(result.status, 0, 'skills complete with bogus outcome should exit non-zero');
  const output = (result.stdout + result.stderr).toLowerCase();
  const hasValidOutcome = (
    output.includes('success') ||
    output.includes('fail') ||
    output.includes('escalation') ||
    output.includes('outcome')
  );
  assert.ok(hasValidOutcome, `expected mention of valid outcomes in output: ${output}`);
});

test('daemon /api/skills/invoke round-trip', { skip: SKIP_PG }, async () => {
  // The fixture daemon runs THIS tree's code, so the old "pre-Phase-43 daemon"
  // and "daemon not running" escape hatches cannot apply and are gone: a 404 on
  // this route is now a failure, which is what it always should have been.
  const res = await httpPost('/api/skills/invoke', {
    skill_name: 'plan-phase',
    prompt: 'test invocation for node test round-trip',
  });
  assert.strictEqual(res.status, 200, `expected 200 from /api/skills/invoke, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(typeof res.body === 'object' && res.body !== null, 'response should be a JSON object');
  assert.ok('invocation_id' in res.body, `response should have invocation_id key: ${JSON.stringify(res.body)}`);
  assert.ok('neighbors' in res.body, `response should have neighbors key: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.neighbors), `neighbors should be an array: ${JSON.stringify(res.body)}`);
});

test('daemon /api/skills/complete round-trip', { skip: SKIP_PG }, async () => {
  const invokeRes = await httpPost('/api/skills/invoke', {
    skill_name: 'plan-phase',
    prompt: 'test invocation for complete round-trip',
  });
  assert.strictEqual(invokeRes.status, 200,
    `expected 200 from /api/skills/invoke, got ${invokeRes.status}: ${JSON.stringify(invokeRes.body)}`);
  assert.ok(invokeRes.body.invocation_id,
    `/api/skills/invoke returned no invocation_id: ${JSON.stringify(invokeRes.body)}`);
  const invocationId = invokeRes.body.invocation_id;
  const completeRes = await httpPost('/api/skills/complete', {
    invocation_id: invocationId,
    outcome_class: 'success',
  });
  assert.strictEqual(completeRes.status, 200, `expected 200 from /api/skills/complete, got ${completeRes.status}: ${JSON.stringify(completeRes.body)}`);
  assert.strictEqual(completeRes.body.ok, true, `expected {ok: true} from /api/skills/complete: ${JSON.stringify(completeRes.body)}`);
});

test('retrieve_similar p95 < 200ms over 1000-row table', { skip: SKIP_PG }, async () => {
  // Warm-up, and a real assertion rather than an escape hatch: the fixture
  // daemon runs this tree's code against the disposable database, so a missing
  // route or a missing invocation_id is a failure, not a reason to skip.
  const warmup = await httpPost('/api/skills/invoke', {
    skill_name: 'perf-test-skill',
    prompt: 'warmup invocation',
  });
  assert.strictEqual(warmup.status, 200,
    `warm-up /api/skills/invoke returned ${warmup.status}: ${JSON.stringify(warmup.body)}`);
  assert.ok(warmup.body.invocation_id,
    `warm-up returned no invocation_id: ${JSON.stringify(warmup.body)}`);

  // Run 20 /api/skills/invoke round-trips and measure wall-clock latency
  const SAMPLE_SIZE = 20;
  const latencies = [];
  const prompts = [
    'plan a new feature', 'debug a failing test', 'write documentation',
    'review a pull request', 'refactor old code', 'analyze performance',
    'create a migration', 'add error handling', 'update dependencies', 'fix a bug',
    'design an API', 'write unit tests', 'deploy to staging', 'monitor logs',
    'optimize queries', 'handle auth flow', 'add caching layer', 'process events',
    'send notifications', 'validate inputs',
  ];
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const prompt = prompts[i % prompts.length];
    const t0 = Date.now();
    try {
      await httpPost('/api/skills/invoke', {
        skill_name: 'plan-phase',
        prompt: `${prompt} (perf sample ${i})`,
      });
    } catch (_) {
      break; // daemon went away mid-test — stop sampling
    }
    latencies.push(Date.now() - t0);
  }

  assert.ok(
    latencies.length >= 5,
    `only ${latencies.length} of ${SAMPLE_SIZE} samples completed; the p95 assertion needs at least 5`
  );

  // Compute p95
  latencies.sort((a, b) => a - b);
  const p95idx = Math.floor(latencies.length * 0.95);
  const p95 = latencies[Math.min(p95idx, latencies.length - 1)];
  // p95 < 200ms assertion
  assert.ok(
    p95 < 200,
    `p95 latency ${p95}ms exceeds 200ms budget (all samples: ${JSON.stringify(latencies)})`
  );
});

test('RRF math sanity (pure JS replica)', () => {
  // Fuse [a, b] + [b, c] → b first (b at rank 2 in list A, rank 1 in list B)
  // a: 1/(60+1) = 0.01639
  // b: 1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
  // c: 1/(60+2) = 0.01613
  // Expected order: b > a > c
  const listA = [{ id: 'a' }, { id: 'b' }];
  const listB = [{ id: 'b' }, { id: 'c' }];
  const fused = rrfFuse(listA, listB);
  assert.ok(Array.isArray(fused), 'RRF output should be an array');
  assert.strictEqual(fused[0].id, 'b', `b should be first (appears in both lists). Got: ${JSON.stringify(fused.map(x => x.id))}`);

  // b score > a score
  const bScore = fused.find(x => x.id === 'b').rrf;
  const aScore = fused.find(x => x.id === 'a').rrf;
  const cScore = fused.find(x => x.id === 'c').rrf;
  assert.ok(bScore > aScore, `b rrf (${bScore}) should exceed a rrf (${aScore})`);
  assert.ok(aScore > cScore, `a rrf (${aScore}) should exceed c rrf (${cScore})`);
});
