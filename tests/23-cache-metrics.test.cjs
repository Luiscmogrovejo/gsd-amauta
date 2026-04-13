#!/usr/bin/env node
/**
 * Phase 23 CACHE-04: Cache Metrics Infrastructure Integration Tests.
 *
 * Validates that prompt_cache.py module, daemon endpoint wiring, and
 * CLI subcommand are all correctly implemented. Tests run without a
 * live daemon — they use Python one-liners and static grep checks.
 *
 * Requirements:
 *   CACHE-04: GET /metrics/cache returns {hit_rate, total_tokens_saved,
 *             cost_savings_estimate, cache_read_tokens, cache_creation_tokens,
 *             total_requests}; counters update after each API call.
 *
 * Run: node --test tests/23-cache-metrics.test.cjs
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');
const PROMPT_CACHE_PY = path.join(PROJECT_ROOT, 'services', 'prompt_cache.py');
const DAEMON_PY = path.join(PROJECT_ROOT, 'services', 'amauta-daemon.py');
const CLI_CJS = path.join(PROJECT_ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');

// Run a Python one-liner from PROJECT_ROOT, return stdout as string
function runPython(code) {
  return execSync(`python3 -c "${code}"`, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
  }).trim();
}

// Run a Python one-liner that outputs JSON, return parsed object
function runPythonJson(code) {
  const raw = runPython(code);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prompt_cache module', () => {

  it('prompt_cache.py file exists', () => {
    assert.ok(fs.existsSync(PROMPT_CACHE_PY), `Missing: ${PROMPT_CACHE_PY}`);
  });

  it('prompt_cache module imports successfully', () => {
    const out = runPython(
      'from services.prompt_cache import PromptCacheMetrics, annotate_cache_control; print(\\"OK\\")'
    );
    assert.strictEqual(out, 'OK');
  });

  it('PromptCacheMetrics.stats() returns all 6 required fields', () => {
    const stats = runPythonJson(
      'from services.prompt_cache import PromptCacheMetrics; ' +
      'import json; m = PromptCacheMetrics(); print(json.dumps(m.stats()))'
    );
    const required = [
      'hit_rate', 'total_tokens_saved', 'cost_savings_estimate',
      'cache_read_tokens', 'cache_creation_tokens', 'total_requests',
    ];
    for (const field of required) {
      assert.ok(field in stats, `Missing field: ${field}`);
    }
  });

  it('stats() fields have correct types', () => {
    const stats = runPythonJson(
      'from services.prompt_cache import PromptCacheMetrics; ' +
      'import json; m = PromptCacheMetrics(); m.record(500, 200); print(json.dumps(m.stats()))'
    );
    assert.strictEqual(typeof stats.hit_rate, 'number', 'hit_rate must be number');
    assert.strictEqual(typeof stats.total_tokens_saved, 'number', 'total_tokens_saved must be number');
    assert.strictEqual(typeof stats.cost_savings_estimate, 'number', 'cost_savings_estimate must be number');
    assert.strictEqual(typeof stats.total_requests, 'number', 'total_requests must be number');
    assert.strictEqual(typeof stats.cache_read_tokens, 'number', 'cache_read_tokens must be number');
    assert.strictEqual(typeof stats.cache_creation_tokens, 'number', 'cache_creation_tokens must be number');
  });

  it('record(500, 200) updates counters correctly', () => {
    const stats = runPythonJson(
      'from services.prompt_cache import PromptCacheMetrics; ' +
      'import json; m = PromptCacheMetrics(); m.record(500, 200); print(json.dumps(m.stats()))'
    );
    assert.strictEqual(stats.cache_read_tokens, 500);
    assert.strictEqual(stats.cache_creation_tokens, 200);
    assert.strictEqual(stats.total_requests, 1);
    assert.strictEqual(stats.total_tokens_saved, 500);
  });

  it('hit_rate computes correctly after record(900, 100)', () => {
    const stats = runPythonJson(
      'from services.prompt_cache import PromptCacheMetrics; ' +
      'import json; m = PromptCacheMetrics(); m.record(900, 100); print(json.dumps(m.stats()))'
    );
    // 900 / (900 + 100) = 0.9 (rounded to 4 decimals)
    assert.ok(Math.abs(stats.hit_rate - 0.9) < 0.001, `Expected hit_rate ~0.9, got ${stats.hit_rate}`);
  });

});

describe('daemon endpoint wiring', () => {

  it('daemon has GET /metrics/cache route', () => {
    const content = fs.readFileSync(DAEMON_PY, 'utf-8');
    assert.ok(content.includes('/metrics/cache'), 'amauta-daemon.py must contain /metrics/cache route');
  });

  it('daemon has POST /metrics/cache/record route', () => {
    const content = fs.readFileSync(DAEMON_PY, 'utf-8');
    assert.ok(
      content.includes('/metrics/cache/record'),
      'amauta-daemon.py must contain /metrics/cache/record POST route'
    );
  });

  it('daemon OIDC bypass includes /metrics/cache', () => {
    const content = fs.readFileSync(DAEMON_PY, 'utf-8');
    // Both bypass locations must include /metrics/cache
    const oidcBypassMatch = content.match(/"\/health",\s*"\/metrics",\s*"\/metrics\/cache"/);
    assert.ok(
      oidcBypassMatch !== null,
      'OIDC bypass must include /metrics/cache alongside /health and /metrics'
    );
  });

  it('daemon has PromptCacheMetrics singleton', () => {
    const content = fs.readFileSync(DAEMON_PY, 'utf-8');
    assert.ok(
      content.includes('_prompt_cache_metrics'),
      'amauta-daemon.py must have _prompt_cache_metrics module-level variable'
    );
  });

});

describe('CLI subcommand', () => {

  it('cache-stats subcommand exists in gsd-amauta.cjs', () => {
    const content = fs.readFileSync(CLI_CJS, 'utf-8');
    assert.ok(content.includes("'cache-stats'"), "gsd-amauta.cjs must contain 'cache-stats' case");
  });

  it('cache-stats fetches /metrics/cache endpoint', () => {
    const content = fs.readFileSync(CLI_CJS, 'utf-8');
    assert.ok(
      content.includes('/metrics/cache'),
      'gsd-amauta.cjs must reference /metrics/cache endpoint'
    );
  });

  it('cache-stats displays hit_rate and cost_savings_estimate', () => {
    const content = fs.readFileSync(CLI_CJS, 'utf-8');
    assert.ok(content.includes('hit_rate'), 'cache-stats must display hit_rate');
    assert.ok(content.includes('cost_savings_estimate'), 'cache-stats must display cost_savings_estimate');
  });

});
