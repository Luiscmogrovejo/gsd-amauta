/**
 * Phase 89 plan 89-08 (RET-05, decision D6): `config-get` / `config-set` gain a
 * SCOPE, and the project keys keep master's behaviour byte for byte.
 *
 * Two halves:
 *
 *   1. THE PROJECT KEYS ARE UNCHANGED, PROVEN — not asserted. Master's
 *      `get-shit-done/bin/lib/config.cjs` (commit a3f247d, git blob
 *      58edff5d040a71abae78d4332261c9c8cfac52ad) is kept verbatim as
 *      `tests/fixtures/89-08/config.master-a3f247d.cjs.txt`. Every one of the
 *      project keys is driven through BOTH implementations — the same
 *      operations, in the same order, each in its own child process — and the
 *      four observables are compared: stdout, stderr, exit status, and the bytes
 *      of `.planning/config.json` afterwards. The comparison is against the
 *      FILE master shipped, not against a description of it. (A `git show
 *      origin/master:` would be the obvious alternative and is not available:
 *      the CI checkout of a pull request is a depth-1 merge commit.)
 *
 *   2. THE SIX HARNESS KEYS resolve to `~/.amauta/config.json` under a TEMP
 *      home, are validated by the model catalogue (the enum is derived from it,
 *      proven by adding a model to a fixture catalogue), and `config-get --all`
 *      prints value, default, source and pending re-embed per key.
 *
 * No database: `GSD_FORCE_SQLITE=1` and an empty `GSD_POSTGRES_URL` in every
 * child. That a model change marks `embedding_state` (target_model,
 * phase='backfilling', active_model untouched, in both directions) needs a
 * PostgreSQL and is asserted in tests/test_89_08_blue_green_backfill.py through
 * the same Python entry point this CLI spawns.
 *
 * Nothing here reads or writes the operator's `~/.amauta/config.json`: every
 * child gets HOME, USERPROFILE, HOMEDRIVE and HOMEPATH pointed at a temp dir.
 *
 * Run: node --test tests/89-08-config-scope.test.cjs
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { homeEnv } = require('./support/home-env.cjs');

const REPO = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const LIB = path.join(REPO, 'get-shit-done', 'bin', 'lib');
const CONFIG_CJS = path.join(LIB, 'config.cjs');
const MASTER_FIXTURE = path.join(__dirname, 'fixtures', '89-08', 'config.master-a3f247d.cjs.txt');
const CATALOGUE = path.join(REPO, 'get-shit-done', 'config', 'embedding-models.json');

const config = require(CONFIG_CJS);

const HARNESS_KEYS = [
  'retrieval.embedding_model.memory',
  'retrieval.embedding_model.code_index',
  'retrieval.rerank_model',
  'retrieval.embedding_provider',
  'retrieval.embedding_dimensions',
  'retrieval.rerank_enabled',
];

/** How "no argument" travels to the runner (argv cannot carry undefined). */
const UNDEFINED = '__89_08_undefined__';

let scratch;
let runner;

/** The pinned environment of every child: a temp home and no database. */
function childEnv(home, extra = {}) {
  return {
    ...process.env,
    ...homeEnv(home),
    GSD_TEST_MODE: '1',
    AMAUTA_DATA_DIR: path.join(home, 'data'),
    GSD_FORCE_SQLITE: '1',
    GSD_AMAUTA_PORT: '0',
    GSD_DAEMON_PORT: '0',
    GSD_RLM_PORT: '0',
    AMAUTA_MEMORY_DATABASE_URL: '',
    GSD_POSTGRES_URL: '',
    AMAUTA_AUTO_BACKUP: 'off',
    GSD_EMBEDDING_CATALOGUE: '',
    GSD_EMBEDDING_MODEL_MEMORY: '',
    GSD_EMBEDDING_MODEL_CODE_INDEX: '',
    GSD_RERANK_MODEL: '',
    GSD_EMBEDDING_PROVIDER: '',
    GSD_EMBEDDING_DIMENSIONS: '',
    GSD_RERANK_ENABLED: '',
    ...extra,
  };
}

function newHome() {
  return fs.mkdtempSync(path.join(scratch, 'home-'));
}

function newProject() {
  const dir = fs.mkdtempSync(path.join(scratch, 'proj-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

/** Run the real CLI. */
function tools(args, cwd, home, extra) {
  const r = spawnSync(process.execPath, [TOOLS, ...args], {
    cwd, encoding: 'utf-8', env: childEnv(home, extra),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Run ONE config operation of one implementation in its own process.
 * `impl` is 'master' (the verbatim fixture) or 'current' (the shipped file).
 */
function op(impl, verb, cwd, home, key, value, raw) {
  const args = [runner, impl, verb, cwd, key === undefined ? '' : key,
    value === undefined ? UNDEFINED : value, raw ? '1' : '0'];
  const r = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf-8', env: childEnv(home),
  });
  const file = path.join(cwd, '.planning', 'config.json');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    file: fs.existsSync(file) ? fs.readFileSync(file).toString('hex') : null,
  };
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-89-08-'));
  // The runner loads either implementation with the SAME `require`, so the only
  // difference between the two arms is the config module's own text.
  runner = path.join(scratch, 'runner.cjs');
  fs.writeFileSync(runner, `
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const [impl, verb, cwd, key, value, raw] = process.argv.slice(2);
const LIB = ${JSON.stringify(LIB)};
const file = impl === 'master' ? ${JSON.stringify(MASTER_FIXTURE)} : path.join(LIB, 'config.cjs');
const m = new Module(path.join(LIB, 'config.cjs'), null);
m.filename = path.join(LIB, 'config.cjs');
m.paths = Module._nodeModulePaths(LIB);
m._compile(fs.readFileSync(file, 'utf-8'), m.filename);
const k = key === '' ? undefined : key;
const v = value === ${JSON.stringify(UNDEFINED)} ? undefined : value;
if (verb === 'set') m.exports.cmdConfigSet(cwd, k, v, raw === '1');
else m.exports.cmdConfigGet(cwd, k, raw === '1');
`, 'utf-8');
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ─── 1. the project keys, against master's own file ──────────────────────────

describe('89-08: every project key behaves exactly as on master', () => {
  test('the fixture IS master\'s config.cjs (git blob 58edff5d…), and it has no harness scope', () => {
    const crypto = require('crypto');
    const body = fs.readFileSync(MASTER_FIXTURE);
    // `git hash-object`, computed here so a hand-edit of the fixture is caught.
    // CRLF is normalised first: a Windows checkout may convert the text file.
    const lf = Buffer.from(body.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8');
    const blob = crypto.createHash('sha1')
      .update(Buffer.concat([Buffer.from(`blob ${lf.length}\0`), lf])).digest('hex');
    assert.strictEqual(blob, '58edff5d040a71abae78d4332261c9c8cfac52ad');
    assert.ok(!body.toString('utf-8').includes('HARNESS_CONFIG_KEYS'));
  });

  test('the project key set is unchanged: the same keys master validates', () => {
    const master = fs.readFileSync(MASTER_FIXTURE, 'utf-8');
    const block = master.slice(master.indexOf('new Set(['), master.indexOf(']);'));
    const masterKeys = [...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual([...config.VALID_CONFIG_KEYS].sort(), masterKeys);
    // Measured, and recorded as a deviation: the plan says 24, the file has 23.
    assert.strictEqual(masterKeys.length, 23);
    for (const key of masterKeys) {
      assert.ok(!config.HARNESS_CONFIG_KEYS.has(key), `${key} is in both scopes`);
    }
  });

  test('set and get of every project key: same stdout, stderr, exit status and file bytes', () => {
    const home = newHome();
    const SEQUENCE = [
      ['set', 'true', false],
      ['set', '42', false],
      ['set', 'hello', true],
      ['get', undefined, false],
      ['get', undefined, true],
    ];
    let compared = 0;
    for (const key of [...config.VALID_CONFIG_KEYS].sort()) {
      const cwdMaster = newProject();
      const cwdCurrent = newProject();
      for (const [verb, value, raw] of SEQUENCE) {
        const a = op('master', verb, cwdMaster, home, key, value, raw);
        const b = op('current', verb, cwdCurrent, home, key, value, raw);
        assert.deepStrictEqual(b, a, `${verb} ${key} ${value === undefined ? '' : value} (raw=${raw})`);
        assert.strictEqual(a.status, 0, `${verb} ${key} failed on master itself: ${a.stderr}`);
        compared += 1;
      }
    }
    assert.strictEqual(compared, 23 * SEQUENCE.length);
    // No project operation created a harness file.
    assert.ok(!fs.existsSync(path.join(home, '.amauta')), 'a project key wrote the harness dir');
  });

  test('the refusals of a project key are unchanged too', () => {
    const home = newHome();
    const cases = [
      ['get', 'model_profile', undefined, 'no config.json'],
      ['get', undefined, undefined, 'no key: still a usage error'],
      ['set', undefined, undefined, 'no key: still a usage error'],
    ];
    for (const [verb, key, value, why] of cases) {
      const a = op('master', verb, newProject(), home, key, value, false);
      const b = op('current', verb, newProject(), home, key, value, false);
      // The two project dirs differ, so the path inside "No config.json found at"
      // differs: compare with the temp path removed.
      const strip = (r) => ({ ...r, stderr: r.stderr.replace(/proj-[A-Za-z0-9]+/g, 'proj') });
      assert.deepStrictEqual(strip(b), strip(a), why);
      assert.strictEqual(a.status, 1, why);
    }
    const seeded = newProject();
    fs.writeFileSync(path.join(seeded, '.planning', 'config.json'), '{"mode":"yolo"}');
    for (const key of ['workflow.research', 'granularity']) {
      const a = op('master', 'get', seeded, home, key, undefined, false);
      const b = op('current', 'get', seeded, home, key, undefined, false);
      assert.deepStrictEqual(b, a, `missing ${key}`);
      assert.match(a.stderr, /Key not found/);
    }
  });

  test('an unknown key is still rejected, and the list now names both scopes', () => {
    const home = newHome();
    const cwd = newProject();
    const master = op('master', 'set', cwd, home, 'bogus.key', '1', false);
    const current = op('current', 'set', cwd, home, 'bogus.key', '1', false);
    assert.strictEqual(current.status, master.status);
    assert.strictEqual(current.status, 1);
    const prefix = 'Error: Unknown config key: "bogus.key". Valid keys: ';
    assert.ok(master.stderr.startsWith(prefix));
    assert.ok(current.stderr.startsWith(prefix), current.stderr);
    assert.match(current.stderr, /\(project scope, \.planning\/config\.json\)/);
    assert.match(current.stderr, /\(harness scope, ~\/\.amauta\/config\.json\)/);
    for (const key of [...config.VALID_CONFIG_KEYS, ...HARNESS_KEYS]) {
      assert.ok(current.stderr.includes(key), `${key} missing from the valid-key list`);
    }
    assert.strictEqual(current.file, null, 'a refused key wrote a file');
  });
});

// ─── 2. the harness keys ─────────────────────────────────────────────────────

describe('89-08: the six harness keys resolve to ~/.amauta/config.json', () => {
  test('the catalogue, the resolver, the job and migration 034 are in the shipped set', () => {
    // The installer's OWN rule, executed (bin/init.cjs is read, never edited).
    const init = require(path.join(REPO, 'bin', 'init.cjs'));
    const shipped = init.shippedFileMap(REPO);
    for (const rel of [
      'get-shit-done/config/embedding-models.json',
      'services/harness_config.py',
      'services/embedding_backfill.py',
      'services/_89_08_reporting.py',
      'migrations/034-embedding-blue-green.sql',
      'migrations/034-embedding-blue-green-DOWN.sql',
    ]) {
      assert.ok(init.isShippedPath(rel), `${rel} is excluded by the installer's rule`);
      assert.ok(rel in shipped, `${rel} is not in the shipped file map`);
    }
  });

  test('HARNESS_CONFIG_KEYS is the planned six, and the Python resolver agrees', () => {
    assert.deepStrictEqual([...config.HARNESS_CONFIG_KEYS].sort(), [...HARNESS_KEYS].sort());
    const { spawnPython } = require(path.join(LIB, 'platform.cjs'));
    const r = spawnPython([path.join(REPO, 'services', 'harness_config.py'), 'keys'],
      { encoding: 'utf-8', cwd: REPO, env: childEnv(newHome()) });
    assert.strictEqual(r.status, 0, r.stderr);
    const keys = JSON.parse(r.stdout.trim()).keys.map((k) => k.key).sort();
    assert.deepStrictEqual(keys, [...HARNESS_KEYS].sort());
  });

  test('the defaults print with their default, source and scope, and create no file', () => {
    const home = newHome();
    const cwd = newProject();
    const expected = {
      'retrieval.embedding_model.memory': 'voyage-code-4',
      'retrieval.embedding_model.code_index': 'voyage-code-4',
      'retrieval.rerank_model': 'rerank-3',
      'retrieval.embedding_provider': 'voyage',
      'retrieval.embedding_dimensions': 1024,
      'retrieval.rerank_enabled': true,
    };
    for (const [key, value] of Object.entries(expected)) {
      const r = tools(['config-get', key], cwd, home);
      assert.strictEqual(r.status, 0, r.stderr);
      const got = JSON.parse(r.stdout);
      assert.strictEqual(got.value, value, key);
      assert.strictEqual(got.default, value, key);
      assert.strictEqual(got.source, 'default', key);
      assert.strictEqual(got.scope, 'harness', key);
      assert.strictEqual(got.pending_reembed, false, key);
      assert.strictEqual(got.path, path.join(home, '.amauta', 'config.json'), key);
      const raw = tools(['config-get', key, '--raw'], cwd, home);
      assert.strictEqual(raw.stdout, String(value), key);
    }
    assert.ok(!fs.existsSync(path.join(home, '.amauta')), 'reading a default created the file');
  });

  test('config-set writes <HOME>/.amauta/config.json, backs up, audits, and leaves the project file alone', () => {
    const home = newHome();
    const cwd = newProject();
    const target = path.join(home, '.amauta', 'config.json');

    const first = tools(['config-set', 'retrieval.rerank_model', 'rerank-3-lite'], cwd, home);
    assert.strictEqual(first.status, 0, first.stderr);
    const saved = JSON.parse(first.stdout);
    assert.strictEqual(saved.path, target);
    assert.strictEqual(saved.scope, 'harness');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf-8')),
      { retrieval: { rerank_model: 'rerank-3-lite' } });

    const second = tools(['config-set', 'retrieval.embedding_model.memory', 'voyage-code-3'], cwd, home);
    assert.strictEqual(second.status, 0, second.stderr);
    const result = JSON.parse(second.stdout);
    // No database in this file: the setting is saved and the re-embed is
    // reported as NOT recorded, with the reason — never silently dropped.
    assert.deepStrictEqual(result.reembed, { marked: false, reason: 'no_database', use: 'memory' });
    assert.ok(result.backup && fs.existsSync(result.backup), 'the previous file was not kept');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(result.backup, 'utf-8')),
      { retrieval: { rerank_model: 'rerank-3-lite' } });
    const audit = fs.readFileSync(path.join(home, '.amauta', 'config-audit.jsonl'), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(audit.map((a) => a.context.key),
      ['retrieval.rerank_model', 'retrieval.embedding_model.memory']);

    const got = JSON.parse(tools(['config-get', 'retrieval.embedding_model.memory'], cwd, home).stdout);
    assert.deepStrictEqual([got.value, got.default, got.source], ['voyage-code-3', 'voyage-code-4', 'harness']);
    assert.ok(!fs.existsSync(path.join(cwd, '.planning', 'config.json')),
      'a harness key wrote the project file');
    assert.strictEqual(tools(['config-set', 'retrieval.rerank_enabled', 'false', '--raw'], cwd, home).stdout,
      'retrieval.rerank_enabled=false');
    assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf-8')).retrieval.rerank_enabled, false);
  });

  test('an invalid value is rejected and writes nothing: unknown model, dimension mismatch', () => {
    const home = newHome();
    const cwd = newProject();
    const unknown = tools(['config-set', 'retrieval.embedding_model.code_index', 'voyage-code-9'], cwd, home);
    assert.strictEqual(unknown.status, 1);
    assert.match(unknown.stderr, /'voyage-code-9' is not an embedding model in the catalogue/);
    assert.match(unknown.stderr, /voyage-code-4, voyage-4, voyage-4-large, voyage-code-3/);
    const dimension = tools(['config-set', 'retrieval.embedding_dimensions', '512'], cwd, home);
    assert.strictEqual(dimension.status, 1);
    assert.match(dimension.stderr, /034-embedding-blue-green\.sql/);
    const crossed = tools(['config-set', 'retrieval.rerank_model', 'voyage-code-4'], cwd, home);
    assert.strictEqual(crossed.status, 1);
    assert.match(crossed.stderr, /is not a rerank model/);
    assert.ok(!fs.existsSync(path.join(home, '.amauta', 'config.json')));
  });

  test('the model enum is DERIVED from the catalogue: a fixture model is accepted with no config.cjs edit', () => {
    const home = newHome();
    const cwd = newProject();
    const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf-8'));
    const refused = tools(['config-set', 'retrieval.embedding_model.memory', 'fixture-code-5'], cwd, home);
    assert.strictEqual(refused.status, 1);

    catalogue.models.push({ ...catalogue.models[0], id: 'fixture-code-5' });
    const fixture = path.join(scratch, 'catalogue-with-fixture.json');
    fs.writeFileSync(fixture, JSON.stringify(catalogue));
    const accepted = tools(['config-set', 'retrieval.embedding_model.memory', 'fixture-code-5'],
      cwd, home, { GSD_EMBEDDING_CATALOGUE: fixture });
    assert.strictEqual(accepted.status, 0, accepted.stderr);
    assert.strictEqual(JSON.parse(accepted.stdout).value, 'fixture-code-5');

    // ...and config.cjs holds no copy of the enum to edit.
    const source = fs.readFileSync(CONFIG_CJS, 'utf-8');
    for (const model of catalogue.models) {
      assert.ok(!source.includes(`'${model.id}'`) && !source.includes(`"${model.id}"`),
        `config.cjs duplicates the model id ${model.id}`);
    }
  });

  test('config-get --all prints value, default, source and pending re-embed for every key', () => {
    const home = newHome();
    const cwd = newProject();
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{"mode":"yolo"}');
    assert.strictEqual(tools(['config-set', 'retrieval.rerank_model', 'rerank-2.5'], cwd, home).status, 0);
    const all = tools(['config-get', '--all'], cwd, home, { GSD_EMBEDDING_MODEL_CODE_INDEX: 'voyage-4' });
    assert.strictEqual(all.status, 0, all.stderr);
    const rows = Object.fromEntries(JSON.parse(all.stdout).keys.map((k) => [k.key, k]));
    for (const key of HARNESS_KEYS) {
      for (const fact of ['value', 'default', 'source', 'pending_reembed']) {
        assert.ok(fact in rows[key], `${key} lacks ${fact}`);
      }
      assert.strictEqual(rows[key].scope, 'harness');
    }
    assert.deepStrictEqual(
      [rows['retrieval.rerank_model'].value, rows['retrieval.rerank_model'].default, rows['retrieval.rerank_model'].source],
      ['rerank-2.5', 'rerank-3', 'harness']);
    assert.deepStrictEqual(
      [rows['retrieval.embedding_model.code_index'].value, rows['retrieval.embedding_model.code_index'].source],
      ['voyage-4', 'env']);
    assert.strictEqual(rows['retrieval.embedding_model.memory'].source, 'default');
    assert.strictEqual(rows['retrieval.embedding_model.memory'].store, 'no_database');
    // The project keys are listed too, from this project's file.
    assert.deepStrictEqual([rows.mode.value, rows.mode.source, rows.mode.scope], ['yolo', 'project', 'project']);
    assert.strictEqual(rows.granularity.source, 'unset');
    assert.strictEqual(Object.keys(rows).length, HARNESS_KEYS.length + config.VALID_CONFIG_KEYS.size);

    const raw = tools(['config-get', '--all', '--raw'], cwd, home).stdout.split('\n');
    assert.strictEqual(raw[2],
      'retrieval.rerank_model="rerank-2.5" default="rerank-3" source=harness scope=harness pending_reembed=false');
  });

  test('a malformed harness file is a refusal, and is not overwritten', () => {
    const home = newHome();
    const cwd = newProject();
    fs.mkdirSync(path.join(home, '.amauta'), { recursive: true });
    const target = path.join(home, '.amauta', 'config.json');
    fs.writeFileSync(target, '{ not json');
    const get = tools(['config-get', 'retrieval.rerank_model'], cwd, home);
    assert.strictEqual(get.status, 1);
    assert.match(get.stderr, /is not valid JSON/);
    const set = tools(['config-set', 'retrieval.rerank_model', 'rerank-3'], cwd, home);
    assert.strictEqual(set.status, 1);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{ not json');
  });
});
