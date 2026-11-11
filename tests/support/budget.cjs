/**
 * Phase 88 plan 88-03: response-time budget harness (skeleton).
 *
 * QUA-04 sets 300 ms (p95) for interactive read and write endpoints. This module
 * is the measuring and asserting half; the registry of budgets lives in
 * tests/budget/budgets.json. Phases 90-93 append endpoints; no dependency is
 * pulled in on purpose.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const DEFAULT_REGISTRY = path.join(__dirname, '..', 'budget', 'budgets.json');

/**
 * Value at quantile `q` of an ascending-sorted array: index ceil(q * n) - 1,
 * clamped to [0, n - 1].
 *
 * @param {number[]} sorted ascending numbers, length >= 1
 * @param {number} q quantile in (0, 1]
 * @returns {number}
 */
function quantile(sorted, q) {
  const n = sorted.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[idx];
}

/**
 * Time `fn` (sync or async): `warmup` untimed calls, then `samples` timed calls.
 *
 * @param {() => (Promise<unknown>|unknown)} fn the operation to time
 * @param {{samples?: number, warmup?: number}} [opts]
 * @returns {Promise<{samples: number, p50: number, p95: number, max: number, min: number, mean: number}>} milliseconds
 * @throws {Error} when `samples` is not a positive integer, or `fn` throws
 */
async function measure(fn, { samples = 30, warmup = 3 } = {}) {
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error('measure: samples must be a positive integer, got ' + samples);
  }
  for (let i = 0; i < warmup; i++) await fn();
  const deltas = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await fn();
    deltas.push(performance.now() - t0);
  }
  const sorted = deltas.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    samples,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    mean: sum / sorted.length,
  };
}

/**
 * Assert a p95 budget.
 *
 * @param {string} name endpoint or scenario name
 * @param {{p50: number, p95: number, max: number, samples: number}} stats from measure()
 * @param {{p95Ms: number}} budget
 * @returns {string} 'BUDGET OK ...' line when within budget
 * @throws {Error} 'BUDGET FAIL ...' when stats.p95 exceeds budget.p95Ms
 */
function assertBudget(name, stats, { p95Ms }) {
  if (stats.p95 > p95Ms) {
    throw new Error(
      `BUDGET FAIL ${name}: p95 ${stats.p95.toFixed(1)}ms exceeds ${p95Ms}ms ` +
        `(p50 ${stats.p50.toFixed(1)}ms, max ${stats.max.toFixed(1)}ms, n=${stats.samples})`
    );
  }
  return `BUDGET OK ${name}: p95 ${stats.p95.toFixed(1)}ms <= ${p95Ms}ms`;
}

/**
 * Read the budget registry.
 *
 * @param {string} [file] path to the registry JSON
 * @returns {{schema: number, budgets: Array<{endpoint: string, p95Ms: number, backend: string, source?: string}>}}
 * @throws {Error} when the file is unreadable, not JSON, or an entry lacks endpoint, p95Ms or backend
 */
function loadBudgets(file = DEFAULT_REGISTRY) {
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!reg || !Array.isArray(reg.budgets)) {
    throw new Error('loadBudgets: ' + file + ' has no "budgets" array');
  }
  reg.budgets.forEach((b, i) => {
    for (const key of ['endpoint', 'p95Ms', 'backend']) {
      if (b[key] === undefined || b[key] === null || b[key] === '') {
        throw new Error(`loadBudgets: budgets[${i}] (${b && b.endpoint}) lacks required field "${key}"`);
      }
    }
  });
  return reg;
}

module.exports = { measure, assertBudget, loadBudgets, quantile };
