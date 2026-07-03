'use strict';

/**
 * hooks/gsd-stop-gate.cjs — Phase 67 HOOK-03.
 *
 * Stop hook: blocks turn-end (block mode only) while any actively claimed
 * task (from the local hook-state marker, TTL-filtered) lacks T-phase
 * evidence in data/tasks.json, OR has an unresolved divergence report sitting
 * in its own phase directory. Task lookup for T-phase evidence goes
 * EXCLUSIVELY through hookState.findTaskItem(tk) — data/tasks.json's `items`
 * field is an ARRAY of task objects (1792+ elements at HEAD, no keyed map),
 * so `items[tk]` is always undefined and MUST NOT appear anywhere in this
 * file. A missing item (task not found at all) is fail-open: unenforceable,
 * never a violation.
 *
 * Resolved-divergence signal: a top-level `orchestrator_response` object is
 * the CANONICAL resolved signal — every one of the 7 real resolved reports
 * on disk (phases 60/61/62/65/66) carries it, none carries a `resolution`
 * key. A top-level `resolution` object is accepted as a future ALIAS.
 * Presence of EITHER key marks a report resolved; a report with neither key,
 * whose task_id is itself present in the active marker, is a violation. A
 * report whose task_id is NOT in the active marker (a completed phase's
 * historic report) is inert — it can never block a different session's turn.
 *
 * Deadlock-impossibility: Claude Code hard-caps at 8 consecutive Stop
 * blocks. This gate escalates to allow-with-warning at 3 consecutive blocks
 * (tracked in data/hook-stop-counter.json, keyed by session_id, 48h-pruned
 * on read) — comfortably before the hard cap, so no un-passable deadlock can
 * exist. The ≤3-then-allow escape is evaluated FIRST, before any
 * violation-conditional branch, so no violation state can suppress it.
 */

const fs = require('fs');
const path = require('path');
const hookCommon = require('./lib/hook-common.cjs');
const hookState = require('../get-shit-done/bin/lib/hook-state.cjs');

const BLOCK_THRESHOLD = 3;
const COUNTER_PRUNE_MS = 48 * 3600 * 1000;

// ─── Session-keyed bounded-retry counter (data/hook-stop-counter.json) ─────

function counterPath(dataDirPath) {
  return path.join(dataDirPath, 'hook-stop-counter.json');
}

function _readCounterState(dataDirPath) {
  try {
    const raw = fs.readFileSync(counterPath(dataDirPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const pruned = {};
    for (const sid of Object.keys(parsed)) {
      const entry = parsed[sid];
      if (!entry || typeof entry !== 'object') continue;
      const updatedMs = entry.updated_at ? Date.parse(entry.updated_at) : NaN;
      if (!Number.isNaN(updatedMs) && (now - updatedMs) > COUNTER_PRUNE_MS) continue; // 48h prune-on-read
      pruned[sid] = entry;
    }
    return pruned;
  } catch {
    return {}; // fail-open: missing/corrupt counter file == count 0 for every session
  }
}

function _writeCounterState(dataDirPath, state) {
  try {
    fs.mkdirSync(dataDirPath, { recursive: true });
    const p = counterPath(dataDirPath);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch {
    // Fail-open: a counter write failure must never crash or block the gate.
  }
}

/** getCounterCount(sessionId, dataDirPath) — 0 for unknown/missing/corrupt state. */
function getCounterCount(sessionId, dataDirPath) {
  const state = _readCounterState(dataDirPath);
  const entry = state[sessionId];
  return entry && Number.isInteger(entry.count) ? entry.count : 0;
}

/** bumpCounter(sessionId, dataDirPath) — increment and persist; returns the new count. */
function bumpCounter(sessionId, dataDirPath) {
  const state = _readCounterState(dataDirPath);
  const current = state[sessionId] && Number.isInteger(state[sessionId].count) ? state[sessionId].count : 0;
  const next = current + 1;
  state[sessionId] = { count: next, updated_at: new Date().toISOString() };
  _writeCounterState(dataDirPath, state);
  return next;
}

/** resetCounter(sessionId, dataDirPath) — drop the session's entry entirely. */
function resetCounter(sessionId, dataDirPath) {
  const state = _readCounterState(dataDirPath);
  if (sessionId in state) {
    delete state[sessionId];
    _writeCounterState(dataDirPath, state);
  }
}

// ─── Violation detection ────────────────────────────────────────────────────

function _isResolved(reportObj) {
  return Object.prototype.hasOwnProperty.call(reportObj, 'orchestrator_response') ||
    Object.prototype.hasOwnProperty.call(reportObj, 'resolution');
}

/**
 * findViolations({activeTasks, repoRoot, dataDirPath}) — pure, exported for
 * tests. `activeTasks` is the marker's `tasks` map (TK-id -> entry, TTL
 * already filtered by the caller via hookState.readActiveTasks()). Returns
 * an array of structured strings, one per violation, naming the exact TK or
 * file path so a block reason is self-explanatory.
 */
function findViolations({ activeTasks, repoRoot, dataDirPath } = {}) {
  const violations = [];
  const tasks = activeTasks || {};
  const tkIds = Object.keys(tasks);
  const effectiveDataDir = dataDirPath || hookState.dataDir();
  const effectiveRoot = repoRoot || hookCommon.repoRoot();

  // 5a — T-phase evidence via the shared array-aware lookup. `items` is an
  // ARRAY; findTaskItem does items.find(...), never items[tk]. A missing
  // item is fail-open (unenforceable), never a violation.
  for (const tk of tkIds) {
    const item = hookState.findTaskItem(tk, { dataDirPath: effectiveDataDir });
    if (!item) continue;
    const tPhase = (item.rpetd_phases && typeof item.rpetd_phases.T === 'string') ? item.rpetd_phases.T : '';
    if (!tPhase.trim()) {
      violations.push(`${tk} missing T-phase evidence (run: node get-shit-done/bin/amauta.cjs rpetd ${tk} --phase T --content ...)`);
    }
  }

  // 5b — unresolved divergence reports. Only phase directories referenced by
  // an active marker entry's `phase` field are scanned; only reports whose
  // task_id is ITSELF in the active marker can be a violation — a historic
  // completed-phase report (task_id not claimed by anyone right now) is
  // inert and can never false-block an unrelated session.
  const phasePrefixes = new Set();
  for (const tk of tkIds) {
    const entry = tasks[tk];
    if (entry && entry.phase) phasePrefixes.add(String(entry.phase));
  }

  let phaseDirEntries = [];
  try {
    phaseDirEntries = fs.readdirSync(path.join(effectiveRoot, '.planning', 'phases'), { withFileTypes: true });
  } catch {
    phaseDirEntries = []; // fail-open: no phases dir readable == no divergence violations
  }

  for (const prefix of phasePrefixes) {
    const matchingDirs = phaseDirEntries.filter((e) => e.isDirectory() && e.name.startsWith(`${prefix}-`));
    for (const dirEnt of matchingDirs) {
      const reportsDir = path.join(effectiveRoot, '.planning', 'phases', dirEnt.name, 'divergence-reports');
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
          if (!tkIds.includes(parsed.task_id)) continue; // not claimed right now -> inert
          if (_isResolved(parsed)) continue; // orchestrator_response (canonical) OR resolution (alias)
          const rel = path.relative(effectiveRoot, fullPath).split(path.sep).join('/');
          violations.push(`unresolved divergence report: ${rel}`);
        } catch {
          // Corrupt report JSON — fail-open, not a violation.
        }
      }
    }
  }

  return violations;
}

// ─── Gate entrypoint ────────────────────────────────────────────────────────

function main() {
  hookCommon.runGate('stop', (input, ctx) => {
    const sessionId = (input && typeof input.session_id === 'string' && input.session_id) || 'unknown-session';
    const stopHookActive = !!(input && input.stop_hook_active);
    const dataDirPath = hookState.dataDir();

    const activeTasksState = hookState.readActiveTasks();
    const activeTasks = activeTasksState.tasks || {};

    const violations = findViolations({ activeTasks, repoRoot: ctx.repoRoot, dataDirPath });

    // Step 3 — unconditional bounded-retry escape. Evaluated BEFORE any
    // violation-conditional branch below, so no violation state can
    // suppress it: the deadlock-impossibility guarantee.
    const currentCount = getCounterCount(sessionId, dataDirPath);
    if (stopHookActive && currentCount >= BLOCK_THRESHOLD) {
      resetCounter(sessionId, dataDirPath);
      hookCommon.emitGateTelemetry('stop', 'hook_gate_failopen', { mode: ctx.mode });
      const list = violations.length > 0 ? violations.join('; ') : 'none';
      hookCommon.warn(`gsd-stop-gate: 3 consecutive blocks reached — allowing turn end with unresolved items: ${list}`);
      return;
    }

    // Step 4 — no active tasks -> allow + reset counter.
    if (tkCount(activeTasks) === 0) {
      resetCounter(sessionId, dataDirPath);
      return;
    }

    // Step 6 — no violations -> allow + reset counter.
    if (violations.length === 0) {
      resetCounter(sessionId, dataDirPath);
      return;
    }

    // Step 7 — violations present: block mode blocks + bumps the counter;
    // warn mode warns with the same list and leaves the counter untouched
    // (warn mode must never walk toward the escalation path). blockStop()
    // is structurally warn-first in hook-common.cjs, so calling it here in
    // warn mode already degrades to the identical systemMessage shape.
    const reason = violations.join('\n');
    if (ctx.mode === 'block') {
      bumpCounter(sessionId, dataDirPath);
      hookCommon.emitGateTelemetry('stop', 'hook_gate_denied', { mode: ctx.mode });
    } else {
      hookCommon.emitGateTelemetry('stop', 'hook_gate_warned', { mode: ctx.mode });
    }
    hookCommon.blockStop(reason);
  });
}

function tkCount(activeTasks) {
  return Object.keys(activeTasks || {}).length;
}

if (require.main === module) {
  main();
}

module.exports = {
  findViolations,
  bumpCounter,
  resetCounter,
  getCounterCount,
  counterPath,
};
