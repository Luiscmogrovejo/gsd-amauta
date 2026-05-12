'use strict';
/**
 * Plan 44-02-04: migrateLegacyCommands() hermetic tests
 * File: tests/init-legacy-migration.test.cjs
 *
 * Requirements covered:
 *   INST-04: Legacy migration .claude/commands/ → .claude/commands.bak.<timestamp>/ atomic rename
 *
 * Tests bin/init.cjs exported migrateLegacyCommands() function via export gate.
 * Hermetic via os.tmpdir() — each test uses an isolated tmpDir passed as opts.cwd.
 *
 * Run: node --test tests/init-legacy-migration.test.cjs
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
// Export gate in bin/init.cjs prevents main() from running on require()
const { migrateLegacyCommands } = require(path.join(ROOT, 'bin', 'init.cjs'));

// Track tmpDirs for cleanup
const tmpDirs = [];

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-migrate-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_e) { /* ignore cleanup errors */ }
  }
});

// ─── Test 1: no legacy commands directory → skip ───────────────────────────

test('no legacy commands directory → skip', () => {
  const tmpDir = mkTmpDir();
  const result = migrateLegacyCommands({ cwd: tmpDir, yes: true });
  assert.equal(result.status, 'skip', 'status should be skip when commands/ missing');
  assert.equal(result.message, 'no legacy commands directory', 'message should match FROZEN skip text');
  assert.equal(result.name, 'legacy_migration', 'name should be legacy_migration');
});

// ─── Test 2: commands/ present, skills/ absent → atomic rename + pass ──────

test('commands/ present, skills/ absent → atomic rename + pass', () => {
  const tmpDir = mkTmpDir();
  // Create .claude/commands/foo.md
  const claudeDir = path.join(tmpDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'foo.md'), '# foo');

  const result = migrateLegacyCommands({ cwd: tmpDir, yes: true });

  assert.equal(result.status, 'pass', 'status should be pass when migration succeeds');
  assert.ok(result.details, 'details should be present');
  assert.ok(typeof result.details.backup_path === 'string', 'backup_path should be a string');
  assert.match(result.details.backup_path, /commands\.bak\./, 'backup_path should contain commands.bak.');
  assert.equal(fs.existsSync(commandsDir), false, '.claude/commands/ should no longer exist after migration');
  // The backup directory should contain foo.md
  assert.equal(fs.existsSync(result.details.backup_path), true, 'backup directory should exist');
  const backupFiles = fs.readdirSync(result.details.backup_path);
  assert.ok(backupFiles.includes('foo.md'), 'backup directory should contain foo.md');
});

// ─── Test 3: timestamp format matches FROZEN 19-char pattern ───────────────

test('timestamp format matches FROZEN YYYY-MM-DDTHH-MM-SS pattern', () => {
  const tmpDir = mkTmpDir();
  const claudeDir = path.join(tmpDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'bar.md'), '# bar');

  const result = migrateLegacyCommands({ cwd: tmpDir, yes: true });

  assert.equal(result.status, 'pass', 'status should be pass');
  assert.ok(result.details && result.details.timestamp, 'timestamp should be present in details');
  assert.match(
    result.details.timestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
    'timestamp must match FROZEN YYYY-MM-DDTHH-MM-SS format (44-CONTEXT.md §Specifics)'
  );
});

// ─── Test 4: commands/ AND skills/ collision (no --force-migrate) → warn ───

test('commands/ AND skills/ collision (no --force-migrate) → warn + non-destructive', () => {
  const tmpDir = mkTmpDir();
  const claudeDir = path.join(tmpDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  const skillsDir = path.join(claudeDir, 'skills');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'foo.md'), '# foo');
  fs.writeFileSync(path.join(skillsDir, 'bar.md'), '# bar');

  const result = migrateLegacyCommands({ cwd: tmpDir, yes: true, forceMigrate: false });

  assert.equal(result.status, 'warn', 'status should be warn on collision without --force-migrate');
  assert.ok(
    result.message.includes('pass --force-migrate to override'),
    'message should include pass --force-migrate to override hint'
  );
  // Must NOT be destructive
  assert.equal(fs.existsSync(commandsDir), true, '.claude/commands/ must still exist — no destructive action');
  assert.equal(fs.existsSync(skillsDir), true, '.claude/skills/ must still exist — no destructive action');
});

// ─── Test 5: --force-migrate bypasses collision guard ──────────────────────

test('--force-migrate bypasses collision guard → rename succeeds', () => {
  const tmpDir = mkTmpDir();
  const claudeDir = path.join(tmpDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  const skillsDir = path.join(claudeDir, 'skills');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'foo.md'), '# foo');
  fs.writeFileSync(path.join(skillsDir, 'bar.md'), '# bar');

  const result = migrateLegacyCommands({ cwd: tmpDir, yes: true, forceMigrate: true });

  assert.equal(result.status, 'pass', 'status should be pass with --force-migrate');
  assert.equal(fs.existsSync(commandsDir), false, '.claude/commands/ should be renamed');
  // backup path should exist
  assert.ok(result.details && fs.existsSync(result.details.backup_path), 'backup directory should exist');
  // Original skills dir should be untouched
  assert.equal(fs.existsSync(skillsDir), true, '.claude/skills/ should remain untouched');
  const skillsFiles = fs.readdirSync(skillsDir);
  assert.ok(skillsFiles.includes('bar.md'), 'skills/bar.md should still exist');
});

// ─── Test 6: idempotency: re-run after migration → skip ────────────────────

test('idempotency: re-run after migration → skip', () => {
  const tmpDir = mkTmpDir();
  const claudeDir = path.join(tmpDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'foo.md'), '# foo');

  // First run — should pass
  const first = migrateLegacyCommands({ cwd: tmpDir, yes: true });
  assert.equal(first.status, 'pass', 'first run should pass');

  // Second run — commands/ no longer exists, should skip
  const second = migrateLegacyCommands({ cwd: tmpDir, yes: true });
  assert.equal(second.status, 'skip', 'second run should skip (idempotent — no state file needed)');
  assert.equal(second.message, 'no legacy commands directory', 'message should be the FROZEN skip message');
});

// ─── Test 7: empty .claude/commands/ counts as missing ─────────────────────

test('empty .claude/commands/ directory counts as missing → skip', () => {
  const tmpDir = mkTmpDir();
  const claudeDir = path.join(tmpDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  // Create commands/ but leave it empty
  fs.mkdirSync(commandsDir, { recursive: true });

  const result = migrateLegacyCommands({ cwd: tmpDir, yes: true });

  assert.equal(result.status, 'skip',
    'empty commands/ should count as missing (false-positive guard per 44-CONTEXT.md §Area 2)');
  assert.equal(result.message, 'no legacy commands directory', 'message should be the FROZEN skip text');
});
