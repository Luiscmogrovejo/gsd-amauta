#!/usr/bin/env node
/**
 * Plan 05-04: Data Flow Alerts Tests
 *
 * Tests:
 *   HEALTH-01: Pipeline status in /health
 *     1. pipeline_status field exists
 *     2. healthy/degraded/critical values present
 *     3. service_errors array exists
 *     4. cache_metrics section exists
 *   HEALTH-02: Service error messages
 *     5. PostgreSQL error message
 *     6. Redis error message
 *     7. RLM error message
 *     8. Voyage API error message
 *     9. Perplexity API error message
 *   BANNER-01: Startup service inventory
 *    10. Service Status banner
 *    11. Pipeline: HEALTHY message
 *    12. Pipeline: DEGRADED message
 *   ALERT-01: CLI data flow errors
 *    13. RLM connection error in gsd-rlm.cjs
 *    14. Daemon connection error in gsd-research.cjs
 *    15. Perplexity API error in gsd-research.cjs
 *   CACHE-01: Cache metrics
 *    16. redis_hit_rate in cache metrics
 *    17. rlm_cache_hit_rate in cache metrics
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
const RLM_CLI = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-rlm.cjs'), 'utf-8');
const RESEARCH = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs'), 'utf-8');

describe('HEALTH-01: Pipeline status in /health', () => {
  it('1. pipeline_status field', () => {
    assert.ok(DAEMON.includes('"pipeline_status"'), 'Missing pipeline_status');
  });
  it('2. healthy/degraded/critical values', () => {
    assert.ok(DAEMON.includes('"healthy"'), 'Missing healthy status');
    assert.ok(DAEMON.includes('"degraded"'), 'Missing degraded status');
    assert.ok(DAEMON.includes('"critical"'), 'Missing critical status');
  });
  it('3. service_errors array', () => {
    assert.ok(DAEMON.includes('"service_errors"'), 'Missing service_errors');
    assert.ok(DAEMON.includes('service_errors = []'), 'service_errors must start as empty list');
  });
  it('4. cache_metrics section', () => {
    assert.ok(DAEMON.includes('"cache_metrics"'), 'Missing cache_metrics');
  });
});

describe('HEALTH-02: Service error messages', () => {
  it('5. PostgreSQL error message', () => {
    assert.ok(DAEMON.includes('PostgreSQL: no database connection'),
      'Missing PG error message');
  });
  it('6. Redis error message', () => {
    assert.ok(DAEMON.includes('Redis: cache unreachable'),
      'Missing Redis error message');
  });
  it('7. RLM error message', () => {
    assert.ok(DAEMON.includes('RLM: context engine not responding'),
      'Missing RLM error message');
  });
  it('8. Voyage API error message', () => {
    assert.ok(DAEMON.includes('Voyage API: key not set'),
      'Missing Voyage error message');
  });
  it('9. Perplexity API error message', () => {
    assert.ok(DAEMON.includes('Perplexity API: key not set'),
      'Missing Perplexity error message');
  });
});

describe('BANNER-01: Startup service inventory', () => {
  it('10. Service Status banner', () => {
    assert.ok(DAEMON.includes('Service Status'),
      'Missing Service Status banner');
  });
  it('11. Pipeline: HEALTHY', () => {
    assert.ok(DAEMON.includes('Pipeline: HEALTHY'),
      'Missing HEALTHY pipeline status');
  });
  it('12. Pipeline: DEGRADED', () => {
    assert.ok(DAEMON.includes('Pipeline: DEGRADED'),
      'Missing DEGRADED pipeline status');
  });
});

describe('ALERT-01: CLI data flow errors', () => {
  it('13. RLM connection error in gsd-rlm.cjs', () => {
    assert.ok(RLM_CLI.includes('DATA FLOW ERROR'),
      'Missing DATA FLOW ERROR in gsd-rlm.cjs');
  });
  it('14. Daemon connection error in gsd-research.cjs', () => {
    assert.ok(RESEARCH.includes('DATA FLOW ERROR'),
      'Missing DATA FLOW ERROR in gsd-research.cjs');
  });
  it('15. Perplexity API error in gsd-research.cjs', () => {
    assert.ok(RESEARCH.includes('Perplexity API'),
      'Missing Perplexity API error in gsd-research.cjs');
  });
});

describe('CACHE-01: Cache metrics', () => {
  it('16. redis_hit_rate in cache metrics', () => {
    assert.ok(DAEMON.includes('redis_hit_rate'),
      'Missing redis_hit_rate');
  });
  it('17. rlm_cache_hit_rate in cache metrics', () => {
    assert.ok(DAEMON.includes('rlm_cache_hit_rate'),
      'Missing rlm_cache_hit_rate');
  });
});
