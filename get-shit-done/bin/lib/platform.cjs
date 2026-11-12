'use strict';

/**
 * get-shit-done/bin/lib/platform.cjs — Phase 88, plan 88-15.
 *
 * The Node half of the two shared platform modules 88-CONTEXT.md mandates (the
 * other is services/_platform.py). Every platform difference the harness needs
 * on the Node side lives here, and nothing here may change POSIX behaviour:
 * every Windows branch is strictly additive.
 *
 * Why it exists:
 *   - about thirty sites spawned a LITERAL `python3`. CI never caught it,
 *     because actions/setup-python provides `python3`; a python.org install on
 *     Windows ships `python.exe` and `py.exe`, and `python3.exe` is a Microsoft
 *     Store STUB that opens the Store instead of running Python. On a real
 *     Windows machine the harness could not run Python at all.
 *   - `which` is a POSIX program. `execSync('which x 2>/dev/null || command -v x')`
 *     reads as "absent" on Windows, so scripts/security-scan.cjs reported every
 *     scanner missing and the pipeline looked clean.
 *   - `process.env.HOME` is unset on cmd and PowerShell, so `process.env.HOME || ''`
 *     resolved config paths RELATIVE to the current directory and the files were
 *     silently not found.
 *
 * NOT required by any hook: hooks are installed with only ./lib/hook-common.cjs
 * beside them, so requiring this file from hooks/ would throw at load and break
 * the fail-open guarantee. The hooks keep their own injectable-platform
 * parameters (plan 88-15 task 04).
 *
 * REMAINING DUPLICATE: tests/support/fixture-daemon.cjs still has its own
 * pythonBin(), a second resolver with a macOS-only Homebrew preference. Plan
 * 88-16 task 88-16-06 repoints it at resolvePython(); until then the two must
 * not drift.
 */

const { spawnSync, spawn, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

/** Candidate probe timeout, ms. ENG-04: a knob with a default, never a literal. */
const PROBE_TIMEOUT_MS = Number(process.env.GSD_PYTHON_PROBE_TIMEOUT_MS || 10000);

/** The one-line program that proves a candidate really is a Python 3. */
const VERSION_PROBE = 'import sys; print(sys.version_info[0])';

let _resolved = null;      // { command, args } once verified
let _resolvedKey = null;   // the GSD_PYTHON / PATH / platform the cache was built for

function _isWindows(platform) {
  return String(platform === undefined ? process.platform : platform).startsWith('win');
}

/**
 * Candidate launchers, in order.
 *
 * 88-CONTEXT.md writes the order as "GSD_PYTHON, then `py -3`, then `python`,
 * then `python3`". Applied literally that would prefer `python` over `python3`
 * ON POSIX TOO, which is a behaviour change on the operator's machine and on
 * the ubuntu and macOS runners (both have a `python` beside `python3`, and on
 * some systems they are different interpreters). The same plan forbids
 * changing POSIX behaviour, so the order is per platform:
 *
 *   POSIX:   GSD_PYTHON, python3, python
 *   Windows: GSD_PYTHON, py -3, python, python3
 *
 * POSIX therefore resolves to exactly what the thirty former sites spawned,
 * and still finds an interpreter on a machine that only has `python`. Windows
 * tries `py -3` and `python` before `python3`, because `python3.exe` there is
 * usually the Microsoft Store stub.
 *
 * @param {string} [platform] - platform override for tests.
 * @param {object} [env] - environment override for tests.
 * @returns {Array<{command: string, args: string[]}>}
 */
function _candidates(platform, env) {
  const e = env || process.env;
  const out = [];
  const explicit = (e.GSD_PYTHON || '').trim();
  if (explicit) out.push({ command: explicit, args: [] });
  if (_isWindows(platform)) {
    out.push({ command: 'py', args: ['-3'] });
    out.push({ command: 'python', args: [] });
    out.push({ command: 'python3', args: [] });
  } else {
    out.push({ command: 'python3', args: [] });
    out.push({ command: 'python', args: [] });
  }
  return out;
}

/**
 * Resolve the Python interpreter to spawn.
 *
 * A candidate is VERIFIED, not merely located: it is run with
 * `-c "import sys; print(sys.version_info[0])"` and must exit 0 printing `3`.
 * That is what distinguishes a real interpreter from the Microsoft Store
 * `python3.exe` stub, which exits non-zero and opens the Store. The result is
 * cached per process (keyed on GSD_PYTHON, PATH and platform), because a
 * thirty-site codebase must not probe thirty times.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform] - platform override for tests.
 * @param {object} [opts.env] - environment override for tests.
 * @param {boolean} [opts.noCache] - skip the per-process cache.
 * @param {Function} [opts.probe] - test seam: (command, args) => spawnSync-like
 *   result. The Windows candidate order cannot be exercised on macOS any other
 *   way, and a `.cmd` shim is not spawnable without a shell on current Node.
 * @returns {{command: string, args: string[]}} the launcher; falls back to
 *   `{command: 'python3', args: []}` when nothing verified, so the caller still
 *   produces a recognisable ENOENT instead of a different error.
 * @example
 *   const { command, args } = resolvePython();
 *   spawnSync(command, [...args, script], { encoding: 'utf-8' });
 */
function resolvePython(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform;
  const key = [env.GSD_PYTHON || '', env.PATH || '', platform === undefined ? process.platform : platform].join('\u0000');
  if (!opts.noCache && _resolved && _resolvedKey === key) return _resolved;
  let found = null;
  for (const candidate of _candidates(platform, env)) {
    let probe;
    try {
      const run = opts.probe || spawnSync;
      probe = run(candidate.command, [...candidate.args, '-c', VERSION_PROBE], {
        encoding: 'utf-8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        env,
      });
    } catch {
      continue;
    }
    if (!probe || probe.error || probe.status !== 0) continue;
    if (String(probe.stdout || '').trim() !== '3') continue;
    found = { command: candidate.command, args: [...candidate.args] };
    break;
  }
  const result = found || { command: 'python3', args: [] };
  if (!opts.noCache) {
    _resolved = result;
    _resolvedKey = key;
  }
  return result;
}

/** Drop the cached interpreter (tests that change PATH between cases). */
function resetPythonCache() {
  _resolved = null;
  _resolvedKey = null;
}

/**
 * Environment additions for a spawned Python: PYTHONUTF8=1 and PYTHONIOENCODING=utf-8.
 *
 * This is the belt-and-braces pass plan 88-13 deliberately deferred here. 88-13
 * fixed the product so these are not REQUIRED (services/_platform.setup_stdio
 * reconfigures stdout when the console code page is not UTF-8); this makes a
 * spawned Python robust even if a future entry point forgets to call it.
 *
 * MERGES, never clobbers: a value the caller already set wins.
 *
 * @param {object} [base] - the environment to extend; defaults to process.env.
 * @returns {object} a new environment object.
 */
function pythonEnv(base) {
  const src = base || process.env;
  const out = { ...src };
  if (out.PYTHONUTF8 === undefined || out.PYTHONUTF8 === '') out.PYTHONUTF8 = '1';
  if (out.PYTHONIOENCODING === undefined || out.PYTHONIOENCODING === '') out.PYTHONIOENCODING = 'utf-8';
  return out;
}

/**
 * Spawn Python synchronously with the resolved launcher and the UTF-8 environment.
 *
 * @param {string[]} args - arguments after the interpreter.
 * @param {object} [opts] - spawnSync options; `env` is merged through pythonEnv.
 * @returns {object} the spawnSync result.
 * @example
 *   const r = spawnPython([script, '--json'], { encoding: 'utf-8', cwd: repoRoot });
 */
function spawnPython(args, opts = {}) {
  const { command, args: prefix } = resolvePython();
  return spawnSync(command, [...prefix, ...args], {
    ...opts,
    env: pythonEnv(opts.env),
  });
}

/**
 * execFileSync Python with the resolved launcher and the UTF-8 environment.
 *
 * @param {string[]} args - arguments after the interpreter.
 * @param {object} [opts] - execFileSync options; `env` is merged through pythonEnv.
 * @returns {Buffer|string} whatever execFileSync returns.
 * @throws {Error} the execFileSync error, unchanged, so callers keep their catch.
 */
function runPython(args, opts = {}) {
  const { command, args: prefix } = resolvePython();
  return execFileSync(command, [...prefix, ...args], {
    ...opts,
    env: pythonEnv(opts.env),
  });
}

/**
 * spawn (async) Python with the resolved launcher and the UTF-8 environment.
 *
 * @param {string[]} args - arguments after the interpreter.
 * @param {object} [opts] - spawn options; `env` is merged through pythonEnv.
 * @returns {ChildProcess} the spawned child.
 */
function launchPython(args, opts = {}) {
  const { command, args: prefix } = resolvePython();
  return spawn(command, [...prefix, ...args], {
    ...opts,
    env: pythonEnv(opts.env),
  });
}

/**
 * Locate an executable on PATH: `where` on Windows (which honours PATHEXT),
 * `which` elsewhere. Never a shell string, so no `2>/dev/null` is needed and
 * nothing user-supplied reaches a shell.
 *
 * @param {string} name - the executable name.
 * @param {object} [opts]
 * @param {string} [opts.platform] - platform override for tests.
 * @param {object} [opts.env] - environment override for tests.
 * @returns {string|null} the first resolved path, or null when absent.
 * @example
 *   if (which('gitleaks')) { ... }
 */
function which(name, opts = {}) {
  if (!name || typeof name !== 'string') return null;
  const finder = _isWindows(opts.platform) ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
      env: opts.env || process.env,
    });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/**
 * The user's home directory, correct on every platform.
 *
 * `process.env.HOME || ''` is not a fallback, it is a silent failure: on
 * Windows cmd and PowerShell HOME is unset, so `path.resolve('', '.claude', …)`
 * resolves RELATIVE to the current directory and the config file is simply not
 * found — the evidence-scrub patterns, the tag rules and the capability catalog
 * all load that way.
 *
 * `os.homedir()` reads $HOME first on POSIX (so a test that redirects HOME is
 * still honoured) and falls back to the passwd entry; on Windows it reads
 * USERPROFILE. It is never the empty string.
 *
 * @returns {string} an absolute home directory path.
 */
function homeDir() {
  const home = os.homedir();
  return home && String(home).length ? home : path.resolve('.');
}

module.exports = {
  resolvePython,
  resetPythonCache,
  pythonEnv,
  spawnPython,
  runPython,
  launchPython,
  which,
  homeDir,
  VERSION_PROBE,
};
