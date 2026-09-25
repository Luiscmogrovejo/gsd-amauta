#!/usr/bin/env node
'use strict';

// audit-rpetd-intelligence.cjs — Plan 15-01-01 (DOGFOOD-01)
//
// Standalone binary that audits a completed task's RPETD content for the
// v2.6 intelligence upgrades:
//   D-phase: structured LEARNING fields (WHAT / WHY / WHEN / TAGS)
//   E-phase: PRE_EXECUTION_EVIDENCE block with at least one required subfield
//   T-phase: inherited_success_criteria + EDGE_CASES + REGRESSION blocks
//
// Usage:
//   audit-rpetd-intelligence.cjs <task_id>
//
// Dogfood requirement (CONTEXT.md Q6): this binary require()s gsd-tools.cjs
// exports directly rather than subprocessing them. The resolvePhaseDir import
// exercises the Phase 13.1 infrastructure at require-time — if the exports
// disappear, this binary fails loudly instead of silently continuing.

// eslint-disable-next-line no-unused-vars
const { resolvePhaseDir } = require('./gsd-tools.cjs');
const { spawnSync } = require('child_process');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

const AMAUTA_CJS = path.join(__dirname, 'amauta.cjs');
const AMAUTA_TIMEOUT_MS = 15000;

// D-phase required structured-learning fields (Phase 10 / LEARN-01)
const D_REQUIRED_FIELDS = ['WHAT', 'WHY', 'WHEN', 'TAGS'];

// E-phase required evidence block marker (Phase 11 / EXEC-01)
const E_EVIDENCE_BLOCK = 'PRE_EXECUTION_EVIDENCE:';
const E_EVIDENCE_SUBFIELDS = [
  'failure_patterns_queried',
  'best_practices_queried',
  'existing_style_queried',
  'security_checklist',
];

// T-phase required QA / spec-inheritance blocks (Phase 12 / QA-01, QA-02)
const T_REQUIRED_BLOCKS = ['inherited_success_criteria', 'EDGE_CASES:', 'REGRESSION:'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printUsage() {
  process.stderr.write('Usage: audit-rpetd-intelligence.cjs <task_id>\n');
}

function fetchTask(taskId) {
  const result = spawnSync('node', [AMAUTA_CJS, 'show', taskId, '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: AMAUTA_TIMEOUT_MS,
    env: { ...process.env },
  });

  if (result.error) {
    return { ok: false, error: 'spawn_error: ' + result.error.message };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || Buffer.alloc(0)).toString('utf8').trim();
    return {
      ok: false,
      error:
        'amauta_show_failed: exit ' +
        result.status +
        (stderr ? ' — ' + stderr : ''),
    };
  }

  const stdout = (result.stdout || Buffer.alloc(0)).toString('utf8');
  try {
    return { ok: true, task: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, error: 'json_parse_failed: ' + err.message };
  }
}

function getPhaseContent(task, phaseKey) {
  // Tolerate several shapes: rpetd.R / rpetd.r / rpetd.R.content / rpetd.R string
  if (!task || typeof task !== 'object') return '';
  const rpetd = task.rpetd;
  if (!rpetd || typeof rpetd !== 'object') return '';
  const upper = phaseKey.toUpperCase();
  const lower = phaseKey.toLowerCase();
  const entry = rpetd[upper] !== undefined ? rpetd[upper] : rpetd[lower];
  if (entry === undefined || entry === null) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object') {
    if (typeof entry.content === 'string') return entry.content;
    if (typeof entry.text === 'string') return entry.text;
  }
  return '';
}

function hasRpetd(task) {
  if (!task || typeof task !== 'object') return false;
  const rpetd = task.rpetd;
  if (!rpetd || typeof rpetd !== 'object') return false;
  return Object.keys(rpetd).length > 0;
}

// Case-insensitive WHAT:/WHY:/WHEN:/TAGS: scan.
function checkDPhase(content) {
  const evidence = [];
  const missingFields = [];
  if (!content) {
    return {
      verdict: 'gaps_found',
      evidence: ['d_phase_empty'],
      missing_fields: D_REQUIRED_FIELDS.slice(),
    };
  }
  for (const field of D_REQUIRED_FIELDS) {
    const re = new RegExp('(^|\\s)' + field + '\\s*:', 'i');
    if (re.test(content)) {
      evidence.push('found:' + field);
    } else {
      missingFields.push(field);
    }
  }
  return {
    verdict: missingFields.length === 0 ? 'pass' : 'gaps_found',
    evidence,
    missing_fields: missingFields,
  };
}

// Case-sensitive PRE_EXECUTION_EVIDENCE: scan with subfield check.
function checkEPhase(content) {
  const evidence = [];
  if (!content) {
    return { verdict: 'gaps_found', evidence: ['e_phase_empty'] };
  }
  if (content.indexOf(E_EVIDENCE_BLOCK) === -1) {
    return { verdict: 'gaps_found', evidence: ['pre_execution_evidence_block_missing'] };
  }
  evidence.push('found:' + E_EVIDENCE_BLOCK);
  let subfieldHit = 0;
  for (const sub of E_EVIDENCE_SUBFIELDS) {
    if (content.indexOf(sub) !== -1) {
      evidence.push('found:' + sub);
      subfieldHit += 1;
    }
  }
  return {
    verdict: subfieldHit >= 1 ? 'pass' : 'gaps_found',
    evidence,
  };
}

// inherited_success_criteria + EDGE_CASES: + REGRESSION: scan.
function checkTPhase(content) {
  const evidence = [];
  const missingBlocks = [];
  if (!content) {
    return {
      verdict: 'gaps_found',
      evidence: ['t_phase_empty'],
      missing_blocks: T_REQUIRED_BLOCKS.slice(),
    };
  }
  for (const block of T_REQUIRED_BLOCKS) {
    if (content.indexOf(block) !== -1) {
      evidence.push('found:' + block);
    } else {
      missingBlocks.push(block);
    }
  }
  return {
    verdict: missingBlocks.length === 0 ? 'pass' : 'gaps_found',
    evidence,
    missing_blocks: missingBlocks,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function auditTask(taskId) {
  const timestamp = new Date().toISOString();

  if (!taskId || typeof taskId !== 'string') {
    return {
      task_id: taskId || null,
      audit_timestamp: timestamp,
      error: 'missing_task_id',
      overall_verdict: 'gaps_found',
    };
  }

  const fetched = fetchTask(taskId);
  if (!fetched.ok) {
    return {
      task_id: taskId,
      audit_timestamp: timestamp,
      error: fetched.error,
      overall_verdict: 'gaps_found',
    };
  }

  const task = fetched.task;
  if (!hasRpetd(task)) {
    return {
      task_id: taskId,
      audit_timestamp: timestamp,
      task_has_no_rpetd: true,
      d_phase: { verdict: 'gaps_found', evidence: [], missing_fields: D_REQUIRED_FIELDS.slice() },
      e_phase: { verdict: 'gaps_found', evidence: [] },
      t_phase: { verdict: 'gaps_found', evidence: [], missing_blocks: T_REQUIRED_BLOCKS.slice() },
      overall_verdict: 'gaps_found',
    };
  }

  const dContent = getPhaseContent(task, 'D');
  const eContent = getPhaseContent(task, 'E');
  const tContent = getPhaseContent(task, 'T');

  const dResult = checkDPhase(dContent);
  const eResult = checkEPhase(eContent);
  const tResult = checkTPhase(tContent);

  const overall =
    dResult.verdict === 'pass' && eResult.verdict === 'pass' && tResult.verdict === 'pass'
      ? 'pass'
      : 'gaps_found';

  return {
    task_id: taskId,
    audit_timestamp: timestamp,
    d_phase: dResult,
    e_phase: eResult,
    t_phase: tResult,
    overall_verdict: overall,
  };
}

// ─── CLI Entry ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }
  const taskId = args[0];
  const report = auditTask(taskId);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // Exit 0 regardless of verdict — the report itself carries the result.
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  auditTask,
  checkDPhase,
  checkEPhase,
  checkTPhase,
  D_REQUIRED_FIELDS,
  E_EVIDENCE_BLOCK,
  E_EVIDENCE_SUBFIELDS,
  T_REQUIRED_BLOCKS,
};
