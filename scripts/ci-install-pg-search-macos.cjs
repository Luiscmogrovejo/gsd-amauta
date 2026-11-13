#!/usr/bin/env node
'use strict';
/**
 * Load the real ParadeDB `pg_search` extension into a macOS CI cell's
 * disposable PostgreSQL, so that cell runs the SAME lexical engine as the Linux
 * cell and production instead of the plain-PostgreSQL full-text fallback.
 *
 * Phase 89, plan 89-12 (decision D4). It runs AFTER `scripts/ci-postgres-cell.cjs
 * --up`, because `shared_preload_libraries` lives in the cluster's
 * `postgresql.conf` and that file does not exist before `initdb`.
 *
 * What it does, in order, and it stops at the first thing that is not exactly
 * as measured:
 *   1. refuses outside CI, off macOS, off Apple silicon, and on a macOS major
 *      it has no pinned package for;
 *   2. downloads ONE release asset by its exact URL;
 *   3. refuses unless the bytes hash to the pinned SHA-256 — no fallback, no
 *      "warn and continue", and nothing is installed after a mismatch;
 *   4. checks the Apple installer signature and its Team ID with `pkgutil`,
 *      and the sigstore bundle with `cosign` WHEN `cosign` is on the runner
 *      (it is not preinstalled; the output says which happened);
 *   5. installs the package with the system installer;
 *   6. requires the library and the control file to be where THIS cluster's
 *      `pg_config` looks, which is the question the plan had to measure;
 *   7. puts `pg_search` into `shared_preload_libraries` idempotently, restarts
 *      the cluster, waits for a real connection, and proves
 *      `CREATE EXTENSION pg_search` works and reports the pinned version.
 *
 * The pins below were MEASURED on hosted runners before this file was written:
 * pull request #49, workflow runs 43432557908 and 43433158637 (macos-26-arm64,
 * image 20261102.0473.1, six independent runners) for the `tahoe` package, and
 * the run named beside the `sequoia` entry for that one. On every runner the
 * downloaded bytes hashed to the value below, which is also the digest the
 * GitHub release API records for the asset — two independent records.
 *
 * Usage:
 *   node scripts/ci-install-pg-search-macos.cjs --port <n> [--data-dir <d>]
 *
 * @module scripts/ci-install-pg-search-macos
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const cell = require('./ci-postgres-cell.cjs');
const platform = require('../get-shit-done/bin/lib/platform.cjs');

/** The ParadeDB release every asset below comes from. */
const PARADEDB_TAG = 'v0.26.6';

/** The `pg_search` version that release installs, and that `extversion` must report. */
const PG_SEARCH_VERSION = '0.26.6';

/** Where release assets are served from. One constant, so a test can assert the host. */
const RELEASE_BASE = 'https://github.com/paradedb/paradedb/releases/download';

/** The Apple Developer Team ID the installer package must be signed by. */
const APPLE_TEAM_ID = 'NDJBT4LXCM';

/** The sigstore identity the release workflow signs with. */
const COSIGN_IDENTITY_REGEXP = '^https://github.com/paradedb/paradedb/';
const COSIGN_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * The pinned packages, keyed by the macOS MAJOR version the runner reports.
 *
 * `macos-latest` moves: plan 89-07 measured macos-15 and this plan, one day
 * later, measured macos-26 on every runner. The asset name carries the macOS
 * code name, so the pin is per major and an unknown major is a refusal — never
 * a guess at "the closest one".
 *
 * SHA256 pins. `sha256` is the installer package, `bundleSha256` its
 * `.cosign.bundle`.
 */
const PACKAGES = Object.freeze({
  26: Object.freeze({
    codename: 'tahoe',
    sha256: '29460a509a62143561024fddeb89838c1b7dad89d4dd5e040118b1fb35b287a0',
    bundleSha256: '9fed937164fe3f606eebb94fad5e03f9c2a63961364843545bdf0772dcbb9f01',
  }),
  15: Object.freeze({
    codename: 'sequoia',
    sha256: '99b426eda50b92999e8a5a0525caa382102278d5cbd55f6240741a5089353d44',
    bundleSha256: '35b2f8e10380f51d147b4342e0fdc3518b62250d52d8b2cf88bffa01da0b7793',
  }),
});

/** How many times a download is attempted before the step fails. */
const DOWNLOAD_ATTEMPTS = 3;

/** The longest one download attempt may take, in milliseconds. */
const DOWNLOAD_TIMEOUT_MS = Number(process.env.GSD_CI_PG_SEARCH_DOWNLOAD_TIMEOUT_MS || 180000);

/** The line this script owns in `postgresql.conf`. */
const PRELOAD_KEY = 'shared_preload_libraries';
const PRELOAD_LIBRARY = 'pg_search';

/**
 * A typed failure, so a caller and a test can branch on the kind.
 */
class InstallError extends Error {
  /**
   * @param {string} code - a stable kind, e.g. `not_ci`, `digest_mismatch`.
   * @param {string} message - the human sentence.
   * @param {object} [detail] - extra fields for the report.
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Refuse to do anything outside CI.
 *
 * The same rule as `scripts/ci-postgres-cell.cjs`, through the same function,
 * so there is one definition of "this is a CI cell". This script runs the
 * system installer with elevated rights; on a developer machine it must be
 * impossible to reach that line.
 *
 * @param {object} env - the environment to read.
 * @returns {void}
 * @throws {InstallError} `not_ci`.
 */
function assertCi(env) {
  try {
    cell.assertCi(env);
  } catch (_e) {
    throw new InstallError(
      'not_ci',
      'ci-install-pg-search-macos: refusing to download or install anything outside CI. '
      + 'CI is unset, so this is a developer machine; nothing was downloaded, installed or restarted.',
    );
  }
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {{port: number|null, dataDir: string|null, help: boolean}}
 * @throws {InstallError} `bad_args`.
 */
function parseArgs(argv) {
  const out = { port: null, dataDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '--data-dir') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined) {
        throw new InstallError('bad_args', 'ci-install-pg-search-macos: ' + a + ' needs a value');
      }
      if (a === '--port') out.port = Number(v);
      else out.dataDir = v;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      throw new InstallError('bad_args', 'ci-install-pg-search-macos: unknown argument ' + a);
    }
  }
  return out;
}

/**
 * The pinned package for a macOS product version.
 *
 * @param {string} productVersion - what `sw_vers -productVersion` printed, e.g. `26.7.2`.
 * @param {object} [packages] - the pin table (tests inject one whose digest they can produce).
 * @returns {{major: string, codename: string, sha256: string, bundleSha256: string}}
 * @throws {InstallError} `unpinned_macos` for a major with no pinned package.
 * @example
 *   selectPackage('26.7.2').codename; // 'tahoe'
 */
function selectPackage(productVersion, packages = PACKAGES) {
  const major = String(productVersion || '').trim().split('.')[0];
  const entry = Object.prototype.hasOwnProperty.call(packages, major) ? packages[major] : null;
  if (!entry) {
    throw new InstallError(
      'unpinned_macos',
      'ci-install-pg-search-macos: no pinned pg_search package for macOS "'
      + String(productVersion).trim() + '". Pinned majors: ' + Object.keys(packages).join(', ')
      + '. The runner image moved; measure the new asset and record its SHA-256 before using it.',
      { productVersion: String(productVersion || '') },
    );
  }
  return { major, ...entry };
}

/**
 * The asset file name and its download URL.
 *
 * @param {string} pgMajor - the PostgreSQL major, e.g. `17`.
 * @param {string} codename - `tahoe` or `sequoia`.
 * @returns {{name: string, url: string, bundleUrl: string}}
 * @example
 *   assetFor('17', 'tahoe').name; // 'pg_search@17--0.26.6.arm64_tahoe.pkg'
 */
function assetFor(pgMajor, codename) {
  const name = 'pg_search@' + pgMajor + '--' + PG_SEARCH_VERSION + '.arm64_' + codename + '.pkg';
  const url = RELEASE_BASE + '/' + PARADEDB_TAG + '/' + encodeURIComponent(name);
  return { name, url, bundleUrl: url + '.cosign.bundle' };
}

/**
 * The SHA-256 of a file, as lowercase hex.
 *
 * @param {string} file
 * @returns {string}
 */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Download one HTTPS URL to a file, following redirects, with a deadline.
 *
 * Node's own client, so no external download tool is named or spawned. Only
 * `https:` is followed: a release asset redirects to GitHub's object store, and
 * a redirect to anything else is refused rather than followed.
 *
 * @param {string} url
 * @param {string} dest
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.redirects] - how many more redirects may be followed.
 * @returns {Promise<void>}
 * @throws {Error} on a non-200 answer, a non-https redirect, or the deadline.
 */
function httpsDownload(url, dest, opts = {}) {
  const timeoutMs = opts.timeoutMs || DOWNLOAD_TIMEOUT_MS;
  const redirects = opts.redirects === undefined ? 5 : opts.redirects;
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) {
      reject(new Error('refusing a non-https URL: ' + url.split('?')[0]));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'ci-install-pg-search-macos' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        httpsDownload(next, dest, { timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error('HTTP ' + status + ' for ' + url.split('?')[0]));
        return;
      }
      const part = dest + '.part';
      const file = fs.createWriteStream(part);
      res.pipe(file);
      file.on('error', reject);
      res.on('error', reject);
      file.on('finish', () => file.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        fs.renameSync(part, dest);
        resolve();
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('no answer within ' + timeoutMs + ' ms')));
    req.on('error', reject);
  });
}

/**
 * Download with a bounded number of attempts.
 *
 * A retry can only ever help a TRANSPORT failure: the digest is checked by the
 * caller afterwards, so wrong bytes are refused however they arrived.
 *
 * @param {function} download - `(url, dest) => Promise<void>`.
 * @param {string} url
 * @param {string} dest
 * @param {object} ctx - `{ pause, out }`.
 * @returns {Promise<number>} the attempt that succeeded, from 1.
 * @throws {InstallError} `download_failed` after the last attempt.
 */
async function downloadWithRetry(download, url, dest, ctx) {
  let last = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(dest, { force: true });
      await download(url, dest);
      return attempt;
    } catch (e) {
      last = e;
      ctx.out('ci-install-pg-search-macos: download attempt ' + attempt + ' of '
        + DOWNLOAD_ATTEMPTS + ' failed: ' + e.message + '\n');
      if (attempt < DOWNLOAD_ATTEMPTS) ctx.pause(2000 * attempt);
    }
  }
  throw new InstallError('download_failed',
    'ci-install-pg-search-macos: could not download ' + url + ' in ' + DOWNLOAD_ATTEMPTS
    + ' attempts: ' + (last && last.message), { url });
}

/**
 * Put `pg_search` into `shared_preload_libraries`, idempotently.
 *
 * PostgreSQL reads the LAST active assignment in the file, so that is the one
 * examined. Three outcomes, and a second run always lands on `unchanged`:
 *   - `appended`:  no active assignment existed (the `initdb` default is a
 *                  comment), so one line is added at the end;
 *   - `merged`:    an active assignment existed without `pg_search`, so the
 *                  library is added to ITS list and nothing else is lost;
 *   - `unchanged`: `pg_search` is already in the active assignment.
 *
 * @param {string} confPath - the cluster's `postgresql.conf`.
 * @returns {string} `appended`, `merged` or `unchanged`.
 * @throws {InstallError} `no_conf` when the file cannot be read.
 * @example
 *   ensurePreload('/tmp/x/postgresql.conf'); // 'appended', then 'unchanged'
 */
function ensurePreload(confPath) {
  let text;
  try {
    text = fs.readFileSync(confPath, 'utf8');
  } catch (e) {
    throw new InstallError('no_conf',
      'ci-install-pg-search-macos: cannot read ' + confPath + ' (' + e.message + '). '
      + 'This step runs after the bring-up step, which is what creates the cluster.');
  }
  const lines = text.split('\n');
  const active = /^[ \t]*shared_preload_libraries[ \t]*=[ \t]*(.*)$/;
  let lastIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (active.test(lines[i])) lastIndex = i;
  }
  if (lastIndex === -1) {
    const sep = text.endsWith('\n') || text === '' ? '' : '\n';
    fs.writeFileSync(confPath, text + sep + PRELOAD_KEY + " = '" + PRELOAD_LIBRARY + "'\n");
    return 'appended';
  }
  const raw = active.exec(lines[lastIndex])[1];
  const value = raw.replace(/#.*$/, '').trim().replace(/^'(.*)'$/, '$1');
  const libraries = value.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (libraries.includes(PRELOAD_LIBRARY)) return 'unchanged';
  libraries.push(PRELOAD_LIBRARY);
  lines[lastIndex] = PRELOAD_KEY + " = '" + libraries.join(',') + "'";
  fs.writeFileSync(confPath, lines.join('\n'));
  return 'merged';
}

/**
 * The first line a tool printed, trimmed.
 *
 * @param {object} r - a spawn result.
 * @returns {string}
 */
function firstLine(r) {
  return String((r && r.stdout) || '').trim().split(/\r?\n/)[0] || '';
}

/**
 * Whether a spawn result means "this tool is not on the runner".
 *
 * @param {object} r - a spawn result.
 * @returns {boolean}
 */
function toolAbsent(r) {
  return !r || (r.error && r.error.code === 'ENOENT') || r.status === 127;
}

/**
 * Install `pg_search` into the running disposable cluster and prove it loads.
 *
 * @param {object} opts
 * @param {number} opts.port - the port the bring-up step chose.
 * @param {string} [opts.dataDir] - the cluster's data directory.
 * @param {string} [opts.platform] - platform override for tests.
 * @param {string} [opts.arch] - architecture override for tests.
 * @param {object} [opts.env] - environment override for tests.
 * @param {function} [opts.run] - injected runner: `(tool, args, options) => spawnSync-like`.
 * @param {function} [opts.download] - injected downloader: `(url, dest) => Promise<void>`.
 * @param {function} [opts.pause] - injected wait, in milliseconds.
 * @param {function} [opts.out] - stdout sink.
 * @param {object} [opts.packages] - pin table override, for tests only.
 * @param {string} [opts.workDir] - where the download is written.
 * @param {number} [opts.readyTimeoutS] - the readiness bound after the restart.
 * @returns {Promise<object>} what happened: versions, digests, which checks ran, seconds per stage.
 * @throws {InstallError} on every failure; `detail.log` carries the server log tail.
 */
async function install(opts) {
  const env = opts.env || process.env;
  const plat = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const run = opts.run || defaultRun;
  const pause = opts.pause || cell.sleepMs;
  const out = opts.out || ((s) => process.stdout.write(s));
  const download = opts.download || httpsDownload;

  assertCi(env);
  if (plat !== 'darwin' || arch !== 'arm64') {
    throw new InstallError('unsupported_platform',
      'ci-install-pg-search-macos: this installs an Apple-silicon macOS package; this is '
      + plat + '/' + arch + '. ParadeDB publishes no Windows build of pg_search at all, and the '
      + 'Linux cell gets it from the pinned container image.', { platform: plat, arch });
  }
  let port;
  try {
    port = cell.assertPortAllowed(opts.port);
  } catch (e) {
    throw new InstallError(e.code || 'bad_port', e.message);
  }

  const dataDir = opts.dataDir || cell.defaultDataDir();
  const logFile = dataDir + '.log';
  const confPath = path.join(dataDir, 'postgresql.conf');
  const fail = (code, message, detail = {}) => new InstallError(code,
    'ci-install-pg-search-macos: ' + message, { ...detail, log: cell.logTail(logFile) });
  const seconds = {};
  const clock = () => Date.now();

  // 1. which package: the runner's macOS major decides, and an unknown one refuses.
  const swVers = run('sw_vers', ['-productVersion'], { env, encoding: 'utf8' });
  const productVersion = firstLine(swVers);
  const pin = selectPackage(productVersion, opts.packages || PACKAGES);
  const asset = assetFor(cell.PG_MAJOR, pin.codename);
  out('ci-install-pg-search-macos: macOS ' + productVersion + ' -> ' + asset.name + '\n');

  // 2. where THIS cluster looks for libraries and control files.
  const binDir = cell.resolveBinDir({ platform: plat, env, run });
  const pgConfig = cell.toolPath(binDir, 'pg_config', plat);
  const pkgLibDir = firstLine(run(pgConfig, ['--pkglibdir'], { env, encoding: 'utf8' }));
  const shareDir = firstLine(run(pgConfig, ['--sharedir'], { env, encoding: 'utf8' }));
  if (!pkgLibDir || !shareDir) {
    throw fail('no_pg_config', 'pg_config printed no --pkglibdir or --sharedir at ' + pgConfig);
  }

  // 3. download, then the digest. Nothing below runs on a mismatch.
  const workDir = opts.workDir || path.join(os.tmpdir(), 'gsd-ci-pg-search');
  fs.mkdirSync(workDir, { recursive: true });
  const pkgPath = path.join(workDir, asset.name);
  let t = clock();
  const attempt = await downloadWithRetry(download, asset.url, pkgPath, { pause, out });
  seconds.download = (clock() - t) / 1000;
  const actual = sha256File(pkgPath);
  if (actual !== pin.sha256) {
    fs.rmSync(pkgPath, { force: true });
    throw fail('digest_mismatch',
      'SHA-256 mismatch for ' + asset.name + ': pinned ' + pin.sha256 + ', downloaded ' + actual
      + '. The file was deleted and nothing was installed.',
      { expected: pin.sha256, actual, url: asset.url });
  }
  out('ci-install-pg-search-macos: sha256 ' + actual + ' matches the pin (' + PARADEDB_TAG
    + ', attempt ' + attempt + ')\n');

  // 4a. Apple's own verifier is always on a macOS runner.
  const sig = run('pkgutil', ['--check-signature', pkgPath], { env, encoding: 'utf8' });
  if (!sig || sig.status !== 0 || !String(sig.stdout || '').includes('(' + APPLE_TEAM_ID + ')')) {
    throw fail('signature_failed',
      'pkgutil --check-signature did not confirm a package signed by Team ID ' + APPLE_TEAM_ID
      + ' (status ' + (sig && sig.status) + '). Nothing was installed.',
      { stdout: String((sig && sig.stdout) || '').slice(-2000), stderr: String((sig && sig.stderr) || '').slice(-2000) });
  }
  out('ci-install-pg-search-macos: installer signature verified (Developer ID Team ' + APPLE_TEAM_ID + ')\n');

  // 4b. the sigstore bundle, when a verifier exists on the runner.
  let cosign = 'skipped: cosign is not on this runner';
  const probe = run('cosign', ['version'], { env, encoding: 'utf8' });
  if (!toolAbsent(probe)) {
    const bundlePath = pkgPath + '.cosign.bundle';
    await downloadWithRetry(download, asset.bundleUrl, bundlePath, { pause, out });
    const bundleActual = sha256File(bundlePath);
    if (bundleActual !== pin.bundleSha256) {
      throw fail('digest_mismatch',
        'SHA-256 mismatch for the cosign bundle: pinned ' + pin.bundleSha256 + ', downloaded '
        + bundleActual + '. Nothing was installed.', { expected: pin.bundleSha256, actual: bundleActual });
    }
    const v = run('cosign', ['verify-blob', '--bundle', bundlePath,
      '--certificate-identity-regexp', COSIGN_IDENTITY_REGEXP,
      '--certificate-oidc-issuer', COSIGN_OIDC_ISSUER, pkgPath], { env, encoding: 'utf8' });
    if (!v || v.status !== 0) {
      throw fail('cosign_failed', 'cosign verify-blob refused the package (status '
        + (v && v.status) + '). Nothing was installed.',
        { stderr: String((v && v.stderr) || '').slice(-2000) });
    }
    cosign = 'verified';
  }
  out('ci-install-pg-search-macos: cosign bundle ' + cosign + '\n');

  // 5. the system installer. `-n`: a password prompt is a failure, never a hang.
  t = clock();
  const inst = run('sudo', ['-n', 'installer', '-pkg', pkgPath, '-target', '/'], { env, encoding: 'utf8' });
  seconds.installer = (clock() - t) / 1000;
  if (!inst || inst.status !== 0) {
    throw fail('installer_failed', 'the system installer failed (status ' + (inst && inst.status) + ')',
      { stdout: String((inst && inst.stdout) || '').slice(-2000), stderr: String((inst && inst.stderr) || '').slice(-2000) });
  }

  // 6. did the files land where THIS cluster looks? (the measured question)
  const library = path.posix.join(pkgLibDir, PRELOAD_LIBRARY + '.dylib');
  const control = path.posix.join(shareDir, 'extension', PRELOAD_LIBRARY + '.control');
  const exists = opts.exists || fs.existsSync;
  for (const f of [library, control]) {
    if (!exists(f)) {
      throw fail('not_in_prefix',
        'the package installed, but ' + f + ' does not exist, so this cluster cannot load it. '
        + 'The package targets the Homebrew postgresql@' + cell.PG_MAJOR + ' layout; the formula moved.',
        { missing: f });
    }
  }
  out('ci-install-pg-search-macos: ' + library + ' and ' + control + ' are in the cluster\'s own directories\n');

  // 7. preload, restart, wait for a REAL connection, prove the extension.
  const edit = ensurePreload(confPath);
  out('ci-install-pg-search-macos: ' + PRELOAD_KEY + ' ' + edit + ' in ' + confPath + '\n');

  // The server inherits the launcher's handles, so they are a FILE, never a
  // pipe — the hang plan 89-07 measured on `pg_ctl start` applies to a restart.
  const ctlOut = dataDir + '.pg_ctl.restart.out';
  const ctlFd = fs.openSync(ctlOut, 'w');
  let restart;
  t = clock();
  try {
    restart = run(cell.toolPath(binDir, 'pg_ctl', plat),
      ['-D', dataDir, '-l', logFile, '-w', '-t', '90', 'restart'],
      { env, stdio: ['ignore', ctlFd, ctlFd] });
  } finally {
    try {
      fs.closeSync(ctlFd);
    } catch (_e) { /* already closed */ }
  }
  seconds.restart = (clock() - t) / 1000;
  let ctlText = '';
  try {
    ctlText = fs.readFileSync(ctlOut, 'utf8');
  } catch (_e) { /* an injected runner writes nothing */ }
  if (!restart || restart.status !== 0) {
    throw fail('restart_failed', 'pg_ctl restart failed (status ' + (restart && restart.status) + ')',
      { stderr: ctlText.slice(-4000) });
  }

  const ctx = { binDir, platform: plat, port, env, run, sleep: pause };
  if (!cell.waitForRealConnection(ctx, opts.readyTimeoutS)) {
    throw fail('not_ready', 'the cluster did not accept a real connection on 127.0.0.1:' + port
      + ' after the restart', { stderr: String((ctx.lastReadinessResult || {}).stderr || '').slice(-2000) });
  }

  const preloaded = firstLine(cell.psql(ctx, cell.DATABASE, ['-tAc', 'SHOW ' + PRELOAD_KEY]));
  if (!preloaded.split(',').map((s) => s.trim()).includes(PRELOAD_LIBRARY)) {
    throw fail('not_preloaded', 'after the restart the server reports ' + PRELOAD_KEY + ' = "'
      + preloaded + '", without ' + PRELOAD_LIBRARY, { preloaded });
  }
  const create = cell.psql(ctx, cell.DATABASE,
    ['-v', 'ON_ERROR_STOP=1', '-c', 'CREATE EXTENSION IF NOT EXISTS pg_search CASCADE']);
  if (!create || create.status !== 0) {
    throw fail('create_extension_failed', 'CREATE EXTENSION pg_search failed (status '
      + (create && create.status) + ')', { stderr: String((create && create.stderr) || '').slice(-4000) });
  }
  const extversion = firstLine(cell.psql(ctx, cell.DATABASE,
    ['-tAc', "SELECT extversion FROM pg_extension WHERE extname = 'pg_search'"]));
  if (extversion !== PG_SEARCH_VERSION) {
    throw fail('wrong_version', 'pg_extension reports pg_search "' + extversion + '", expected '
      + PG_SEARCH_VERSION, { extversion });
  }
  const serverVersion = firstLine(cell.psql(ctx, cell.DATABASE, ['-tAc', 'SHOW server_version']));

  out('ci-install-pg-search-macos: pg_search ' + extversion + ' on PostgreSQL ' + serverVersion
    + ' | download ' + seconds.download.toFixed(1) + ' s, installer ' + seconds.installer.toFixed(1)
    + ' s, restart ' + seconds.restart.toFixed(1) + ' s\n');
  return {
    productVersion, asset: asset.name, sha256: actual, cosign, edit, extversion, serverVersion, seconds,
  };
}

/**
 * The default spawner: `platform.spawnTool` through the bring-up module's own
 * wrapper, so no string is ever handed to a command interpreter.
 *
 * @param {string} command - a bare tool name or an absolute path.
 * @param {string[]} args
 * @param {object} [options]
 * @returns {object} the spawn result.
 */
function defaultRun(command, args, options = {}) {
  return platform.spawnTool({ command, args: [] }, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

/** The usage text. */
const USAGE = [
  'Usage:',
  '  node scripts/ci-install-pg-search-macos.cjs --port <n> [--data-dir <d>]',
  '',
  'Refuses to run unless CI is set, and only on Apple-silicon macOS. Run it after',
  'scripts/ci-postgres-cell.cjs --up, with the same port.',
].join('\n');

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @param {object} [env]
 * @returns {Promise<number>} the process exit code.
 */
async function main(argv, env = process.env) {
  try {
    // The CI refusal comes FIRST, before any complaint about arguments, so a
    // bare hand-run on a developer machine says the one thing that matters.
    assertCi(env);
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE + '\n');
      return 0;
    }
    await install({ port: args.port, dataDir: args.dataDir, env });
    return 0;
  } catch (e) {
    const code = e instanceof InstallError ? e.code : 'unexpected';
    process.stderr.write('ci-install-pg-search-macos: FAILED [' + code + '] ' + e.message + '\n');
    if (code === 'bad_args') process.stderr.write(USAGE + '\n');
    const d = (e && e.detail) || {};
    for (const key of ['stdout', 'stderr']) {
      if (d[key] !== undefined && String(d[key]).trim() !== '') {
        process.stderr.write('--- ' + key + ' ---\n' + String(d[key]) + '\n');
      }
    }
    if (d.log) {
      process.stderr.write('--- server log (last ' + cell.LOG_TAIL_LINES + ' lines) ---\n' + d.log + '\n');
    }
    return code === 'bad_args' ? 2 : 1;
  }
}

module.exports = {
  APPLE_TEAM_ID,
  COSIGN_IDENTITY_REGEXP,
  COSIGN_OIDC_ISSUER,
  DOWNLOAD_ATTEMPTS,
  InstallError,
  PACKAGES,
  PARADEDB_TAG,
  PG_SEARCH_VERSION,
  PRELOAD_KEY,
  PRELOAD_LIBRARY,
  RELEASE_BASE,
  assertCi,
  assetFor,
  downloadWithRetry,
  ensurePreload,
  httpsDownload,
  install,
  main,
  parseArgs,
  selectPackage,
  sha256File,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
