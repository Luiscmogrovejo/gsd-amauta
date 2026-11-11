/**
 * Phase 88 plan 88-12 task 03: bin/init.cjs starts a daemon only for the operator's
 * own account. `--start-daemon` is the one override; `--skip-daemon` always wins.
 *
 * The end-to-end cases run the installer with --skip-install against a port the
 * test obtained itself (never the default) and a throwaway HOME. None of them is
 * allowed to start a daemon: if the gate regressed, the `finally` below stops
 * whatever listens on that port, by pid.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN_INIT = path.join(ROOT, 'bin', 'init.cjs');
const { shouldStartDaemon } = require(BIN_INIT);

const HOME = '/home/operator';

describe('88-12 shouldStartDaemon decision table', () => {
  const cases = [
    ['--skip-daemon', { env: {}, homedir: HOME, passwdHome: HOME, flags: { skipDaemon: true } }, false, 'skip_daemon_flag'],
    ['--skip-daemon beats --start-daemon', { env: {}, homedir: HOME, passwdHome: HOME, flags: { skipDaemon: true, startDaemon: true } }, false, 'skip_daemon_flag'],
    ['--start-daemon in test mode', { env: { GSD_TEST_MODE: '1' }, homedir: '/tmp/x', passwdHome: HOME, flags: { startDaemon: true } }, true, 'forced_by_flag'],
    ['test mode', { env: { GSD_TEST_MODE: '1' }, homedir: HOME, passwdHome: HOME, flags: {} }, false, 'test_mode'],
    ['foreign HOME', { env: {}, homedir: '/tmp/throwaway', passwdHome: HOME, flags: {} }, false, 'foreign_home'],
    ['foreign CLAUDE_CONFIG_DIR', { env: { CLAUDE_CONFIG_DIR: '/tmp/elsewhere/.claude' }, homedir: HOME, passwdHome: HOME, flags: {} }, false, 'foreign_config_dir'],
    ['a sibling dir that merely shares a prefix', { env: { CLAUDE_CONFIG_DIR: HOME + '-other/.claude' }, homedir: HOME, passwdHome: HOME, flags: {} }, false, 'foreign_config_dir'],
    ['the operator, no config dir', { env: {}, homedir: HOME, passwdHome: HOME, flags: {} }, true, 'operator_home'],
    ['the operator, config dir under HOME', { env: { CLAUDE_CONFIG_DIR: HOME + '/.claude' }, homedir: HOME, passwdHome: HOME, flags: {} }, true, 'operator_home'],
    ['GSD_TEST_MODE=behavioral is not test mode', { env: { GSD_TEST_MODE: 'behavioral' }, homedir: HOME, passwdHome: HOME, flags: {} }, true, 'operator_home'],
  ];
  for (const [name, ctx, start, reason] of cases) {
    test(name, () => {
      assert.deepStrictEqual(shouldStartDaemon(ctx), { start, reason });
    });
  }
});

/** @returns {Promise<number>} a free port the OS chose */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Stop whatever LISTENS on `port`, by pid. Belt to the gate's braces.
 * @param {number} port
 * @returns {void}
 */
function stopListeners(port) {
  let out = '';
  try {
    out = execFileSync('lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_e) {
    return; // nothing listening (lsof exits 1) or no lsof
  }
  for (const pid of out.split(/\s+/).filter(Boolean).map(Number)) {
    if (pid === process.pid || pid === process.ppid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_e) {
      /* gone */
    }
  }
}

/**
 * @param {number} port
 * @returns {Promise<boolean>} true when something accepts connections on the port
 */
function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/**
 * Run the installer in a throwaway HOME and return the parsed start_daemon step.
 * @param {string[]} extraArgs
 * @param {object} envOverrides
 * @param {number} port
 * @param {string} home
 * @returns {{step: object, status: number|null, stdout: string}}
 */
function runInit(extraArgs, envOverrides, port, home) {
  const env = { ...process.env, ...envOverrides };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AMAUTA_DATA_DIR: path.join(home, 'data'),
    GSD_AMAUTA_PORT: String(port),
  });
  for (const k of Object.keys(envOverrides)) if (envOverrides[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [BIN_INIT, '--json', '--skip-install', '--backend', 'sqlite', ...extraArgs], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120000,
  });
  const parsed = JSON.parse(r.stdout);
  return { step: parsed.results.find((x) => x.name === 'start_daemon'), status: r.status, stdout: r.stdout };
}

describe('88-12 init end to end in a throwaway HOME', () => {
  test('no --start-daemon: the step is skipped with the gate reason and nothing listens', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-init-gate-'));
    const port = await freePort();
    try {
      const { step } = runInit([], {}, port, home);
      assert.strictEqual(step.status, 'skip');
      assert.ok(['test_mode', 'foreign_home'].includes(step.details.skip_reason), 'got ' + step.details.skip_reason);
      assert.match(step.message, /pass --start-daemon to override/);
      assert.strictEqual(await listening(port), false);
    } finally {
      stopListeners(port);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('outside test mode the throwaway HOME itself is the reason (foreign_home)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-init-gate-'));
    const port = await freePort();
    try {
      const { step } = runInit([], { GSD_TEST_MODE: undefined }, port, home);
      assert.strictEqual(step.status, 'skip');
      assert.strictEqual(step.details.skip_reason, 'foreign_home');
      assert.strictEqual(await listening(port), false);
    } finally {
      stopListeners(port);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('--skip-daemon keeps precedence and its message text', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-init-gate-'));
    const port = await freePort();
    try {
      const { step } = runInit(['--skip-daemon'], {}, port, home);
      assert.strictEqual(step.status, 'skip');
      assert.strictEqual(step.details.skip_reason, 'skip_daemon_flag');
      assert.strictEqual(step.message, 'skipped via --skip-daemon');
      assert.strictEqual(await listening(port), false);
    } finally {
      stopListeners(port);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
