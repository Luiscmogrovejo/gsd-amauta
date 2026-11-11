/**
 * Phase 88 plan 88-01: scripts/run-tests.cjs hands every child a scrubbed environment.
 */

'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { buildHermeticEnv } = require(path.join(ROOT, 'scripts', 'run-tests.cjs'));

const POLLUTED = {
  GSD_POSTGRES_URL: 'postgresql://live:live@127.0.0.1:5433/live',
  DATABASE_URL: 'postgresql://live',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  VALKEY_URL: 'redis://127.0.0.1:6379/1',
  AMAUTA_MEMORY_DATABASE_URL: 'postgresql://live/mem',
  GSD_PG_PORT: '5433',
  NODE_OPTIONS: '--max-old-space-size=4096',
};

describe('buildHermeticEnv', () => {
  const env = buildHermeticEnv({ ...POLLUTED });
  const root = path.dirname(env.AMAUTA_DATA_DIR);
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('removes every pollutant key', () => {
    for (const k of Object.keys(POLLUTED).filter((k) => k !== 'NODE_OPTIONS')) {
      assert.ok(!(k in env), k + ' must be removed');
    }
  });

  test('forces SQLite, test mode and the no-side-effect switches', () => {
    assert.strictEqual(env.GSD_FORCE_SQLITE, '1');
    assert.strictEqual(env.GSD_TEST_MODE, '1');
    assert.strictEqual(env.GSD_INSTALL_FILES_ONLY, '1');
    assert.strictEqual(env.GSD_AMAUTA_NO_AUTO_START, '1');
    assert.strictEqual(env.AMAUTA_AUTO_BACKUP, 'off');
  });

  test('moves ports off the live services', () => {
    assert.strictEqual(env.GSD_AMAUTA_PORT, env.GSD_DAEMON_PORT);
    for (const k of ['GSD_AMAUTA_PORT', 'GSD_RLM_PORT']) {
      assert.ok(!['18799', '18798', '6379', '5433'].includes(env[k]), k + '=' + env[k]);
    }
    assert.notStrictEqual(env.GSD_AMAUTA_PORT, env.GSD_RLM_PORT);
    assert.ok(!/:(6379|5433)\//.test(env.GSD_REDIS_URL), env.GSD_REDIS_URL);
  });

  test('data and config dirs are temporary and not the live store', () => {
    const tmp = fs.realpathSync(os.tmpdir());
    const data = fs.realpathSync(env.AMAUTA_DATA_DIR);
    assert.ok(data.startsWith(tmp + path.sep), data);
    assert.notStrictEqual(data, path.join(os.homedir(), '.amauta'));
    assert.notStrictEqual(data, path.join(ROOT, 'data'));
    assert.ok(fs.statSync(env.CLAUDE_CONFIG_DIR).isDirectory());
    assert.notStrictEqual(env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude'));
  });

  test('NODE_OPTIONS keeps the caller value and loads the guard', () => {
    assert.ok(env.NODE_OPTIONS.includes('--max-old-space-size=4096'));
    assert.ok(env.NODE_OPTIONS.includes('hermetic-guard.cjs'));
  });

  test('PYTHONPATH carries the sitecustomize guard; HOME is untouched', () => {
    const e = buildHermeticEnv({ HOME: '/Users/x', PYTHONPATH: '/keep/me' });
    fs.rmSync(path.dirname(e.AMAUTA_DATA_DIR), { recursive: true, force: true });
    assert.ok(e.PYTHONPATH.startsWith(path.join(ROOT, 'tests', 'support', 'pythonpath')));
    assert.ok(e.PYTHONPATH.includes('/keep/me'));
    assert.strictEqual(e.HOME, '/Users/x');
  });
});
