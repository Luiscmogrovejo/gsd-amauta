'use strict';
/**
 * Plan 43-03-05: Semgrep Enforcement Determinism Tests
 * File: tests/skill-semgrep-enforcement.test.cjs
 *
 * Requirements covered:
 *   SKILL-04: Semgrep skill tool-boundary enforcement (Phase 43-03)
 *
 * Tests scripts/skill-semgrep-runner.cjs exported functions.
 * Synthesizes fixture SKILL.md files under /tmp/skill-enforcement-test-<pid>/.
 * No live DB or daemon dependency — hermetic.
 *
 * Semgrep-dependent tests skip gracefully when semgrep is not installed
 * (runner exits 2). Tests 6 and 7 are always-runnable.
 *
 * Run: node --test tests/skill-semgrep-enforcement.test.cjs
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runner = require(path.join(ROOT, 'scripts', 'skill-semgrep-runner.cjs'));
const { runEnforcement, loadMutationVerbs, checkSemgrepInstalled } = runner;

// ─── Fixture root ─────────────────────────────────────────────────────────────

const FIXTURE_ROOT = path.join('/tmp', `skill-enforcement-test-${process.pid}`);

// Ensure fixture root is clean
if (fs.existsSync(FIXTURE_ROOT)) {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}
fs.mkdirSync(FIXTURE_ROOT, { recursive: true });

// ─── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

// ─── Helper: write a fixture SKILL.md ────────────────────────────────────────

function writeFixture(subdir, content) {
  const dir = path.join(FIXTURE_ROOT, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}

// ─── Test 1: clean baseline on canonical skills ───────────────────────────────

test('runner returns exit 0 on canonical skills (clean baseline)', (t) => {
  if (!checkSemgrepInstalled()) {
    t.skip('semgrep not installed — asserting exit 2 is the expected warn behavior');
    return;
  }
  const canonicalSkillsDir = path.join(ROOT, 'get-shit-done/skills');
  const { exitCode } = runEnforcement(canonicalSkillsDir);
  assert.strictEqual(
    exitCode,
    0,
    `Expected exit 0 on canonical skills (all read-write), got ${exitCode}`
  );
});

// ─── Test 2: read-only + Edit violation ──────────────────────────────────────

test('runner returns exit 1 on read-only + Edit violation', (t) => {
  if (!checkSemgrepInstalled()) {
    t.skip('semgrep not installed — skipping violation detection test');
    return;
  }

  // NOTE: security_class BEFORE allowed-tools (canonical field order per Plan 43-01)
  const fixtureDir = writeFixture('violation-edit', `---
name: read-only-with-edit
description: "A read-only skill that wrongly includes Edit in allowed-tools."
category: workflow
version: 1.0.0
security_class: read-only
allowed-tools:
  - Read
  - Edit
depends_on: []
---

# Body

This skill incorrectly declares Edit in allowed-tools.
`);

  const { exitCode, findings } = runEnforcement(fixtureDir);
  assert.strictEqual(exitCode, 1, `Expected exit 1 on read-only+Edit, got ${exitCode}`);
  const ruleIds = findings.map(f => f.check_id || '');
  assert.ok(
    ruleIds.some(id => id.includes('skill-read-only-no-write')),
    `Expected skill-read-only-no-write finding, got: ${JSON.stringify(ruleIds)}`
  );
});

// ─── Test 3: missing allowed-tools field ─────────────────────────────────────

test('runner returns exit 1 on missing allowed-tools field', (t) => {
  if (!checkSemgrepInstalled()) {
    t.skip('semgrep not installed — skipping missing-field detection test');
    return;
  }

  // SKILL.md without allowed-tools entirely
  const fixtureDir = writeFixture('violation-no-tools', `---
name: missing-allowed-tools
description: "A skill that omits the allowed-tools field entirely, violating SKILL-04 enforcement."
category: workflow
version: 1.0.0
security_class: read-write
depends_on: []
---

# Body

This skill is missing the required allowed-tools frontmatter field.
`);

  const { exitCode, findings } = runEnforcement(fixtureDir);
  assert.strictEqual(exitCode, 1, `Expected exit 1 on missing allowed-tools, got ${exitCode}`);
  const ruleIds = findings.map(f => f.check_id || '');
  assert.ok(
    ruleIds.some(id => id.includes('skill-allowed-tools-required')),
    `Expected skill-allowed-tools-required finding, got: ${JSON.stringify(ruleIds)}`
  );
});

// ─── Test 4: read-only + bash rm -rf ─────────────────────────────────────────

test('runner returns exit 1 on read-only + bash rm -rf', (t) => {
  if (!checkSemgrepInstalled()) {
    t.skip('semgrep not installed — skipping bash mutation verb detection test');
    return;
  }

  // NOTE: security_class BEFORE allowed-tools (canonical field order per Plan 43-01)
  // Bash tool in allowed-tools is not itself blocked — the CONTENT of the bash block is checked
  const fixtureDir = writeFixture('violation-rm', `---
name: read-only-with-rm
description: "A read-only skill whose bash block uses rm, violating the mutation verb rule."
category: workflow
version: 1.0.0
security_class: read-only
allowed-tools:
  - Read
  - Bash
depends_on: []
---

# Body

This skill incorrectly contains a mutation verb in a Bash block.

\`\`\`bash
rm -rf /tmp/some-dir
\`\`\`
`);

  const { exitCode, findings } = runEnforcement(fixtureDir);
  assert.strictEqual(exitCode, 1, `Expected exit 1 on read-only+bash rm, got ${exitCode}`);
  const ruleIds = findings.map(f => f.check_id || '');
  assert.ok(
    ruleIds.some(id => id.includes('skill-bash-mutation-verbs-readonly')),
    `Expected skill-bash-mutation-verbs-readonly finding, got: ${JSON.stringify(ruleIds)}`
  );
});

// ─── Test 5: clean read-only skill ───────────────────────────────────────────

test('runner returns exit 0 on clean read-only skill', (t) => {
  if (!checkSemgrepInstalled()) {
    t.skip('semgrep not installed — skipping clean read-only validation test');
    return;
  }

  // NOTE: security_class BEFORE allowed-tools (canonical field order per Plan 43-01)
  const fixtureDir = writeFixture('clean-read-only', `---
name: clean-read-only-skill
description: "A correctly declared read-only skill with only allowed tools and no mutation verbs."
category: workflow
version: 1.0.0
security_class: read-only
allowed-tools:
  - Read
  - Grep
  - Glob
depends_on: []
---

# Body

This skill only reads data. It never writes.

## Lookup

\`\`\`bash
grep -r "pattern" .
\`\`\`
`);

  const { exitCode } = runEnforcement(fixtureDir);
  assert.strictEqual(
    exitCode,
    0,
    `Expected exit 0 on clean read-only skill, got ${exitCode}`
  );
});

// ─── Test 6: exit 2 when semgrep unavailable (stubbed) ───────────────────────
// Always-runnable: stubs checkSemgrepInstalled via require.cache module replacement

test('runner returns exit 2 when semgrep unavailable (stubbed)', () => {
  const runnerPath = require.resolve(path.join(ROOT, 'scripts', 'skill-semgrep-runner.cjs'));

  // Save original module exports
  const origModule = require.cache[runnerPath];
  const origExports = origModule ? { ...origModule.exports } : null;

  try {
    // Temporarily replace checkSemgrepInstalled in the cached module
    if (require.cache[runnerPath]) {
      require.cache[runnerPath].exports.checkSemgrepInstalled = () => false;
    }

    // Re-require to get the stubbed version
    const stubbed = require.cache[runnerPath].exports;
    const { exitCode } = stubbed.runEnforcement(path.join(ROOT, 'get-shit-done/skills'));
    assert.strictEqual(exitCode, 2, `Expected exit 2 on semgrep unavailable, got ${exitCode}`);
  } finally {
    // Restore original exports
    if (require.cache[runnerPath] && origExports) {
      require.cache[runnerPath].exports.checkSemgrepInstalled = origExports.checkSemgrepInstalled;
    }
  }
});

// ─── Test 7: loadMutationVerbs reads seed file ────────────────────────────────
// Always-runnable: no semgrep dependency

test('loadMutationVerbs reads the seed file', () => {
  const verbsPath = path.join(ROOT, 'get-shit-done/references/mutation_verbs.txt');
  const verbs = loadMutationVerbs(verbsPath);

  assert.ok(verbs.length >= 14, `Expected >= 14 verbs, got ${verbs.length}`);
  assert.ok(verbs.includes('rm'), `Expected 'rm' in verbs, got: ${JSON.stringify(verbs)}`);
  assert.ok(verbs.includes('mv'), `Expected 'mv' in verbs`);
  assert.ok(verbs.includes('git push'), `Expected 'git push' in verbs`);
  assert.ok(verbs.includes('git commit'), `Expected 'git commit' in verbs`);
  assert.ok(verbs.includes('INSERT'), `Expected 'INSERT' in verbs`);
  assert.ok(verbs.includes('DROP'), `Expected 'DROP' in verbs`);

  // Comment lines should be stripped
  for (const v of verbs) {
    assert.ok(!v.startsWith('#'), `Comment line leaked into verbs: ${v}`);
  }
});
