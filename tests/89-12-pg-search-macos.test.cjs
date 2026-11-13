/**
 * Phase 89 plan 89-12 task 02: `scripts/ci-install-pg-search-macos.cjs`, driven
 * with an INJECTED command runner and an INJECTED downloader.
 *
 * Nothing here downloads, installs or restarts anything, on any cell. The
 * module refuses to act unless `CI` is set, and every case below either
 * exercises a refusal or hands the module fakes and asserts what it WOULD have
 * spawned and fetched. That is how a macOS-only installer is tested on Linux
 * and Windows cells with no network.
 *
 * The last block reads `.github/workflows/test.yml`: a script that is unit
 * tested but never invoked passes every test about it, so the invocation itself
 * is asserted.
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
const SCRIPT = path.join(ROOT, 'scripts', 'ci-install-pg-search-macos.cjs');
const pgs = require(SCRIPT);
const cell = require(path.join(ROOT, 'scripts', 'ci-postgres-cell.cjs'));
const { LIVE_PORTS } = require(path.join(ROOT, 'scripts', 'run-tests.cjs'));

/** A port no live service owns. */
const SAFE_PORT = 54331;

/** The bytes the fake download writes, and their digest. */
const GOOD_BYTES = Buffer.from('a stand-in for the installer package, plan 89-12\n');
const GOOD_SHA = crypto.createHash('sha256').update(GOOD_BYTES).digest('hex');
const BUNDLE_BYTES = Buffer.from('{"a":"stand-in sigstore bundle"}\n');
const BUNDLE_SHA = crypto.createHash('sha256').update(BUNDLE_BYTES).digest('hex');

/** A pin table whose digests this file can actually produce. */
const TEST_PACKAGES = {
  26: { codename: 'tahoe', sha256: GOOD_SHA, bundleSha256: BUNDLE_SHA },
  15: { codename: 'sequoia', sha256: GOOD_SHA, bundleSha256: BUNDLE_SHA },
};

const LIBDIR = '/opt/homebrew/lib/postgresql@17';
const SHAREDIR = '/opt/homebrew/share/postgresql@17';
const BINDIR = '/opt/homebrew/opt/postgresql@17/bin';

/** An environment that looks like a CI cell, without touching process.env. */
function ciEnv(extra = {}) {
  return { CI: 'true', PATH: process.env.PATH || '', ...extra };
}

/** The tool's bare name, from a path in either platform's flavour. */
function baseName(command) {
  return String(command).split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

/**
 * A fresh fake cluster directory: a `postgresql.conf` as `initdb` leaves it
 * (the preload line present only as a comment) and a server log with a
 * sentinel line.
 *
 * @param {string} tag
 * @returns {{dataDir: string, conf: string, workDir: string}}
 */
function fakeCluster(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8912-' + tag + '-'));
  const dataDir = path.join(base, 'pgdata');
  fs.mkdirSync(dataDir);
  const conf = path.join(dataDir, 'postgresql.conf');
  fs.writeFileSync(conf, [
    '# - Shared Library Preloading -',
    "#shared_preload_libraries = ''\t# (change requires restart)",
    'max_connections = 100',
    '',
  ].join('\n'));
  fs.writeFileSync(dataDir + '.log', 'LOG:  earlier line\nFATAL:  SENTINEL-8912 the server said this\n');
  return { dataDir, conf, workDir: path.join(base, 'work') };
}

/**
 * A recording runner that answers like a healthy macOS runner.
 *
 * @param {object} [o]
 * @param {string} [o.productVersion] - what `sw_vers` prints.
 * @param {boolean} [o.cosign] - whether `cosign` exists on the fake runner.
 * @param {object} [o.status] - per-tool exit status overrides, keyed by base name.
 * @param {object} [o.stdout] - per-tool stdout overrides, keyed by base name.
 * @param {string} [o.extversion] - what `pg_extension` reports.
 * @param {string} [o.preloaded] - what `SHOW shared_preload_libraries` reports.
 * @returns {{calls: Array, run: Function}}
 */
function recorder(o = {}) {
  const calls = [];
  const status = o.status || {};
  const stdoutOver = o.stdout || {};
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const base = baseName(command);
    if (base === 'cosign' && !o.cosign) {
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn cosign ENOENT'), { code: 'ENOENT' }) };
    }
    let stdout = '';
    if (base === 'sw_vers') stdout = (o.productVersion || '26.7.2') + '\n';
    else if (base === 'brew') stdout = '/opt/homebrew/opt/postgresql@17\n';
    else if (base === 'pg_config') stdout = (args[0] === '--pkglibdir' ? LIBDIR : SHAREDIR) + '\n';
    else if (base === 'pkgutil') stdout = '   Status: signed by a developer certificate issued by Apple for distribution\n    1. Developer ID Installer: ParadeDB, Inc. (NDJBT4LXCM)\n';
    else if (base === 'psql') {
      const q = String(args[args.length - 1] || '');
      if (q === 'SELECT 1') stdout = '1\n';
      else if (q.includes('SHOW shared_preload_libraries')) stdout = (o.preloaded === undefined ? 'pg_search' : o.preloaded) + '\n';
      else if (q.includes('extversion')) stdout = (o.extversion === undefined ? pgs.PG_SEARCH_VERSION : o.extversion) + '\n';
      else if (q.includes('server_version')) stdout = '17.11 (Homebrew)\n';
    }
    if (Object.prototype.hasOwnProperty.call(stdoutOver, base)) stdout = stdoutOver[base];
    const st = Object.prototype.hasOwnProperty.call(status, base) ? status[base] : 0;
    return { status: st, stdout, stderr: st === 0 ? '' : base + ' failed', signal: null, error: null };
  };
  return { calls, run };
}

/**
 * A recording downloader that writes chosen bytes.
 *
 * @param {object} [o]
 * @param {Buffer} [o.pkg] - bytes for the package URL.
 * @param {Buffer} [o.bundle] - bytes for the bundle URL.
 * @returns {{urls: string[], download: Function}}
 */
function downloader(o = {}) {
  const urls = [];
  const download = async (url, dest) => {
    urls.push(url);
    fs.writeFileSync(dest, url.endsWith('.cosign.bundle') ? (o.bundle || BUNDLE_BYTES) : (o.pkg || GOOD_BYTES));
  };
  return { urls, download };
}

/**
 * Drive `install()` end to end with fakes.
 *
 * @param {object} [o] - recorder options, plus `cluster`, `download`, `exists`, `env`, `platform`, `arch`, `port`.
 * @returns {Promise<{calls: Array, urls: string[], out: string[], result: object, cluster: object}>}
 */
async function drive(o = {}) {
  const rec = o.rec || recorder(o);
  const dl = o.dl || downloader(o);
  const cluster = o.cluster || fakeCluster('drive');
  const out = [];
  const promise = pgs.install({
    port: o.port === undefined ? SAFE_PORT : o.port,
    dataDir: cluster.dataDir,
    workDir: cluster.workDir,
    platform: o.platform || 'darwin',
    arch: o.arch || 'arm64',
    env: o.env || ciEnv(),
    run: rec.run,
    download: dl.download,
    pause: () => {},
    out: (s) => out.push(s),
    packages: o.packages || TEST_PACKAGES,
    exists: o.exists || (() => true),
    readyTimeoutS: 2,
  });
  const result = await promise;
  return { calls: rec.calls, urls: dl.urls, out, result, cluster };
}

/** The calls whose tool has this base name. */
function callsTo(calls, base) {
  return calls.filter((c) => baseName(c.command) === base);
}

/** Whether any recorded call would have run the system installer. */
function installerCalled(calls) {
  return calls.some((c) => c.args.includes('installer') || baseName(c.command) === 'installer');
}

/** Active (uncommented) preload assignments in a conf file. */
function activePreloadLines(conf) {
  return fs.readFileSync(conf, 'utf8').split('\n')
    .filter((l) => /^[ \t]*shared_preload_libraries[ \t]*=/.test(l));
}

describe('89-12 pg_search on macOS: the pins', () => {
  test('the release tag, the version and both digests are fixed constants', () => {
    assert.strictEqual(pgs.PARADEDB_TAG, 'v0.26.6');
    assert.strictEqual(pgs.PG_SEARCH_VERSION, '0.26.6');
    assert.deepStrictEqual(Object.keys(pgs.PACKAGES).sort(), ['15', '26']);
    for (const [major, pin] of Object.entries(pgs.PACKAGES)) {
      assert.match(pin.sha256, /^[0-9a-f]{64}$/, 'package digest for macOS ' + major);
      assert.match(pin.bundleSha256, /^[0-9a-f]{64}$/, 'bundle digest for macOS ' + major);
      assert.notStrictEqual(pin.sha256, pin.bundleSha256);
    }
    assert.strictEqual(pgs.PACKAGES[26].codename, 'tahoe');
    assert.strictEqual(pgs.PACKAGES[15].codename, 'sequoia');
    assert.notStrictEqual(pgs.PACKAGES[26].sha256, pgs.PACKAGES[15].sha256);
    assert.ok(Object.isFrozen(pgs.PACKAGES) && Object.isFrozen(pgs.PACKAGES[26]),
      'the pin table must not be mutable at run time');
  });

  test('the URL is the exact release asset, on the release host, for the cluster major', () => {
    const a = pgs.assetFor(cell.PG_MAJOR, 'tahoe');
    assert.strictEqual(a.name, 'pg_search@17--0.26.6.arm64_tahoe.pkg');
    assert.strictEqual(a.url,
      'https://github.com/paradedb/paradedb/releases/download/v0.26.6/pg_search%4017--0.26.6.arm64_tahoe.pkg');
    assert.strictEqual(a.bundleUrl, a.url + '.cosign.bundle');
  });

  test('the macOS major picks the package, and an unknown major refuses', () => {
    assert.strictEqual(pgs.selectPackage('26.7.2').codename, 'tahoe');
    assert.strictEqual(pgs.selectPackage('15.6\n').codename, 'sequoia');
    for (const v of ['14.7.1', '27.0', '', 'garbage']) {
      assert.throws(() => pgs.selectPackage(v), (e) => e.code === 'unpinned_macos', 'macOS ' + v);
    }
  });
});

describe('89-12 pg_search on macOS: the refusals', () => {
  test('refuses when CI is unset, names CI, and touches nothing', async () => {
    const rec = recorder();
    const dl = downloader();
    for (const env of [{ PATH: '/usr/bin' }, { CI: '' }, { CI: 'false' }, { CI: '0' }]) {
      await assert.rejects(
        drive({ rec, dl, env }),
        (e) => e.code === 'not_ci' && /\bCI\b/.test(e.message),
      );
    }
    assert.deepStrictEqual(rec.calls, [], 'nothing may be spawned outside CI');
    assert.deepStrictEqual(dl.urls, [], 'nothing may be downloaded outside CI');
  });

  test('the command line itself exits non-zero outside CI, before reading its arguments', () => {
    const env = { ...process.env };
    delete env.CI;
    delete env.GSD_CI_PG_ALLOW_LOCAL;
    for (const argv of [[], ['--port', String(SAFE_PORT)], ['--no-such-flag']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...argv], { env, encoding: 'utf8' });
      assert.strictEqual(r.status, 1, 'argv ' + JSON.stringify(argv) + ' -> ' + r.stderr);
      assert.match(r.stderr, /\[not_ci\]/);
      assert.match(r.stderr, /\bCI\b/);
    }
  });

  test('refuses off Apple-silicon macOS before spawning anything', async () => {
    for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'x64'], ['linux', 'arm64']]) {
      const rec = recorder();
      const dl = downloader();
      await assert.rejects(drive({ rec, dl, platform, arch }), (e) => e.code === 'unsupported_platform');
      assert.deepStrictEqual(rec.calls, []);
      assert.deepStrictEqual(dl.urls, []);
    }
  });

  test('every live port is refused before spawning anything', async () => {
    for (const port of LIVE_PORTS) {
      const rec = recorder();
      await assert.rejects(drive({ rec, port }), (e) => e.code === 'live_port', 'port ' + port);
      assert.deepStrictEqual(rec.calls, []);
    }
  });

  test('a macOS major with no pinned package downloads nothing and installs nothing', async () => {
    const rec = recorder({ productVersion: '14.7.1' });
    const dl = downloader();
    await assert.rejects(drive({ rec, dl }), (e) => e.code === 'unpinned_macos' && /14\.7\.1/.test(e.message));
    assert.deepStrictEqual(dl.urls, []);
    assert.strictEqual(installerCalled(rec.calls), false);
  });

  test('a digest mismatch refuses: no installer argv, the file is deleted, the conf is untouched', async () => {
    const rec = recorder();
    const dl = downloader({ pkg: Buffer.from('not the pinned bytes') });
    const cluster = fakeCluster('mismatch');
    const before = fs.readFileSync(cluster.conf, 'utf8');
    let caught = null;
    await assert.rejects(drive({ rec, dl, cluster }), (e) => {
      caught = e;
      return e.code === 'digest_mismatch';
    });
    assert.strictEqual(caught.detail.expected, GOOD_SHA);
    assert.match(caught.detail.actual, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(caught.detail.actual, GOOD_SHA);
    assert.strictEqual(installerCalled(rec.calls), false, 'no install argv may be constructed');
    assert.deepStrictEqual(callsTo(rec.calls, 'pkgutil'), [], 'a mismatch stops before the signature check');
    assert.deepStrictEqual(callsTo(rec.calls, 'pg_ctl'), [], 'no restart after a mismatch');
    assert.deepStrictEqual(fs.readdirSync(cluster.workDir), [], 'the refused download must not be left on disk');
    assert.strictEqual(fs.readFileSync(cluster.conf, 'utf8'), before);
  });

  test('the REAL pin refuses stand-in bytes (the production table is what the script uses)', async () => {
    const rec = recorder();
    await assert.rejects(
      drive({ rec, packages: pgs.PACKAGES }),
      (e) => e.code === 'digest_mismatch' && e.detail.expected === pgs.PACKAGES[26].sha256,
    );
    assert.strictEqual(installerCalled(rec.calls), false);
  });

  test('a package Apple does not confirm, or signed by another team, is not installed', async () => {
    for (const o of [
      { status: { pkgutil: 1 } },
      { stdout: { pkgutil: '   Status: no signature\n' } },
      { stdout: { pkgutil: '    1. Developer ID Installer: Somebody Else (ABCDE12345)\n' } },
    ]) {
      const rec = recorder(o);
      await assert.rejects(drive({ rec }), (e) => e.code === 'signature_failed');
      assert.strictEqual(installerCalled(rec.calls), false);
    }
  });

  test('files outside the directories this cluster reads are a refusal, not a silent fallback', async () => {
    const rec = recorder();
    const cluster = fakeCluster('prefix');
    const before = fs.readFileSync(cluster.conf, 'utf8');
    await assert.rejects(
      drive({ rec, cluster, exists: (f) => !f.endsWith('pg_search.dylib') }),
      (e) => e.code === 'not_in_prefix' && e.detail.missing === LIBDIR + '/pg_search.dylib',
    );
    assert.deepStrictEqual(callsTo(rec.calls, 'pg_ctl'), []);
    assert.strictEqual(fs.readFileSync(cluster.conf, 'utf8'), before);
  });

  test('a server that comes back without the preload, or with another version, fails the step', async () => {
    await assert.rejects(drive({ preloaded: '' }), (e) => e.code === 'not_preloaded');
    await assert.rejects(drive({ extversion: '0.22.6' }), (e) => e.code === 'wrong_version');
    await assert.rejects(drive({ extversion: '' }), (e) => e.code === 'wrong_version');
  });
});

describe('89-12 pg_search on macOS: what it spawns and fetches', () => {
  test('the order: identify, locate, download, verify, install, preload, restart, prove', async () => {
    const { calls, urls, result, out } = await drive();
    const names = calls.map((c) => baseName(c.command));
    const first = (n) => names.indexOf(n);
    assert.strictEqual(names[0], 'sw_vers');
    assert.deepStrictEqual(calls[0].args, ['-productVersion']);
    assert.ok(first('brew') < first('pg_config'));
    assert.ok(first('pg_config') < first('pkgutil'));
    assert.ok(first('pkgutil') < first('sudo'));
    assert.ok(first('sudo') < first('pg_ctl'));
    assert.ok(first('pg_ctl') < first('psql'));
    assert.deepStrictEqual(urls, [pgs.assetFor('17', 'tahoe').url], 'one download, the pinned asset');
    assert.strictEqual(result.sha256, GOOD_SHA);
    assert.strictEqual(result.extversion, '0.26.6');
    assert.strictEqual(result.cosign, 'skipped: cosign is not on this runner');
    assert.ok(out.some((l) => /cosign bundle skipped/.test(l)), 'the output must say the bundle was not verified');
    assert.ok(out.some((l) => l.includes('sha256 ' + GOOD_SHA + ' matches the pin')));
  });

  test('the sequoia runner fetches the sequoia asset', async () => {
    const { urls } = await drive({ productVersion: '15.7.3' });
    assert.deepStrictEqual(urls, [pgs.assetFor('17', 'sequoia').url]);
  });

  test('the verify argv', async () => {
    const { calls, cluster } = await drive();
    const pkg = path.join(cluster.workDir, 'pg_search@17--0.26.6.arm64_tahoe.pkg');
    assert.deepStrictEqual(callsTo(calls, 'pkgutil').map((c) => c.args), [['--check-signature', pkg]]);
  });

  test('the install argv: non-interactive, the verified file, the root volume', async () => {
    const { calls, cluster } = await drive();
    const pkg = path.join(cluster.workDir, 'pg_search@17--0.26.6.arm64_tahoe.pkg');
    const sudo = callsTo(calls, 'sudo');
    assert.strictEqual(sudo.length, 1);
    assert.deepStrictEqual(sudo[0].args, ['-n', 'installer', '-pkg', pkg, '-target', '/']);
  });

  test('the restart argv: the same data directory and log, waited for, never given a pipe', async () => {
    const { calls, cluster } = await drive();
    const ctl = callsTo(calls, 'pg_ctl');
    assert.strictEqual(ctl.length, 1);
    assert.strictEqual(ctl[0].command, BINDIR + '/pg_ctl');
    assert.deepStrictEqual(ctl[0].args,
      ['-D', cluster.dataDir, '-l', cluster.dataDir + '.log', '-w', '-t', '90', 'restart']);
    const stdio = ctl[0].options.stdio;
    assert.strictEqual(stdio[0], 'ignore');
    assert.strictEqual(typeof stdio[1], 'number', 'stdout must be a file descriptor');
    assert.strictEqual(stdio[1], stdio[2]);
  });

  test('the proof after the restart goes over TCP to the given port, as the gsd role', async () => {
    const { calls } = await drive();
    const psql = callsTo(calls, 'psql');
    const queries = psql.map((c) => c.args[c.args.length - 1]);
    assert.deepStrictEqual(queries, [
      'SELECT 1',
      'SHOW shared_preload_libraries',
      'CREATE EXTENSION IF NOT EXISTS pg_search CASCADE',
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_search'",
      'SHOW server_version',
    ]);
    for (const c of psql) {
      assert.deepStrictEqual(c.args.slice(0, 6), ['-h', '127.0.0.1', '-p', String(SAFE_PORT), '-U', cell.ROLE]);
      assert.strictEqual(c.options.env.PGPASSWORD, cell.PASSWORD, 'the password travels in the environment');
      assert.ok(!c.args.some((a) => String(a).includes(cell.PASSWORD + '@')), 'never on the command line');
    }
  });

  test('with cosign on the runner the bundle is fetched, pinned and verified BEFORE the installer', async () => {
    const { calls, urls, result, cluster } = await drive({ cosign: true });
    const a = pgs.assetFor('17', 'tahoe');
    const pkg = path.join(cluster.workDir, a.name);
    assert.deepStrictEqual(urls, [a.url, a.bundleUrl]);
    const cosign = callsTo(calls, 'cosign');
    assert.deepStrictEqual(cosign[0].args, ['version']);
    assert.deepStrictEqual(cosign[1].args, ['verify-blob', '--bundle', pkg + '.cosign.bundle',
      '--certificate-identity-regexp', '^https://github.com/paradedb/paradedb/',
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', pkg]);
    const names = calls.map((c) => baseName(c.command));
    assert.ok(names.lastIndexOf('cosign') < names.indexOf('sudo'));
    assert.strictEqual(result.cosign, 'verified');
  });

  test('a cosign refusal, or a bundle that is not the pinned one, installs nothing', async () => {
    const rec = recorder({ cosign: true, status: { cosign: 1 } });
    // `cosign version` also answers 1 here, which is still "present": only a
    // missing binary means absent, so the verification is attempted and fails.
    await assert.rejects(drive({ rec }), (e) => e.code === 'cosign_failed');
    assert.strictEqual(installerCalled(rec.calls), false);

    const rec2 = recorder({ cosign: true });
    const dl2 = downloader({ bundle: Buffer.from('another bundle') });
    await assert.rejects(drive({ rec: rec2, dl: dl2 }), (e) => e.code === 'digest_mismatch');
    assert.strictEqual(installerCalled(rec2.calls), false);
  });

  test('no call asks for a command interpreter, and no argument carries a metacharacter', async () => {
    const { calls } = await drive({ cosign: true });
    assert.ok(calls.length >= 12);
    for (const c of calls) {
      assert.ok(!c.options || !c.options.shell, baseName(c.command) + ' was given a shell option');
      assert.ok(Array.isArray(c.args), 'arguments are always an array, never one string');
      for (const a of c.args) {
        assert.doesNotMatch(String(a), /[;&|`<>\n]|\$\(/, baseName(c.command) + ' argument ' + JSON.stringify(a));
      }
      assert.doesNotMatch(String(c.command), /\s/, 'the tool is one path, not a command line');
    }
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /shell:\s*true/);
    assert.doesNotMatch(src, /execSync\(|child_process/);
  });
});

describe('89-12 pg_search on macOS: the conf edit', () => {
  test('initdb\'s commented default is left alone and one active line is appended', () => {
    const { conf } = fakeCluster('append');
    assert.strictEqual(pgs.ensurePreload(conf), 'appended');
    assert.deepStrictEqual(activePreloadLines(conf), ["shared_preload_libraries = 'pg_search'"]);
    assert.ok(fs.readFileSync(conf, 'utf8').includes("#shared_preload_libraries = ''"));
    assert.ok(fs.readFileSync(conf, 'utf8').includes('max_connections = 100'));
  });

  test('a second and a third run change nothing: exactly one line', () => {
    const { conf } = fakeCluster('idem');
    pgs.ensurePreload(conf);
    const once = fs.readFileSync(conf, 'utf8');
    assert.strictEqual(pgs.ensurePreload(conf), 'unchanged');
    assert.strictEqual(pgs.ensurePreload(conf), 'unchanged');
    assert.strictEqual(fs.readFileSync(conf, 'utf8'), once);
    assert.strictEqual(activePreloadLines(conf).length, 1);
    assert.strictEqual(once.split('pg_search').length - 1, 1);
  });

  test('the whole installer run twice against one cluster still leaves exactly one line', async () => {
    const cluster = fakeCluster('twice');
    const a = await drive({ cluster });
    const b = await drive({ cluster });
    assert.strictEqual(a.result.edit, 'appended');
    assert.strictEqual(b.result.edit, 'unchanged');
    assert.deepStrictEqual(activePreloadLines(cluster.conf), ["shared_preload_libraries = 'pg_search'"]);
  });

  test('an existing active list keeps its libraries and gains pg_search once', () => {
    const { conf } = fakeCluster('merge');
    fs.appendFileSync(conf, "shared_preload_libraries = 'pg_stat_statements, auto_explain'  # ours\n");
    assert.strictEqual(pgs.ensurePreload(conf), 'merged');
    assert.deepStrictEqual(activePreloadLines(conf),
      ["shared_preload_libraries = 'pg_stat_statements,auto_explain,pg_search'"]);
    assert.strictEqual(pgs.ensurePreload(conf), 'unchanged');
  });

  test('a file with no trailing newline does not get the line glued to its last setting', () => {
    const { conf } = fakeCluster('nonl');
    fs.writeFileSync(conf, 'max_connections = 100');
    pgs.ensurePreload(conf);
    assert.strictEqual(fs.readFileSync(conf, 'utf8'),
      "max_connections = 100\nshared_preload_libraries = 'pg_search'\n");
  });

  test('a missing conf is a named failure that says the bring-up comes first', () => {
    assert.throws(() => pgs.ensurePreload(path.join(os.tmpdir(), 'gsd-8912-absent', 'postgresql.conf')),
      (e) => e.code === 'no_conf' && /after the bring-up/.test(e.message));
  });
});

describe('89-12 pg_search on macOS: failures carry the evidence', () => {
  test('a failed restart reports the server log tail', async () => {
    const rec = recorder({ status: { pg_ctl: 1 } });
    await assert.rejects(drive({ rec }), (e) => e.code === 'restart_failed'
      && /SENTINEL-8912/.test(e.detail.log));
  });

  test('a failed installer and a failed CREATE EXTENSION report it too', async () => {
    await assert.rejects(drive({ status: { sudo: 1 } }),
      (e) => e.code === 'installer_failed' && /SENTINEL-8912/.test(e.detail.log));
    const rec = recorder();
    const inner = rec.run;
    rec.run = (command, args, options) => {
      const r = inner(command, args, options);
      if (String(args[args.length - 1]).startsWith('CREATE EXTENSION')) return { ...r, status: 3, stderr: 'ERROR:  could not load library' };
      return r;
    };
    await assert.rejects(drive({ rec }), (e) => e.code === 'create_extension_failed'
      && /could not load library/.test(e.detail.stderr) && /SENTINEL-8912/.test(e.detail.log));
  });

  test('a server that never answers after the restart is not_ready, with the log', async () => {
    const rec = recorder();
    const inner = rec.run;
    rec.run = (command, args, options) => {
      const r = inner(command, args, options);
      if (args[args.length - 1] === 'SELECT 1') return { ...r, status: 2, stdout: '', stderr: 'connection refused' };
      return r;
    };
    await assert.rejects(drive({ rec }), (e) => e.code === 'not_ready' && /SENTINEL-8912/.test(e.detail.log));
  });

  test('main() exits 1 and prints the log tail on stderr', async () => {
    const cluster = fakeCluster('main');
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    let code;
    try {
      // CI is set and the platform is whatever this cell is. On a macOS cell the
      // port is a live one, so the run stops at the port refusal; elsewhere it
      // stops at the platform refusal. Neither reaches a spawn.
      code = await pgs.main(['--port', '5433', '--data-dir', cluster.dataDir], ciEnv());
    } finally {
      process.stderr.write = original;
    }
    assert.strictEqual(code, 1);
    const text = written.join('');
    assert.match(text, /FAILED \[(unsupported_platform|live_port)\]/);
  });

  test('main() answers 2 and the usage for a bad argument, inside CI', async () => {
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    let code;
    try {
      code = await pgs.main(['--no-such-flag'], ciEnv());
    } finally {
      process.stderr.write = original;
    }
    assert.strictEqual(code, 2);
    assert.match(written.join(''), /Usage:/);
  });
});

describe('89-12 pg_search on macOS: the download', () => {
  test('a transport failure is retried, with a growing wait, and the attempt is reported', async () => {
    const pauses = [];
    let n = 0;
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8912-dl-')), 'f');
    const attempt = await pgs.downloadWithRetry(async (_url, d) => {
      n += 1;
      if (n < 3) throw new Error('socket hang up');
      fs.writeFileSync(d, 'x');
    }, 'https://example.invalid/f', dest, { pause: (ms) => pauses.push(ms), out: () => {} });
    assert.strictEqual(attempt, 3);
    assert.deepStrictEqual(pauses, [2000, 4000]);
  });

  test('it gives up after the bounded number of attempts with a typed error', async () => {
    let n = 0;
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8912-dl-')), 'f');
    await assert.rejects(pgs.downloadWithRetry(async () => {
      n += 1;
      throw new Error('HTTP 503');
    }, 'https://example.invalid/f', dest, { pause: () => {}, out: () => {} }),
    (e) => e.code === 'download_failed' && /HTTP 503/.test(e.message));
    assert.strictEqual(n, pgs.DOWNLOAD_ATTEMPTS);
  });

  test('a URL that is not https is refused without opening a socket', async () => {
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-8912-dl-')), 'f');
    await assert.rejects(pgs.httpsDownload('http://example.invalid/f', dest), /non-https/);
    assert.strictEqual(fs.existsSync(dest), false);
  });
});
