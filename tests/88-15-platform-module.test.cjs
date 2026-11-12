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
