'use strict';
/**
 * tests/docs-update-truth.test.cjs
 *
 *   update.md     documented a raw cp/rsync "update" that bypasses install.js's
 *                 path rewriting and manifest regeneration, and copied a
 *                 get-shit-done/VERSION file that does not exist in the repo
 *                 (hidden behind `|| true`).
 *   check-update  was neutralized to always report no update, so a stale
 *                 install could never be noticed. It now compares the installed
 *                 VERSION with the package it was installed from — locally, no
 *                 network.
 *   README/docs   documented `gsd-amauta a2a tail` with no a2a branch in
 *                 cli.cjs, called Docker a hard requirement, and presented A2A
 *                 and party sessions as shipped features.
 *
 * Run: node --test tests/docs-update-truth.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
const { homeEnv } = require('./support/home-env.cjs');

// ─── update.md ───────────────────────────────────────────────────────────────

test('update.md documents the installer, not a raw file sync', () => {
  const md = read('get-shit-done/workflows/update.md');
  assert.match(md, /node bin\/init\.cjs --upgrade/,
    'the real update path must be documented');
  assert.ok(!/rsync -a --delete get-shit-done\/bin\//.test(md),
    'the raw rsync sync must not be presented as an update procedure');
  assert.ok(!/cp get-shit-done\/VERSION .* \|\| true/.test(md),
    'copying a non-existent VERSION file must be gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'get-shit-done', 'VERSION')),
    'sanity: get-shit-done/VERSION really does not exist in the repo');
  assert.match(md, /npm/, 'the npm refusal must survive');
});

test('update.md still refuses the npm path', () => {
  const md = read('get-shit-done/workflows/update.md');
  assert.match(md, /NOT trusted|npm path disabled/);
  assert.match(md, /doctor/, 'post-update verification must be documented');
});

// ─── check-update hook ───────────────────────────────────────────────────────

function runHook(home, configDir) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'gsd-check-update.js')], {
    encoding: 'utf-8',
    env: { ...process.env, ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir },
    timeout: 20000,
  });
}

function fakeInstall(version, pluginRoot) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hook-home-'));
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(path.join(cfg, 'get-shit-done'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'get-shit-done', 'VERSION'), version);
  if (pluginRoot) {
    const dataDir = path.join(home, '.amauta', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'install_record.json'),
      JSON.stringify({ version, plugin_root: pluginRoot }));
  }
  return { home, cfg };
}

function readCache(cfg) {
  return JSON.parse(fs.readFileSync(path.join(cfg, 'cache', 'gsd-update-check.json'), 'utf-8'));
}

test('check-update reports a stale install against the local package', () => {
  const { home, cfg } = fakeInstall('0.0.1', ROOT);
  const res = runHook(home, cfg);
  assert.strictEqual(res.status, 0, res.stderr);
  const cache = readCache(cfg);
  assert.strictEqual(cache.installed, '0.0.1');
  assert.strictEqual(cache.latest, PKG_VERSION);
  assert.strictEqual(cache.update_available, true,
    'a version behind the source repo must be reported');
  assert.strictEqual(cache.source, ROOT);
});

test('check-update reports no update when the installed copy matches', () => {
  const { home, cfg } = fakeInstall(PKG_VERSION, ROOT);
  runHook(home, cfg);
  const cache = readCache(cfg);
  assert.strictEqual(cache.update_available, false);
});

test('check-update says the source is unknown rather than claiming up-to-date', () => {
  const { home, cfg } = fakeInstall('0.0.1', null); // no install record
  runHook(home, cfg);
  const cache = readCache(cfg);
  assert.strictEqual(cache.update_available, false, 'never guess without a source');
  assert.strictEqual(cache.source, 'unknown');
  assert.match(cache.note, /unknown/);
});

test('check-update makes no network call and spawns no process', () => {
  // Comments mention npm (explaining why the check was removed), so inspect
  // code lines only.
  const code = read('hooks/gsd-check-update.js')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/require\(['"]https?['"]\)/.test(code), 'no http(s) module');
  assert.ok(!/child_process/.test(code), 'no child processes');
  assert.ok(!/registry\.npmjs|npm view/.test(code), 'no npm registry access');
});

// ─── README / docs / cli ─────────────────────────────────────────────────────

test('cli.cjs has the a2a branch the README documents', () => {
  const src = read('bin/cli.cjs');
  assert.match(src, /command === 'a2a'/, 'cli.cjs must dispatch a2a');
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cli.cjs'), 'a2a'], {
    encoding: 'utf-8', timeout: 20000,
  });
  assert.match(res.stdout + res.stderr, /a2a tail/,
    'gsd-amauta a2a must reach the a2a usage, not fall through to the task CLI');
});

test('README marks A2A and party sessions experimental', () => {
  const md = read('README.md');
  assert.match(md, /A2A Agent-to-Agent protocol \(v3\.3\) — EXPERIMENTAL/);
  assert.match(md, /no production caller/i);
  assert.match(md, /circuit breaker is never armed/i);
  assert.match(md, /party sessions/i);
});

test('README presents Docker as recommended with a documented SQLite fallback', () => {
  const md = read('README.md');
  assert.ok(!/\| Requires Docker \| Yes \(PG \+ Valkey\)/.test(md),
    'the comparison table must not claim Docker is required');
  assert.match(md, /SQLite fallback: what actually works/);
  for (const feature of ['pgvector', 'RLM code index', 'blackboard', 'semantic cache', 'A2A exchange log']) {
    assert.ok(md.includes(feature), `the fallback section must name ${feature}`);
  }
  assert.match(md, /0 healthy \/ 1 degraded \/ 2 failing|0 = healthy, 1 = degraded, 2 = failing/,
    'doctor exit codes must be documented');
});

test('the A2A "no production caller" claim is still true', () => {
  // If this fails, A2A gained a real caller — update the README instead of the test.
  const clientSrc = read('services/a2a_client.py');
  assert.match(clientSrc, /_A2A_REDIS_CLIENT = None/,
    'the breaker client injector must still default to None');
  const grep = spawnSync('grep', ['-rln', '--include=*.py', 'a2a_client', '.'],
    { cwd: ROOT, encoding: 'utf-8' });
  const callers = (grep.stdout || '').split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('./tests/'))
    .filter((f) => f !== './services/a2a_client.py');
  assert.deepStrictEqual(callers, [],
    `a2a_client now has non-test importers: ${callers.join(', ')}`);
});
