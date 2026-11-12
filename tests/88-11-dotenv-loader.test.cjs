'use strict';

/**
 * tests/88-11-dotenv-loader.test.cjs — Phase 88, plan 88-11 task 04.
 *
 * The Node half of the `.env` loader census. Four CLIs — `gsd-amauta.cjs`,
 * `gsd-memory.cjs`, `gsd-rlm.cjs` and `gsd-research.cjs` — carry a `loadDotenv`
 * IIFE that runs at REQUIRE time and reads `<repo>/.env`, then `/srv/amauta/.env`.
 * Their comment already said "skipped in test mode", but the only thing they
 * tested was `GSD_AMAUTA_NO_AUTO_START`, so a child spawned from a test session
 * that had not set that one name read the operator's live file.
 *
 * Each case runs the REAL loader source, extracted from the real file and
 * called with an injected `__dirname` (a temporary tree holding a sentinel
 * `.env`) and an injected `process` whose `env` the test owns. Nothing is
 * copied, nothing is required, no CLI runs, no port is touched, and the
 * repository's own `.env` is never read: on the operator's machine it holds
 * live credentials.
 *
 * The first half pins what the loader does OUTSIDE test mode — the installed
 * CLIs depend on it and this plan does not change it. The second half pins the
 * guard: inside test mode the loader reads nothing unless `GSD_DOTENV_PATH`
 * names one file explicitly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

/** The four CLIs that carry the loader, repository-relative. */
const LOADERS = [
  'get-shit-done/bin/gsd-amauta.cjs',
  'get-shit-done/bin/gsd-memory.cjs',
  'get-shit-done/bin/gsd-rlm.cjs',
  'get-shit-done/bin/gsd-research.cjs',
];

/** The sentinel body written to every temporary tree's `.env`. */
const SENTINEL_ENV =
  'GSD_DOTENV_SENTINEL=leaked-from-dotenv\n' +
  'GSD_POSTGRES_URL=postgresql://sentinel@127.0.0.1:1/none\n' +
  'VOYAGE_API_KEY=sentinel-not-a-real-key\n';

/**
 * Extract the `loadDotenv` IIFE from a CLI's source.
 *
 * The block is located by its function name and closed by brace balance, the
 * same way the party canaries extract a `case` block, so a reformatting of the
 * body cannot silently shrink what is under test.
 *
 * @param {string} rel repository-relative path of the CLI
 * @returns {{block: string, source: string}} the IIFE text and the whole file
 * @throws {Error} when the file has no `loadDotenv`, two of them, or an
 *   unbalanced body — any of which means this test is no longer reading the
 *   loader and must fail rather than pass vacuously.
 * @example
 *   extractLoader('get-shit-done/bin/gsd-rlm.cjs').block.includes('.env')  // true
 */
function extractLoader(rel) {
  const source = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf-8');
  const marker = '(function loadDotenv() {';
  const first = source.indexOf(marker);
  if (first === -1) throw new Error(`${rel}: no "${marker}"`);
  if (source.indexOf(marker, first + 1) !== -1) throw new Error(`${rel}: two loadDotenv blocks`);
  let depth = 0;
  for (let i = source.indexOf('{', first); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        const end = source.indexOf(';', i);
        return { block: source.slice(first, end + 1), source };
      }
    }
  }
  throw new Error(`${rel}: unbalanced loadDotenv body`);
}

/**
 * Run one CLI's real loader against a temporary tree and return its `process.env`.
 *
 * @param {string} rel repository-relative path of the CLI
 * @param {object} opts options
 * @param {object} [opts.env] the starting environment (owned by the caller)
 * @param {string|null} [opts.envText] body of the tree's `.env`; null writes none
 * @param {object} [opts.files] extra files to write, relative to the tree root
 * @param {object} [opts.t] the node:test context, used to remove the tree afterwards
 * @returns {{env: object, root: string}} the environment after the loader ran
 */
function runLoader(rel, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dotenv-'));
  // The loaders resolve `path.join(__dirname, '..', '..', '.env')`, so the
  // injected __dirname sits two directories below the tree root.
  const dirname = path.join(root, 'get-shit-done', 'bin');
  fs.mkdirSync(dirname, { recursive: true });
  const envText = opts.envText === undefined ? SENTINEL_ENV : opts.envText;
  if (envText !== null) fs.writeFileSync(path.join(root, '.env'), envText);
  for (const [name, body] of Object.entries(opts.files || {})) {
    fs.writeFileSync(path.join(root, name), body);
  }
  if (opts.t) opts.t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...(opts.env || {}) };
  const { block } = extractLoader(rel);
  // eslint-disable-next-line no-new-func -- the point is to run the product's
  // own source with an injected __dirname and an injected process.
  new Function('__dirname', 'path', 'fs', 'process', block)(dirname, path, fs, { env });
  return { env, root };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchors: the extraction really is reading the loader
// ─────────────────────────────────────────────────────────────────────────────

for (const rel of LOADERS) {
  test(`anchor: ${rel} has exactly one loadDotenv and it owns the only '.env' literal`, () => {
    const { block, source } = extractLoader(rel);
    assert.ok(block.includes("'.env'"), 'the extracted block must name .env');
    assert.ok(block.includes('process.env'), 'the extracted block must write process.env');
    const occurrences = source.split("'.env'").length - 1;
    assert.equal(occurrences, 1, `${rel} reads '.env' in ${occurrences} places, expected 1`);
    assert.ok(
      source.indexOf("'.env'") > source.indexOf('(function loadDotenv() {'),
      'the only .env read must be inside the loader',
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTSIDE TEST MODE — characterisation. These expectations must not change.
// ─────────────────────────────────────────────────────────────────────────────

for (const rel of LOADERS) {
  test(`outside test mode ${rel} reads the repo-root .env`, (t) => {
    const { env } = runLoader(rel, { t });
    assert.deepEqual(env, {
      GSD_DOTENV_SENTINEL: 'leaked-from-dotenv',
      GSD_POSTGRES_URL: 'postgresql://sentinel@127.0.0.1:1/none',
      VOYAGE_API_KEY: 'sentinel-not-a-real-key',
    });
  });

  test(`outside test mode ${rel} never overrides a name already set`, (t) => {
    const { env } = runLoader(rel, { t, env: { GSD_DOTENV_SENTINEL: 'from-the-environment' } });
    assert.equal(env.GSD_DOTENV_SENTINEL, 'from-the-environment');
    assert.equal(env.VOYAGE_API_KEY, 'sentinel-not-a-real-key');
  });

  test(`outside test mode ${rel} skips comments, blanks and lines without =`, (t) => {
    const { env } = runLoader(rel, {
      t,
      envText:
        '# GSD_DOTENV_IN_COMMENT=commented-out\n' +
        '   # an indented comment\n' +
        '\n' +
        '   \n' +
        'GSD_DOTENV_BARE_LINE\n' +
        'GSD_DOTENV_SENTINEL=below-the-junk\n',
    });
    assert.deepEqual(env, { GSD_DOTENV_SENTINEL: 'below-the-junk' });
  });

  test(`outside test mode ${rel} quoting and whitespace rules`, (t) => {
    const { env } = runLoader(rel, {
      t,
      envText:
        'GSD_DOTENV_DQ="double"\n' +
        "GSD_DOTENV_SQ='single'\n" +
        'GSD_DOTENV_PADDED=   padded   \n' +
        'GSD_DOTENV_INNER_EQUALS=a=b=c\n' +
        'GSD_DOTENV_INNER_SPACES="  kept  "\n' +
        'GSD_DOTENV_HALF_QUOTED="mixed\'\n' +
        'GSD_DOTENV_PADDED_KEY  =  value\n' +
        'GSD_DOTENV_EMPTY=\n',
    });
    assert.deepEqual(env, {
      GSD_DOTENV_DQ: 'double',
      GSD_DOTENV_SQ: 'single',
      GSD_DOTENV_PADDED: 'padded',
      GSD_DOTENV_INNER_EQUALS: 'a=b=c',
      GSD_DOTENV_INNER_SPACES: '  kept  ',
      GSD_DOTENV_HALF_QUOTED: 'mixed',
      GSD_DOTENV_PADDED_KEY: 'value',
      GSD_DOTENV_EMPTY: '',
    });
  });

  test(`outside test mode ${rel} with no .env in the tree injects nothing`, (t) => {
    const { env } = runLoader(rel, { t, envText: null });
    assert.equal(env.GSD_DOTENV_SENTINEL, undefined);
  });

  test(`outside test mode ${rel} still honours GSD_AMAUTA_NO_AUTO_START`, (t) => {
    const { env } = runLoader(rel, { t, env: { GSD_AMAUTA_NO_AUTO_START: '1' } });
    assert.deepEqual(env, { GSD_AMAUTA_NO_AUTO_START: '1' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INSIDE TEST MODE — the guard
// ─────────────────────────────────────────────────────────────────────────────

/** Truthy spellings of GSD_TEST_MODE, as gsd-amauta.cjs has always read them. */
const TEST_MODE_ON = ['1', 'true', 'TRUE', 'yes', 'on'];

/** Spellings that are not test mode: the loader must still read the file. */
const TEST_MODE_OFF = ['0', 'false', 'off', ''];

for (const rel of LOADERS) {
  test(`in test mode ${rel} reads nothing`, (t) => {
    const { env, root } = runLoader(rel, { t, env: { GSD_TEST_MODE: '1' } });
    assert.ok(fs.existsSync(path.join(root, '.env')), 'the sentinel file must exist');
    assert.deepEqual(env, { GSD_TEST_MODE: '1' });
  });

  for (const spelling of TEST_MODE_ON) {
    test(`in test mode ${rel} reads nothing with GSD_TEST_MODE=${spelling}`, (t) => {
      const { env } = runLoader(rel, { t, env: { GSD_TEST_MODE: spelling } });
      assert.equal(env.GSD_DOTENV_SENTINEL, undefined);
    });
  }

  for (const spelling of TEST_MODE_OFF) {
    test(`GSD_TEST_MODE=${JSON.stringify(spelling)} is not test mode for ${rel}`, (t) => {
      const { env } = runLoader(rel, { t, env: { GSD_TEST_MODE: spelling } });
      assert.equal(env.GSD_DOTENV_SENTINEL, 'leaked-from-dotenv');
    });
  }

  test(`in test mode ${rel} reads only the file GSD_DOTENV_PATH names`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dotenv-explicit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const explicit = path.join(root, 'explicit.env');
    fs.writeFileSync(explicit, 'GSD_DOTENV_EXPLICIT=from-the-explicit-file\n');
    const { env } = runLoader(rel, {
      t,
      env: { GSD_TEST_MODE: '1', GSD_DOTENV_PATH: explicit },
    });
    assert.equal(env.GSD_DOTENV_EXPLICIT, 'from-the-explicit-file');
    assert.equal(env.GSD_DOTENV_SENTINEL, undefined, 'the ambient .env must stay unread');
  });

  test(`in test mode ${rel} survives a GSD_DOTENV_PATH that does not exist`, (t) => {
    const { env, root } = runLoader(rel, {
      t,
      env: { GSD_TEST_MODE: '1', GSD_DOTENV_PATH: path.join(os.tmpdir(), 'no-such-file.env') },
    });
    assert.ok(fs.existsSync(path.join(root, '.env')));
    assert.equal(env.GSD_DOTENV_SENTINEL, undefined);
  });

  test(`outside test mode ${rel} ignores GSD_DOTENV_PATH`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dotenv-explicit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const explicit = path.join(root, 'explicit.env');
    fs.writeFileSync(explicit, 'GSD_DOTENV_EXPLICIT=from-the-explicit-file\n');
    const { env } = runLoader(rel, { t, env: { GSD_DOTENV_PATH: explicit } });
    assert.equal(env.GSD_DOTENV_EXPLICIT, undefined, 'production must not gain a new input');
    assert.equal(env.GSD_DOTENV_SENTINEL, 'leaked-from-dotenv');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The harness: this very process proves the runner set test mode
// ─────────────────────────────────────────────────────────────────────────────

test('scripts/run-tests.cjs hands every test process GSD_TEST_MODE=1', () => {
  // This file is run by scripts/run-tests.cjs, so its own environment is the
  // evidence: if the runner stopped setting the name, the loaders in every
  // product child spawned by a Node test would be back on the ambient .env.
  assert.equal(
    process.env.GSD_TEST_MODE,
    '1',
    'run this file through scripts/run-tests.cjs, which is what sets GSD_TEST_MODE',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift: the guard is spelled the same way in all four, and the three loaders
// that were byte-identical before this plan still are.
//
// These are source assertions, and they are NOT the proof — the behavioural
// cases above are. They exist so a fifth spelling of the guard, or a copy that
// quietly loses it, shows up as a failure here rather than as a leak on the one
// machine that has a .env.
// ─────────────────────────────────────────────────────────────────────────────

const GUARD = [
  "  const testMode = /^(1|true|yes|on)$/i.test(String(process.env.GSD_TEST_MODE || ''))",
  '    || Boolean(process.env.PYTEST_CURRENT_TEST);',
  "  const explicit = testMode ? String(process.env.GSD_DOTENV_PATH || '') : '';",
  '  if (testMode && !explicit) return;',
].join('\n');

test('all four Node loaders spell the guard identically, above the candidates', () => {
  for (const rel of LOADERS) {
    const { block } = extractLoader(rel);
    assert.ok(block.includes(GUARD), `${rel} does not carry the guard verbatim`);
    assert.ok(
      block.indexOf(GUARD) < block.indexOf('candidates'),
      `${rel} builds its candidate list before the guard`,
    );
  }
});

test('gsd-amauta, gsd-memory and gsd-rlm still share one byte-identical loader', () => {
  const shared = [
    'get-shit-done/bin/gsd-amauta.cjs',
    'get-shit-done/bin/gsd-memory.cjs',
    'get-shit-done/bin/gsd-rlm.cjs',
  ].map((rel) => ({ rel, block: extractLoader(rel).block }));
  for (const { rel, block } of shared) {
    assert.equal(block, shared[0].block, `${rel} has drifted from ${shared[0].rel}`);
  }
  // gsd-research.cjs says the same thing in its own words (different variable
  // names, a multi-line candidate list); its behaviour is pinned by every case
  // above, which is why it is not required to match byte for byte.
  assert.notEqual(extractLoader('get-shit-done/bin/gsd-research.cjs').block, shared[0].block);
});

for (const rel of LOADERS) {
  test(`a CLI spawned from a pytest test reads nothing: ${rel}`, (t) => {
    // PYTEST_CURRENT_TEST is inherited by every child a pytest test spawns, and
    // tests/test_88_rlm_port_safety.py deletes GSD_TEST_MODE, so this is the
    // marker that covers a Node CLI called from such a test.
    const { env } = runLoader(rel, {
      t,
      env: { PYTEST_CURRENT_TEST: 'tests/test_x.py::test_y (call)' },
    });
    assert.equal(env.GSD_DOTENV_SENTINEL, undefined);
  });
}
