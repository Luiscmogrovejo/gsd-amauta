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
 * Plan 89-05 (ORC-02) removed the A2A surface, so the README/docs assertions are
 * INVERTED rather than deleted: the README must now SAY the removal happened,
 * no page may offer a removed verb, no page may call the blackboard PG-only
 * (measured false), and the deleted modules must be unimportable.
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

// Plan 89-05 (ORC-02) removed the A2A surface, so the three assertions below are
// INVERTED, not deleted: they used to pin "the README documents a verb that
// exists", and they now pin "the README says the removal happened and documents
// no removed verb". The docs and the code must still agree — in the other
// direction.

test('cli.cjs has no a2a branch, and `a2a` is just an unknown verb', () => {
  const src = read('bin/cli.cjs');
  assert.ok(!/a2a/i.test(src), 'bin/cli.cjs must not dispatch or document a2a');
  const removed = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cli.cjs'), 'a2a'], {
    encoding: 'utf-8', timeout: 20000,
    env: { ...process.env, GSD_TEST_MODE: '1', GSD_FORCE_SQLITE: '1' },
  });
  assert.ok(!/a2a tail|a2a list|a2a capabilities/.test(removed.stdout + removed.stderr),
    'gsd-amauta a2a must not reach an a2a usage: the verb is gone');
  // The usage text must not offer it either.
  const help = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cli.cjs'), '--help'], {
    encoding: 'utf-8', timeout: 20000,
  });
  assert.ok(!/a2a/i.test(help.stdout + help.stderr),
    'the usage text still offers a2a');
  assert.match(help.stdout, /party \.\.\./, 'the party verb must survive this plan');
});

test('gsd-tools has no a2a case and refuses the verb', () => {
  assert.ok(!/a2a/i.test(read('get-shit-done/bin/gsd-tools.cjs')),
    'gsd-tools.cjs must not dispatch or document a2a');
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'), 'a2a', 'tail'],
    { encoding: 'utf-8', timeout: 20000,
      env: { ...process.env, GSD_TEST_MODE: '1', GSD_DAEMON_PORT: '0', GSD_AMAUTA_PORT: '0' } },
  );
  assert.match(res.stdout + res.stderr, /Unknown command: a2a/,
    'gsd-tools a2a must be refused by name, not poll a port');
});

test('the README says the A2A removal happened, and what a party session is now', () => {
  const md = read('README.md');
  assert.match(md, /The bespoke A2A request\/response protocol was removed in v3\.7/,
    'criterion 5: the README must SAY the removal happened, not merely stop mentioning it');
  assert.match(md, /no production code path ever used/i);
  assert.match(md, /circuit breaker was never armed/i);
  assert.match(md, /blackboard inbox is the single agent-to-agent channel/i);
  assert.match(md, /PostgreSQL \*\*and\*\* on SQLite/,
    'the README must say the channel works on both backends');
  // The removed verbs are named only in the removal statement, never offered.
  assert.ok(!/```[^`]*gsd-amauta a2a[^`]*```/s.test(md),
    'no code block may still offer a removed a2a verb');
  assert.ok(!/gsd-tools a2a tail/.test(md), 'no doc page may offer gsd-tools a2a tail');
  // Plan 89-13 (ORC-02 part 2): the README says what a party session IS now,
  // names the verbs that survive and the ones that were removed, and stays
  // consistent with the single-channel statement above.
  assert.match(md, /A party session keeps only recorded decisions/,
    'the README must say what a party session is now');
  assert.ok(!/Party sessions are still experimental/.test(md),
    'the README still carries the pre-89-13 "being reduced" sentence');
  for (const removed of ['party pause', 'party resume', 'party kill']) {
    assert.ok(md.includes('`' + removed + '`'), `the removal statement must name ${removed}`);
    assert.ok(!new RegExp('```[^`]*gsd-amauta ' + removed + '[^`]*```', 's').test(md),
      `no code block may still offer the removed verb ${removed}`);
  }
  for (const verb of ['create', 'start', 'status', 'inspect', 'get', 'terminate']) {
    assert.ok(md.includes(`gsd-amauta party ${verb}`), `the README must name the surviving verb party ${verb}`);
  }
  assert.match(md, /not a second agent channel/,
    'the party paragraph must not contradict "the blackboard inbox is the single agent-to-agent channel"');
  assert.match(md, /requires_postgres/, 'the README must say party sessions need PostgreSQL');
});

test('the party verbs the README offers are exactly the verbs the tool answers', () => {
  // Read from the code: KNOWN_ACTIONS inside the `case 'party':` block.
  const tools = read('get-shit-done/bin/gsd-tools.cjs');
  const block = tools.slice(tools.indexOf("case 'party':"));
  const known = /const KNOWN_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(block);
  assert.ok(known, 'KNOWN_ACTIONS not found in the party block');
  const actions = known[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  const md = read('README.md');
  const offered = [...new Set([...md.matchAll(/gsd-amauta party ([a-z]+)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(offered, actions,
    'the README offers a party verb the tool does not answer, or omits one it does');
});

test('README presents Docker as recommended with a documented SQLite fallback', () => {
  const md = read('README.md');
  assert.ok(!/\| Requires Docker \| Yes \(PG \+ Valkey\)/.test(md),
    'the comparison table must not claim Docker is required');
  assert.match(md, /SQLite fallback: what actually works/);
  // The three features that really are off, and the A2A row is gone with the
  // feature. "blackboard" moved to the WORKS list: plan 89-05 measured it on
  // SQLite, so listing it as off was false.
  for (const feature of ['pgvector', 'RLM code index', 'semantic cache']) {
    assert.ok(md.includes(feature), `the fallback section must name ${feature}`);
  }
  assert.ok(!md.includes('A2A exchange log'),
    'the fallback section still names a removed feature');
  const worksOn = md.slice(md.indexOf('**Works on SQLite:**'), md.indexOf('**Off on SQLite:**'));
  assert.match(worksOn, /blackboard/i,
    'the blackboard works on SQLite and must be in the WORKS list, not the OFF list');
  const offOn = md.slice(md.indexOf('**Off on SQLite:**'), md.indexOf('**How to check:**'));
  assert.ok(!/blackboard/i.test(offOn), 'the blackboard is not off on SQLite');
  assert.match(md, /0 healthy \/ 1 degraded \/ 2 failing|0 = healthy, 1 = degraded, 2 = failing/,
    'doctor exit codes must be documented');
});

test('no doc page and no package description names a removed verb or endpoint', () => {
  const pages = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md',
    'docs/QUICKSTART.md', 'docs/GETTING-STARTED.md'];
  for (const page of pages) {
    const md = read(page);
    for (const removed of ['gsd-amauta a2a tail', 'gsd-amauta a2a list',
      'gsd-amauta a2a capabilities', 'gsd-tools a2a']) {
      // The removal statement may NAME the verb; no page may present it as a
      // command, which is what a shell prompt or a code fence does.
      assert.ok(!new RegExp(`^\\s*(\\$\\s*)?${removed.replace(/ /g, '\\s+')}`, 'm').test(md),
        `${page} still offers \`${removed}\` as a command`);
    }
  }
  const pkg = require(path.join(ROOT, 'package.json'));
  assert.ok(!/a2a/i.test(pkg.description),
    `package.json's description still names the A2A protocol: ${pkg.description}`);
  assert.match(pkg.description, /blackboard/i,
    'the description should name the channel that replaced it');
});

test('the A2A modules are gone, so nothing can import them', () => {
  for (const rel of ['services/a2a_client.py', 'services/a2a_breaker.py',
    'services/a2a_registry.py', 'services/a2a_registry_cli.py']) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)), `${rel} still exists`);
  }
  // Over the TRACKED tree: the untracked data/ and backups/ carry the string and
  // would make this unreachable. tests/89-05-a2a-absent.test.cjs is the full walk.
  const tracked = spawnSync('git', ['ls-files', '--', '*.py'],
    { cwd: ROOT, encoding: 'utf-8' }).stdout.split('\n').filter(Boolean);
  const importers = tracked.filter((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    return /^\s*(from|import)\s+(services\.)?a2a_/m.test(text);
  });
  assert.deepStrictEqual(importers, [],
    `a tracked Python file still imports a deleted A2A module: ${importers.join(', ')}`);
});
