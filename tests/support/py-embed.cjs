'use strict';
/**
 * tests/support/py-embed.cjs -- put values into Python source, or hand them to Python, safely.
 *
 * Plan 88-14 (G2). A JS test that interpolates a path into Python source text
 * (`'${ROOT}'`) is correct on POSIX and wrong on Windows: `ROOT` is
 * `D:\a\gsd-amauta\gsd-amauta` there, and inside a Python string literal `\a` is U+0007
 * (BEL), `\g` is an invalid escape (SyntaxWarning) and `\U` starts a Unicode escape. The
 * path silently turns into garbage (`D:<BEL>gsd-amauta...`).
 *
 * Two safe ways, in order of preference:
 *   1. pyArgs(code, args)  -- the values travel in argv and the Python code reads sys.argv[1:].
 *      The value never enters the Python parser at all.
 *   2. pyLiteral(value)    -- where a value must appear inside a larger Python expression
 *      (a bootstrap prelude, a dict literal) use this; it emits a correct Python literal.
 *
 * Never write `'${somePath}'` inside Python source.
 */

/**
 * Detect a lone (unpaired) UTF-16 surrogate in a string.
 *
 * @param {string} s
 * @returns {boolean} true when `s` contains an unpaired surrogate
 */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * Embed a value in Python source safely.
 *
 * A Windows path interpolated raw into Python source is reinterpreted as escapes:
 * `D:\a\gsd-amauta` becomes `D:<BEL>gsd-amauta`. JSON string syntax is a subset of Python
 * string-literal syntax, so JSON.stringify of a string is a correct Python literal on every
 * platform. Booleans and null are not: JSON `true`/`false`/`null` are Python `True`/`False`/`None`,
 * so the value is walked rather than text-replaced (a string that contains the word "true" must
 * stay untouched).
 *
 * Supported: string, finite number, boolean, null, array, plain object (string keys).
 * Anything else (undefined, function, symbol, bigint, NaN/Infinity, Date, Map, class instance)
 * throws a TypeError. A string with a lone surrogate throws a RangeError instead of emitting
 * source Python would reject or mis-encode.
 *
 * @param {unknown} value
 * @returns {string} a Python expression
 * @throws {TypeError} the value (or a nested one) is not a supported type
 * @throws {RangeError} a string holds a lone surrogate, or a number is not finite
 * @example
 *   pyLiteral('D:\\a\\b')   // => "D:\\a\\b"  (a Python str equal to D:\a\b)
 *   pyLiteral({ ok: true }) // => {"ok": True}
 */
function pyLiteral(value) {
  if (value === null) return 'None';
  switch (typeof value) {
    case 'string':
      if (hasLoneSurrogate(value)) {
        throw new RangeError('pyLiteral: string contains a lone surrogate');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'True' : 'False';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new RangeError(`pyLiteral: number is not finite: ${value}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map(pyLiteral).join(', ')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('pyLiteral: only plain objects are supported');
      }
      const body = Object.keys(value).map((k) => `${pyLiteral(k)}: ${pyLiteral(value[k])}`);
      return `{${body.join(', ')}}`;
    }
    default:
      throw new TypeError(`pyLiteral: unsupported type ${typeof value}`);
  }
}

/**
 * Build the argv for `python3 -c <code>` with values passed as arguments rather than
 * interpolated. The code reads them from sys.argv[1:], so no quoting or escaping of the
 * caller's values happens at all. Prefer this over pyLiteral where the shape allows it.
 *
 * @param {string} code  Python source; reads its inputs from sys.argv[1:]
 * @param {string[]} [args]
 * @returns {string[]} argv suitable for execFileSync(pythonBin, argv)
 * @throws {TypeError} code or an argument is not a string
 * @example
 *   execFileSync('python3', pyArgs('import sys; print(sys.argv[1])', [root]))
 */
function pyArgs(code, args = []) {
  if (typeof code !== 'string') throw new TypeError('pyArgs: code must be a string');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('pyArgs: args must be an array of strings');
  }
  return ['-c', code, ...args];
}

module.exports = { pyLiteral, pyArgs, hasLoneSurrogate };
