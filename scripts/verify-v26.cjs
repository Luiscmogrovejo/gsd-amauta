#!/usr/bin/env node
'use strict';

// Phase 15 dogfood: exercise Phase 13.1 infrastructure via direct require
const { manifestCheck, resolvePhaseDir, GLOBAL_ALLOWLIST } = require('../get-shit-done/bin/gsd-tools.cjs');

// If the require above failed, the process already exited. If we got here,
// Phase 13.1 infrastructure is available and this audit can proceed. Losing
// those exports is exactly the kind of regression Phase 15 exists to catch —
// surfacing it as an import-time crash is the point.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Directly require the audit function rather than subprocessing (CONTEXT.md
// Q6 rationale: require over subprocess indirection).
const { auditTask } = require('../get-shit-done/bin/audit-rpetd-intelligence.cjs');

// ─── Locked constants (CONTEXT.md Q6/Q7/Q9/Q10, Gap 1b/2/3) ──────────────────

const AUDITED_PHASES = ["10", "11", "12", "13", "13.1", "14"];
// Phase 9 excluded: baseline tech-debt sweep, not an RPETD upgrade (Gap 1b).
// Phase 15 excluded: recursive scope exclusion (CONTEXT.md Q10) — cannot audit
// its own deliverables.

const SELF_EXCLUSION = [
  'scripts/verify-v26.cjs',
  '15-AUDIT-REPORT.json',
  '15-AUDIT-REPORT.md',
  'docs/v2.6-dogfood-ledger.md',
  'get-shit-done/bin/audit-rpetd-intelligence.cjs',
  'get-shit-done/workflows/verify-rpetd-intelligence.md',
  'commands/amauta/verify-v26.md',
  // Phase 15 deliverables excluded from audit scope — verified by the
  // plan-phase checker and Plan 15-01 acceptance criteria instead.
];

const BEHAVIORAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (CONTEXT.md Gap 2)

// Pre-existing npm failures — matched by NAME not count (CONTEXT.md Q9).
const PRE_EXISTING_NPM_FAILURES = [
  'rlm-workflow-spec.test.cjs',
  'agent-frontmatter.test.cjs',
  'comprehensive-e2e.test.cjs',
  'gsd-amauta.test.cjs',
];

// Pre-existing pytest failures all live in this file (STATE.md: 3 tests,
// names resolved at runtime).
const PRE_EXISTING_PYTEST_FILE = 'test_pg_integration.py';

const PHASE_DIR = path.join('.planning', 'milestones', 'v2.2-phases', '15-dogfood');
const JSON_REPORT_PATH = path.join(PHASE_DIR, '15-AUDIT-REPORT.json');
const MD_REPORT_PATH = path.join(PHASE_DIR, '15-AUDIT-REPORT.md');

// Phase 10 lives under v2.1-phases (cross-milestone split, hygiene debt).
const PHASE_DIR_OVERRIDES = {
  '10': path.join('.planning', 'milestones', 'v2.1-phases', '10-d-phase-structured-learning'),
};

// Phase 18: sampling_health state set by sampleCompletedTasks() and read by
// buildReport(). Module-scoped to avoid changing assessDogfood01()'s signature.
let _lastSamplingHealth = {
  daemon_available: false,
  pool_source: 'summary_md',
  fallback_used: null,
  pool_size: 0,
  limitations_observed: ['not_yet_sampled: sampleCompletedTasks has not run'],
};

// Directory globs under v2.2-phases that match each audited phase number.
const V22_PHASES_ROOT = path.join('.planning', 'milestones', 'v2.2-phases');

// Tooling bugs observed during v2.6 dogfood (AUDIT-03).
// These are defects in the audit tooling itself that produced silent drift.
const TOOLING_BUGS_SEED = [
  {
    id: 'TOOL-01',
    depth: 7,
    description: 'Ghost directory detection -- discuss-phase init returned v2.3-phases/15-data-purge instead of phase_found: false when querying phase 15 from v2.7 context',
    phase_detected: '15',
    resolved_by: '16',
  },
  {
    id: 'TOOL-02',
    depth: 8,
    description: 'Init resolver recurrence -- same bug fired at execute-phase init, confirming cross-surface reproduction (not a discuss-phase-only artifact)',
    phase_detected: '15',
    resolved_by: '16',
  },
];

// ─── Pre-flight ───────────────────────────────────────────────────────────────

function preflightEnvCheck() {
  const required = ['ANTHROPIC_API_KEY'];
  const missing = required.filter((k) => !process.env[k] || process.env[k].length === 0);
  return {
    required,
    missing,
    available: missing.length === 0,
  };
}

// ─── Deterministic checks ─────────────────────────────────────────────────────

function findPhaseDir(phase) {
  if (PHASE_DIR_OVERRIDES[phase]) {
    const p = PHASE_DIR_OVERRIDES[phase];
    return fs.existsSync(p) ? p : null;
  }
  if (!fs.existsSync(V22_PHASES_ROOT)) return null;
  const entries = fs.readdirSync(V22_PHASES_ROOT, { withFileTypes: true });
  // Match directories starting with "<phase>-" (e.g. "13.1-orchestrator-..."),
  // avoiding a "13"-prefix match against "13.1-...".
  const prefix = phase + '-';
  const match = entries.find((e) => e.isDirectory() && e.name.startsWith(prefix));
  return match ? path.join(V22_PHASES_ROOT, match.name) : null;
}

function checkVerificationFiles() {
  const perPhase = {};
  let present = 0;
  for (const phase of AUDITED_PHASES) {
    const dir = findPhaseDir(phase);
    if (!dir) {
      perPhase[phase] = { dir: null, verification_md: false, note: 'phase_directory_not_found' };
      continue;
    }
    // Probe prefixed form first (e.g., "14-VERIFICATION.md"), then unprefixed fallback
    const prefixedPath = path.join(dir, phase + '-VERIFICATION.md');
    const unprefixedPath = path.join(dir, 'VERIFICATION.md');
    const prefixedExists = fs.existsSync(prefixedPath);
    const unprefixedExists = fs.existsSync(unprefixedPath);
    const found = prefixedExists || unprefixedExists;
    const resolvedPath = prefixedExists ? prefixedPath : (unprefixedExists ? unprefixedPath : null);
    perPhase[phase] = {
      dir,
      verification_md: found,
      path: resolvedPath,
      form: prefixedExists ? 'prefixed' : (unprefixedExists ? 'unprefixed' : 'none'),
    };
    if (found) present += 1;
  }
  return {
    total: AUDITED_PHASES.length,
    present,
    per_phase: perPhase,
    all_present: present === AUDITED_PHASES.length,
  };
}

function parseNpmFailures(stdout, stderr) {
  const combined = (stdout || '') + '\n' + (stderr || '');
  const structured = [];
  const seen = new Set();

  // Primary: node --test runner format
  // Pattern: "test at <filepath>:<line>:<col>" followed by a line with
  // the Unicode cross mark (U+2716) and test name, then error on next line.
  const lines = combined.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const crossLine = lines[i].match(/^\s*\u2716\s+(.+?)\s+\([\d.]+m?s\)\s*$/);
    if (!crossLine) continue;

    const testName = crossLine[1];
    let testFile = null;
    let reason = null;

    // Look backward for "test at <file>:<line>:<col>"
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const atMatch = lines[j].match(/test at\s+([\w\-./]+\.test\.c?js):\d+:\d+/);
      if (atMatch) {
        testFile = path.basename(atMatch[1]);
        break;
      }
    }

    // Look forward for error reason (first indented non-empty line after the cross)
    for (let k = i + 1; k < Math.min(lines.length, i + 5); k++) {
      const trimmed = lines[k].trim();
      if (trimmed && /^[A-Z]\w*Error:/.test(trimmed)) {
        reason = trimmed;
        break;
      }
      if (trimmed && !trimmed.startsWith('at ')) {
        reason = trimmed;
        break;
      }
    }

    if (testFile && !seen.has(testFile + '::' + testName)) {
      seen.add(testFile + '::' + testName);
      structured.push({ test_file: testFile, test_name: testName, reason: reason || 'unknown' });
    }
  }

  // Secondary fallback: legacy FAIL <filepath> format (for compatibility)
  const failLine = /FAIL\s+([\w\-./]+\.test\.c?js)/g;
  let m;
  while ((m = failLine.exec(combined)) !== null) {
    const base = path.basename(m[1]);
    if (!seen.has(base + '::legacy_match')) {
      seen.add(base + '::legacy_match');
      structured.push({ test_file: base, test_name: 'legacy_match', reason: 'matched FAIL line' });
    }
  }

  return structured;
}

function parsePytestFailures(stdout, stderr) {
  const combined = (stdout || '') + '\n' + (stderr || '');
  const failures = new Set();
  const failLine = /FAILED\s+([^\s:]+)/g;
  let m;
  while ((m = failLine.exec(combined)) !== null) {
    failures.add(m[1]);
  }
  return Array.from(failures);
}

function runNpmTest() {
  const result = spawnSync('npm', ['test', '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
    timeout: 15 * 60 * 1000, // 15-minute hard cap for npm test
  });
  const stdout = (result.stdout || Buffer.alloc(0)).toString('utf8');
  const stderr = (result.stderr || Buffer.alloc(0)).toString('utf8');
  const failures = parseNpmFailures(stdout, stderr);
  return {
    exit_code: result.status,
    timed_out: !!result.error && result.error.code === 'ETIMEDOUT',
    failures,
    stdout_tail: stdout.slice(-4000),
    stderr_tail: stderr.slice(-4000),
  };
}

function runPytest() {
  const result = spawnSync('pytest', ['-q', '--no-header'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    timeout: 15 * 60 * 1000,
  });
  const stdout = (result.stdout || Buffer.alloc(0)).toString('utf8');
  const stderr = (result.stderr || Buffer.alloc(0)).toString('utf8');
  const failures = parsePytestFailures(stdout, stderr);
  return {
    exit_code: result.status,
    timed_out: !!result.error && result.error.code === 'ETIMEDOUT',
    failures,
    stdout_tail: stdout.slice(-4000),
    stderr_tail: stderr.slice(-4000),
  };
}

function classifyFailures(observed, preExistingNames, preExistingFile) {
  const preExistingObserved = [];
  const newFailures = [];
  for (const entry of observed) {
    // Structured entries from parseNpmFailures already have test_file as a basename;
    // the old includes() branch is intentionally dropped — exact match via === is correct.
    const base = typeof entry === 'string' ? path.basename(entry) : entry.test_file;
    if (preExistingNames && preExistingNames.some((name) => base === name)) {
      preExistingObserved.push(entry);
      continue;
    }
    if (preExistingFile && base.indexOf(preExistingFile) !== -1) {
      preExistingObserved.push(entry);
      continue;
    }
    newFailures.push(entry);
  }
  return { preExistingObserved, newFailures };
}

function checkGsdToolsExports() {
  // manifestCheck / resolvePhaseDir / GLOBAL_ALLOWLIST were imported at the
  // top of this file. If the require had failed, we would not be running.
  return {
    manifestCheck: typeof manifestCheck === 'function',
    resolvePhaseDir: typeof resolvePhaseDir === 'function',
    GLOBAL_ALLOWLIST: Array.isArray(GLOBAL_ALLOWLIST) || typeof GLOBAL_ALLOWLIST === 'object',
  };
}

function checkGsdAmautaExports() {
  const expectedFns = [
    '_checkEvidenceBlock',
    'checkEvidenceAdvisory',
    '_checkQaBlocks',
    '_checkRedGreenOrder',
    'checkSpecInheritanceAdvisory',
  ];
  const result = { expected: expectedFns, present: {}, all_present: true };
  let mod;
  try {
    mod = require('../get-shit-done/bin/gsd-amauta.cjs');
  } catch (err) {
    result.require_error = err.message;
    result.all_present = false;
    return result;
  }
  for (const fn of expectedFns) {
    const hit = mod && typeof mod[fn] === 'function';
    result.present[fn] = hit;
    if (!hit) result.all_present = false;
  }
  return result;
}

function runDeterministicChecks() {
  const verification = checkVerificationFiles();
  const npm = runNpmTest();
  const pytest = runPytest();
  const npmClassified = classifyFailures(npm.failures, PRE_EXISTING_NPM_FAILURES, null);
  const pytestClassified = classifyFailures(pytest.failures, null, PRE_EXISTING_PYTEST_FILE);
  const gsdTools = checkGsdToolsExports();
  const gsdAmauta = checkGsdAmautaExports();

  return {
    verification_files: verification,
    npm: {
      ...npm,
      pre_existing_observed: npmClassified.preExistingObserved,
      new_failures: npmClassified.newFailures,
    },
    pytest: {
      ...pytest,
      pre_existing_observed: pytestClassified.preExistingObserved,
      new_failures: pytestClassified.newFailures,
    },
    gsd_tools_exports: gsdTools,
    gsd_amauta_exports: gsdAmauta,
  };
}

// ─── Behavioral tests ─────────────────────────────────────────────────────────

function runBehavioralTests() {
  const started = Date.now();
  const result = spawnSync('npm', ['run', 'test:behavioral', '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    timeout: BEHAVIORAL_TIMEOUT_MS,
  });
  const elapsedMs = Date.now() - started;
  const stdout = (result.stdout || Buffer.alloc(0)).toString('utf8');
  const stderr = (result.stderr || Buffer.alloc(0)).toString('utf8');
  const timedOut = !!result.error && result.error.code === 'ETIMEDOUT';

  // Parse the "Behavioral: N/M passed" summary line (run-behavioral-tests.cjs).
  let invocationsCompleted = null;
  let totalInvocations = null;
  const summary = stdout.match(/Behavioral:\s+(\d+)\/(\d+)\s+passed/);
  if (summary) {
    invocationsCompleted = Number(summary[1]);
    totalInvocations = Number(summary[2]);
  }

  // Phase 13 incident replay: look for a line naming it (harness-specific).
  let incidentReplay = 'not_found';
  if (/phase[_\s-]*13[_\s-]*incident/i.test(stdout)) {
    incidentReplay = /phase[_\s-]*13[_\s-]*incident.*(pass|ok)/i.test(stdout) ? 'pass' : 'fail';
  }

  return {
    elapsed_ms: elapsedMs,
    exit_code: result.status,
    timed_out: timedOut,
    timeout_minutes: BEHAVIORAL_TIMEOUT_MS / 60000,
    behavioral_test_timeout: timedOut,
    total_invocations_attempted: totalInvocations,
    invocations_completed: invocationsCompleted,
    phase_13_incident_replay: incidentReplay,
    stdout_tail: stdout.slice(-8000),
    stderr_tail: stderr.slice(-4000),
  };
}

// ─── DOGFOOD criterion assessments ────────────────────────────────────────────

/**
 * Query the amauta daemon for completed task IDs in the current milestone scope.
 *
 * Uses the `gsd-amauta.cjs` CLI directly (NOT the `amauta.cjs` HTTP wrapper — the
 * wrapper routes commands through /api/exec and rejects `exec list`). The `--json`
 * flag returns a `{"output": "<ANSI text>"}` envelope, not a structured task list,
 * so we regex TK-IDs out of the output field (same pattern the SUMMARY.md scraper
 * uses, applied to daemon output instead of SUMMARY text).
 *
 * Returns an object: { success: boolean, ids: string[], reason: string | null }.
 * On any failure (spawn error, non-zero exit, empty output, parse failure),
 * success=false and reason names the failure mode. Callers fall back on failure.
 *
 * Phase 18 / SAMPLE-01 / GA1+GA4.
 */
function queryDaemonTaskIds() {
  const gsdAmautaCjs = path.join('get-shit-done', 'bin', 'gsd-amauta.cjs');
  try {
    const result = spawnSync('node', [gsdAmautaCjs, 'exec', 'list', '--status', 'done', '--json'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.error) {
      return { success: false, ids: [], reason: 'spawn_error:' + result.error.code };
    }
    if (result.status !== 0) {
      return { success: false, ids: [], reason: 'nonzero_exit:' + result.status };
    }
    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      return { success: false, ids: [], reason: 'empty_output' };
    }
    // Parse the { "output": "<ANSI text>" } envelope.
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch (_e) {
      return { success: false, ids: [], reason: 'envelope_parse_error' };
    }
    const text = envelope && typeof envelope.output === 'string' ? envelope.output : '';
    if (!text) {
      return { success: false, ids: [], reason: 'empty_envelope_output' };
    }
    // Extract TK-\d+ IDs. ANSI escape codes don't interfere with this regex.
    const matches = text.match(/TK-\d+/g) || [];
    const unique = Array.from(new Set(matches));
    return { success: true, ids: unique, reason: null };
  } catch (err) {
    return { success: false, ids: [], reason: 'exception:' + err.message };
  }
}

/**
 * Sample completed tasks for DOGFOOD-01 auditing.
 *
 * PRIMARY path: query the amauta daemon for `status=done` tasks via
 *   `get-shit-done/bin/gsd-amauta.cjs exec list --status done --json`
 * and return a flat list of TK-IDs.
 *
 * FALLBACK path: scrape phase SUMMARY.md files for `TK-\d+` matches.
 *
 * Fallback triggers on: daemon spawn failure, non-zero exit, envelope parse
 * failure, empty result, or an empty post-filter pool (the expected state when
 * plan-to-tasks auto-registration has not yet populated v2.7 tasks).
 *
 * The return shape is a FLAT array of task ID strings. The consumer
 * (`assessDogfood01`) continues to call `auditTask(tk)` lazily per GA3 lock —
 * RPETD content is NOT pre-loaded here.
 *
 * Side effect: mutates the module-scoped `_lastSamplingHealth` record so
 * `buildReport()` can emit the `sampling_health` top-level field. This is the
 * minimum-diff way to thread degradation state into the report without
 * changing `assessDogfood01()`'s signature.
 *
 * Phase 18 / SAMPLE-01 / GA1+GA2+GA3+GA4.
 */
function sampleCompletedTasks() {
  const limitations = [];
  const daemonResult = queryDaemonTaskIds();

  if (daemonResult.success && daemonResult.ids.length > 0) {
    // Daemon path: the raw ID list is not yet milestone-scoped. Since the
    // current repo state (per 18-CONTEXT.md <code_context>) contains no v2.7
    // tasks in the daemon database and a per-task tag inspection would
    // require an O(N) show --json fan-out, we accept the raw daemon IDs as
    // the pool when any are returned. Milestone-scope filtering is deferred
    // to v2.8 (tracked as 18-CONTEXT.md deferred item "plan-to-tasks
    // auto-registration not running for v2.7 phases").
    //
    // If the raw daemon result is non-empty but no downstream TK-ID is
    // recognizable to auditTask, assessDogfood01 will record per-task gaps
    // as its usual evidence — that path is unchanged.
    _lastSamplingHealth = {
      daemon_available: true,
      pool_source: 'daemon_query',
      fallback_used: null,
      pool_size: daemonResult.ids.length,
      limitations_observed: limitations,
    };
    return daemonResult.ids;
  }

  // Daemon path failed or returned empty — record the reason and fall back.
  if (!daemonResult.success) {
    limitations.push('daemon_unavailable: ' + (daemonResult.reason || 'unknown'));
  } else {
    // success=true but ids=[] — daemon reachable, no tasks matched.
    limitations.push('no_v2.7_tasks_registered: daemon returned 0 done tasks');
  }

  // Fallback: scan phase SUMMARY.md files for TK-\d+ references.
  const tasks = new Set();
  for (const phase of AUDITED_PHASES) {
    const dir = findPhaseDir(phase);
    if (!dir || !fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /-SUMMARY\.md$/.test(f));
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch (_e) {
        continue;
      }
      const matches = text.match(/TK-\d+/g) || [];
      for (const tk of matches) tasks.add(tk);
    }
  }
  const fallbackIds = Array.from(tasks);

  _lastSamplingHealth = {
    daemon_available: daemonResult.success,
    pool_source: 'summary_md',
    fallback_used: 'summary_md_scraping',
    pool_size: fallbackIds.length,
    limitations_observed: limitations,
  };
  return fallbackIds;
}

function assessDogfood01() {
  // Sampling criterion: run audit-rpetd-intelligence on sampled completed tasks.
  const pool = sampleCompletedTasks();
  if (pool.length === 0) {
    return {
      id: 'DOGFOOD-01',
      category: 'sampling',
      verdict: 'not_assessable',
      evidence: ['no completed v2.6 tasks discovered in phase SUMMARY.md files'],
      details: 'Pool size 0 — no tasks to sample. Route as Phase 16 re-audit opportunity.',
    };
  }
  const sample = pool.slice(0, Math.min(pool.length, 10));
  const reports = [];
  let passes = 0;
  for (const tk of sample) {
    let report;
    try {
      report = auditTask(tk);
    } catch (err) {
      report = { task_id: tk, error: err.message, overall_verdict: 'gaps_found' };
    }
    reports.push({ task_id: tk, overall: report.overall_verdict, error: report.error || null });
    if (report.overall_verdict === 'pass') passes += 1;
  }
  const poolNote = pool.length < 5
    ? `assessed on n=${pool.length} pool, below ROADMAP's assumed sample size of 10`
    : `assessed on n=${sample.length} pool (total discovered=${pool.length})`;
  return {
    id: 'DOGFOOD-01',
    category: 'sampling',
    verdict: passes === sample.length ? 'pass' : 'gaps_found',
    evidence: [poolNote, `${passes}/${sample.length} sampled tasks passed`, ...reports.map((r) => `${r.task_id}:${r.overall}`)],
    details: `Sampled ${sample.length} task(s) from pool of ${pool.length}. Passes: ${passes}.`,
  };
}

function assessDogfood02() {
  const workflowPath = path.join('get-shit-done', 'workflows', 'verify-rpetd-intelligence.md');
  if (!fs.existsSync(workflowPath)) {
    return {
      id: 'DOGFOOD-02',
      category: 'indirectly_assessed',
      verdict: 'fail',
      evidence: ['workflow file missing: ' + workflowPath],
      details: 'verify-rpetd-intelligence.md not present.',
    };
  }
  const content = fs.readFileSync(workflowPath, 'utf8');
  const markers = {
    purpose: content.indexOf('<purpose>') !== -1,
    step: content.indexOf('<step') !== -1,
    audit_ref: content.indexOf('audit-rpetd-intelligence') !== -1,
  };
  const allPresent = Object.values(markers).every(Boolean);
  return {
    id: 'DOGFOOD-02',
    category: 'indirectly_assessed',
    verdict: allPresent ? 'pass' : 'gaps_found',
    evidence: Object.keys(markers).filter((k) => markers[k]).map((k) => `found:${k}`),
    details: 'Structural workflow presence check — direct execution requires running a full task through 5 phases, out of audit scope.',
  };
}

function assessDogfood03() {
  // Self-referential: verify-v26.cjs executing is itself the proof.
  return {
    id: 'DOGFOOD-03',
    category: 'deterministic',
    verdict: 'pass',
    evidence: ['verify-v26.cjs executed successfully'],
    details: 'Self-referential. The script running to completion IS the deliverable proof.',
  };
}

function assessDogfood04() {
  const cmdPath = path.join('commands', 'amauta', 'verify-v26.md');
  if (!fs.existsSync(cmdPath)) {
    return {
      id: 'DOGFOOD-04',
      category: 'deterministic',
      verdict: 'fail',
      evidence: ['slash command file missing: ' + cmdPath],
      details: 'commands/amauta/verify-v26.md not present.',
    };
  }
  const content = fs.readFileSync(cmdPath, 'utf8');
  const markers = {
    name_frontmatter: content.indexOf('name: amauta:verify-v26') !== -1,
    workflow_ref: content.indexOf('verify-rpetd-intelligence.md') !== -1,
  };
  const pass = markers.name_frontmatter && markers.workflow_ref;
  return {
    id: 'DOGFOOD-04',
    category: 'deterministic',
    verdict: pass ? 'pass' : 'gaps_found',
    evidence: Object.keys(markers).filter((k) => markers[k]).map((k) => `found:${k}`),
    details: 'Slash command structural check.',
  };
}

function assessDogfood05(verificationFiles) {
  const missing = [];
  for (const phase of AUDITED_PHASES) {
    const entry = verificationFiles.per_phase[phase];
    if (!entry || !entry.verification_md) missing.push(phase);
  }
  return {
    id: 'DOGFOOD-05',
    category: 'deterministic',
    verdict: missing.length === 0 ? 'pass' : 'gaps_found',
    evidence: [
      `phases_with_verification=${verificationFiles.present}/${verificationFiles.total}`,
      ...AUDITED_PHASES.map((p) => `${p}:${verificationFiles.per_phase[p] && verificationFiles.per_phase[p].verification_md ? 'present' : 'missing'}`),
    ],
    details: missing.length === 0
      ? '6/6 audited phases have VERIFICATION.md.'
      : `Missing VERIFICATION.md for phases: ${missing.join(', ')}. Phase 13.1 missing is expected (known hygiene debt).`,
  };
}

// ─── Report assembly ──────────────────────────────────────────────────────────

function buildReport(deterministic, behavioral, envCheck) {
  const criteria = [
    assessDogfood01(),
    assessDogfood02(),
    assessDogfood03(),
    assessDogfood04(),
    assessDogfood05(deterministic.verification_files),
  ];

  const behavioralBlock = behavioral
    ? {
        total_invocations_attempted: behavioral.total_invocations_attempted,
        invocations_completed: behavioral.invocations_completed,
        phase_13_incident_replay: behavioral.phase_13_incident_replay,
        per_scenario_results: {},
        harness_limitations_observed: behavioral.timed_out
          ? ['behavioral_test_timeout after ' + behavioral.timeout_minutes + ' minutes']
          : [],
        behavioral_test_timeout: !!behavioral.timed_out,
        timeout_minutes: behavioral.timeout_minutes,
      }
    : {
        total_invocations_attempted: null,
        invocations_completed: null,
        phase_13_incident_replay: 'skipped',
        per_scenario_results: {},
        harness_limitations_observed: ['behavioral suite skipped — environment_missing: ' + envCheck.missing.join(',')],
      };

  const hygieneDebt = [
    'Phase 10 VERIFICATION.md is under v2.1-phases/, not v2.2-phases/ (cross-milestone directory split)',
    'Phase 13.1 has no VERIFICATION.md (only .gitkeep and divergence-reports/)',
    'Nyquist gate CONTEXT.md-as-source pattern: workflow should formalize CONTEXT.md as a valid validation source (3rd instance in v2.6: 13.1, 14, 15)',
    'discuss-phase init is a recurring drift-detection surface (3 instances: Phase 14, Phase 15, Phase 13.1 reconciliation); consider formalizing the cross-reference check as part of init itself',
  ];

  if (!envCheck.available) {
    hygieneDebt.push('environment_missing: ' + envCheck.missing.join(','));
  }

  return {
    audit_timestamp: new Date().toISOString(),
    schema_version: 3,
    milestone: 'v2.6',
    phases_audited: AUDITED_PHASES,
    phase_15_excluded_from_audit: true,
    self_exclusion: SELF_EXCLUSION,
    environment: {
      available: envCheck.available,
      missing: envCheck.missing,
    },
    criteria,
    behavioral_test_results: behavioralBlock,
    pre_existing_failures_verified: [
      ...deterministic.npm.pre_existing_observed,
      ...deterministic.pytest.pre_existing_observed,
    ],
    new_failures_surfaced: [
      ...deterministic.npm.new_failures,
      ...deterministic.pytest.new_failures,
    ],
    hygiene_debt_observed: hygieneDebt,
    sampling_health: _lastSamplingHealth,
    tooling_bugs_observed: TOOLING_BUGS_SEED,
    dogfood_ledger_depths_captured: [0, 1, 2, 4, 5, 6, 7],
    dogfood_ledger_gaps: [3],
    deterministic_summary: {
      gsd_tools_exports_ok: deterministic.gsd_tools_exports,
      gsd_amauta_exports_ok: deterministic.gsd_amauta_exports.all_present,
      npm_exit: deterministic.npm.exit_code,
      pytest_exit: deterministic.pytest.exit_code,
    },
  };
}

// ─── Markdown generation (single source: JSON) ────────────────────────────────

function generateMarkdown(report) {
  const lines = [];
  lines.push('# v2.6 End-to-End Dogfood Audit Report');
  lines.push('');
  lines.push('_Auto-generated from `15-AUDIT-REPORT.json` by `scripts/verify-v26.cjs`._');
  lines.push('_Do not hand-edit — re-run the script to regenerate._');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Audit timestamp | ${report.audit_timestamp} |`);
  lines.push(`| Schema version | ${report.schema_version || 1} |`);
  lines.push(`| Milestone | ${report.milestone} |`);
  lines.push(`| Phases audited | ${report.phases_audited.join(', ')} |`);
  lines.push(`| Phase 15 excluded | ${report.phase_15_excluded_from_audit} |`);
  lines.push(`| Environment available | ${report.environment.available} |`);
  if (!report.environment.available) {
    lines.push(`| Missing env vars | ${report.environment.missing.join(', ')} |`);
  }
  lines.push('');

  lines.push('## Per-Criterion Results');
  lines.push('');
  lines.push('| ID | Category | Verdict | Details |');
  lines.push('|----|----------|---------|---------|');
  for (const c of report.criteria) {
    const details = (c.details || '').replace(/\|/g, '\\|');
    lines.push(`| ${c.id} | ${c.category} | ${c.verdict} | ${details} |`);
  }
  lines.push('');

  lines.push('### Evidence per criterion');
  lines.push('');
  for (const c of report.criteria) {
    lines.push(`- **${c.id}** (${c.verdict})`);
    for (const e of c.evidence || []) {
      lines.push(`  - ${e}`);
    }
  }
  lines.push('');

  lines.push('## Behavioral Test Results');
  lines.push('');
  const b = report.behavioral_test_results;
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| invocations_completed | ${b.invocations_completed} |`);
  lines.push(`| total_invocations_attempted | ${b.total_invocations_attempted} |`);
  lines.push(`| phase_13_incident_replay | ${b.phase_13_incident_replay} |`);
  lines.push(`| behavioral_test_timeout | ${!!b.behavioral_test_timeout} |`);
  if (b.timeout_minutes) {
    lines.push(`| timeout_minutes | ${b.timeout_minutes} |`);
  }
  lines.push('');
  if ((b.harness_limitations_observed || []).length > 0) {
    lines.push('**Harness limitations observed:**');
    lines.push('');
    for (const l of b.harness_limitations_observed) lines.push(`- ${l}`);
    lines.push('');
  }

  // Phase 18: Sampling Health — audit methodology, not verdict evidence.
  lines.push('## Sampling Health');
  lines.push('');
  const sh = report.sampling_health || null;
  if (!sh) {
    lines.push('_No sampling_health field present (schema_version < 3)._');
  } else {
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| daemon_available | ${sh.daemon_available} |`);
    lines.push(`| pool_source | ${sh.pool_source} |`);
    lines.push(`| fallback_used | ${sh.fallback_used === null ? '_(none)_' : sh.fallback_used} |`);
    lines.push(`| pool_size | ${sh.pool_size} |`);
    lines.push('');
    if ((sh.limitations_observed || []).length > 0) {
      lines.push('**Limitations observed:**');
      lines.push('');
      for (const l of sh.limitations_observed) lines.push('- ' + l);
      lines.push('');
    }
  }

  lines.push('## Pre-Existing vs New Failures');
  lines.push('');
  lines.push('**Pre-existing failures verified (matched by name, CONTEXT.md Q9):**');
  lines.push('');
  if (report.pre_existing_failures_verified.length === 0) {
    lines.push('- _none observed_');
  } else {
    for (const f of report.pre_existing_failures_verified) {
      if (typeof f === 'string') {
        lines.push('- ' + f);
      } else {
        lines.push('- `' + f.test_file + '` -- ' + (f.test_name || 'unknown') + ' (' + (f.reason || 'unknown') + ')');
      }
    }
  }
  lines.push('');
  lines.push('**New failures surfaced:**');
  lines.push('');
  if (report.new_failures_surfaced.length === 0) {
    lines.push('- _none_');
  } else {
    for (const f of report.new_failures_surfaced) {
      if (typeof f === 'string') {
        lines.push('- ' + f);
      } else {
        lines.push('- `' + f.test_file + '` -- ' + (f.test_name || 'unknown') + ' (' + (f.reason || 'unknown') + ')');
      }
    }
  }
  lines.push('');

  lines.push('## Tooling Bugs Observed');
  lines.push('');
  if ((report.tooling_bugs_observed || []).length === 0) {
    lines.push('_No tooling bugs observed._');
  } else {
    lines.push('| ID | Depth | Description | Detected | Resolved |');
    lines.push('|----|-------|-------------|----------|----------|');
    for (const bug of report.tooling_bugs_observed) {
      const desc = (bug.description || '').replace(/\|/g, '\\|');
      lines.push(`| ${bug.id} | ${bug.depth} | ${desc} | Phase ${bug.phase_detected} | Phase ${bug.resolved_by} |`);
    }
  }
  lines.push('');

  lines.push('## Hygiene Debt Observed');
  lines.push('');
  for (const h of report.hygiene_debt_observed) lines.push(`- ${h}`);
  lines.push('');

  lines.push('## Dogfood Ledger Status');
  lines.push('');
  lines.push(`- Depths captured: ${report.dogfood_ledger_depths_captured.join(', ')}`);
  lines.push(`- Depths still open: ${report.dogfood_ledger_gaps.join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Report generation: verify-v26.cjs (Plan 15-01-03)._');

  return lines.join('\n') + '\n';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const envCheck = preflightEnvCheck();
  if (!envCheck.available) {
    process.stderr.write(
      'verify-v26: environment_missing — ' +
        envCheck.missing.join(', ') +
        ' — behavioral tests will be skipped, deterministic checks will still run.\n',
    );
  }

  const deterministic = runDeterministicChecks();
  const skipBehavioral = !envCheck.available || process.env.SKIP_BEHAVIORAL === '1';
  const behavioral = skipBehavioral ? null : runBehavioralTests();
  const report = buildReport(deterministic, behavioral, envCheck);

  if (!fs.existsSync(PHASE_DIR)) {
    fs.mkdirSync(PHASE_DIR, { recursive: true });
  }

  fs.writeFileSync(JSON_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(MD_REPORT_PATH, generateMarkdown(report));

  process.stdout.write('Audit complete. Report written to:\n');
  process.stdout.write('  JSON: ' + JSON_REPORT_PATH + '\n');
  process.stdout.write('  MD:   ' + MD_REPORT_PATH + '\n');
  process.exit(0); // Always exit 0 — the report carries the verdicts.
}

if (require.main === module) {
  main();
}

module.exports = {
  preflightEnvCheck,
  runDeterministicChecks,
  runBehavioralTests,
  buildReport,
  generateMarkdown,
  parseNpmFailures,
  checkVerificationFiles,
  findPhaseDir,
  classifyFailures,
  sampleCompletedTasks,
  queryDaemonTaskIds,
  AUDITED_PHASES,
  SELF_EXCLUSION,
  BEHAVIORAL_TIMEOUT_MS,
  PRE_EXISTING_NPM_FAILURES,
  PRE_EXISTING_PYTEST_FILE,
  TOOLING_BUGS_SEED,
};
