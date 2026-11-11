'use strict';
/**
 * tests/install-hook-timeout-uninstall.test.cjs
 *
 * Two installer-truth defects:
 *   1. Every hook install.js registered in settings.json carried NO `timeout`,
 *      while the repo's own .claude/settings.json requires `timeout: 5`. A
 *      wedged hook then blocked the session on the host default.
 *   2. The uninstall file list skipped gsd-compress-gate.cjs,
 *      gsd-compress-post.cjs and the staged hooks/lib/ deps, so an uninstall
 *      left executable hook files behind.
 *
 * Harness mirrors tests/75-01-install-toggle.test.cjs: install.js's
 * GSD_TEST_MODE export writes only under process.cwd()/.claude, and
 * loadInstall() busts the require cache so top-level env-derived consts are
 * recomputed. The uninstall half spawns the real CLI with --local in a temp
 * cwd, so no global/user install is touched.
 *
 * Run: node --test tests/install-hook-timeout-uninstall.test.cjs
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

process.env.GSD_TEST_MODE = '1';

const INSTALL_PATH = require.resolve('../bin/install.js');

function loadInstall(envOverrides = {}) {
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[INSTALL_PATH];
  return require(INSTALL_PATH);
}

/** Every hook object registered across every event. */
function allHooks(settings) {
  const out = [];
  for (const event of Object.keys((settings && settings.hooks) || {})) {
    for (const entry of settings.hooks[event]) {
      for (const h of (entry.hooks || [])) out.push({ event, ...h });
    }
  }
  return out;
}

describe('installer: hook timeouts + uninstall completeness', () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-timeout-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.GSD_COMPRESS;
  });

  test('every registered hook carries timeout 5', () => {
    const mod = loadInstall({ GSD_COMPRESS: undefined });
    const result = mod.install(false, 'claude');
    const hooks = allHooks(result.settings);
    assert.ok(hooks.length >= 2, `expected registered hooks, got ${hooks.length}`);
    for (const h of hooks) {
      assert.strictEqual(h.timeout, 5,
        `hook on ${h.event} (${h.command}) must carry timeout 5, got ${h.timeout}`);
    }
  });

  test('compression hooks are registered with a timeout too', () => {
    const mod = loadInstall({ GSD_COMPRESS: 'on' });
    const result = mod.install(false, 'claude');
    const hooks = allHooks(result.settings);
    const compress = hooks.filter(h => h.command && h.command.includes('gsd-compress'));
    assert.strictEqual(compress.length, 2, 'both compression hooks registered');
    for (const h of compress) {
      assert.strictEqual(h.timeout, 5, `${h.command} must carry timeout 5`);
    }
  });

  test('uninstall removes the compression hooks and their staged lib deps', () => {
    // Build a local .claude that looks like a finished install.
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    const libDir = path.join(hooksDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const files = [
      path.join(hooksDir, 'gsd-statusline.js'),
      path.join(hooksDir, 'gsd-check-update.js'),
      path.join(hooksDir, 'gsd-context-monitor.js'),
      path.join(hooksDir, 'gsd-compress-gate.cjs'),
      path.join(hooksDir, 'gsd-compress-post.cjs'),
      path.join(libDir, 'hook-common.cjs'),
      path.join(libDir, 'compress-classify.cjs'),
    ];
    for (const f of files) fs.writeFileSync(f, '// installed\n');
    // A user file in hooks/lib must survive.
    const userFile = path.join(libDir, 'my-own-helper.cjs');
    fs.writeFileSync(userFile, '// mine\n');

    const res = spawnSync(process.execPath,
      [INSTALL_PATH, '--uninstall', '--local', '--claude'],
      { cwd: tmpDir, encoding: 'utf-8', env: { ...process.env, GSD_TEST_MODE: '' } });
    assert.strictEqual(res.status, 0, `uninstall failed: ${res.stderr}`);

    for (const f of files) {
      assert.ok(!fs.existsSync(f), `${path.basename(f)} must be removed by uninstall`);
    }
    assert.ok(fs.existsSync(userFile), 'a non-GSD file in hooks/lib must be preserved');
  });

  test('uninstall removes an empty hooks/lib directory', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    const libDir = path.join(hooksDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-compress-gate.cjs'), '// installed\n');
    fs.writeFileSync(path.join(libDir, 'hook-common.cjs'), '// installed\n');
    fs.writeFileSync(path.join(libDir, 'compress-classify.cjs'), '// installed\n');

    const res = spawnSync(process.execPath,
      [INSTALL_PATH, '--uninstall', '--local', '--claude'],
      { cwd: tmpDir, encoding: 'utf-8', env: { ...process.env, GSD_TEST_MODE: '' } });
    assert.strictEqual(res.status, 0, `uninstall failed: ${res.stderr}`);
    assert.ok(!fs.existsSync(libDir), 'an emptied hooks/lib must not be left behind');
  });
});
