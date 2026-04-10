#!/usr/bin/env node
/**
 * Plan 16-03-01: Regression tests for the milestone-scoped resolver (RESOLVE-01)
 * and the --phase-dir override (RESOLVE-02).
 *
 * These tests replay the exact v2.6/v2.7 dogfood firings (depths 7, 8, 10) plus
 * edge cases and a live smoke test. Historical directory names are used verbatim —
 * no generic v1.0/v2.0 fixtures. Historical specificity is load-bearing.
 *
 * Test cases (>= 10):
 *   01. depth-7/8 replay: phase 15 from v2.7 context returns null (not v2.3/v2.2 ghost)
 *   02. depth-10 replay: phase 16 from v2.7 returns v2.7 dir (not v2.3-phases/16-data-integrity ghost)
 *   03. RESOLVE-02 override: --phase-dir returns exact path even cross-milestone (v2.3)
 *   04. config.json missing: findPhaseInternal returns null
 *   05. malformed current_milestone (empty string): findPhaseInternal returns null
 *   06. --phase-dir nonexistent path: error() fires with "does not exist"
 *   07. --phase-dir empty directory (no PLANs): error() fires with "no PLAN.md files"
 *   08. --phase-dir absolute path accepted and normalized to relative
 *   09. .planning/phases/ secondary location found when milestone dir is absent
 *   10. live smoke: init phase-op 16 from real repo returns v2.7 directory
 *
 * Run: node --test tests/16-init-resolver.test.cjs
 *
 * Temp-dir discipline: each test creates its own temp dir under
 * os.tmpdir() with prefix `gsd-16-resolver-`. On success the dir is removed;
 * on failure the path is logged to stderr and left in place for post-mortem.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const { findPhaseInternal, searchPhaseInDir, normalizePhaseName, toPosixPath } = require(
  path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'core.cjs')
);
const { validatePhaseDirOverride } = require(
  path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'init.cjs')
);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a temp directory tree simulating a project root with .planning/config.json
 * and .planning/milestones/ directories. Returns the tmpDir path.
 *
 * opts:
 *   config    — object written as .planning/config.json (omit to skip)
 *   milestones — { 'v2.7-phases': [ 'dir-name' | { name, plans: ['f.md'] } ], ... }
 *   phases    — array for .planning/phases/ (same structure as milestone subdirs)
 */
function createFixture(opts) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-16-resolver-'));
  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  if (opts.config !== undefined) {
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(opts.config, null, 2));
  }

  if (opts.milestones) {
    const milestonesDir = path.join(planningDir, 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });
    for (const [milestoneDir, phases] of Object.entries(opts.milestones)) {
      const msDir = path.join(milestonesDir, milestoneDir);
      fs.mkdirSync(msDir, { recursive: true });
      for (const phaseEntry of phases) {
        const pDir = path.join(msDir, typeof phaseEntry === 'string' ? phaseEntry : phaseEntry.name);
        fs.mkdirSync(pDir, { recursive: true });
        if (typeof phaseEntry === 'object' && phaseEntry.plans) {
          for (const plan of phaseEntry.plans) {
            fs.writeFileSync(path.join(pDir, plan), '---\nphase: test\n---\n# Test Plan\n');
          }
        }
      }
    }
  }

  if (opts.phases) {
    const phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    for (const phaseEntry of opts.phases) {
      const pDir = path.join(phasesDir, typeof phaseEntry === 'string' ? phaseEntry : phaseEntry.name);
      fs.mkdirSync(pDir, { recursive: true });
      if (typeof phaseEntry === 'object' && phaseEntry.plans) {
        for (const plan of phaseEntry.plans) {
          fs.writeFileSync(path.join(pDir, plan), '---\nphase: test\n---\n# Test Plan\n');
        }
      }
    }
  }

  return tmpDir;
}

function cleanupOrPreserve(tmpDir, err) {
  if (err) {
    process.stderr.write('[preserve] ' + tmpDir + '\n');
    throw err;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

/**
 * Run fn() with process.exit and process.stderr temporarily intercepted.
 * Returns { exitCode, stderrOutput } so tests can assert on error behavior.
 * Restores originals even if fn throws unexpectedly.
 */
function captureError(fn) {
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let capturedExitCode = null;
  let capturedStderr = '';

  process.stderr.write = (msg) => {
    capturedStderr += String(msg);
    return true;
  };

  process.exit = (code) => {
    capturedExitCode = code !== undefined ? Number(code) : 0;
    // Throw a sentinel so execution unwinds out of the function under test.
    throw { __capturedExit: true, code: capturedExitCode };
  };

  try {
    fn();
    // If fn returns normally (no exit called), mark as no-exit.
    capturedExitCode = null;
  } catch (e) {
    if (!e || !e.__capturedExit) {
      process.exit = originalExit;
      process.stderr.write = originalStderrWrite;
      throw e;
    }
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }

  return { exitCode: capturedExitCode, stderrOutput: capturedStderr };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('depth-7/8 replay: phase 15 from v2.7 context returns null (not v2.3 or v2.2 ghost)', () => {
  // Replicates dogfood depths 7 and 8:
  //   v2.7-phases/ has NO phase 15
  //   v2.3-phases/15-data-purge/ exists (archived ghost — depth 7 match)
  //   v2.2-phases/15-dogfood/ exists (archived ghost — depth 8 match)
  //   config.json sets current_milestone: v2.7
  // Resolver must return null, NOT either ghost.
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    milestones: {
      'v2.7-phases': [],
      'v2.3-phases': [{ name: '15-data-purge', plans: ['15-01-PLAN.md'] }],
      'v2.2-phases': [{ name: '15-dogfood', plans: ['15-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '15');
    assert.strictEqual(result, null, 'Must return null — v2.3-phases/15-data-purge and v2.2-phases/15-dogfood are ghosts');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('depth-10 replay: phase 16 from v2.7 returns v2.7 dir (not v2.3-phases/16-data-integrity ghost)', () => {
  // Replicates dogfood depth 10 — the self-referential firing:
  //   v2.7-phases/16-init-resolver-fix/ exists (correct)
  //   v2.3-phases/16-data-integrity/ exists (the ghost that fired at depth 10)
  //   config.json sets current_milestone: v2.7
  // Resolver must return v2.7 directory. This test is the regression guard:
  // if it ever breaks, depth 10 has recurred.
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    milestones: {
      'v2.7-phases': [{ name: '16-init-resolver-fix', plans: ['16-01-PLAN.md'] }],
      'v2.3-phases': [{ name: '16-data-integrity', plans: ['16-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '16');
    assert.ok(result, 'Must find a match in v2.7-phases/');
    assert.ok(
      result.directory.includes('v2.7-phases/16-init-resolver-fix'),
      'Must return v2.7 directory, got: ' + result.directory,
    );
    assert.ok(
      !result.directory.includes('v2.3'),
      'Must NOT return v2.3-phases/16-data-integrity ghost, got: ' + result.directory,
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('RESOLVE-02 override: --phase-dir returns exact path even cross-milestone (v2.3)', () => {
  // RESOLVE-02: override bypasses the milestone-scoped resolver entirely.
  // Even though config says v2.7, passing --phase-dir pointing at a v2.3 archived directory
  // must return THAT directory (the operator explicitly requested a cross-milestone path).
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    milestones: {
      'v2.7-phases': [{ name: '16-init-resolver-fix', plans: ['16-01-PLAN.md'] }],
      'v2.3-phases': [{ name: '16-data-integrity', plans: ['16-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const overridePath = '.planning/milestones/v2.3-phases/16-data-integrity';
    const result = validatePhaseDirOverride(tmpDir, overridePath);
    assert.ok(result, 'Must return a result for the override path');
    assert.ok(
      result.directory.includes('v2.3-phases/16-data-integrity'),
      'Must return the override path, got: ' + result.directory,
    );
    assert.strictEqual(result.override, true, 'Must be marked as override: true');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('config.json missing: findPhaseInternal returns null', () => {
  // When .planning/config.json does not exist, current_milestone is unknown.
  // Resolver must return null (hard stop, not a cross-milestone fallback).
  const tmpDir = createFixture({
    // no config — simulates missing config.json
    milestones: {
      'v2.3-phases': [{ name: '16-data-integrity', plans: ['16-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '16');
    assert.strictEqual(result, null, 'Must return null when config.json is missing');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('malformed current_milestone (empty string): findPhaseInternal returns null', () => {
  // Empty string current_milestone is falsy — same as missing.
  // Resolver must return null, not fall back to archived milestones.
  const tmpDir = createFixture({
    config: { current_milestone: '' },
    milestones: {
      'v2.3-phases': [{ name: '16-data-integrity', plans: ['16-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '16');
    assert.strictEqual(result, null, 'Must return null with empty current_milestone');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('--phase-dir nonexistent path: error() fires with "does not exist"', () => {
  // validatePhaseDirOverride calls error() which calls process.exit(1).
  // We intercept process.exit so the test process is not killed.
  const tmpDir = createFixture({ config: { current_milestone: 'v2.7' } });
  let err;
  try {
    const { exitCode, stderrOutput } = captureError(() => {
      validatePhaseDirOverride(tmpDir, '/nonexistent/path/gsd-16-resolver-test-definitely-missing');
    });
    assert.strictEqual(exitCode, 1, 'Must exit with code 1');
    assert.match(stderrOutput, /does not exist/i, 'Error message must mention "does not exist"');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('--phase-dir empty directory (no PLANs): error() fires with "no PLAN.md files"', () => {
  // validatePhaseDirOverride should hard-error when the directory exists but has no PLAN.md files.
  // It should also suggest sibling directories that have PLANs.
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    milestones: {
      'v2.7-phases': [
        '16-init-resolver-fix',  // empty — no PLAN.md files
        { name: '17-audit-hardening', plans: ['17-01-PLAN.md'] },
      ],
    },
  });
  let err;
  try {
    const { exitCode, stderrOutput } = captureError(() => {
      validatePhaseDirOverride(tmpDir, '.planning/milestones/v2.7-phases/16-init-resolver-fix');
    });
    assert.strictEqual(exitCode, 1, 'Must exit with code 1');
    assert.match(stderrOutput, /no PLAN\.md files/i, 'Error message must mention "no PLAN.md files"');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('--phase-dir absolute path accepted and normalized to relative', () => {
  // RESOLVE-02 accepts absolute paths and normalizes to relative-from-cwd internally.
  // The returned directory must be a relative (non-absolute) POSIX path.
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    milestones: {
      'v2.7-phases': [{ name: '16-init-resolver-fix', plans: ['16-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    const absPath = path.join(tmpDir, '.planning', 'milestones', 'v2.7-phases', '16-init-resolver-fix');
    const result = validatePhaseDirOverride(tmpDir, absPath);
    assert.ok(result, 'Must return a result for absolute path input');
    assert.ok(
      !path.isAbsolute(result.directory),
      'Returned directory must be normalized to relative, got: ' + result.directory,
    );
    assert.ok(
      result.directory.includes('v2.7-phases/16-init-resolver-fix'),
      'Relative path must contain the expected phase directory, got: ' + result.directory,
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('.planning/phases/ secondary location: found when v2.7 milestone dir is absent', () => {
  // findPhaseInternal searches .planning/phases/ as a secondary location after the
  // milestone-scoped directory. This covers the case where phases live outside the
  // milestones/ hierarchy (e.g., tech-debt sweep in a legacy layout).
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    // v2.7-phases does NOT have phase 09 — only .planning/phases/ does
    phases: [{ name: '09-tech-debt-sweep', plans: ['09-01-PLAN.md'] }],
  });
  let err;
  try {
    const result = findPhaseInternal(tmpDir, '9');
    assert.ok(result, 'Must find phase in .planning/phases/ secondary location');
    assert.ok(
      result.directory.includes('phases/09-tech-debt-sweep'),
      'Must return the .planning/phases/ path, got: ' + result.directory,
    );
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('no cross-milestone bleed: v2.7 milestone ignores v2.3-phases/15-data-purge entirely', () => {
  // Belt-and-suspenders: verify the ghost path is literally absent from the result,
  // not just that a non-null result is returned. Specifically checks v2.3-phases/15-data-purge.
  const tmpDir = createFixture({
    config: { current_milestone: 'v2.7' },
    milestones: {
      'v2.7-phases': [{ name: '16-init-resolver-fix', plans: ['16-01-PLAN.md'] }],
      'v2.3-phases': [{ name: '15-data-purge', plans: ['15-01-PLAN.md'] }],
      'v2.2-phases': [{ name: '15-dogfood', plans: ['15-01-PLAN.md'] }],
    },
  });
  let err;
  try {
    // Phase 16 should find v2.7 match
    const result16 = findPhaseInternal(tmpDir, '16');
    assert.ok(result16, 'Phase 16 must be found');
    assert.ok(
      !result16.directory.includes('v2.3-phases/15-data-purge'),
      'Phase 16 result must not bleed into v2.3-phases/15-data-purge',
    );

    // Phase 15 should not find anything (not in v2.7-phases)
    const result15 = findPhaseInternal(tmpDir, '15');
    assert.strictEqual(result15, null, 'Phase 15 must return null — not in current milestone');
  } catch (e) { err = e; }
  cleanupOrPreserve(tmpDir, err);
});

test('live smoke: init phase-op 16 from real repo returns v2.7 directory', () => {
  // Bootstrap transition validator: once RESOLVE-01 ships, the real repo's
  // init call for phase 16 must return the v2.7 directory, not the v2.3 ghost.
  // Failure here means depth 10 has recurred in the actual repo.
  const realCwd = path.resolve(__dirname, '..');
  const result = findPhaseInternal(realCwd, '16');
  assert.ok(result, 'Phase 16 must be found in the real repo');
  assert.ok(
    result.directory.includes('v2.7-phases/16-init-resolver-fix'),
    'Must return v2.7 directory, not v2.3 ghost. Got: ' + result.directory,
  );
  assert.ok(
    !result.directory.includes('v2.3'),
    'Must NOT return v2.3-phases/16-data-integrity. Got: ' + result.directory,
  );
});
