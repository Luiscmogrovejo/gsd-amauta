'use strict';

/**
 * hooks/gsd-session-handoff.cjs — Phase 67 HOOK-04.
 *
 * One script, switched on `hook_event_name` from stdin:
 *
 *   - PreCompact (trigger auto OR manual): writes data/handoff-ledger.json —
 *     current phase/next action (best-effort parse of .planning/STATE.md),
 *     active claimed tasks, open (unresolved) divergence reports, and the
 *     first 20 `git status --porcelain` paths. Exits 0 always; never fails
 *     the compaction it is riding on.
 *   - SessionStart (startup/resume/compact): if a ledger exists and is no
 *     older than 7 days, rehydrates it as additionalContext so pause/resume
 *     never depends on a manual, skippable step. Missing/stale/corrupt
 *     ledger -> silent exit 0.
 *
 * This script structurally NEVER emits a deny or "block" output shape for
 * any event, under any mode, on any failure path: it imports only the allow
 * / warn / SessionStart-context emitters from hook-common.cjs, never the
 * Stop or PreToolUse deny-shape emitters that live alongside them there.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const hookCommon = require('./lib/hook-common.cjs');
const hookState = require('../get-shit-done/bin/lib/hook-state.cjs');

const FRESHNESS_MS = 7 * 24 * 3600 * 1000;
const GIT_STATUS_TIMEOUT_MS = 3000;
const MAX_TOUCHED_FILES = 20;

function ledgerPath(dataDirPath) {
  return path.join(dataDirPath, 'handoff-ledger.json');
}

// ─── STATE.md best-effort parsing (every field individually try/caught) ───

function _readStateField(repoRoot, regex) {
  try {
    const content = fs.readFileSync(path.join(repoRoot, '.planning', 'STATE.md'), 'utf8');
    const m = regex.exec(content);
    return m ? m[1].trim() : null;
  } catch {
    return null; // missing/unreadable STATE.md still yields a valid ledger
  }
}

function currentPhaseFromState(repoRoot) {
  return _readStateField(repoRoot, /^Phase:\s*(.+)$/m);
}

function nextActionFromState(repoRoot) {
  return _readStateField(repoRoot, /^Next step:\s*(.+)$/m);
}

// ─── touched files (best-effort, 3s-bounded git status) ────────────────────

function touchedFiles(repoRoot) {
  try {
    const raw = execSync('git status --porcelain', {
      cwd: repoRoot,
      timeout: GIT_STATUS_TIMEOUT_MS,
      encoding: 'utf8',
    });
    return raw
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .slice(0, MAX_TOUCHED_FILES);
  } catch {
    return [];
  }
}

// ─── open (unresolved) divergence reports — same rule as the Stop gate:
// only phase dirs referenced by an active marker entry, only reports whose
// task_id is itself in the active marker, resolved via orchestrator_response
// (canonical) OR resolution (accepted alias) ────────────────────────────────

function _isResolved(reportObj) {
  return Object.prototype.hasOwnProperty.call(reportObj, 'orchestrator_response') ||
    Object.prototype.hasOwnProperty.call(reportObj, 'resolution');
}

function openDivergences(activeTasks, repoRoot) {
  const openPaths = [];
  const tkIds = Object.keys(activeTasks || {});
  const phasePrefixes = new Set();
  for (const tk of tkIds) {
    const entry = activeTasks[tk];
    if (entry && entry.phase) phasePrefixes.add(String(entry.phase));
  }

  let phaseDirEntries = [];
  try {
    phaseDirEntries = fs.readdirSync(path.join(repoRoot, '.planning', 'phases'), { withFileTypes: true });
  } catch {
    phaseDirEntries = [];
  }

  for (const prefix of phasePrefixes) {
    const matchingDirs = phaseDirEntries.filter((e) => e.isDirectory() && e.name.startsWith(`${prefix}-`));
    for (const dirEnt of matchingDirs) {
      const reportsDir = path.join(repoRoot, '.planning', 'phases', dirEnt.name, 'divergence-reports');
      let files = [];
      try {
        files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json'));
      } catch {
        files = [];
      }
      for (const f of files) {
        const fullPath = path.join(reportsDir, f);
        try {
          const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (!parsed || typeof parsed !== 'object') continue;
          if (!tkIds.includes(parsed.task_id)) continue;
          if (_isResolved(parsed)) continue;
          openPaths.push(path.relative(repoRoot, fullPath).split(path.sep).join('/'));
        } catch {
          // Corrupt report JSON — fail-open, not included.
        }
      }
    }
  }
  return openPaths;
}

// ─── PreCompact: build + atomically write the ledger ───────────────────────

function buildLedger(input, repoRoot) {
  const activeTasksState = hookState.readActiveTasks();
  const activeTasks = activeTasksState.tasks || {};

  const activeTaskEntries = Object.keys(activeTasks).map((tk) => ({
    tk,
    plan_task_id: activeTasks[tk].plan_task_id || null,
    agent: activeTasks[tk].agent || null,
    claimed_at: activeTasks[tk].claimed_at || null,
  }));

  return {
    version: 1,
    written_at: new Date().toISOString(),
    trigger: (input && typeof input.trigger === 'string' && input.trigger) || 'auto',
    session_id: (input && typeof input.session_id === 'string' && input.session_id) || null,
    current_phase: currentPhaseFromState(repoRoot),
    next_action: nextActionFromState(repoRoot),
    active_tasks: activeTaskEntries,
    open_divergences: openDivergences(activeTasks, repoRoot),
    touched_files: touchedFiles(repoRoot),
  };
}

function writeLedger(dataDirPath, ledger) {
  try {
    fs.mkdirSync(dataDirPath, { recursive: true });
    const p = ledgerPath(dataDirPath);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false; // fail-open: a ledger write failure must never block compaction
  }
}

// ─── SessionStart: read + render as additionalContext ──────────────────────

function readLedger(dataDirPath) {
  try {
    const raw = fs.readFileSync(ledgerPath(dataDirPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isFresh(ledger) {
  if (!ledger || typeof ledger.written_at !== 'string') return false;
  const writtenMs = Date.parse(ledger.written_at);
  if (Number.isNaN(writtenMs)) return false;
  return (Date.now() - writtenMs) <= FRESHNESS_MS;
}

function renderContext(ledger) {
  const lines = [`## GSD handoff (from ${ledger.written_at})`, ''];
  if (ledger.current_phase) lines.push(`Phase: ${ledger.current_phase}`);
  if (ledger.next_action) lines.push(`Next action: ${ledger.next_action}`);
  if (Array.isArray(ledger.active_tasks) && ledger.active_tasks.length > 0) {
    lines.push('Active tasks:');
    for (const t of ledger.active_tasks) {
      lines.push(`- ${t.tk} (${t.plan_task_id || 'unknown plan'}, ${t.agent || 'unknown agent'})`);
    }
  }
  if (Array.isArray(ledger.open_divergences) && ledger.open_divergences.length > 0) {
    lines.push('Open divergences:');
    for (const p of ledger.open_divergences) lines.push(`- ${p}`);
  }
  if (Array.isArray(ledger.touched_files) && ledger.touched_files.length > 0) {
    lines.push('Touched files:');
    for (const f of ledger.touched_files) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

// ─── Gate entrypoint ────────────────────────────────────────────────────────

function main() {
  hookCommon.runGate('session-handoff', (input, ctx) => {
    const eventName = input && typeof input.hook_event_name === 'string' ? input.hook_event_name : null;
    const dataDirPath = hookState.dataDir();

    if (eventName === 'PreCompact') {
      const ledger = buildLedger(input, ctx.repoRoot);
      writeLedger(dataDirPath, ledger);
      return; // always exit 0 — PreCompact must never fail the compaction
    }

    if (eventName === 'SessionStart') {
      const ledger = readLedger(dataDirPath);
      if (!isFresh(ledger)) return; // missing/stale/corrupt -> silent exit 0
      hookCommon.sessionStartContext(renderContext(ledger));
      return;
    }

    // Unknown hook_event_name -> exit 0, no output (runGate defaults to allow()).
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildLedger,
  writeLedger,
  readLedger,
  isFresh,
  renderContext,
  openDivergences,
  ledgerPath,
  currentPhaseFromState,
  nextActionFromState,
  touchedFiles,
};
