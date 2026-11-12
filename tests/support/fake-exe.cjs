'use strict';
/**
 * tests/support/fake-exe.cjs -- fake executables that shadow a real tool, on every platform.
 *
 * Plan 88-14 (G8). A test used to write an extensionless `#!/bin/sh` file, chmod it 0o755 and
 * prepend its directory to PATH joined with a literal ":". On Windows none of that works:
 * there is no shebang and no execute bit, an extensionless file is not in PATHEXT, and ":" is
 * the drive-letter separator (the path separator is ";").
 *
 * What this helper can and cannot do on Windows
 *   - It makes a fake that cmd.exe and any caller that applies PATHEXT will find: a `<name>.cmd`
 *     shim (plus a `<name>.cjs` beside it for a Node body).
 *   - It CANNOT make a fake shadow a bare-name spawn from a program that does not apply PATHEXT:
 *     Node's execFileSync('python3') goes through libuv and Python's subprocess through
 *     CreateProcess; both resolve only `.exe`/`.com`, and Node's documentation says a `.cmd`
 *     cannot be launched without a shell. A test whose product spawns the tool by bare name
 *     therefore still needs the product to resolve the executable itself (plan 88-15).
 *
 * Prefer a Node body: one JavaScript program behind a POSIX shebang and a `.cmd` shim is the
 * same program on both platforms; a shell body needs two translations that drift.
 */

const fs = require('node:fs');
const path = require('node:path');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Write a fake executable that shadows a real tool on PATH, on every platform.
 *
 * POSIX: an extensionless file with a #! line and mode 0o755.
 * Windows: a `<name>.cmd` batch shim (cmd.exe resolves .cmd through PATHEXT; there is no
 * shebang and no execute bit). A shim that calls node or python must spell out the
 * interpreter, because `#!` is not read. PATHEXT must list `.CMD` (the default does); the
 * caller must put `dir` on PATH with prependPath so the shim is found first.
 *
 * @param {string} dir     directory to write into (must already exist)
 * @param {string} name    tool name as it will be typed, without an extension
 * @param {{node?: string, sh?: string, cmd?: string}} body
 *        `node`: JavaScript source (preferred, identical on both platforms), or
 *        `sh` (POSIX shell, no shebang line) together with `cmd` (batch, no @echo off line)
 * @param {{platform?: string, nodePath?: string}} [options]
 *        `platform` is injectable so the Windows branch can be unit-tested anywhere;
 *        `nodePath` is the interpreter written into the shebang / shim (default process.execPath)
 * @returns {string} the full path written (the extensionless file, or the `.cmd` shim)
 * @throws {TypeError} the name is not a plain file name, or no usable body was given
 * @example
 *   const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-'));
 *   writeFakeExe(bin, 'python3', { node: "console.log('FAKE ' + process.argv.slice(2).join(' '))" });
 *   const env = { ...process.env, PATH: prependPath([bin]) };
 */
function writeFakeExe(dir, name, body, options = {}) {
  const platform = options.platform || process.platform;
  const nodePath = options.nodePath || process.execPath;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new TypeError(`writeFakeExe: name must be a plain tool name, got ${JSON.stringify(name)}`);
  }
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('writeFakeExe: dir must be a non-empty string');
  }
  const hasNode = body && typeof body.node === 'string';
  const hasShell = body && typeof body.sh === 'string' && typeof body.cmd === 'string';
  if (!hasNode && !hasShell) {
    throw new TypeError('writeFakeExe: body needs { node } or both { sh, cmd }');
  }
  const win = platform === 'win32';
  if (win) {
    const shim = path.join(dir, `${name}.cmd`);
    if (hasNode) {
      fs.writeFileSync(path.join(dir, `${name}.cjs`), body.node.endsWith('\n') ? body.node : `${body.node}\n`);
      const lines = ['@echo off', `"${nodePath}" "%~dp0${name}.cjs" %*`];
      fs.writeFileSync(shim, `${lines.join('\r\n')}\r\n`);
    } else {
      fs.writeFileSync(shim, `@echo off\r\n${body.cmd.replace(/\r?\n/g, '\r\n')}\r\n`);
    }
    return shim;
  }
  const file = path.join(dir, name);
  const text = hasNode
    ? `#!${nodePath}\n${body.node}${body.node.endsWith('\n') ? '' : '\n'}`
    : `#!/bin/sh\n${body.sh}${body.sh.endsWith('\n') ? '' : '\n'}`;
  fs.writeFileSync(file, text);
  // chmod is a no-op on Windows that some Node versions warn about, so POSIX only.
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * Prepend directories to a PATH value using the platform's separator.
 *
 * @param {string[]} dirs
 * @param {string} [base=process.env.PATH]
 * @param {string} [delimiter=path.delimiter] injectable for tests; ":" on POSIX, ";" on Windows
 * @returns {string}
 * @throws {TypeError} dirs is not an array of non-empty strings
 */
function prependPath(dirs, base = process.env.PATH, delimiter = path.delimiter) {
  if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== 'string' || d === '')) {
    throw new TypeError('prependPath: dirs must be an array of non-empty strings');
  }
  return [...dirs, ...(base ? [base] : [])].join(delimiter);
}

module.exports = { writeFakeExe, prependPath };
