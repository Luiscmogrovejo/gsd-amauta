/**
 * 89-10 — the managed keys file `~/.amauta/env`, seen from the Node cells.
 *
 * `tests/test_89_10_managed_env.py` holds the full matrix on the three Python
 * cells. This file runs the same product code on the six Node cells
 * (Linux, macOS and Windows x Node 20 and 22), because that is where the
 * interpreter comes from `platform.resolvePython()` — the way the product
 * itself starts Python — and where Windows gets a second, independent look:
 *
 *   1. the loader reads `<home>/.amauta/env` FIRST, outside test mode, and the
 *      repository `.env` behind it;
 *   2. in test mode nothing is read unless `GSD_DOTENV_PATH` names the file;
 *   3. a group- or world-accessible file is refused with the typed error and
 *      the `chmod 600` fix on POSIX; on Windows the file is read and `doctor`
 *      says the permissions were not checked;
 *   4. `doctor --json` reports presence and source, and the value appears in
 *      nothing the child prints.
 *
 * SECRETS: the only "key" is FAKE_KEY, an obviously fake literal written into
 * a temporary home directory. Every child runs under that temporary HOME /
 * USERPROFILE. The child reports a SHA-256 of what it loaded, never the value,
 * so every byte of child output is searched for the literal.
 *
 * Run: node scripts/run-tests.cjs tests/89-10-managed-env.test.cjs
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { resolvePython, pythonEnv } = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));

const LOADER = path.join(ROOT, 'services', '_dotenv.py');
const DOCTOR = path.join(ROOT, 'services', 'doctor.py');
const FAKE_KEY = 'pa-test-not-a-real-key-89-10-node-FAKEFAKE';
const FAKE_SHA = crypto.createHash('sha256').update(FAKE_KEY).digest('hex');
const POSIX = process.platform !== 'win32';
const MARKER = 'GSD_8910_JSON ';
const KEY_NAMES = ['VOYAGE_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY'];
const LOADER_MARKERS = ['GSD_TEST_MODE', 'GSD_DOTENV_PATH', 'PYTEST_CURRENT_TEST', 'GSD_AMAUTA_NO_AUTO_START'];

const CHILD = [
  'import hashlib, importlib.util, json, os, sys',
  'spec = importlib.util.spec_from_file_location("gsd_dotenv", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'read = mod.load_dotenv(sys.argv[2])',
  'names = sys.argv[3:]',
  'sha = {n: (hashlib.sha256(os.environ[n].encode("utf-8")).hexdigest() if n in os.environ else None) for n in names}',
  `print("${MARKER}" + json.dumps({"read": read, "sha": sha}))`,
].join('\n');

/**
 * A temporary home directory, optionally holding `.amauta/env`.
 * @param {object} t the node:test context (cleanup is registered on it)
 * @param {string|null} body the managed file's body, or null for no file
 * @param {number} [mode=0o600] the managed file's mode
 * @returns {{home: string, managed: string, root: string}} the three paths
 */
function makeHome(t, body, mode = 0o600) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8910-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'root');
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const managed = path.join(home, '.amauta', 'env');
  if (body !== null) {
    fs.mkdirSync(path.dirname(managed));
    fs.writeFileSync(managed, body, { mode: 0o600 });
    fs.chmodSync(managed, mode);
  }
  return { home, managed, root };
}

/**
 * The child environment: this process's, under a temporary home, with no key
 * and no loader marker except the ones the case passes.
 * @param {string} home the temporary home directory
 * @param {object} overrides names to set
 * @returns {object} the environment
 */
function childEnv(home, overrides) {
  const env = pythonEnv({ ...process.env, HOME: home, USERPROFILE: home });
  for (const name of [...KEY_NAMES, ...LOADER_MARKERS, 'GSD_8910_ONLY_REPO']) delete env[name];
  return { ...env, ...overrides };
}

/**
 * Fail when the fake key literal appears in any captured text.
 * @param {...string} texts captured output
 * @returns {void}
 */
function assertNoSecret(...texts) {
  for (const text of texts) {
    assert.ok(!String(text).includes(FAKE_KEY), `a key VALUE was emitted:\n${String(text).slice(-1500)}`);
  }
}

/**
 * Run the loader in a child the way an entry point does (loaded by path).
 * `-I` keeps tests/support/pythonpath/sitecustomize.py from arming test mode.
 * @param {object} dirs from makeHome
 * @param {string[]} names variables to report on
 * @param {object} [overrides] environment overrides
 * @returns {{report: object|null, r: object}} the report and the spawn result
 */
function runLoader(dirs, names, overrides = {}) {
  const python = resolvePython();
  const r = spawnSync(python.command, [...python.args, '-I', '-c', CHILD, LOADER, dirs.root, ...names],
    { encoding: 'utf8', env: childEnv(dirs.home, overrides), timeout: 120000 });
  assertNoSecret(r.stdout, r.stderr);
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith(MARKER));
  return { report: line ? JSON.parse(line.slice(MARKER.length)) : null, r };
}

describe('89-10 the loader reads the managed keys file first', () => {
  test('outside test mode <home>/.amauta/env wins and the repo .env is still read', (t) => {
    const dirs = makeHome(t, `VOYAGE_API_KEY=${FAKE_KEY}\n`);
    fs.writeFileSync(path.join(dirs.root, '.env'), 'VOYAGE_API_KEY=shadowed\nGSD_8910_ONLY_REPO=repo\n');
    const { report, r } = runLoader(dirs, ['VOYAGE_API_KEY', 'GSD_8910_ONLY_REPO']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(report.read, dirs.managed);
    assert.strictEqual(report.sha.VOYAGE_API_KEY, FAKE_SHA);
    assert.strictEqual(report.sha.GSD_8910_ONLY_REPO,
      crypto.createHash('sha256').update('repo').digest('hex'));
  });

  test('in test mode nothing is read, unless GSD_DOTENV_PATH names the file', (t) => {
    const dirs = makeHome(t, `VOYAGE_API_KEY=${FAKE_KEY}\n`);
    const inert = runLoader(dirs, ['VOYAGE_API_KEY'], { GSD_TEST_MODE: '1' });
    assert.strictEqual(inert.r.status, 0, inert.r.stderr);
    assert.deepStrictEqual(inert.report, { read: null, sha: { VOYAGE_API_KEY: null } });
    const optIn = runLoader(dirs, ['VOYAGE_API_KEY'], { GSD_TEST_MODE: '1', GSD_DOTENV_PATH: dirs.managed });
    assert.strictEqual(optIn.report.read, dirs.managed);
    assert.strictEqual(optIn.report.sha.VOYAGE_API_KEY, FAKE_SHA);
  });

  test('the loader creates nothing', (t) => {
    const dirs = makeHome(t, null);
    const { report, r } = runLoader(dirs, ['VOYAGE_API_KEY']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(report.read, null);
    assert.ok(!fs.existsSync(path.join(dirs.home, '.amauta')), 'the loader created ~/.amauta');
  });

  test('a 0644 keys file is refused with the chmod 600 fix (POSIX); read unchecked on Windows', (t) => {
    const dirs = makeHome(t, `VOYAGE_API_KEY=${FAKE_KEY}\n`, 0o644);
    const { report, r } = runLoader(dirs, ['VOYAGE_API_KEY']);
    if (POSIX) {
      assert.notStrictEqual(r.status, 0, 'a 0644 keys file was accepted');
      assert.strictEqual(report, null);
      assert.ok(r.stderr.includes('ManagedEnvPermissionError'), r.stderr);
      assert.ok(r.stderr.includes(`chmod 600 ${dirs.managed}`), r.stderr);
    } else {
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(report.sha.VOYAGE_API_KEY, FAKE_SHA);
    }
  });
});

describe('89-10 doctor reports presence and source, never the value', () => {
  /**
   * Run `doctor --json` under a temporary home.
   * @param {object} dirs from makeHome
   * @returns {object} checks by category
   */
  function doctor(dirs) {
    const python = resolvePython();
    const r = spawnSync(python.command, [...python.args, DOCTOR, '--json'], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 120000,
      env: childEnv(dirs.home, {
        GSD_TEST_MODE: '1',
        GSD_DOTENV_PATH: dirs.managed,
        GSD_AMAUTA_PORT: '18991',
        GSD_RLM_PORT: '18992',
        GSD_POSTGRES_URL: '',
        AMAUTA_MEMORY_DATABASE_URL: '',
        AMAUTA_DATA_DIR: path.join(dirs.home, 'data'),
      }),
    });
    assertNoSecret(r.stdout, r.stderr);
    assert.ok(r.stdout && r.stdout.trim().startsWith('{'), `doctor printed no JSON: ${r.stderr}`);
    const checks = {};
    for (const c of JSON.parse(r.stdout).checks) checks[c.category] = c;
    return checks;
  }

  test('a key in the managed file is present, source managed_env_file', (t) => {
    const dirs = makeHome(t, `VOYAGE_API_KEY=${FAKE_KEY}\n`);
    const row = doctor(dirs).keys;
    assert.ok(row, 'doctor has no `keys` row');
    assert.strictEqual(row.status, 'OK');
    assert.deepStrictEqual(row.data.VOYAGE_API_KEY, { present: true, source: 'managed_env_file' });
    assert.deepStrictEqual(row.data.PERPLEXITY_API_KEY, { present: false, source: 'absent' });
    assert.deepStrictEqual(Object.keys(row.data.VOYAGE_API_KEY).sort(), ['present', 'source']);
    assert.strictEqual(row.data._managed_env_file.path, dirs.managed);
    assert.strictEqual(row.data._managed_env_file.permissions, POSIX ? 'owner_only' : 'not_checked_windows');
    if (!POSIX) assert.ok(row.detail.includes('NOT checked on Windows'), row.detail);
  });

  test('a file that is too open: WARN with the fix on POSIX, stated as unchecked on Windows', (t) => {
    const dirs = makeHome(t, `VOYAGE_API_KEY=${FAKE_KEY}\n`, 0o644);
    const row = doctor(dirs).keys;
    if (POSIX) {
      assert.strictEqual(row.status, 'WARN');
      assert.ok(row.detail.includes(`chmod 600 ${dirs.managed}`), row.detail);
      assert.deepStrictEqual(row.data.VOYAGE_API_KEY, { present: false, source: 'absent' });
    } else {
      assert.strictEqual(row.status, 'OK');
      assert.ok(row.detail.includes('NOT checked on Windows'), row.detail);
    }
  });
});
