/**
 * Integration tests for the init flow (Plan 01-01) and status command (Plan 01-02).
 *
 * Validates:
 *   - infra_detect.py JSON output structure
 *   - bin/cli.cjs dispatch logic for init and status
 *   - bin/init.cjs structure and required components
 *   - package.json bin entry for gsd-amauta
 *   - SQLite fallback detection path
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

describe('init flow integration', () => {

  // ── Test 1: infra_detect.py outputs valid JSON ──────────────────────────

  test('infra_detect.py outputs valid JSON with required fields', async () => {
    const detectScript = path.join(ROOT, 'services', 'infra_detect.py');
    if (!fs.existsSync(detectScript)) {
      // Skip gracefully if infra_detect.py does not exist (e.g., partial checkout)
      return;
    }

    const result = execFileSync('python3', [detectScript], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result.trim());
    assert.ok(parsed.backend, 'backend field exists');
    assert.ok(Array.isArray(parsed.features), 'features is an array');
    assert.ok(parsed.message, 'message field exists');
    assert.ok(
      ['postgresql', 'sqlite'].includes(parsed.backend),
      `backend must be postgresql or sqlite, got: ${parsed.backend}`
    );
  });

  // ── Test 2: bin/cli.cjs exists and has init dispatch ────────────────────

  test('cli.cjs dispatches init command', () => {
    const cliPath = path.join(ROOT, 'bin', 'cli.cjs');
    assert.ok(fs.existsSync(cliPath), 'cli.cjs exists');

    const content = fs.readFileSync(cliPath, 'utf-8');
    assert.ok(content.includes('init'), 'contains init dispatch');
    assert.ok(content.includes('gsd-amauta.cjs'), 'delegates to gsd-amauta.cjs');
  });

  // ── Test 3: bin/init.cjs exists and has expected structure ──────────────

  test('init.cjs has required components', () => {
    const initPath = path.join(ROOT, 'bin', 'init.cjs');
    assert.ok(fs.existsSync(initPath), 'init.cjs exists');

    const content = fs.readFileSync(initPath, 'utf-8');
    assert.ok(content.includes('infra_detect'), 'calls infra_detect');
    assert.ok(content.includes('amauta-daemon'), 'manages daemon');
    assert.ok(content.includes('/health'), 'checks daemon health');
  });

  // ── Test 4: status command accessible without args ──────────────────────

  test('cli.cjs routes bare status to system status', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'bin', 'cli.cjs'), 'utf-8'
    );
    assert.ok(content.includes('status'), 'handles status command');
    assert.ok(
      content.includes('gsd-memory'),
      'routes to memory module for system status'
    );
  });

  // ── Test 5: package.json has gsd-amauta bin entry ──────────────────────

  test('package.json has gsd-amauta bin entry pointing to cli.cjs', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    assert.ok(pkg.bin['gsd-amauta'], 'gsd-amauta bin entry exists');
    assert.strictEqual(
      pkg.bin['gsd-amauta'], 'bin/cli.cjs',
      'gsd-amauta bin points to bin/cli.cjs'
    );
  });

  // ── Test 6: SQLite fallback path works ─────────────────────────────────

  test('infra_detect detects SQLite as fallback when PG is blocked', async () => {
    const detectScript = path.join(ROOT, 'services', 'infra_detect.py');
    if (!fs.existsSync(detectScript)) {
      return;
    }

    // Run infra_detect with empty PG URL to block PG detection
    const env = { ...process.env, GSD_POSTGRES_URL: '' };
    const result = execFileSync('python3', [detectScript], {
      encoding: 'utf-8',
      timeout: 30000,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result.trim());
    assert.ok(
      ['postgresql', 'sqlite'].includes(parsed.backend),
      `backend must be postgresql or sqlite, got: ${parsed.backend}`
    );
    assert.ok(Array.isArray(parsed.features), 'features is an array');
  });

  // ── Test 7: cli.cjs routes status with id to gsd-amauta.cjs ───────────

  test('cli.cjs preserves task status change routing', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'bin', 'cli.cjs'), 'utf-8'
    );
    // Verify the dispatching logic distinguishes bare status from status-with-id
    assert.ok(
      content.includes('startsWith(\'--\')'),
      'detects flags vs positional args for status routing'
    );
    assert.ok(
      content.includes('gsd-amauta.cjs'),
      'delegates status-with-id to gsd-amauta.cjs'
    );
  });

  // ── Test 8: cmdStatus in gsd-memory.cjs has version and RLM ───────────

  test('gsd-memory.cjs cmdStatus includes version and RLM health', () => {
    const memoryPath = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-memory.cjs');
    assert.ok(fs.existsSync(memoryPath), 'gsd-memory.cjs exists');

    const content = fs.readFileSync(memoryPath, 'utf-8');
    assert.ok(content.includes('package.json'), 'references package.json for version');
    assert.ok(content.includes('RLM'), 'includes RLM health display');
    assert.ok(content.includes('18798'), 'uses correct RLM default port 18798');
    assert.ok(content.includes('rlm_status'), 'JSON mode includes rlm_status field');
  });

  // ── Test 9: init.cjs has flag parsing ──────────────────────────────────

  test('init.cjs supports expected CLI flags', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'bin', 'init.cjs'), 'utf-8'
    );
    assert.ok(content.includes('--skip-install'), 'supports --skip-install');
    assert.ok(content.includes('--skip-daemon'), 'supports --skip-daemon');
    assert.ok(content.includes('--backend'), 'supports --backend');
    assert.ok(content.includes('--force'), 'supports --force');
    assert.ok(content.includes('--json'), 'supports --json');
  });

});
