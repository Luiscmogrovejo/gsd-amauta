/**
 * Phase 89 plan 89-09 task 04 and task 06: the ONE cache-URL resolver, both halves.
 *
 * Three things live here:
 *   1. the Node resolver's own cases;
 *   2. the CROSS-LANGUAGE table — the same environment, rung by rung, through
 *      `get-shit-done/bin/lib/cache-url.cjs` and `services/cache_url.py`, with the
 *      URL and the source compared for every rung, so the two cannot drift;
 *   3. the LINT (task 06): no product file reads one of the five names directly.
 *      There is NO exception list — task 04 converted every consumer, including the
 *      two canary-pinned ones, which is why the check can be absolute.
 *
 * Every case asserts on the RESOLVED STRING. Nothing here constructs a client or
 * opens a socket: the local 6379 is the operator's own Redis server.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const cache = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'cache-url.cjs'));
const { resolvePython, pythonEnv } = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));

/**
 * One row per rung of the chain: [environment, URL, source]. The SAME table as
 * `CHAIN` in tests/test_89_09_cache_url.py, fed to both halves below.
 */
const CHAIN = [
  [{ GSD_REDIS_URL: 'redis://a:1/0', AMAUTA_REDIS_URL: 'redis://b:2/0', VALKEY_URL: 'redis://c:3/0', REDIS_URL: 'redis://d:4/0', REDIS_HOST: 'e', REDIS_PORT: '5' }, 'redis://a:1/0', 'GSD_REDIS_URL'],
  [{ AMAUTA_REDIS_URL: 'redis://b:2/0', VALKEY_URL: 'redis://c:3/0', REDIS_URL: 'redis://d:4/0' }, 'redis://b:2/0', 'AMAUTA_REDIS_URL'],
  [{ VALKEY_URL: 'redis://c:3/0', REDIS_URL: 'redis://d:4/0' }, 'redis://c:3/0', 'VALKEY_URL'],
  [{ REDIS_URL: 'redis://d:4/0' }, 'redis://d:4/0', 'REDIS_URL'],
  [{ REDIS_HOST: 'e', REDIS_PORT: '5' }, 'redis://e:5/0', 'REDIS_HOST+REDIS_PORT'],
  [{ REDIS_HOST: 'e' }, 'redis://e:6379/0', 'REDIS_HOST+REDIS_PORT'],
  [{ REDIS_PORT: '5' }, 'redis://127.0.0.1:5/0', 'REDIS_HOST+REDIS_PORT'],
  [{}, 'redis://127.0.0.1:6379/0', 'default'],
  [{ GSD_REDIS_PORT: '7001' }, 'redis://127.0.0.1:7001/0', 'default'],
  [{ GSD_REDIS_URL: '   ' }, 'redis://127.0.0.1:6379/0', 'default'],
  [{ GSD_REDIS_URL: '', VALKEY_URL: 'redis://c:3/0' }, 'redis://c:3/0', 'VALKEY_URL'],
  [{ REDIS_URL: 'redis://u:secret@h:6379/0' }, 'redis://u:secret@h:6379/0', 'REDIS_URL'],
  [{ GSD_TEST_VALKEY_URL: 'redis://z:9/0' }, 'redis://127.0.0.1:6379/0', 'default'],
  [{ GSD_REDIS_ENABLED: 'false' }, 'redis://127.0.0.1:6379/0', 'default'],
];

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 the Node resolver', () => {
  for (const [env, url, source] of CHAIN) {
    test(`resolves ${JSON.stringify(env)} -> ${url} (${source})`, () => {
      assert.strictEqual(cache.cacheUrl(env), url);
      assert.strictEqual(cache.cacheUrlSource(env), source);
      assert.deepStrictEqual(cache.resolve(env), { url, source });
    });
  }

  test('the precedence order is data, not four ifs', () => {
    assert.deepStrictEqual(cache.URL_NAMES, ['GSD_REDIS_URL', 'AMAUTA_REDIS_URL', 'VALKEY_URL', 'REDIS_URL']);
    assert.strictEqual(cache.CANONICAL, 'GSD_REDIS_URL');
    const env = {};
    cache.URL_NAMES.forEach((name, i) => { env[name] = `redis://${i}:${i}/0`; });
    for (const name of cache.URL_NAMES) {
      assert.strictEqual(cache.cacheUrlSource(env), name);
      delete env[name];
    }
    assert.strictEqual(cache.cacheUrlSource(env), 'default');
  });

  test('the test-side opt-in is not in the chain', () => {
    assert.ok(!cache.URL_NAMES.includes('GSD_TEST_VALKEY_URL'));
    assert.ok(!cache.LEGACY_NAMES.includes('GSD_TEST_VALKEY_URL'));
    assert.strictEqual(cache.cacheUrlSource({ GSD_TEST_VALKEY_URL: 'redis://z:9/0' }), 'default');
  });

  test('the password is masked in every reported form', () => {
    const env = { REDIS_URL: 'redis://user:s3cr3t@cache.internal:6379/0' };
    assert.strictEqual(cache.maskedCacheUrl(env), 'redis://user:***@cache.internal:6379/0');
    assert.deepStrictEqual(cache.report(env), {
      cache_url_source: 'REDIS_URL',
      cache_url_masked: 'redis://user:***@cache.internal:6379/0',
      cache_url_canonical: 'GSD_REDIS_URL',
    });
    assert.ok(!JSON.stringify(cache.report(env)).includes('s3cr3t'));
  });

  test('a legacy name warns exactly once per process, with the URL masked', () => {
    // a child process, so the once-per-process set starts empty and the stderr
    // this asserts on is only this case's
    const script = [
      "const c = require(process.argv[1]);",
      "const env = {REDIS_URL: 'redis://user:s3cr3t@cache.internal:6379/0'};",
      "c.cacheUrl(env); c.cacheUrl(env); c.cacheUrl(env);",
      "c.cacheUrl({GSD_REDIS_URL: 'redis://a:1/0'});",
      "c.cacheUrl({});",
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script, path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'cache-url.cjs')],
      { encoding: 'utf8', cwd: ROOT });
    const lines = r.stderr.trim().split('\n').filter((l) => l.includes('[cache-url]'));
    assert.strictEqual(lines.length, 1, `expected ONE warning, got:\n${r.stderr}`);
    assert.match(lines[0], /REDIS_URL is deprecated/);
    assert.match(lines[0], /GSD_REDIS_URL/);
    assert.match(lines[0], /redis:\/\/user:\*\*\*@cache\.internal:6379\/0/);
    assert.ok(!lines[0].includes('s3cr3t'), 'the password reached stderr');
  });

  test('this module opens no socket and builds no client', () => {
    const source = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'cache-url.cjs'), 'utf8');
    const code = source.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const forbidden of ["require('redis')", 'createClient(', '.connect(', "require('net')"]) {
      assert.ok(!code.includes(forbidden), `cache-url.cjs must resolve strings only: ${forbidden}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 the two resolvers cannot drift', () => {
  const python = resolvePython();

  test('every rung of the chain: the same URL and the same source on both sides', () => {
    // ONE child for the whole table, so the comparison is one measurement
    const code = [
      'import json, os, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from services import cache_url',
      'rows = json.loads(sys.argv[2])',
      'print(json.dumps([cache_url.resolve(env) for env in rows]))',
    ].join('\n');
    const r = spawnSync(python.command, [...python.args, '-c', code, ROOT, JSON.stringify(CHAIN.map((c) => c[0]))],
      { encoding: 'utf8', cwd: ROOT, env: pythonEnv() });
    assert.ok(r.stdout && r.stdout.trim(), `python printed nothing: ${r.stderr}`);
    const pyRows = JSON.parse(r.stdout.trim().split('\n').pop());
    const table = [];
    CHAIN.forEach(([env, url, source], i) => {
      const js = cache.resolve(env);
      const py = { url: pyRows[i][0], source: pyRows[i][1] };
      table.push(`${JSON.stringify(env)}\n    node:   ${js.url}  (${js.source})\n    python: ${py.url}  (${py.source})`);
      assert.deepStrictEqual(py, js, `rung ${i} disagrees:\n${table[table.length - 1]}`);
      assert.deepStrictEqual(js, { url, source }, `rung ${i} is not what the table declares`);
    });
  });

  test('the masking rule is the same on both sides', () => {
    const cases = [
      'redis://u:secret@h:6379/0',
      'redis://h:6379/0',
      'rediss://user:p%40ss@h:6380/1',
      '',
    ];
    const code = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from services import cache_url',
      'from services.pg_dsn import mask_dsn',
      'print(json.dumps([mask_dsn(u) for u in json.loads(sys.argv[2])]))',
    ].join('\n');
    const r = spawnSync(python.command, [...python.args, '-c', code, ROOT, JSON.stringify(cases)],
      { encoding: 'utf8', cwd: ROOT, env: pythonEnv() });
    assert.ok(r.stdout && r.stdout.trim(), `python printed nothing: ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), cases.map((u) => cache.maskUrl(u)));
  });

  test('the two name lists are identical', () => {
    const code = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from services import cache_url',
      'print(json.dumps({"canonical": cache_url.CANONICAL, "urls": list(cache_url.URL_NAMES),',
      '                  "legacy": list(cache_url.LEGACY_NAMES), "host_port": cache_url.HOST_PORT_SOURCE,',
      '                  "default": cache_url.DEFAULT_SOURCE}))',
    ].join('\n');
    const r = spawnSync(python.command, [...python.args, '-c', code, ROOT], { encoding: 'utf8', cwd: ROOT, env: pythonEnv() });
    assert.ok(r.stdout && r.stdout.trim(), `python printed nothing: ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), {
      canonical: cache.CANONICAL,
      urls: cache.URL_NAMES,
      legacy: cache.LEGACY_NAMES,
      host_port: cache.HOST_PORT_SOURCE,
      default: cache.DEFAULT_SOURCE,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The lint (task 06). NO exception list: task 04 converted every consumer,
// including the two canary-pinned ones, so the rule is absolute inside its scope.
//
// SCOPE, stated rather than implied: PRODUCT code — every tracked `*.py`, `*.cjs`,
// `*.js` and `*.mjs` file outside `tests/`, minus the two resolvers themselves,
// which are where the reads are supposed to be. `tests/` is excluded because a
// test legitimately WRITES and UNSETS these names (`tests/conftest.py`'s scrub
// list, `tests/support/fixture-*.cjs`) and legitimately ASSERTS on them
// (`tests/test_88_hermetic_guard.py:138` asserts the scrub worked) — and a
// per-file allow-list of those is exactly the exception list this check exists to
// do without.
//
// `git ls-files` rather than a directory walk, so an untracked runtime file in the
// working copy cannot change the verdict (plan 88-11's tracked-tree rule).

/** The five legacy names plus the canonical one: a direct read of any is a finding. */
const WATCHED = ['GSD_REDIS_URL', 'AMAUTA_REDIS_URL', 'VALKEY_URL', 'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT'];

/** The two files the reads belong in. */
const RESOLVERS = ['services/cache_url.py', 'get-shit-done/bin/lib/cache-url.cjs'];

/**
 * Direct-environment-READ expressions, per name. A write (`env[N] = `), a delete
 * (`delete env[N]`, `env.pop(N)`) and a mention in prose are NOT reads: the point
 * of the rule is that nothing RESOLVES the cache address for itself.
 *
 * @param {string} name the environment variable
 * @returns {RegExp[]}
 */
function readPatterns(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`os\\.environ\\.get\\(\\s*["']${n}["']`),
    new RegExp(`os\\.environ\\[\\s*["']${n}["']\\s*\\](?!\\s*=)`),
    new RegExp(`(?<!os\\.)environ\\.get\\(\\s*["']${n}["']`),
    new RegExp(`\\benv\\.get\\(\\s*["']${n}["']`),
    new RegExp(`\\bgetenv\\(\\s*["']${n}["']`),
    new RegExp(`process\\.env\\.${n}\\b`),
    new RegExp(`process\\.env\\[\\s*["']${n}["']\\s*\\](?!\\s*=)`),
  ];
}

/**
 * Strip comments and docstrings cheaply, so prose naming a variable is not a read.
 * Conservative on purpose: it only removes whole lines that START as a comment.
 *
 * @param {string} source file text
 * @returns {{line: number, text: string}[]} candidate code lines
 */
function codeLines(source) {
  const out = [];
  source.split('\n').forEach((text, i) => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    out.push({ line: i + 1, text });
  });
  return out;
}

describe('89-09 the lint: no product file resolves the cache address for itself', () => {
  /** Every tracked product source file, repo-relative with forward slashes. */
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => /\.(?:py|cjs|js|mjs)$/.test(f))
    .filter((f) => !f.startsWith('tests/'))
    .filter((f) => !RESOLVERS.includes(f));

  /**
   * Every direct read in one text, as `file:line name`.
   * @param {string} rel the file name, for the message
   * @param {string} source the text
   * @returns {string[]}
   */
  function violations(rel, source) {
    const found = [];
    for (const { line, text } of codeLines(source)) {
      for (const name of WATCHED) {
        if (readPatterns(name).some((re) => re.test(text))) {
          found.push(`${rel}:${line} reads ${name} directly: ${text.trim()}`);
        }
      }
    }
    return found;
  }

  test('the tracked product tree is clean, with no exception list at all', () => {
    assert.ok(tracked.length > 100, `only ${tracked.length} tracked product files were walked`);
    assert.strictEqual(
      fs.existsSync(path.join(ROOT, 'tests', 'cache-env-exceptions.json')),
      false,
      'this check has NO exception list; a file that needs one is a conversion that was not done'
    );
    const found = [];
    for (const rel of tracked) {
      found.push(...violations(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
    }
    assert.deepStrictEqual(found, [],
      `a product file resolves the cache address for itself instead of calling the resolver:\n  ${found.join('\n  ')}`);
  });

  test('the lint CAN fail: every read spelling is caught', () => {
    const mutations = [
      ['python, get', 'const u = 1;\nurl = os.environ.get("REDIS_URL", "redis://x")'],
      ['python, index', 'url = os.environ["REDIS_HOST"]'],
      ['python, env.get', 'url = env.get("VALKEY_URL")'],
      ['node, dotted', 'const u = process.env.AMAUTA_REDIS_URL || null;'],
      ['node, bracket', "const u = process.env['REDIS_PORT'];"],
      ['node, canonical', "const u = process.env.GSD_REDIS_URL || 'redis://127.0.0.1:6379/0';"],
    ];
    for (const [label, text] of mutations) {
      assert.strictEqual(violations('scratch.cjs', text).length, 1, `${label} was NOT caught: ${text}`);
    }
  });

  test('a write, a delete and a mention in prose are not reads', () => {
    const allowed = [
      "for (const k of ['REDIS_URL']) delete env[k];",
      "env['REDIS_HOST'] = host;",
      'os.environ["REDIS_PORT"] = str(port)',
      'env.pop("REDIS_HOST", None)',
      '# GSD_REDIS_URL is the canonical name; REDIS_URL is legacy',
      ' *   AMAUTA_REDIS_URL  Valkey/Redis connection URL',
      "assert COMPOSE.includes('${GSD_REDIS_PORT:-6379}')",
    ];
    for (const text of allowed) {
      assert.deepStrictEqual(violations('scratch.cjs', text), [], `falsely flagged: ${text}`);
    }
  });

  test('the resolvers themselves are the only files that read the names', () => {
    for (const rel of RESOLVERS) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(source.includes('GSD_REDIS_URL'), `${rel} must name the canonical variable`);
    }
    // and they are not in the linted set, by construction
    for (const rel of RESOLVERS) assert.ok(!tracked.includes(rel), rel);
  });
});
