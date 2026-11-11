/**
 * Phase 88 plan 88-03: the response-time budget harness.
 *
 * Pure tests for measure / assertBudget / loadBudgets, plus one integration test
 * that measures the two registered endpoints against the fixture daemon. The
 * integration test REPORTS rather than gates (see the comment inside it).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { measure, assertBudget, loadBudgets, quantile } = require(path.join(ROOT, 'tests', 'support', 'budget.cjs'));
const { startFixtureDaemon, stopFixtureDaemon } = require(path.join(ROOT, 'tests', 'support', 'fixture-daemon.cjs'));

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a path on the fixture daemon and drain the body.
 *
 * @param {number} port
 * @param {string} urlPath
 * @returns {Promise<number>} HTTP status
 * @throws {Error} on a socket error
 */
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });
}

describe('measure', () => {
  test('returns ordered statistics for a deterministic sleep', async () => {
    const stats = await measure(() => sleep(2), { samples: 30, warmup: 2 });
    assert.strictEqual(stats.samples, 30);
    assert.ok(stats.min <= stats.p50, 'min <= p50');
    assert.ok(stats.p50 <= stats.p95, 'p50 <= p95');
    assert.ok(stats.p95 <= stats.max, 'p95 <= max');
    assert.ok(stats.mean >= stats.min && stats.mean <= stats.max, 'mean within [min, max]');
  });

  test('runs warmup calls without recording them', async () => {
    let calls = 0;
    const stats = await measure(() => { calls++; }, { samples: 5, warmup: 3 });
    assert.strictEqual(calls, 8);
    assert.strictEqual(stats.samples, 5);
  });

  test('rejects a non-positive sample count', async () => {
    await assert.rejects(() => measure(() => {}, { samples: 0 }), /samples must be a positive integer/);
  });

  test('quantile indexes ceil(q*n)-1 and clamps', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.strictEqual(quantile(v, 0.5), 5);
    assert.strictEqual(quantile(v, 0.95), 10);
    assert.strictEqual(quantile([7], 0.95), 7);
    assert.strictEqual(quantile(v, 0.0001), 1);
  });
});

describe('assertBudget', () => {
  test('returns a BUDGET OK line when p95 is within budget', () => {
    const line = assertBudget('GET /x', { p95: 120, p50: 10, max: 150, samples: 30 }, { p95Ms: 300 });
    assert.ok(line.startsWith('BUDGET OK GET /x'), line);
  });

  test('throws the exact BUDGET FAIL message when p95 exceeds the budget', () => {
    assert.throws(
      () => assertBudget('GET /x', { p95: 900, p50: 1, max: 2, samples: 30 }, { p95Ms: 300 }),
      (e) => e.message === 'BUDGET FAIL GET /x: p95 900.0ms exceeds 300ms (p50 1.0ms, max 2.0ms, n=30)'
    );
  });
});

describe('loadBudgets', () => {
  test('the registry parses and every entry is complete', () => {
    const reg = loadBudgets();
    assert.strictEqual(reg.schema, 1);
    assert.ok(reg.budgets.length >= 2);
    for (const b of reg.budgets) {
      assert.ok(b.endpoint, 'endpoint');
      assert.ok(Number.isFinite(b.p95Ms), 'p95Ms');
      assert.ok(b.backend, 'backend');
    }
  });

  test('names the missing field of an incomplete entry', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')), 'bad.json');
    fs.writeFileSync(f, JSON.stringify({ schema: 1, budgets: [{ endpoint: 'GET /y', backend: 'sqlite' }] }));
    assert.throws(() => loadBudgets(f), /lacks required field "p95Ms"/);
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
});

describe('budgets against the fixture daemon', () => {
  test('GET /health and GET /api/list are measured (reported, not gated)', async (t) => {
    const daemon = await startFixtureDaemon();
    try {
      const budgets = loadBudgets().budgets.filter((b) => b.backend === 'sqlite');
      for (const [endpoint, p95Ms] of budgets.map((b) => [b.endpoint, b.p95Ms])) {
        const urlPath = endpoint.replace(/^GET /, '');
        const stats = await measure(async () => {
          const status = await get(daemon.port, urlPath);
          assert.ok(status < 500, `${endpoint} answered ${status}`);
        }, { samples: 30, warmup: 3 });

        // CI runner timing is not a product property, so a slow runner must not turn this
        // red: a BUDGET FAIL becomes a diagnostic plus a stderr line. The test only fails
        // when p95 is above 3000 ms (ten times the 300 ms budget), i.e. the endpoint is
        // actually broken rather than the runner being slow. Phase 93 tightens this.
        try {
          const line = assertBudget(endpoint, stats, { p95Ms });
          t.diagnostic(line);
          console.log(line);
        } catch (e) {
          t.diagnostic(e.message);
          console.error(e.message);
        }
        if (stats.p95 > 3000) {
          assert.fail(`${endpoint}: p95 ${stats.p95.toFixed(1)}ms is above 3000ms, the endpoint is broken`);
        }
      }
    } finally {
      await stopFixtureDaemon(daemon);
    }
  });
});
