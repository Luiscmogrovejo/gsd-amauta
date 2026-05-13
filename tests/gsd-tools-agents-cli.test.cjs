'use strict';
/**
 * tests/gsd-tools-agents-cli.test.cjs — Phase 52 Wave 4 CLI surface integration
 *
 * Tests the gsd-tools agents + bin/cli.cjs agents dispatch via subprocess invocation.
 * Does NOT call agentCompiler.compile() directly — those unit tests live in
 * tests/agent-compiler.test.cjs (52-03-02). This file tests CLI surface ONLY.
 *
 * Tests:
 *   1. gsd-tools agents (no action) prints Usage to stdout and exits 0
 *   2. gsd-tools agents list emits JSON array of 17 agents
 *   3. gsd-tools agents validate <valid-dir> exits 0
 *   4. gsd-tools agents validate <missing-dir> exits non-zero
 *   5. gsd-tools agents compile --target=claude-code --dry-run compiled.length === 17
 *   6. gsd-tools agents compile --target=invalid-ide exits 2 + stderr 'unknown target'
 *   7. gsd-tools agents compile (no --target) exits 1 + stderr '--target'
 *   8. bin/cli.cjs agents list same output as gsd-tools.cjs agents list
 *
 * Run: node --test tests/gsd-tools-agents-cli.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const CLI = path.join(ROOT, 'bin', 'cli.cjs');
const NODE = process.execPath;

/**
 * Run a command via execFileSync, capture stdout + stderr.
 * Returns { stdout, stderr, status }.
 * Never throws — captures exit code from the SpawnSyncReturns-compatible
 * try/catch pattern.
 */
function run(args, opts) {
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    ...(opts || {}),
  };
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    stdout = execFileSync(NODE, args, options);
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    status = e.status || 1;
  }
  return { stdout, stderr, status };
}

/**
 * Parse JSON from the last contiguous JSON block in output.
 * Handles dry-run prefix lines like "[dry-run] Would write: ..." that appear
 * on stdout before the JSON payload.
 */
function extractJson(output) {
  const jsonStart = output.indexOf('{');
  if (jsonStart === -1) throw new Error(`No JSON found in output: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(jsonStart));
}

// ─── Test 1: no-action prints Usage to stdout, exits 0 ───────────────────────

test('gsd-tools agents (no action) prints Usage to stdout and exits 0', () => {
  const { stdout, status } = run([GSD_TOOLS, 'agents']);
  assert.equal(status, 0, `Expected exit 0, got ${status}`);
  assert.ok(
    stdout.includes('Usage: gsd-tools agents'),
    `Expected Usage banner on stdout, got: ${stdout.slice(0, 300)}`
  );
});

// ─── Test 2: list emits JSON array of 17 agents ───────────────────────────────

test('gsd-tools agents list emits JSON array of 17 agents', () => {
  const { stdout, status } = run([GSD_TOOLS, 'agents', 'list', '--source=get-shit-done/agents']);
  assert.equal(status, 0, `Expected exit 0, got ${status}`);

  let agents;
  try {
    agents = JSON.parse(stdout);
  } catch (e) {
    assert.fail(`stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }

  assert.ok(Array.isArray(agents), `Expected JSON array, got ${typeof agents}`);
  assert.equal(agents.length, 17, `Expected 17 agents, got ${agents.length}`);
  for (const agent of agents) {
    assert.ok(
      typeof agent.name === 'string' && agent.name.startsWith('gsd-'),
      `Agent .name should start with 'gsd-', got: ${agent.name}`
    );
  }
});

// ─── Test 3: validate valid-dir exits 0 ──────────────────────────────────────

test('gsd-tools agents validate <valid-dir> exits 0', () => {
  const agentDir = path.join(ROOT, 'get-shit-done', 'agents', 'gsd-planner');
  const { stdout, stderr, status } = run([GSD_TOOLS, 'agents', 'validate', agentDir]);
  assert.equal(
    status, 0,
    `Expected exit 0 for valid agent dir, got ${status}. stderr: ${stderr}`
  );
});

// ─── Test 4: validate missing-dir exits non-zero ─────────────────────────────

test('gsd-tools agents validate <missing-dir> exits non-zero', () => {
  const missingDir = '/tmp/nonexistent-agent-dir-52-04-xxx';
  const { status } = run([GSD_TOOLS, 'agents', 'validate', missingDir]);
  assert.notEqual(status, 0, `Expected non-zero exit for missing agent dir, got 0`);
});

// ─── Test 5: compile --target=claude-code --dry-run compiled.length === 17 ───

test('gsd-tools agents compile --target=claude-code --dry-run has 17 compiled entries', () => {
  const { stdout, stderr, status } = run([
    GSD_TOOLS, 'agents', 'compile',
    '--target=claude-code',
    '--dry-run',
  ]);
  assert.equal(
    status, 0,
    `Expected exit 0 for dry-run compile, got ${status}. stderr: ${stderr}`
  );

  let result;
  try {
    result = extractJson(stdout);
  } catch (e) {
    assert.fail(`Could not parse JSON from compile output: ${e.message}. stdout: ${stdout.slice(0, 300)}`);
  }

  assert.ok(Array.isArray(result.compiled), `Expected result.compiled to be an array`);
  assert.equal(
    result.compiled.length, 17,
    `Expected 17 compiled entries, got ${result.compiled.length}`
  );
});

// ─── Test 6: compile --target=invalid-ide exits 2, stderr contains 'unknown target' ──

test('gsd-tools agents compile --target=invalid-ide exits 2 with unknown target error', () => {
  const { stderr, status } = run([GSD_TOOLS, 'agents', 'compile', '--target=foo-bar-invalid']);
  assert.equal(status, 2, `Expected exit 2 for unknown target, got ${status}`);
  assert.ok(
    stderr.toLowerCase().includes('unknown target'),
    `Expected 'unknown target' in stderr, got: ${stderr.slice(0, 200)}`
  );
});

// ─── Test 7: compile (no --target) exits 1, stderr contains '--target' ────────

test('gsd-tools agents compile without --target exits 1 with --target hint in stderr', () => {
  const { stderr, status } = run([GSD_TOOLS, 'agents', 'compile']);
  assert.equal(status, 1, `Expected exit 1 for missing --target, got ${status}`);
  assert.ok(
    stderr.includes('--target'),
    `Expected '--target' hint in stderr, got: ${stderr.slice(0, 200)}`
  );
});

// ─── Test 8: bin/cli.cjs agents list deep-equals gsd-tools.cjs agents list ───

test('bin/cli.cjs agents list produces same output as gsd-tools.cjs agents list', () => {
  const toolsResult = run([GSD_TOOLS, 'agents', 'list']);
  assert.equal(toolsResult.status, 0, `gsd-tools agents list failed with exit ${toolsResult.status}`);

  const cliResult = run([CLI, 'agents', 'list']);
  assert.equal(cliResult.status, 0, `bin/cli.cjs agents list failed with exit ${cliResult.status}`);

  let toolsAgents, cliAgents;
  try {
    toolsAgents = JSON.parse(toolsResult.stdout);
  } catch (e) {
    assert.fail(`gsd-tools.cjs agents list stdout is not valid JSON: ${toolsResult.stdout.slice(0, 200)}`);
  }
  try {
    cliAgents = JSON.parse(cliResult.stdout);
  } catch (e) {
    assert.fail(`bin/cli.cjs agents list stdout is not valid JSON: ${cliResult.stdout.slice(0, 200)}`);
  }

  assert.deepEqual(
    toolsAgents, cliAgents,
    'bin/cli.cjs agents list output should deep-equal gsd-tools.cjs agents list output'
  );
});
