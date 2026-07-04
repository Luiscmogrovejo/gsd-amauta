'use strict';

/**
 * tests/68-install-mcp-gating.test.cjs — Phase 68 MOBL-01/MOBL-02
 *
 * Installer gating matrix for bin/install.js's mcpServers registration:
 *   1. Mobile executor agent files present in <tmp>/agents -> settings.json
 *      gains mcpServers.xcodebuildmcp with args exactly
 *      ['-y', 'xcodebuildmcp@2.6.2', 'mcp'].
 *   2. Agents absent -> NO xcodebuildmcp key.
 *   3. Agents present WITHOUT --enable-mobile-mcp -> no mobile-mcp key AND
 *      stdout names the flag.
 *   4. Agents present WITH --enable-mobile-mcp (GSD_MOBILE_MCP=on) ->
 *      mobile-mcp key pinned exactly @0.0.61.
 *   5. Pre-existing unrelated mcpServers.custom-user-server entry survives
 *      a re-install byte-identically (idempotence/no-clobber).
 *
 * Uses install.js's GSD_TEST_MODE export (precedent: opencode-config.test.cjs,
 * codex-config.test.cjs) — install(false, 'claude') writes only under
 * process.cwd()/.claude, so beforeEach/afterEach chdir into a fresh temp
 * directory per test.
 *
 * Two structural workarounds, both documented at the call site:
 *   - enableMobileMcp / explicitConfigDir / hasGlobal are top-level consts
 *     computed ONCE at install.js require-time from process.argv/env — the
 *     require-cache is busted and the module re-required per scenario so
 *     GSD_MOBILE_MCP takes effect.
 *   - The repo's real agents/ directory always contains
 *     gsd-executor-mobile-ios.md and gsd-executor-wearables.md, so a normal
 *     install() call can never produce the "agents absent" branch on its
 *     own; fs.existsSync is mocked ONLY for those two specific installed-
 *     agent-dir paths (pass-through for everything else) to exercise the
 *     actual runtime gate without mutating real repo files.
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.GSD_TEST_MODE = '1';

const INSTALL_PATH = require.resolve('../bin/install.js');

/**
 * Delete install.js's require-cache entry and re-require it with the given
 * env overrides applied first, so its top-level consts (enableMobileMcp,
 * hasGlobal, explicitConfigDir, ...) are recomputed against the new env.
 * Returns the fresh module exports; does NOT restore env (each test sets
 * what it needs directly, afterEach clears GSD_MOBILE_MCP).
 */
function loadInstall(envOverrides = {}) {
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[INSTALL_PATH];
  return require(INSTALL_PATH);
}

/** Mirrors install.js's own (unexported) writeSettings(). */
function persistSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function readSettingsFile(tmpDir) {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

describe('installer mcpServers gating matrix (Phase 68 MOBL-01/MOBL-02)', () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-mobl-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
    delete process.env.GSD_MOBILE_MCP;
  });

  test('mobile executor agents present -> xcodebuildmcp registered with exact pinned args', () => {
    const mod = loadInstall({ GSD_MOBILE_MCP: undefined });
    const result = mod.install(false, 'claude');
    persistSettings(result.settingsPath, result.settings);

    const settings = readSettingsFile(tmpDir);
    assert.ok(settings.mcpServers && settings.mcpServers.xcodebuildmcp, 'xcodebuildmcp key present when mobile agents installed');
    assert.deepEqual(
      settings.mcpServers.xcodebuildmcp.args,
      ['-y', 'xcodebuildmcp@2.6.2', 'mcp'],
      'xcodebuildmcp args exactly match the locked pin'
    );
    assert.equal(settings.mcpServers.xcodebuildmcp.disabled, false);
  });

  test('mobile executor agents absent -> NO xcodebuildmcp key', () => {
    const mod = loadInstall({ GSD_MOBILE_MCP: undefined });
    // Resolve via process.cwd() (post-chdir), not the pre-chdir tmpDir string —
    // macOS resolves /var/folders/... through the /private symlink, so
    // install.js's internal path.join(targetDir, 'agents') (targetDir derived
    // from process.cwd()) can differ byte-for-byte from a naive tmpDir-based
    // join even though both point at the same real directory.
    const installedAgentsDir = path.join(process.cwd(), '.claude', 'agents');
    const realExistsSync = fs.existsSync;

    mock.method(fs, 'existsSync', (p) => {
      if (
        typeof p === 'string' &&
        path.dirname(p) === installedAgentsDir &&
        (path.basename(p) === 'gsd-executor-mobile-ios.md' || path.basename(p) === 'gsd-executor-wearables.md')
      ) {
        return false;
      }
      return realExistsSync(p);
    });

    const result = mod.install(false, 'claude');
    persistSettings(result.settingsPath, result.settings);

    const settings = readSettingsFile(tmpDir);
    assert.ok(
      !settings.mcpServers || !settings.mcpServers.xcodebuildmcp,
      'no xcodebuildmcp key when mobile executor agents are absent'
    );
    assert.ok(
      !settings.mcpServers || !settings.mcpServers['mobile-mcp'],
      'no mobile-mcp key either when mobile executor agents are absent'
    );
  });

  test('agents present WITHOUT --enable-mobile-mcp -> no mobile-mcp key AND stdout names the flag', () => {
    const mod = loadInstall({ GSD_MOBILE_MCP: undefined });
    const logs = [];
    const originalLog = console.log;
    console.log = (...parts) => logs.push(parts.join(' '));

    let result;
    try {
      result = mod.install(false, 'claude');
    } finally {
      console.log = originalLog;
    }
    persistSettings(result.settingsPath, result.settings);

    const settings = readSettingsFile(tmpDir);
    assert.ok(!settings.mcpServers || !settings.mcpServers['mobile-mcp'], 'no mobile-mcp key without the opt-in flag');
    assert.ok(
      logs.some((line) => line.includes('--enable-mobile-mcp')),
      'stdout names --enable-mobile-mcp as the visible opt-in path'
    );
  });

  test('agents present WITH --enable-mobile-mcp -> mobile-mcp key pinned @0.0.61', () => {
    const mod = loadInstall({ GSD_MOBILE_MCP: 'on' });
    const result = mod.install(false, 'claude');
    persistSettings(result.settingsPath, result.settings);

    const settings = readSettingsFile(tmpDir);
    assert.ok(settings.mcpServers && settings.mcpServers['mobile-mcp'], 'mobile-mcp key present with GSD_MOBILE_MCP=on');
    assert.deepEqual(
      settings.mcpServers['mobile-mcp'].args,
      ['-y', '@mobilenext/mobile-mcp@0.0.61'],
      'mobile-mcp pinned to exactly 0.0.61'
    );
    assert.equal(settings.mcpServers['mobile-mcp'].disabled, false);
  });

  test('pre-existing unrelated mcpServers.custom-user-server survives a re-install byte-identically', () => {
    const mod = loadInstall({ GSD_MOBILE_MCP: undefined });
    const settingsDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, 'settings.json');

    const customUserServer = { command: 'node', args: ['my-custom-server.js'], disabled: false };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { 'custom-user-server': customUserServer } }, null, 2) + '\n'
    );

    // First install
    let result = mod.install(false, 'claude');
    persistSettings(result.settingsPath, result.settings);
    const afterFirst = readSettingsFile(tmpDir);
    assert.deepEqual(
      afterFirst.mcpServers['custom-user-server'],
      customUserServer,
      'custom-user-server present unchanged after first install'
    );

    // Re-install — idempotent, must not clobber the unrelated entry
    result = mod.install(false, 'claude');
    persistSettings(result.settingsPath, result.settings);
    const afterSecond = readSettingsFile(tmpDir);
    assert.deepEqual(
      afterSecond.mcpServers['custom-user-server'],
      customUserServer,
      'custom-user-server survives a re-install byte-identically'
    );
    // Amauta's own managed keys are still present alongside the untouched custom entry
    assert.ok(afterSecond.mcpServers['gsd-amauta'], 'gsd-amauta managed key still registered');
    assert.ok(afterSecond.mcpServers.xcodebuildmcp, 'xcodebuildmcp managed key still registered');
  });
});
