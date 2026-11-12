'use strict';
/**
 * Plan 88-14: unit coverage for the Windows-portability helpers under tests/support/.
 *
 *   - py-embed.cjs   (G2)  paths reach embedded Python through argv or a correct literal
 *   - home-env.cjs   (G7)  HOME, USERPROFILE, HOMEDRIVE and HOMEPATH are set together
 *   - fake-exe.cjs   (G8)  a fake executable is a .cmd shim on Windows; PATH uses path.delimiter
 *
 * Windows itself cannot be run on the machines this suite is developed on, so these tests
 * exercise the CONTENT that breaks there (a backslash path, a path with a space, a path that
 * contains an apostrophe) rather than the platform. A raw interpolation of such a value into
 * Python source is demonstrated to be wrong first, so the fix is shown to be load-bearing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pyLiteral, pyArgs } = require('./support/py-embed.cjs');
const { homeEnv, applyHomeEnv, HOME_VARS } = require('./support/home-env.cjs');
const { writeFakeExe, prependPath } = require('./support/fake-exe.cjs');

/** Python bytes of stdout, decoded as UTF-8, so the check is independent of the console code page. */
function runPy(argv, baseEnv = process.env) {
  return execFileSync('python3', argv, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...baseEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeout: 15000,
  }).toString('utf8');
}

const WRITE_EXPR = (expr) => `import sys; sys.stdout.buffer.write((${expr}).encode('utf-8'))`;

const AWKWARD_VALUES = [
  'D:\\a\\b\\gsd',
  'D:\\a\\gsd-amauta\\gsd-amauta\\services',
  'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x y\\U0001F600\\g',
  "srv/it's a \"quoted\" dir/with space",
  'tab\there\nnewline',
  'unicode \u00e9\u4e2d\ud83d\ude00',
];

describe('[88-14] py-embed: pyLiteral', () => {
  it('a raw interpolation of a Windows path is NOT the path (the defect this helper removes)', () => {
    // Python source `'D:\a\b\gsd'` has a BEL (\a) in it, so it is not the original string.
    const raw = `'D:\\a\\b\\gsd'`;
    const got = runPy(['-c', WRITE_EXPR(raw)]);
    assert.notEqual(got, 'D:\\a\\b\\gsd');
    assert.ok(got.includes('\u0007'), 'the \\a escape became a BEL character');
  });

  it('pyLiteral round-trips D:\\a\\b\\gsd exactly', () => {
    const got = runPy(['-c', WRITE_EXPR(pyLiteral('D:\\a\\b\\gsd'))]);
    assert.equal(got, 'D:\\a\\b\\gsd');
  });

  it('pyLiteral round-trips awkward strings (space, quotes, \\U, newline, non-BMP)', () => {
    for (const value of AWKWARD_VALUES) {
      const got = runPy(['-c', WRITE_EXPR(pyLiteral(value))]);
      assert.equal(got, value, `round trip failed for ${JSON.stringify(value)}`);
    }
  });

  it('pyLiteral maps true/false/null to True/False/None and keeps strings untouched', () => {
    assert.equal(pyLiteral(true), 'True');
    assert.equal(pyLiteral(false), 'False');
    assert.equal(pyLiteral(null), 'None');
    assert.equal(pyLiteral('true'), '"true"');
    assert.equal(pyLiteral({ ok: true, none: null, list: [1, 2.5, 'null'] }),
      '{"ok": True, "none": None, "list": [1, 2.5, "null"]}');
    // and Python agrees: the literal evaluates to the same structure
    const out = runPy(['-c', WRITE_EXPR(`repr(${pyLiteral({ ok: true, none: null, list: [1, 'null'] })})`)]);
    assert.equal(out, "{'ok': True, 'none': None, 'list': [1, 'null']}");
  });

  it('pyLiteral rejects a lone surrogate instead of emitting broken source', () => {
    assert.throws(() => pyLiteral('abc\ud800def'), RangeError);
    assert.throws(() => pyLiteral('\udc00'), RangeError);
    assert.throws(() => pyLiteral(['ok', 'bad\ud83d']), RangeError);
    assert.doesNotThrow(() => pyLiteral('pair \ud83d\ude00'));
  });

  it('pyLiteral throws on unsupported values', () => {
    for (const bad of [undefined, () => 1, Symbol('x'), 10n, NaN, Infinity, new Date(0), new Map(), new (class A {})()]) {
      assert.throws(() => pyLiteral(bad), (err) => err instanceof TypeError || err instanceof RangeError,
        `expected a throw for ${String(bad)}`);
    }
  });
});

describe('[88-14] py-embed: pyArgs', () => {
  it('pyArgs returns the -c argv with the values after the code', () => {
    assert.deepEqual(pyArgs('print(1)', ['a', 'b']), ['-c', 'print(1)', 'a', 'b']);
    assert.deepEqual(pyArgs('print(1)'), ['-c', 'print(1)']);
  });

  it('pyArgs hands D:\\a\\b\\gsd to Python unchanged through sys.argv', () => {
    for (const value of AWKWARD_VALUES) {
      const argv = pyArgs(WRITE_EXPR('sys.argv[1]'), [value]);
      const got = runPy(argv);
      assert.equal(got, value, `argv round trip failed for ${JSON.stringify(value)}`);
    }
  });

  it('pyArgs rejects non-string code and non-string args', () => {
    assert.throws(() => pyArgs(5, []), TypeError);
    assert.throws(() => pyArgs('x', [1]), TypeError);
    assert.throws(() => pyArgs('x', 'not-an-array'), TypeError);
  });
});

describe('[88-14] home-env: homeEnv', () => {
  it('sets all four variables, on a POSIX path', () => {
    assert.deepEqual(homeEnv('/work/h'), { HOME: '/work/h', USERPROFILE: '/work/h', HOMEDRIVE: '', HOMEPATH: '/work/h' });
    assert.deepEqual(Object.keys(homeEnv('/work/h')).sort(), [...HOME_VARS].sort());
  });

  it('splits a Windows drive path into HOMEDRIVE and HOMEPATH (value-level, on any platform)', () => {
    const env = homeEnv('D:\\a\\gsd-amauta\\home');
    assert.equal(env.HOME, 'D:\\a\\gsd-amauta\\home');
    assert.equal(env.USERPROFILE, 'D:\\a\\gsd-amauta\\home');
    assert.equal(env.HOMEDRIVE, 'D:');
    assert.equal(env.HOMEPATH, '\\a\\gsd-amauta\\home');
    assert.equal(env.HOMEDRIVE + env.HOMEPATH, env.USERPROFILE);
  });

  it('is unconditional: the output does not depend on process.platform', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    const outputs = [];
    try {
      for (const platform of ['win32', 'darwin', 'linux']) {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        outputs.push(JSON.stringify(homeEnv('/work/h')));
      }
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
    assert.equal(new Set(outputs).size, 1);
  });

  it('rejects a missing or relative directory', () => {
    assert.throws(() => homeEnv(''), TypeError);
    assert.throws(() => homeEnv(undefined), TypeError);
    assert.throws(() => homeEnv('relative/dir'), RangeError);
  });

  it('BEHAVIOUR: a child with HOME removed resolves ~ to the directory through USERPROFILE', () => {
    // ntpath is the Windows implementation of expanduser, importable on every platform: it reads
    // USERPROFILE first, then HOMEDRIVE + HOMEPATH, never HOME. It is the real resolver the
    // product Python uses on Windows, run here against the variables the helper produced.
    const code = 'import ntpath; print(ntpath.expanduser("~"))';
    const base = { ...process.env, ...homeEnv('D:\\a\\gsd-amauta\\home') };
    delete base.HOME;
    const viaProfile = runPy(['-c', code], base).trim();
    assert.equal(viaProfile, 'D:\\a\\gsd-amauta\\home');
    const fallback = { ...base };
    delete fallback.USERPROFILE;
    assert.equal(runPy(['-c', code], fallback).trim(), 'D:\\a\\gsd-amauta\\home');
  });

  it('BEHAVIOUR: os.homedir() in a child follows the helper on this platform', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-env-'));
    try {
      const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], {
        encoding: 'utf8',
        env: { ...process.env, ...homeEnv(dir) },
        timeout: 15000,
      });
      assert.equal(out, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('[88-14] home-env: applyHomeEnv', () => {
  it('sets the four variables and restores each exactly (set -> old value, unset -> deleted)', () => {
    const env = { HOME: '/old/home', USERPROFILE: undefined, PATH: '/bin' };
    delete env.USERPROFILE; // unset, as opposed to set-to-undefined
    const restore = applyHomeEnv('/work/new', env);
    assert.equal(env.HOME, '/work/new');
    assert.equal(env.USERPROFILE, '/work/new');
    assert.equal(env.HOMEPATH, '/work/new');
    assert.equal(env.PATH, '/bin');
    restore();
    assert.deepEqual(env, { HOME: '/old/home', PATH: '/bin' });
    restore(); // idempotent
    assert.deepEqual(env, { HOME: '/old/home', PATH: '/bin' });
  });

  it('defaults to process.env and puts it back', () => {
    const before = HOME_VARS.map((k) => process.env[k]);
    const restore = applyHomeEnv(path.join(os.tmpdir(), 'apply-home-env'));
    try {
      assert.equal(process.env.USERPROFILE, path.join(os.tmpdir(), 'apply-home-env'));
    } finally {
      restore();
    }
    assert.deepEqual(HOME_VARS.map((k) => process.env[k]), before);
  });
});

describe('[88-14] fake-exe: prependPath', () => {
  it('joins with the delimiter it is given (":" POSIX, ";" Windows), tool dirs first', () => {
    assert.equal(prependPath(['/a', '/b'], '/usr/bin', ':'), '/a:/b:/usr/bin');
    assert.equal(prependPath(['C:\\a', 'D:\\b'], 'C:\\Windows', ';'), 'C:\\a;D:\\b;C:\\Windows');
  });

  it('uses path.delimiter by default (asserted against path.delimiter, not against ":")', () => {
    const joined = prependPath(['/a', '/b'], '/base');
    assert.equal(joined, ['/a', '/b', '/base'].join(path.delimiter));
    assert.deepEqual(joined.split(path.delimiter), ['/a', '/b', '/base']);
  });

  it('adds no trailing delimiter when there is no base PATH, and rejects bad dirs', () => {
    assert.equal(prependPath(['/a'], ''), '/a');
    assert.equal(prependPath(['/a'], undefined, ':').startsWith('/a'), true);
    assert.throws(() => prependPath('/a'), TypeError);
    assert.throws(() => prependPath(['/a', '']), TypeError);
  });
});

describe('[88-14] fake-exe: writeFakeExe', () => {
  /** Run `fn(dir)` with a fresh temp dir that is removed afterwards. */
  function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-exe-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('POSIX layout: an extensionless file with a #! line, mode 0o755, chmod called', () => {
    withDir((dir) => {
      const calls = [];
      const orig = fs.chmodSync;
      fs.chmodSync = (...args) => { calls.push(args); return orig(...args); };
      let file;
      try {
        file = writeFakeExe(dir, 'tool', { node: 'console.log(1)' }, { platform: 'linux', nodePath: '/x/node' });
      } finally {
        fs.chmodSync = orig;
      }
      assert.equal(file, path.join(dir, 'tool'));
      assert.equal(fs.readFileSync(file, 'utf8'), '#!/x/node\nconsole.log(1)\n');
      assert.deepEqual(calls.map((c) => c[1]), [0o755]);
    });
  });

  it('POSIX shell body: #!/bin/sh and the sh text', () => {
    withDir((dir) => {
      const file = writeFakeExe(dir, 'tool', { sh: 'echo not gsd', cmd: 'echo not gsd' }, { platform: 'darwin' });
      assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho not gsd\n');
    });
  });

  it('Windows layout: a <name>.cmd shim calling a <name>.cjs, CRLF, and NO chmod', () => {
    withDir((dir) => {
      const calls = [];
      const orig = fs.chmodSync;
      fs.chmodSync = (...args) => { calls.push(args); return orig(...args); };
      let shim;
      try {
        shim = writeFakeExe(dir, 'python3', { node: "console.log('hi')" }, { platform: 'win32', nodePath: 'C:\\n\\node.exe' });
      } finally {
        fs.chmodSync = orig;
      }
      assert.equal(shim, path.join(dir, 'python3.cmd'));
      assert.equal(fs.readFileSync(shim, 'utf8'), '@echo off\r\n"C:\\n\\node.exe" "%~dp0python3.cjs" %*\r\n');
      assert.equal(fs.readFileSync(path.join(dir, 'python3.cjs'), 'utf8'), "console.log('hi')\n");
      assert.deepEqual(calls, [], 'chmod is POSIX-only');
      assert.equal(fs.existsSync(path.join(dir, 'python3')), false, 'no extensionless file on Windows');
    });
  });

  it('Windows batch body: the cmd text with CRLF line endings', () => {
    withDir((dir) => {
      const shim = writeFakeExe(dir, 'amauta', { sh: 'echo not gsd', cmd: 'echo not gsd' }, { platform: 'win32' });
      assert.equal(fs.readFileSync(shim, 'utf8'), '@echo off\r\necho not gsd\r\n');
    });
  });

  it('rejects a path-like name and a body with no usable form', () => {
    withDir((dir) => {
      assert.throws(() => writeFakeExe(dir, '../evil', { node: '1' }), TypeError);
      assert.throws(() => writeFakeExe(dir, 'a b', { node: '1' }), TypeError);
      assert.throws(() => writeFakeExe(dir, 'tool', {}), TypeError);
      assert.throws(() => writeFakeExe(dir, 'tool', { sh: 'exit 0' }), TypeError, 'sh without cmd');
      assert.throws(() => writeFakeExe('', 'tool', { node: '1' }), TypeError);
    });
  });

  it('BEHAVIOUR: a fake with a Node body really shadows the real tool when its dir leads PATH', () => {
    // The property the five G8 failures are about: a fake that silently fails to shadow turns a
    // hermetic test into a live one. A shell is used to launch it so that PATHEXT applies on
    // Windows (a bare-name spawn of a .cmd without a shell cannot work there; see fake-exe.cjs).
    withDir((dir) => {
      writeFakeExe(dir, 'python3', {
        node: "process.stdout.write('SENTINEL-88-14 ' + process.argv.slice(2).join(' '));",
      });
      const r = spawnSync('python3 --version', {
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, PATH: prependPath([dir]) },
        timeout: 30000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'SENTINEL-88-14 --version', 'the fake ran, not the real python3');
    });
  });
});
