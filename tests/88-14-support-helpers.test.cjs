'use strict';
/**
 * Plan 88-14: unit coverage for the Windows-portability helpers under tests/support/.
 *
 *   - py-embed.cjs   (G2)  paths reach embedded Python through argv or a correct literal
 *
 * Windows itself cannot be run on the machines this suite is developed on, so these tests
 * exercise the CONTENT that breaks there (a backslash path, a path with a space, a path that
 * contains an apostrophe) rather than the platform. A raw interpolation of such a value into
 * Python source is demonstrated to be wrong first, so the fix is shown to be load-bearing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { pyLiteral, pyArgs } = require('./support/py-embed.cjs');

/** Python bytes of stdout, decoded as UTF-8, so the check is independent of the console code page. */
function runPy(argv) {
  return execFileSync('python3', argv, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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
