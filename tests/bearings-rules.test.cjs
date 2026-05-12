'use strict';
/**
 * Plan 45-01-06: 7 unit tests for the FROZEN 6-rule recommendation precedence chain.
 *
 * Tests chooseRecommendation() directly via module import (no subprocess).
 * Covers all 6 rules + 1 precedence-order proof (Rule 1 beats Rule 2).
 *
 * Run: node --test tests/bearings-rules.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { chooseRecommendation } = require(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'));

// ─── Synthetic fixture builder ────────────────────────────────────────────────

/**
 * Build a baseline structured object with optional overrides.
 * @param {object} overrides — { project_state, plan_progress, pattern_stats }
 */
const synth = (overrides = {}) => ({
  project_state: {
    phase_number: '45',
    phase_name: 'X',
    current_plan: '45-01',
    status: 'in_progress',
    drift_signals: [],
    ...(overrides.project_state || {}),
  },
  plan_progress: {
    feature_list_path: null,
    counts: { pass: 0, fail: 0, pending: 0 },
    ...(overrides.plan_progress || {}),
  },
  pattern_stats: overrides.pattern_stats || [
    { name: 'avg_sessions_per_phase_type', value: '2.3', status: 'pass', detail: '' },
    { name: 'commits_since_last_test', value: '1', status: 'pass', detail: '' },
    { name: 'similar_feature_sessions', value: '4.2', status: 'pass', detail: '' },
    { name: 'plan_complexity_trend', value: '67/100', status: 'pass', detail: '' },
  ],
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('Rule 1 — fail > 0 → /amauta:debug', () => {
  const obj = synth({ plan_progress: { feature_list_path: null, counts: { pass: 0, fail: 2, pending: 3 } } });
  const rec = chooseRecommendation(obj);
  assert.strictEqual(rec.action, '/amauta:debug');
  assert.match(rec.reasoning, /2 failing/);
});

test('Rule 2 — drift_signals non-empty → git status / review STATE.md', () => {
  const obj = synth({
    project_state: { phase_number: '45', phase_name: 'X', current_plan: '45-01', status: 'in_progress', drift_signals: ['state_git_phase_mismatch'] },
    plan_progress: { feature_list_path: null, counts: { pass: 1, fail: 0, pending: 0 } },
  });
  const rec = chooseRecommendation(obj);
  assert.strictEqual(rec.action, 'git status / review STATE.md');
});

test('Rule 3 — pending > 0 AND no fail → /amauta:execute-phase 45', () => {
  const obj = synth({ plan_progress: { feature_list_path: null, counts: { pass: 1, fail: 0, pending: 3 } } });
  const rec = chooseRecommendation(obj);
  assert.ok(rec.action.startsWith('/amauta:execute-phase 45'));
  assert.match(rec.reasoning, /3 pending/);
});

test('Rule 4 — all pass → /amauta:plan-phase 46', () => {
  const obj = synth({ plan_progress: { feature_list_path: null, counts: { pass: 5, fail: 0, pending: 0 } } });
  const rec = chooseRecommendation(obj);
  assert.ok(rec.action.startsWith('/amauta:plan-phase 46'));
  assert.match(rec.reasoning, /plan complete/);
});

test('Rule 5 — commits_since_last_test > 3 → /amauta:test-phase 45', () => {
  const obj = synth({
    pattern_stats: [
      { name: 'avg_sessions_per_phase_type', value: '2', status: 'pass', detail: '' },
      { name: 'commits_since_last_test', value: '7', status: 'warn', detail: '' },
      { name: 'similar_feature_sessions', value: null, status: 'unavailable', detail: '' },
      { name: 'plan_complexity_trend', value: '42/100', status: 'pass', detail: '' },
    ],
  });
  const rec = chooseRecommendation(obj);
  assert.ok(rec.action.startsWith('/amauta:test-phase 45'));
  assert.match(rec.reasoning, /7 commits/);
});

test('Rule 6 — default → /amauta:progress', () => {
  // All-zero counts, no drift, low commits
  const obj = synth();
  const rec = chooseRecommendation(obj);
  assert.strictEqual(rec.action, '/amauta:progress');
});

test('PRECEDENCE — Rule 1 (fail > 0) beats Rule 2 (drift_signals)', () => {
  // Both fail > 0 AND drift_signals non-empty — Rule 1 MUST win
  const obj = synth({
    project_state: { phase_number: '45', phase_name: 'X', current_plan: '45-01', status: 'in_progress', drift_signals: ['x'] },
    plan_progress: { feature_list_path: null, counts: { pass: 0, fail: 2, pending: 0 } },
  });
  const rec = chooseRecommendation(obj);
  assert.strictEqual(rec.action, '/amauta:debug', 'Rule 1 must fire before Rule 2');
  assert.notEqual(rec.action, 'git status / review STATE.md');
});
