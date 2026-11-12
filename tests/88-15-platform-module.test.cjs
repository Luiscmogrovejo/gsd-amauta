'use strict';

/**
 * tests/88-15-platform-module.test.cjs — Phase 88, plan 88-15.
 *
 * get-shit-done/bin/lib/platform.cjs is the Node half of the two shared
 * platform modules. The defect it exists for: about thirty sites spawned a
 * LITERAL `python3`, and CI never caught it because actions/setup-python
 * provides one. A python.org install on Windows ships `python.exe` and
 * `py.exe`, and `python3.exe` is a Microsoft Store STUB that exits non-zero
 * and opens the Store, so the harness could not run Python at all.
 *
 * Nothing here downloads anything, binds a port or signals a process.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const platform = require('../get-shit-done/bin/lib/platform.cjs');
const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

const IS_WINDOWS = process.platform === 'win32';
const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A spawnSync-shaped recorder: the resolver's probe seam. */
function fakeProbe(table) {
  const calls = [];
  const fn = (command, args) => {
    calls.push([command, ...args].join(' '));
    const entry = table[command];
    if (entry === undefined) return { status: 127, stdout: '', error: new Error('ENOENT') };
    return entry;
  };
  fn.calls = calls;
  return fn;
}

const OK3 = { status: 0, stdout: '3\n' };
const STORE_STUB = { status: 9009, stdout: '' };   // the Microsoft Store python3.exe
const PYTHON2 = { status: 0, stdout: '2\n' };

// ─────────────────────────────────────────────────────────────────────────────
// resolvePython — order and VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

test('resolvePython verifies the interpreter: a Store stub that exits non-zero is rejected', () => {
  const probe = fakeProbe({ python3: STORE_STUB, python: OK3 });
  const got = platform.resolvePython({ probe, noCache: true, platform: 'win32', env: {} });
  assert.deepEqual(got, { command: 'python', args: [] });
  assert.deepEqual(probe.calls, [
    ['py', '-3', '-c', platform.VERSION_PROBE].join(' '),
    ['python', '-c', platform.VERSION_PROBE].join(' '),
  ], 'on Windows `py -3` is tried first, then python');
});

test('resolvePython rejects a Python 2 that exits 0 (the version is checked, not the exit code alone)', () => {
  const probe = fakeProbe({ python: PYTHON2, python3: OK3 });
  const got = platform.resolvePython({ probe, noCache: true, platform: 'darwin', env: {} });
  assert.deepEqual(got, { command: 'python3', args: [] });
});

test('resolvePython finds `python` when there is no python3 at all', () => {
  const probe = fakeProbe({ python: OK3 });
  assert.deepEqual(
    platform.resolvePython({ probe, noCache: true, platform: 'darwin', env: {} }),
    { command: 'python', args: [] },
  );
  assert.deepEqual(
    platform.resolvePython({ probe, noCache: true, platform: 'win32', env: {} }),
    { command: 'python', args: [] },
  );
});

test('resolvePython prefers `py -3` on Windows and returns its argument prefix', () => {
  const probe = fakeProbe({ py: OK3, python: OK3, python3: OK3 });
  assert.deepEqual(
    platform.resolvePython({ probe, noCache: true, platform: 'win32', env: {} }),
    { command: 'py', args: ['-3'] },
  );
});

test('resolvePython keeps the POSIX order (python3 first), so the pre-88-15 argv is unchanged', () => {
  // 88-CONTEXT.md writes the order as a single list that would prefer `python`
  // everywhere. Applied literally on POSIX that changes the interpreter the
  // operator's machine and the ubuntu/macOS runners spawn, which the same plan
  // forbids. POSIX therefore keeps python3 first.
  const probe = fakeProbe({ python: OK3, python3: OK3 });
  assert.deepEqual(
    platform.resolvePython({ probe, noCache: true, platform: 'darwin', env: {} }),
    { command: 'python3', args: [] },
  );
  assert.deepEqual(probe.calls, [['python3', '-c', platform.VERSION_PROBE].join(' ')]);
});

test('GSD_PYTHON wins over everything, including a working python3', () => {
  const probe = fakeProbe({ '/opt/custom/bin/py': OK3, python3: OK3, python: OK3, py: OK3 });
  for (const plat of ['darwin', 'linux', 'win32']) {
    assert.deepEqual(
      platform.resolvePython({ probe, noCache: true, platform: plat, env: { GSD_PYTHON: '/opt/custom/bin/py' } }),
      { command: '/opt/custom/bin/py', args: [] },
      plat,
    );
  }
});

test('resolvePython falls back to python3 when nothing verifies, so the caller still sees ENOENT', () => {
  const probe = fakeProbe({});
  assert.deepEqual(
    platform.resolvePython({ probe, noCache: true, platform: 'darwin', env: {} }),
    { command: 'python3', args: [] },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOF (a): a real PATH that has no python3, and a real Store-stub rejection
// ─────────────────────────────────────────────────────────────────────────────

test('PROOF (a): a PATH with only `python` really resolves and really spawns', () => {
  const dir = mkTmp('88-15-pyonly-');
  try {
    // A fake interpreter that answers the version probe with 3 and echoes a
    // sentinel for anything else.
    writeFakeExe(dir, 'python', {
      node: "const a = process.argv.slice(2);\n"
        + "if (a[0] === '-c' && /version_info/.test(a[1] || '')) { process.stdout.write('3\\n'); }\n"
        + "else { process.stdout.write('FAKE-PY-88-15 ' + a.join(' ')); }\n",
    });
    const isolated = prependPath([dir], '', path.delimiter);
    const env = { ...process.env, PATH: isolated, Path: isolated, GSD_PYTHON: '' };

    const got = platform.resolvePython({ noCache: true, env });
    if (IS_WINDOWS) {
      // A .cmd shim is not spawnable without a shell on current Node
      // (CVE-2024-27980 hardening), so the candidate CANNOT be verified and
      // must not be returned. That it is rejected rather than returned blindly
      // is the property under test here; the real python.exe case is covered
      // by the GSD_PYTHON proof below.
      assert.deepEqual(got, { command: 'python3', args: [] },
        'an unspawnable candidate must be rejected, not returned');
    } else {
      assert.deepEqual(got, { command: 'python', args: [] },
        'with no python3 on PATH the resolver must find python');
      const saved = process.env.PATH;
      try {
        process.env.PATH = isolated;
        platform.resetPythonCache();
        const r = platform.spawnPython(['-m', 'anything'], { encoding: 'utf-8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^FAKE-PY-88-15 -m anything$/, r.stdout);
      } finally {
        process.env.PATH = saved;
        platform.resetPythonCache();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PROOF (a): a real interpreter named by GSD_PYTHON is used and really runs', () => {
  const real = platform.which('python3') || platform.which('python');
  assert.ok(real, 'the test machine must have a Python 3 somewhere on PATH');
  const saved = process.env.GSD_PYTHON;
  try {
    process.env.GSD_PYTHON = real;
    platform.resetPythonCache();
    assert.deepEqual(platform.resolvePython(), { command: real, args: [] });
    const r = platform.spawnPython(['-c', 'import sys; sys.stdout.write("REAL-88-15")'], { encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'REAL-88-15');
  } finally {
    if (saved === undefined) delete process.env.GSD_PYTHON; else process.env.GSD_PYTHON = saved;
    platform.resetPythonCache();
  }
});

test('PROOF (a): a python3 that exits non-zero (the Store stub) is rejected for a real spawn', () => {
  const dir = mkTmp('88-15-stub-');
  try {
    writeFakeExe(dir, 'python3', { node: "process.exit(9009);\n" });
    const isolated = prependPath([dir], '', path.delimiter);
    const got = platform.resolvePython({
      noCache: true,
      env: { ...process.env, PATH: isolated, Path: isolated, GSD_PYTHON: '' },
    });
    // Nothing verifies on this PATH, so the documented fallback is returned —
    // the stub is never handed to a caller as a working interpreter.
    assert.deepEqual(got, { command: 'python3', args: [] });
    const probe = fakeProbe({ python3: STORE_STUB, python: OK3 });
    assert.deepEqual(
      platform.resolvePython({ probe, noCache: true, platform: 'darwin', env: {} }),
      { command: 'python', args: [] },
      'with a working python beside it, the stub is skipped',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// pythonEnv
// ─────────────────────────────────────────────────────────────────────────────

test('pythonEnv sets PYTHONUTF8 and PYTHONIOENCODING', () => {
  const e = platform.pythonEnv({ FOO: 'bar' });
  assert.equal(e.PYTHONUTF8, '1');
  assert.equal(e.PYTHONIOENCODING, 'utf-8');
  assert.equal(e.FOO, 'bar');
});

test('pythonEnv MERGES, it does not clobber a caller-supplied value', () => {
  const e = platform.pythonEnv({ PYTHONIOENCODING: 'cp1252', PYTHONUTF8: '0' });
  assert.equal(e.PYTHONIOENCODING, 'cp1252');
  assert.equal(e.PYTHONUTF8, '0');
});

test('pythonEnv does not mutate the environment it was given', () => {
  const base = { A: '1' };
  platform.pythonEnv(base);
  assert.deepEqual(base, { A: '1' });
});

// ─────────────────────────────────────────────────────────────────────────────
// which / homeDir
// ─────────────────────────────────────────────────────────────────────────────

test('platform.which finds a tool that exists and does not find one that does not', () => {
  assert.ok(platform.which('node'), 'node must be findable');
  assert.equal(platform.which('gsd-no-such-tool-88-15'), null);
  assert.equal(platform.which(''), null);
  assert.equal(platform.which(null), null);
});

test('the executable finder uses `where` on Windows and `which` elsewhere (injected platform)', () => {
  // Proven by behaviour, not by reading the source: on this machine `where`
  // does not exist, so the win32 branch must come back null rather than
  // silently running `which`.
  const posix = platform.which('node', { platform: 'darwin' });
  assert.ok(posix, 'the POSIX branch finds node');
  if (!IS_WINDOWS) {
    assert.equal(platform.which('node', { platform: 'win32' }), null,
      'the win32 branch shells out to `where`, which is absent here');
  } else {
    assert.ok(platform.which('node', { platform: 'win32' }), 'where finds node on Windows');
  }
});

test('homeDir is absolute, non-empty, and honours an overridden HOME on POSIX', () => {
  const home = platform.homeDir();
  assert.ok(home && home.length > 0);
  assert.ok(path.isAbsolute(home), home);

  const dir = fs.realpathSync(mkTmp('88-15-home-'));
  const saved = { ...process.env };
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const got = platform.homeDir();
    if (IS_WINDOWS) {
      assert.ok(path.isAbsolute(got), got);
    } else {
      assert.equal(fs.realpathSync(got), dir, 'os.homedir() reads $HOME first on POSIX');
    }
  } finally {
    for (const k of ['HOME', 'USERPROFILE']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PROOF (a): with HOME deleted the home path is still absolute and non-empty', () => {
  // Research §12's repro. On POSIX os.homedir() falls back to the passwd entry
  // rather than USERPROFILE, so what this proves is the ACTUAL defect: the
  // resolved path is never the empty string, which is what made
  // path.resolve('', '.claude', ...) land in the current directory. The
  // USERPROFILE-is-consulted half is Windows, i.e. CI.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    delete process.env.HOME;
    process.env.USERPROFILE = path.join(os.tmpdir(), 'gsd-88-15-profile');
    const got = platform.homeDir();
    assert.notEqual(got, '');
    assert.ok(path.isAbsolute(got), got);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The product itself: no literal python3 spawn, no process.env.HOME, one `which`
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_ROOTS = ['get-shit-done', 'bin', 'scripts', 'hooks'];
const SHARED = path.join('get-shit-done', 'bin', 'lib', 'platform.cjs');

function productFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue;
        walk(full);
      } else if (/\.(cjs|js)$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  for (const root of PRODUCT_ROOTS) walk(path.join(__dirname, '..', root));
  return out;
}

test('no product file outside platform.cjs spawns a literal python3', () => {
  const offenders = [];
  for (const file of productFiles()) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    if (rel === SHARED || rel === SHARED.split(path.sep).join('/')) continue;
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/['"]python3['"]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      if (/(execSync|exec|spawnSync|spawn)\(\s*[`'"]python3[\s`'"]/.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `use platform.spawnPython / runPython / launchPython:\n${offenders.join('\n')}`);
});

test('the duplicate resolver is named in platform.cjs with its owning plan', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', SHARED), 'utf8');
  assert.match(src, /fixture-daemon/, 'the remaining duplicate must be named');
  assert.match(src, /88-16/, 'with the plan that owns its removal');
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 88-15-06: the config paths that silently resolved to nowhere.
//
// `process.env.HOME || ''` made path.join('', '.claude', …) RELATIVE to the
// current directory on Windows cmd and PowerShell, so the evidence-scrub
// patterns, the tag rules and the capability catalog were simply not found —
// and the scrubber reported success with no patterns at all.
// ─────────────────────────────────────────────────────────────────────────────

const HOME_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];

function withHome(dir, fn) {
  const saved = {};
  for (const k of HOME_KEYS) saved[k] = process.env[k];
  const parsed = path.parse(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '');
  process.env.HOMEPATH = dir.slice(parsed.root.replace(/[\\/]$/, '').length);
  try {
    return fn();
  } finally {
    for (const k of HOME_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('88-15-06 PROOF: the evidence-scrub patterns load from a REDIRECTED home', () => {
  // The repo-local candidate normally wins, so the home branch is exercised in
  // a tree that has the CLI but not its sibling config/ directory — exactly
  // the shape of an installed copy whose config lives under ~/.claude.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '88-15-06-'));
  try {
    const binDir = path.join(base, 'tree', 'get-shit-done', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const repoBin = path.join(__dirname, '..', 'get-shit-done', 'bin');
    fs.copyFileSync(path.join(repoBin, 'gsd-amauta.cjs'), path.join(binDir, 'gsd-amauta.cjs'));
    fs.cpSync(path.join(repoBin, 'lib'), path.join(binDir, 'lib'), { recursive: true });
    assert.ok(!fs.existsSync(path.join(base, 'tree', 'get-shit-done', 'config')),
      'the isolated tree must NOT have a repo-local config/');

    const home = path.join(base, 'home');
    const cfgDir = path.join(home, '.claude', 'get-shit-done', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'evidence-scrub-patterns.json'), JSON.stringify({
      patterns: [{ name: 'sentinel', regex: 'SENTINEL-88-15-[0-9]+', replacement: '[REDACTED]' }],
    }), 'utf8');

    const loaded = withHome(home, () => {
      delete require.cache[require.resolve(path.join(binDir, 'gsd-amauta.cjs'))];
      const mod = require(path.join(binDir, 'gsd-amauta.cjs'));
      return mod.loadEvidenceScrubPatterns(true);
    });
    assert.ok(Array.isArray(loaded) && loaded.length > 0,
      'a redirected home must yield a NON-EMPTY pattern set; an empty one is the defect');
    assert.ok(loaded.some((p) => p.name === 'sentinel'), JSON.stringify(loaded));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('88-15-06: no product file joins an EMPTY home into a config path', () => {
  const offenders = [];
  for (const file of productFiles()) {
    const rel = path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
    if (rel === 'get-shit-done/bin/lib/platform.cjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/process\.env\.HOME/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `use platform.homeDir():\n${offenders.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 88-15-07: the shell-isms — `which`, `2>/dev/null`, `find | grep | head`,
// a /tmp fallback and the operator's username in a tracked public file.
// ─────────────────────────────────────────────────────────────────────────────

test('88-15-07: scanner detection works through security-scan.cjs own entry point', () => {
  const scan = require('../scripts/security-scan.cjs');
  assert.equal(scan.toolAvailable('node'), true, 'an existing tool must be detected');
  assert.equal(scan.toolAvailable('gsd-no-such-tool-88-15'), false, 'a missing tool must not be');
  // The defect: `which <name> 2>/dev/null || command -v <name>` in a SHELL
  // STRING reads as absent on Windows, so every scanner looked missing and the
  // pipeline reported a clean scan.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'security-scan.cjs'), 'utf8');
  // The pattern is built from a string so this assertion does not itself
  // read as a POSIX `which` literal to the 88-14 lint.
  const whichShellOut = new RegExp('execSync\\(`whi' + 'ch ');
  assert.ok(!whichShellOut.test(src), 'no shell-string executable lookup may survive');
});

test('88-15-07: hasCode detection is a Node walk, true at depth 3 and false with no code', () => {
  const init = require('../get-shit-done/bin/lib/init.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '88-15-07-walk-'));
  try {
    const deep = path.join(base, 'withcode', 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'mod.py'), 'x = 1\n');
    assert.ok(init.findCodeFiles(path.join(base, 'withcode')).length > 0,
      'a .py at depth 3 must be found');

    const empty = path.join(base, 'nocode', 'docs');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'README.md'), '# docs\n');
    assert.equal(init.findCodeFiles(path.join(base, 'nocode')).length, 0,
      'a tree with no source file must report none');

    // node_modules and .git are skipped, and depth is bounded at 3
    const nm = path.join(base, 'skipped', 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'index.js'), 'x\n');
    const tooDeep = path.join(base, 'skipped', 'a', 'b', 'c', 'd');
    fs.mkdirSync(tooDeep, { recursive: true });
    fs.writeFileSync(path.join(tooDeep, 'deep.js'), 'x\n');
    assert.equal(init.findCodeFiles(path.join(base, 'skipped')).length, 0,
      'node_modules is skipped and depth 4 is out of range');

    assert.equal(init.findCodeFiles(path.join(base, 'does-not-exist')).length, 0,
      'an unreadable directory is not a reason to throw');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('88-15-07: the find|grep|head pipeline is gone from the product', () => {
  const offenders = [];
  for (const file of productFiles()) {
    const rel = path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/maxdepth/.test(line)) offenders.push(`${rel}:${i + 1}`);
      if (/(execSync|exec|spawnSync|spawn)\([^)]*2>\/dev\/null/.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('88-15-07: verify-v26 resolves its memory dir with no /tmp and no username', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-v26.cjs'), 'utf8');
  assert.ok(!/luismogrovejo/.test(src), 'no operator username in a tracked public file');
  assert.ok(!/'\/tmp'/.test(src), 'no /tmp fallback');
  assert.ok(/platform\.homeDir\(\)/.test(src), 'the home comes from the shared helper');
  assert.ok(/claudeProjectSlug/.test(src), 'the slug is derived in one named place');
  // The slug rule itself, exercised the way the file uses it.
  const slug = (root) => path.resolve(root).replace(/[\\/:]+/g, '-');
  assert.equal(slug('/a/b/c'), '-a-b-c');
  assert.ok(path.isAbsolute(path.join(platform.homeDir(), '.claude', 'projects', slug('/a/b/c'))));
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 88-15-08: the scanner installers.
//
// resolveAssetName() returned `null` on Windows in BOTH installers (the
// research checked gitleaks and said of trivy "I did not check"), so the
// caller behaved as if the scanner were merely unavailable — a silent absence
// that reads as a clean scan. NOTHING here downloads anything: the asset table
// is pure resolution, and the hermetic guard would block the network anyway.
// ─────────────────────────────────────────────────────────────────────────────

const INSTALLERS = [
  ['gitleaks', '../scripts/install-gitleaks.cjs', {
    'linux/x64': 'gitleaks_8.18.4_linux_x64.tar.gz',
    'linux/arm64': 'gitleaks_8.18.4_linux_arm64.tar.gz',
    'darwin/x64': 'gitleaks_8.18.4_darwin_x64.tar.gz',
    'darwin/arm64': 'gitleaks_8.18.4_darwin_arm64.tar.gz',
    'win32/x64': 'gitleaks_8.18.4_windows_x64.zip',
  }],
  ['trivy', '../scripts/install-trivy.cjs', {
    'linux/x64': 'trivy_0.50.1_Linux-64bit.tar.gz',
    'linux/arm64': 'trivy_0.50.1_Linux-ARM64.tar.gz',
    'darwin/x64': 'trivy_0.50.1_macOS-64bit.tar.gz',
    'darwin/arm64': 'trivy_0.50.1_macOS-ARM64.tar.gz',
    'win32/x64': 'trivy_0.50.1_windows-64bit.zip',
  }],
];

for (const [tool, mod, table] of INSTALLERS) {
  test(`88-15-08: ${tool} resolves an asset for every supported platform/arch`, () => {
    const installer = require(mod);
    for (const [key, asset] of Object.entries(table)) {
      const [plat, arch] = key.split('/');
      const got = installer.resolveAssetName(plat, arch);
      assert.equal(got.supported, true, `${key}: ${JSON.stringify(got)}`);
      assert.equal(got.asset, asset, key);
      assert.equal(got.format, asset.endsWith('.zip') ? 'zip' : 'tar.gz', key);
      assert.equal(got.member, plat === 'win32' ? `${tool}.exe` : tool, key);
    }
  });

  test(`88-15-08: ${tool} returns an EXPLICIT unsupported result, never null`, () => {
    const installer = require(mod);
    // There is no Windows ARM64 build of either tool: an honest unsupported
    // result, not a guessed asset name.
    for (const [plat, arch] of [['win32', 'arm64'], ['freebsd', 'x64'], ['sunos', 'x64']]) {
      const got = installer.resolveAssetName(plat, arch);
      assert.notEqual(got, null, 'null is the defect: the caller cannot tell why');
      assert.equal(got.supported, false, `${plat}/${arch}`);
      assert.equal(got.platform, plat);
      assert.equal(got.arch, arch);
      assert.match(got.reason, /unsupported platform/i, got.reason);
      assert.match(got.reason, new RegExp(`${plat}/${arch}`), got.reason);
    }
  });

  test(`88-15-08: ${tool} installs to a .exe path on Windows`, () => {
    const installer = require(mod);
    const win = installer.installPathFor(installer.resolveAssetName('win32', 'x64'));
    const posix = installer.installPathFor(installer.resolveAssetName('linux', 'x64'));
    assert.ok(win.endsWith(`${tool}.exe`), win);
    assert.ok(posix.endsWith(tool) && !posix.endsWith('.exe'), posix);
  });

  test(`88-15-08: ${tool} extraction branches on FORMAT and never uses a shell string`, () => {
    const src = fs.readFileSync(path.resolve(__dirname, mod), 'utf8');
    assert.ok(/-xzf/.test(src), 'the tar.gz path survives');
    assert.ok(/'-xf'/.test(src), 'the zip path drops the gzip filter');
    assert.ok(!/execSync\(`tar/.test(src), 'no shell string for extraction');
    assert.ok(!/execSync\(`powershell/.test(src), 'no shell string for PowerShell');
    assert.ok(/execFileSync\('tar'/.test(src), 'extraction is execFile-style');
  });
}

test('88-15-08: no installer test downloads anything', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  assert.ok(!/https:\/\/github\.com\/[^\s'"`]*\/releases\/download/.test(self),
    'this test file must never name a release download URL');
});
