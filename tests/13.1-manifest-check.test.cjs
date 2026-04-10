#!/usr/bin/env node
/**
 * Plan 13.1-05-02: deterministic manifest-check unit tests (HARDEN-01 coverage).
 *
 * Covers the manifestCheck() utility in get-shit-done/bin/gsd-tools.cjs and
 * the writeGapsReport() helper in get-shit-done/bin/gsd-amauta.cjs. The test
 * is CJS and uses node:test top-level `test(...)` style so that:
 *   grep -cE "^test\(" tests/13.1-manifest-check.test.cjs >= 13
 *
 * Test cases (13 minimum):
 *   01. manifestCheck: pass when actual matches expected exactly
 *   02. manifestCheck: halt on unexpected modify
 *   03. manifestCheck: halt on missing create
 *   04. manifestCheck: allowlist suppresses package-lock.json
 *   05. manifestCheck: orchestrator-owned files always halt (ignoring warn)
 *   06. manifestCheck: GSD_MANIFEST_CHECK=warn downgrades halt to warn
 *   07. manifestCheck: rejects overly broad globs
 *   08. manifestCheck: rename classified as delete + create
 *   09. manifestCheck: missing files_expected key rejected
 *   10. manifestCheck: violation report schema is complete
 *   11. writeGapsReport: writes valid JSON with required schema
 *   12. writeGapsReport: forbids severity field (source-grep defense)
 *   13. behavioral harness: temp dir is preserved on forced failure
 *
 * Run: node --test tests/13.1-manifest-check.test.cjs
 *
 * Temp-dir discipline: each test creates its own temp dir under
 * os.tmpdir() with the prefix `gsd-13.1-manifest-`. On success the dir is
 * removed; on failure the dir path is logged to stderr via console.error
 * and left in place for post-mortem inspection.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const GSD_AMAUTA = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-amauta.cjs');

const tools = require(GSD_TOOLS);
const { manifestCheck, GLOBAL_ALLOWLIST, ORCHESTRATOR_OWNED } = tools;

// Lazy-require amauta.cjs because it has module-scope side effects that we
// only need to exercise for writeGapsReport coverage.
let writeGapsReport;
try {
  process.env.GSD_AMAUTA_NO_AUTO_START = '1';
  process.env.GSD_AMAUTA_PORT = process.env.GSD_AMAUTA_PORT || '19998';
  const amauta = require(GSD_AMAUTA);
  writeGapsReport = amauta.writeGapsReport;
} catch (err) {
  // Fall through — tests 11 and 12 will assert the load error explicitly.
  writeGapsReport = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mkTemp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-13.1-manifest-${label}-`));
  return dir;
}

function cleanupOrPreserve(tmpDir, err) {
  if (err) {
    console.error(`[preserve] ${tmpDir}`);
    throw err;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

function initRepo(tmpDir) {
  execSync('git init -q', { cwd: tmpDir });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir });
  execSync('git config user.name "test"', { cwd: tmpDir });
  execSync('git config commit.gpgsign false', { cwd: tmpDir });
}

function commitAll(tmpDir, message) {
  execSync('git add -A', { cwd: tmpDir });
  execSync(`git commit -q --allow-empty -m "${message}"`, { cwd: tmpDir });
  return execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
}

function writeFile(tmpDir, rel, content) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('manifestCheck: pass when actual matches expected exactly', async () => {
  const tmp = mkTemp('pass-exact');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'a.txt', 'initial\n');
    const before = commitAll(tmp, 'baseline');
    writeFile(tmp, 'a.txt', 'changed\n');
    const after = commitAll(tmp, 'task-commit');

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-PASS',
      filesExpected: { modify: ['a.txt'], create: [], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      cwd: tmp,
    });

    assert.equal(res.ok, true);
    assert.equal(res.action, 'pass');
    assert.equal(res.reportPath, null);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: halt on unexpected modify', async () => {
  const tmp = mkTemp('halt-unexpected-modify');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'a.txt', 'a0\n');
    writeFile(tmp, 'b.txt', 'b0\n');
    const before = commitAll(tmp, 'baseline');
    writeFile(tmp, 'a.txt', 'a1\n');
    writeFile(tmp, 'b.txt', 'b1\n');
    const after = commitAll(tmp, 'task-commit');

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-HALT-MOD',
      filesExpected: { modify: ['a.txt'], create: [], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      cwd: tmp,
    });

    assert.equal(res.ok, false);
    assert.equal(res.action, 'halt');
    assert.ok(res.reportPath, 'expected violation report path');
    const report = JSON.parse(fs.readFileSync(res.reportPath, 'utf-8'));
    assert.ok(
      report.violations.unexpected_modifies.includes('b.txt'),
      'b.txt should be flagged as unexpected_modify',
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: halt on missing create', async () => {
  const tmp = mkTemp('halt-missing-create');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'seed.txt', 'seed\n');
    const before = commitAll(tmp, 'baseline');
    // Executor did nothing — empty task commit
    const after = commitAll(tmp, 'task-commit');

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-HALT-MISSING',
      filesExpected: { modify: [], create: ['new.txt'], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      cwd: tmp,
    });

    assert.equal(res.ok, false);
    assert.equal(res.action, 'halt');
    const report = JSON.parse(fs.readFileSync(res.reportPath, 'utf-8'));
    assert.ok(
      report.violations.missing_creates.includes('new.txt'),
      'new.txt should be flagged as missing_create',
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: allowlist suppresses package-lock.json', async () => {
  const tmp = mkTemp('allowlist-pkglock');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'package-lock.json', '{"version":0}\n');
    const before = commitAll(tmp, 'baseline');
    writeFile(tmp, 'package-lock.json', '{"version":1}\n');
    const after = commitAll(tmp, 'task-commit');

    // Sanity — GLOBAL_ALLOWLIST must include package-lock.json
    assert.ok(
      GLOBAL_ALLOWLIST.includes('package-lock.json'),
      'GLOBAL_ALLOWLIST must include package-lock.json',
    );

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-ALLOWLIST',
      filesExpected: { modify: [], create: [], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      cwd: tmp,
    });

    assert.equal(res.ok, true);
    assert.equal(res.action, 'pass');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: orchestrator-owned files always halt', async () => {
  const tmp = mkTemp('halt_orchestrator_owned');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, '.planning/STATE.md', '# state\n');
    const before = commitAll(tmp, 'baseline');
    writeFile(tmp, '.planning/STATE.md', '# state changed\n');
    const after = commitAll(tmp, 'task-commit');

    assert.ok(
      ORCHESTRATOR_OWNED.includes('.planning/STATE.md'),
      'ORCHESTRATOR_OWNED must include .planning/STATE.md',
    );

    // Even with GSD_MANIFEST_CHECK=warn, orchestrator-owned must halt.
    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-OWNED',
      filesExpected: { modify: [], create: [], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      envOverride: 'warn',
      cwd: tmp,
    });

    assert.equal(res.ok, false);
    assert.equal(res.action, 'halt_orchestrator_owned');
    const report = JSON.parse(fs.readFileSync(res.reportPath, 'utf-8'));
    assert.equal(report.orchestrator_action, 'halt_orchestrator_owned');
    assert.ok(
      Array.isArray(report.orchestrator_owned_hits)
        && report.orchestrator_owned_hits.includes('.planning/STATE.md'),
      'report should list orchestrator_owned_hits',
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: GSD_MANIFEST_CHECK=warn downgrades halt to warn', async () => {
  const tmp = mkTemp('warn-downgrade');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'x.txt', 'x0\n');
    const before = commitAll(tmp, 'baseline');
    writeFile(tmp, 'x.txt', 'x1\n');
    const after = commitAll(tmp, 'task-commit');

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-WARN',
      filesExpected: { modify: [], create: [], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      envOverride: 'warn',
      cwd: tmp,
    });

    assert.equal(res.ok, true);
    assert.equal(res.action, 'warn');
    assert.ok(res.reportPath, 'report should still be written in warn mode');
    const report = JSON.parse(fs.readFileSync(res.reportPath, 'utf-8'));
    assert.equal(report.orchestrator_action, 'warn');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: rejects overly broad globs', async () => {
  const tmp = mkTemp('broad-glob');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'seed.txt', 'seed\n');
    const sha = commitAll(tmp, 'baseline');

    let threw = false;
    let msg = '';
    try {
      await manifestCheck({
        phase: '13.1',
        wave: 1,
        taskId: 'TK-BROAD',
        filesExpected: { modify: ['**/*.md'], create: [], delete: [] },
        gitShaBefore: sha,
        gitShaAfter: sha,
        cwd: tmp,
      });
    } catch (e) {
      threw = true;
      msg = e.message;
    }
    assert.equal(threw, true, 'expected manifestCheck to reject broad glob');
    assert.match(msg, /overly broad|invalid/i);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: rename classified as delete + create', async () => {
  const tmp = mkTemp('rename');
  let err;
  try {
    initRepo(tmp);
    // Give the file enough content that git recognises the move as a rename
    // instead of a delete+add pair.
    const longContent = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    writeFile(tmp, 'old.txt', longContent);
    const before = commitAll(tmp, 'baseline');
    execSync('git mv old.txt new.txt', { cwd: tmp });
    const after = commitAll(tmp, 'rename-commit');

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-RENAME',
      filesExpected: { modify: [], create: ['new.txt'], delete: ['old.txt'] },
      gitShaBefore: before,
      gitShaAfter: after,
      cwd: tmp,
    });

    assert.equal(res.ok, true, `rename should satisfy delete+create manifest, got ${JSON.stringify(res)}`);
    assert.equal(res.action, 'pass');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: missing files_expected key rejected', async () => {
  const tmp = mkTemp('missing-key');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'seed.txt', 'seed\n');
    const sha = commitAll(tmp, 'baseline');

    let threw = false;
    let msg = '';
    try {
      await manifestCheck({
        phase: '13.1',
        wave: 1,
        taskId: 'TK-MISSKEY',
        // delete key missing entirely
        filesExpected: { modify: [], create: [] },
        gitShaBefore: sha,
        gitShaAfter: sha,
        cwd: tmp,
      });
    } catch (e) {
      threw = true;
      msg = e.message;
    }
    assert.equal(threw, true, 'expected missing-key rejection');
    assert.match(msg, /must declare all of modify, create, delete/);
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('manifestCheck: violation report schema is complete', async () => {
  const tmp = mkTemp('report-schema');
  let err;
  try {
    initRepo(tmp);
    writeFile(tmp, 'c.txt', 'c0\n');
    const before = commitAll(tmp, 'baseline');
    writeFile(tmp, 'c.txt', 'c1\n');
    const after = commitAll(tmp, 'task-commit');

    const res = await manifestCheck({
      phase: '13.1',
      wave: 1,
      taskId: 'TK-SCHEMA',
      // Declare an expected create that will not happen — forces halt and
      // therefore a written report.
      filesExpected: { modify: ['c.txt'], create: ['does-not-exist.txt'], delete: [] },
      gitShaBefore: before,
      gitShaAfter: after,
      cwd: tmp,
    });

    assert.equal(res.action, 'halt');
    assert.ok(res.reportPath, 'report path must exist on halt');
    const report = JSON.parse(fs.readFileSync(res.reportPath, 'utf-8'));
    // Mandatory fields per 13.1-CONTEXT.md HARDEN-01 schema.
    const mandatory = [
      'phase',
      'wave',
      'task_id',
      'expected',
      'actual',
      'violations',
      'git_sha_before',
      'git_sha_after',
      'timestamp',
      'orchestrator_action',
    ];
    for (const f of mandatory) {
      assert.ok(f in report, `missing mandatory field: ${f}`);
    }
  } catch (e) { err = e; }
  cleanupOrPreserve(tmp, err);
});

test('writeGapsReport: writes valid JSON with required schema', async () => {
  assert.ok(typeof writeGapsReport === 'function',
    'writeGapsReport must be exported from gsd-amauta.cjs');

  const tmp = mkTemp('gaps-report');
  const originalCwd = process.cwd();
  let err;
  try {
    process.chdir(tmp);
    const reportPath = writeGapsReport(
      '13.1-test',
      'TK-TEST',
      [{ requirement_id: 'HARDEN-01', description: 'x' }],
      ['cosmetic: y'],
    );
    assert.ok(fs.existsSync(reportPath), 'gaps report file should exist');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    assert.equal(report.phase, '13.1-test');
    assert.equal(report.task_id, 'TK-TEST');
    assert.equal(report.verdict, 'gaps_found');
    assert.ok(Array.isArray(report.gaps));
    assert.equal(report.gaps.length, 1);
    assert.equal(report.gaps[0].requirement_id, 'HARDEN-01');
    assert.equal(report.gaps[0].description, 'x');
    assert.ok(Array.isArray(report.non_gaps_observations));
    assert.equal(report.non_gaps_observations.length, 1);
    assert.equal(report.non_gaps_observations[0], 'cosmetic: y');
    assert.ok(typeof report.timestamp === 'string');
    // No severity anywhere on gaps entries.
    for (const gap of report.gaps) {
      assert.ok(!('severity' in gap), 'gap entries must not carry a severity key');
    }
  } catch (e) { err = e; }
  process.chdir(originalCwd);
  cleanupOrPreserve(tmp, err);
});

test('writeGapsReport: forbids severity field (source-grep defense)', () => {
  // Defense-in-depth: scan the source file for any "severity" mention inside
  // the writeGapsReport / cmdValidate range. We search the whole file and
  // allow occurrences only in comments if any (we expect zero matches).
  const src = fs.readFileSync(GSD_AMAUTA, 'utf-8');

  // Find the bounds of writeGapsReport + cmdValidate's --gaps-found branch.
  const startIdx = src.indexOf('function writeGapsReport');
  assert.ok(startIdx >= 0, 'writeGapsReport function not found');
  // End at the next top-level function or switch case after cmdValidate's
  // gaps_found branch — we conservatively slice 4000 chars forward which
  // covers the full gaps-found branch based on current layout.
  const slice = src.slice(startIdx, startIdx + 4000);

  const matches = slice.match(/"severity"/g) || [];
  assert.equal(matches.length, 0,
    `writeGapsReport range must not mention "severity", found ${matches.length} matches`);

  const singleQuoted = slice.match(/'severity'/g) || [];
  assert.equal(singleQuoted.length, 0,
    `writeGapsReport range must not mention 'severity', found ${singleQuoted.length} matches`);
});

test('behavioral harness: temp dir is preserved on forced failure', () => {
  // Meta-test: guards tests/13.1-divergence-protocol.integration.test.cjs
  // against regressions that re-introduce `afterEach(cleanup)`,
  // `beforeEach`, or `finally { cleanup }`. Any of these destroys the
  // preserved temp dir on behavioral-test failure, which defeats the
  // HARDEN-05 post-mortem contract.
  //
  // This test runs on every `npm test` (it lives in the deterministic suite).
  // It is NOT gated on the behavioral runner.
  const integrationPath = path.join(
    REPO_ROOT,
    'tests',
    '13.1-divergence-protocol.integration.test.cjs',
  );
  assert.ok(
    fs.existsSync(integrationPath),
    'behavioral integration test file must exist — plan 13.1-05-03 prerequisite',
  );

  const src = fs.readFileSync(integrationPath, 'utf-8');

  const afterEachHits = (src.match(/afterEach/g) || []).length;
  assert.equal(afterEachHits, 0,
    `integration test must not register afterEach hooks (found ${afterEachHits}) — ` +
    'they destroy the preserved temp dir on failure');

  const beforeEachHits = (src.match(/beforeEach/g) || []).length;
  assert.equal(beforeEachHits, 0,
    `integration test must not register beforeEach hooks (found ${beforeEachHits})`);

  const finallyCleanupHits = (src.match(/finally\s*\{[^}]*cleanup/g) || []).length;
  assert.equal(finallyCleanupHits, 0,
    `integration test must not wrap cleanup in finally{} (found ${finallyCleanupHits}) — ` +
    'finally runs on both success and failure, destroying the preserved artifact');

  // Positive assertion: the "preserve on failure" marker must be present
  // so reviewers can grep-verify the pattern is in place.
  const preserveMarkerHits = (src.match(/preserve on failure/g) || []).length;
  assert.ok(preserveMarkerHits >= 3,
    `integration test must include at least 3 "preserve on failure" markers, ` +
    `found ${preserveMarkerHits}`);
});
