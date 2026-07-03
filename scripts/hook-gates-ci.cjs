#!/usr/bin/env node
'use strict';
/**
 * scripts/hook-gates-ci.cjs
 *
 * Phase 67 HOOK-07 — CI mirror of the hook gates. Edits made OUTSIDE the
 * harness (direct pushes, other tools, hooks disabled) must meet the same
 * bar the hook layer enforces at write time. This script runs four
 * independently-reported deterministic checks, reusing gsd-tools.cjs
 * surfaces, with NO hook runtime spawned anywhere in this file.
 *
 * Checks:
 *   1. Allowlist artifact drift  — `gsd-tools.cjs hook-config check`
 *   2. Manifest/plan-shape       — `_validatePlanShape` over every
 *                                  .planning/phases/[N]-.../[NN]-[MM]-PLAN.md
 *                                  with numeric phase >= PHASE_FLOOR
 *   3. Validator verdict presence — every checked ROADMAP.md phase line has
 *                                   a <N>-VERIFICATION.md on disk
 *   4. Hook contract suite       — every tests/67-*.test.cjs passes
 *
 * Flags:
 *   --repo-root <dir>   Injectable root to scan/check (default: process.cwd()).
 *                       Check 1 delegates `--cwd <repo-root>` to gsd-tools.cjs
 *                       so the artifact file it reads/writes is resolved
 *                       against the injected root; the gsd-tools.cjs CODE
 *                       itself is always the copy bundled with THIS script
 *                       (resolved via __dirname), never the injected root's.
 *   --skip-tests        Run checks 1-3 only (skip check 4). Used by the
 *                       sandboxed fixture tests in tests/67-05-ci-mirror.test.cjs
 *                       to stay fast — check 4 spawns real node processes.
 *
 * Exit codes:
 *   0 — all executed checks pass
 *   1 — one or more checks failed
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── Constants (Plan 67-05: CI mirror of the hook gates) ───────────────────
// PHASE_FLOOR scopes check 2's plan-shape enforcement to the concrete-manifest
// era (FIDEL-01 precondition, Phase 59+). Legacy pre-59 plans are grandfathered.
const PHASE_FLOOR = 59;
// Matches ROADMAP.md's checked-checkbox phase lines, e.g.:
//   "- [x] **Phase 59: Phase-File Fidelity (FOUNDATION)** — ..."
const CHECKED_PHASE_RE = /^- \[x\] \*\*Phase (\d+):/gm;
// Matches per-wave plan files under a phase dir, e.g. "67-05-PLAN.md".
const PLAN_FILE_RE = /^\d+-\d+-PLAN\.md$/;

const CHECK_NAMES = {
  ALLOWLIST_DRIFT: 'allowlist_artifact_drift',
  PLAN_SHAPE: 'manifest_plan_shape',
  VERIFICATION_PRESENCE: 'validator_verdict_presence',
  HOOK_CONTRACT_SUITE: 'hook_contract_suite',
};

// gsd-tools.cjs is ALWAYS resolved relative to THIS script (the known-good,
// bundled copy) — never from --repo-root. --repo-root only controls where
// the scanned artifacts/plans/roadmap live (Phase 60 audit-engine
// testability learning: separate "code under test" from "data under test").
const GSD_TOOLS_PATH = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-tools.cjs');

function parseArgs(argv) {
  let repoRoot = process.cwd();
  let skipTests = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo-root') {
      repoRoot = path.resolve(argv[++i] || process.cwd());
    } else if (arg.startsWith('--repo-root=')) {
      repoRoot = path.resolve(arg.slice('--repo-root='.length));
    } else if (arg === '--skip-tests') {
      skipTests = true;
    }
  }
  return { repoRoot, skipTests };
}

// ─── Check 1: allowlist artifact drift ──────────────────────────────────────
function checkAllowlistDrift(repoRoot) {
  const result = spawnSync(process.execPath, [GSD_TOOLS_PATH, 'hook-config', 'check', '--cwd', repoRoot], {
    encoding: 'utf-8',
  });
  const pass = result.status === 0;
  const output = ((result.stdout || '') + (result.stderr || '')).trim();
  return {
    name: CHECK_NAMES.ALLOWLIST_DRIFT,
    pass,
    detail: pass
      ? 'get-shit-done/config/hook-allowlists.json matches single-source constants (no drift)'
      : `hook-config check exited ${result.status}: ${output || '(no output)'}`,
  };
}

// ─── Check 2: manifest/plan-shape discipline ────────────────────────────────
// Scope note (deliberate narrowing, not an oversight): this check uses
// _validatePlanShape (manifest PRECONDITIONS: plan shape validity, manifest
// presence, breadth limits) rather than HARDEN-01's manifestCheck
// (diff-vs-manifest comparison) because CI has no task-claim context — a push
// or PR carries no record of WHICH claimed task's manifest governs WHICH
// subset of the diff, so a diff-vs-manifest comparison is undefined at this
// layer. The write-time manifest gate (67-02) owns diff-vs-manifest
// enforcement where claim context exists; CI enforces everything that is
// deterministically checkable without it. This is a documented narrowing of
// HOOK-07's "same checks" wording.
function checkPlanShape(repoRoot) {
  let gsdTools;
  try {
    gsdTools = require(GSD_TOOLS_PATH);
  } catch (err) {
    return {
      name: CHECK_NAMES.PLAN_SHAPE,
      pass: false,
      detail: `failed to load gsd-tools.cjs module exports: ${err.message}`,
    };
  }
  const { _validatePlanShape } = gsdTools;
  if (typeof _validatePlanShape !== 'function') {
    return {
      name: CHECK_NAMES.PLAN_SHAPE,
      pass: false,
      detail: '_validatePlanShape export not found on gsd-tools.cjs',
    };
  }

  const phasesDir = path.join(repoRoot, '.planning', 'phases');
  if (!fs.existsSync(phasesDir)) {
    return {
      name: CHECK_NAMES.PLAN_SHAPE,
      pass: false,
      detail: `.planning/phases not found under repo root: ${phasesDir}`,
    };
  }

  const failures = [];
  let scanned = 0;
  const phaseDirs = fs.readdirSync(phasesDir).filter((d) => {
    try {
      return fs.statSync(path.join(phasesDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const dirName of phaseDirs) {
    const match = dirName.match(/^(\d+)-/);
    if (!match) continue;
    const phaseNum = parseInt(match[1], 10);
    if (phaseNum < PHASE_FLOOR) continue;

    const dirPath = path.join(phasesDir, dirName);
    const planFiles = fs.readdirSync(dirPath).filter((f) => PLAN_FILE_RE.test(f));
    for (const planFile of planFiles) {
      scanned++;
      const planPath = path.join(dirPath, planFile);
      const relPath = path.relative(repoRoot, planPath);
      let content;
      try {
        content = fs.readFileSync(planPath, 'utf-8');
      } catch (err) {
        failures.push(`${relPath}: unreadable (${err.message})`);
        continue;
      }
      const shapeResult = _validatePlanShape(content);
      if (!shapeResult.valid) {
        const firstError = shapeResult.errors[0];
        const errorMsg = firstError ? `${firstError.code}: ${firstError.message}` : 'invalid shape (no error detail)';
        failures.push(`${relPath}: ${errorMsg}`);
      }
    }
  }

  return {
    name: CHECK_NAMES.PLAN_SHAPE,
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `${scanned} plan(s) at phase >= ${PHASE_FLOOR} all pass _validatePlanShape`
        : `${failures.length}/${scanned} plan(s) failed shape validation: ${failures.join('; ')}`,
  };
}

// ─── Check 3: validator verdict presence ────────────────────────────────────
function checkVerificationPresence(repoRoot) {
  const roadmapPath = path.join(repoRoot, '.planning', 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    return {
      name: CHECK_NAMES.VERIFICATION_PRESENCE,
      pass: false,
      detail: `.planning/ROADMAP.md not found under repo root: ${roadmapPath}`,
    };
  }
  const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
  const phasesDir = path.join(repoRoot, '.planning', 'phases');

  const checkedPhases = [];
  let m;
  const re = new RegExp(CHECKED_PHASE_RE.source, CHECKED_PHASE_RE.flags);
  while ((m = re.exec(roadmapContent)) !== null) {
    checkedPhases.push(parseInt(m[1], 10));
  }

  const missing = [];
  let phaseDirEntries = [];
  if (fs.existsSync(phasesDir)) {
    phaseDirEntries = fs.readdirSync(phasesDir).filter((d) => {
      try {
        return fs.statSync(path.join(phasesDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  for (const phaseNum of checkedPhases) {
    const dirName = phaseDirEntries.find((d) => d.match(new RegExp(`^${phaseNum}-`)));
    const expectedRelPath = path.join('.planning', 'phases', `${phaseNum}-*`, `${phaseNum}-VERIFICATION.md`);
    if (!dirName) {
      missing.push(`Phase ${phaseNum}: no phase directory found (expected ${expectedRelPath})`);
      continue;
    }
    const verificationPath = path.join(phasesDir, dirName, `${phaseNum}-VERIFICATION.md`);
    if (!fs.existsSync(verificationPath)) {
      missing.push(`Phase ${phaseNum}: missing ${path.relative(repoRoot, verificationPath)}`);
    }
  }

  return {
    name: CHECK_NAMES.VERIFICATION_PRESENCE,
    pass: missing.length === 0,
    detail:
      missing.length === 0
        ? `${checkedPhases.length} checked ROADMAP phase(s) all have a VERIFICATION.md`
        : `${missing.length}/${checkedPhases.length} checked phase(s) missing verification: ${missing.join('; ')}`,
  };
}

// ─── Check 4: hook contract suite ───────────────────────────────────────────
// NO hook runtime executes in this file. This check only spawns
// `node <tests/67-*.test.cjs>` files — the contract tests themselves double
// as the CI proof that the enforcement layer honors deny/warn/off/fail-open
// shapes; hook process invocation (if any) happens inside those test files,
// not here.
function checkHookContractSuite(repoRoot) {
  const testsDir = path.join(repoRoot, 'tests');
  if (!fs.existsSync(testsDir)) {
    return {
      name: CHECK_NAMES.HOOK_CONTRACT_SUITE,
      pass: false,
      detail: `tests/ not found under repo root: ${testsDir}`,
    };
  }
  const testFiles = fs
    .readdirSync(testsDir)
    .filter((f) => /^67-.*\.test\.cjs$/.test(f))
    .sort();

  if (testFiles.length === 0) {
    return {
      name: CHECK_NAMES.HOOK_CONTRACT_SUITE,
      pass: false,
      detail: 'no tests/67-*.test.cjs files found',
    };
  }

  for (const file of testFiles) {
    const filePath = path.join(testsDir, file);
    const result = spawnSync(process.execPath, [filePath], { encoding: 'utf-8' });
    if (result.status !== 0) {
      const output = ((result.stdout || '') + (result.stderr || '')).trim();
      return {
        name: CHECK_NAMES.HOOK_CONTRACT_SUITE,
        pass: false,
        detail: `${file} exited ${result.status}: ${output.slice(-1000) || '(no output)'}`,
      };
    }
  }

  return {
    name: CHECK_NAMES.HOOK_CONTRACT_SUITE,
    pass: true,
    detail: `${testFiles.length} tests/67-*.test.cjs file(s) all exit 0: ${testFiles.join(', ')}`,
  };
}

// ─── Summary table + main ───────────────────────────────────────────────────
function printSummary(results) {
  const lines = [];
  lines.push('');
  lines.push('Hook Gates CI Mirror — Summary');
  lines.push('='.repeat(60));
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    lines.push(`[${status}] ${r.name}`);
    lines.push(`       ${r.detail}`);
  }
  lines.push('='.repeat(60));
  const overallPass = results.every((r) => r.pass);
  lines.push(overallPass ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
  return overallPass;
}

function main() {
  const { repoRoot, skipTests } = parseArgs(process.argv.slice(2));

  const results = [];
  results.push(checkAllowlistDrift(repoRoot));
  results.push(checkPlanShape(repoRoot));
  results.push(checkVerificationPresence(repoRoot));
  if (!skipTests) {
    results.push(checkHookContractSuite(repoRoot));
  }

  const overallPass = printSummary(results);
  process.exit(overallPass ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  PHASE_FLOOR,
  CHECKED_PHASE_RE,
  parseArgs,
  checkAllowlistDrift,
  checkPlanShape,
  checkVerificationPresence,
  checkHookContractSuite,
};
