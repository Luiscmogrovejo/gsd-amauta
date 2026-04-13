#!/usr/bin/env node
/**
 * Plan 05-01: Redis Infrastructure + Daemon Service Management Tests
 *
 * Tests:
 *   COMPOSE-01: Redis in docker-compose
 *     1. redis service block exists with correct image
 *     2. Localhost-only port binding
 *     3. Healthcheck with redis-cli ping
 *     4. Cache-only config (--save "" and allkeys-lru)
 *   DEPS-01: Dependencies and env vars
 *     5. redis>=5.0 in requirements.txt
 *     6. GSD_REDIS_URL in .env.example
 *     7. GSD_REDIS_ENABLED in .env.example
 *   DAEMON-01: Redis daemon management
 *     8. _start_redis function exists
 *     9. _stop_redis function exists
 *    10. _check_redis_health function exists
 *    11. _redis_watchdog function exists
 *    12. _auto_start_redis_container function exists
 *    13. redis_managed in /health endpoint
 *    14. redis_running in /health endpoint
 *    15. redis_restarts in /health endpoint
 *    16. REDIS_MAX_RESTARTS = 3
 *    17. _HAS_REDIS import guard
 *    18. _stop_redis in shutdown path
 *   INFRA-01: infra_detect Redis support
 *    19. _detect_redis function exists
 *    20. redis_available in detect result
 *    21. gsd-redis docker start in auto-start path
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE = fs.readFileSync(path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf-8');
const REQUIREMENTS = fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf-8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
const INFRA = fs.readFileSync(path.join(ROOT, 'services', 'infra_detect.py'), 'utf-8');

describe('COMPOSE-01: Redis in docker-compose', () => {
  it('1. redis service with valkey/valkey:8-alpine image (INFRA-01 Valkey swap)', () => {
    assert.ok(COMPOSE.includes('image: valkey/valkey:8-alpine'), 'Missing valkey/valkey:8-alpine image');
  });
  it('2. Localhost-only port binding', () => {
    assert.ok(COMPOSE.includes('127.0.0.1:6379:6379'), 'Missing localhost-only Redis port');
  });
  it('3. Healthcheck with valkey-cli ping (INFRA-01 Valkey swap)', () => {
    assert.ok(COMPOSE.includes('valkey-cli'), 'Missing valkey-cli healthcheck');
  });
  it('4. Cache-only config', () => {
    assert.ok(COMPOSE.includes('allkeys-lru'), 'Missing allkeys-lru eviction policy');
    assert.ok(COMPOSE.includes('--save ""'), 'Missing --save "" (persistence disabled)');
  });
});

describe('DEPS-01: Dependencies and env vars', () => {
  it('5. redis>=5.0 in requirements.txt', () => {
    assert.ok(REQUIREMENTS.includes('redis>=5.0'), 'Missing redis>=5.0 dependency');
  });
  it('6. GSD_REDIS_URL in .env.example', () => {
    assert.ok(ENV_EXAMPLE.includes('GSD_REDIS_URL'), 'Missing GSD_REDIS_URL');
  });
  it('7. GSD_REDIS_ENABLED in .env.example', () => {
    assert.ok(ENV_EXAMPLE.includes('GSD_REDIS_ENABLED'), 'Missing GSD_REDIS_ENABLED');
  });
});

describe('DAEMON-01: Redis daemon management', () => {
  it('8. _start_redis function exists', () => {
    assert.ok(DAEMON.includes('def _start_redis():'), 'Missing _start_redis');
  });
  it('9. _stop_redis function exists', () => {
    assert.ok(DAEMON.includes('def _stop_redis():'), 'Missing _stop_redis');
  });
  it('10. _check_redis_health function exists', () => {
    assert.ok(DAEMON.includes('def _check_redis_health():'), 'Missing _check_redis_health');
  });
  it('11. _redis_watchdog function exists', () => {
    assert.ok(DAEMON.includes('def _redis_watchdog():'), 'Missing _redis_watchdog');
  });
  it('12. _auto_start_redis_container function exists', () => {
    assert.ok(DAEMON.includes('def _auto_start_redis_container():'), 'Missing _auto_start_redis_container');
  });
  it('13. redis_managed in /health endpoint', () => {
    assert.ok(DAEMON.includes('"redis_managed"'), 'Missing redis_managed in health');
  });
  it('14. redis_running in /health endpoint', () => {
    assert.ok(DAEMON.includes('"redis_running"'), 'Missing redis_running in health');
  });
  it('15. redis_restarts in /health endpoint', () => {
    assert.ok(DAEMON.includes('"redis_restarts"'), 'Missing redis_restarts in health');
  });
  it('16. REDIS_MAX_RESTARTS = 3', () => {
    assert.ok(DAEMON.includes('REDIS_MAX_RESTARTS = 3'), 'Missing REDIS_MAX_RESTARTS');
  });
  it('17. _HAS_REDIS import guard', () => {
    assert.ok(DAEMON.includes('_HAS_REDIS'), 'Missing _HAS_REDIS flag');
    assert.ok(DAEMON.includes('import redis as redis_module'), 'Missing redis import guard');
  });
  it('18. _stop_redis in shutdown path', () => {
    assert.ok(DAEMON.includes('_stop_redis()'), 'Missing _stop_redis in shutdown');
  });
});

describe('INFRA-01: infra_detect Redis support', () => {
  it('19. _detect_redis function exists', () => {
    assert.ok(INFRA.includes('def _detect_redis():'), 'Missing _detect_redis');
  });
  it('20. redis_available in detect result', () => {
    assert.ok(INFRA.includes('redis_available'), 'Missing redis_available in result');
  });
  it('21. gsd-redis docker start in auto-start path', () => {
    assert.ok(INFRA.includes('gsd-redis'), 'Missing gsd-redis in auto-start');
  });
});
