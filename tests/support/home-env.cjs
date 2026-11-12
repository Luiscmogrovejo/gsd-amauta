'use strict';
/**
 * tests/support/home-env.cjs -- redirect "the user's home" on every platform.
 *
 * Plan 88-14 (G7). A test that wants the product to write under a temporary home used to set
 * `HOME` only. That is enough on POSIX and wrong on Windows: Node's os.homedir() and Python's
 * os.path.expanduser read USERPROFILE there (falling back to HOMEDRIVE + HOMEPATH), so the
 * product wrote into the runner's REAL profile -- on a developer's Windows machine, the
 * developer's own profile.
 *
 * The four variables are set TOGETHER and UNCONDITIONALLY (no process.platform branch): every
 * cell then hands its child the same environment shape, so a POSIX run cannot drift from a
 * Windows one, and the Windows branch is exercised by unit tests on any machine.
 *
 * Note: scripts/run-tests.cjs deliberately leaves the runner's own HOME alone (replacing it on
 * macOS hides the user-site Python packages). This helper changes only what an individual test
 * hands to ITS child, or (applyHomeEnv) to its own process for the duration of one test.
 */

const path = require('node:path');

/** Environment variables that name the user's home, in the order Windows consults them. */
const HOME_VARS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];

const WIN_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Split a home directory into the HOMEDRIVE / HOMEPATH pair Windows uses.
 * A drive-letter path `D:\a\h` gives drive `D:` and path `\a\h`; any other shape (POSIX path,
 * UNC share) gives an empty drive and the whole path, so that HOMEDRIVE + HOMEPATH === dir
 * always holds.
 *
 * @param {string} dir absolute directory
 * @returns {{drive: string, rest: string}}
 */
function splitDrive(dir) {
  if (WIN_DRIVE_PATH.test(dir)) {
    const parsed = path.win32.parse(dir);
    const drive = parsed.root.slice(0, 2);
    return { drive, rest: dir.slice(drive.length) };
  }
  return { drive: '', rest: dir };
}

/**
 * Build the environment variables that redirect "the user's home" on every platform.
 *
 * POSIX reads HOME. Windows reads USERPROFILE, and falls back to HOMEDRIVE+HOMEPATH;
 * Node's os.homedir() and Python's os.path.expanduser both follow that order. Setting
 * HOME alone leaves the product writing into the real profile, which is both a wrong
 * test and a real hazard on a developer's machine.
 *
 * @param {string} dir absolute path to the temporary home
 * @returns {Record<string,string>} variables to merge into a child's env
 * @throws {TypeError} dir is not a non-empty string
 * @throws {RangeError} dir is not an absolute path (POSIX or Windows style)
 * @example
 *   spawnSync(cmd, args, { env: { ...process.env, ...homeEnv(tmpHome) } });
 */
function homeEnv(dir) {
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('homeEnv: dir must be a non-empty string');
  }
  if (!path.isAbsolute(dir) && !WIN_DRIVE_PATH.test(dir)) {
    throw new RangeError(`homeEnv: dir must be absolute, got ${JSON.stringify(dir)}`);
  }
  const { drive, rest } = splitDrive(dir);
  return { HOME: dir, USERPROFILE: dir, HOMEDRIVE: drive, HOMEPATH: rest };
}

/**
 * Point the CURRENT process's home variables at `dir` (for an in-process test) and return a
 * function that restores every one of them exactly: a variable that was unset is deleted again,
 * one that was set gets its old value back.
 *
 * @param {string} dir absolute path to the temporary home
 * @param {NodeJS.ProcessEnv} [env=process.env] environment object to mutate (injectable for tests)
 * @returns {() => void} restore function (idempotent)
 * @throws {TypeError|RangeError} as homeEnv
 * @example
 *   const restore = applyHomeEnv(emptyHome);
 *   try { ... } finally { restore(); }
 */
function applyHomeEnv(dir, env = process.env) {
  const next = homeEnv(dir);
  const saved = {};
  for (const k of HOME_VARS) {
    saved[k] = Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined;
  }
  Object.assign(env, next);
  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    for (const k of HOME_VARS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  };
}

module.exports = { homeEnv, applyHomeEnv, HOME_VARS, splitDrive };
