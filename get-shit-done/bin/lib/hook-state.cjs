'use strict';

/**
 * get-shit-done/bin/lib/hook-state.cjs — Phase 67 HOOK-05 foundation.
 *
 * The local session-state store the blocking hook gates read INSTEAD OF the
 * daemon. TK-1747: `amauta claim` has hit 30s daemon timeouts, so gates make
 * ZERO synchronous daemon calls, ever — everything here is a local file read.
 *
 * Owns two things:
 *   1. the claim marker map (see markerPath() below), keyed by TK-id,
 *      written by `cmdClaim` and pruned by `cmdStatus` (see gsd-amauta.cjs).
 *   2. Claim-time resolution of a task's `files_expected` manifest from its
 *      registered plan file (data/tasks.json items carry NO manifest of
 *      their own — verified 0 of N items at HEAD — so the manifest is
 *      resolved ONCE at claim time by parsing the plan the task's
 *      `plan:<planId>`/`task:<planLocalId>` tags point at).
 *
 * Style-matched to get-shit-done/bin/lib/telemetry.cjs: every fs/JSON
 * operation is wrapped in try/catch and returns a safe default. This module
 * NEVER throws to callers.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 24 * 3600 * 1000;

/**
 * Repo root resolution. This file lives at get-shit-done/bin/lib/, so three
 * '..' hops reach the repo root in the source-repo layout — identical
 * discipline to telemetry.cjs's dataDir().
 */
function repoRoot() {
  return process.env.CLAUDE_PROJECT_DIR ||
    path.resolve(__dirname, '..', '..', '..');
}

/**
 * Resolve the hook-state data directory. MUST stay byte-compatible with
 * telemetry.cjs's dataDir() (process.env.AMAUTA_DATA_DIR ||
 * <repo_root>/data) — dual-runtime discipline.
 */
function dataDir() {
  return process.env.AMAUTA_DATA_DIR ||
    path.join(path.resolve(__dirname, '..', '..', '..'), 'data');
}

function markerPath() {
  return path.join(dataDir(), 'hook-active-tasks.json');
}

/**
 * readActiveTasks({ttlMs}) — parse the marker file. Entries whose
 * `claimed_at` is older than ttlMs are filtered out on the read side (no
 * write-back — pruning stale entries is not this function's job). ANY error
 * (missing file, corrupt JSON, wrong shape) fails open to an empty result.
 */
function readActiveTasks({ ttlMs = DEFAULT_TTL_MS } = {}) {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const tasksIn = (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object')
      ? parsed.tasks
      : {};
    const now = Date.now();
    const tasks = {};
    for (const tkId of Object.keys(tasksIn)) {
      const entry = tasksIn[tkId];
      if (!entry || typeof entry !== 'object') continue;
      const claimedAtMs = entry.claimed_at ? Date.parse(entry.claimed_at) : NaN;
      if (!Number.isNaN(claimedAtMs) && (now - claimedAtMs) > ttlMs) continue; // TTL expired
      tasks[tkId] = entry;
    }
    return { version: 1, tasks };
  } catch {
    return { version: 1, tasks: {} };
  }
}

function _readRawMarker() {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object') {
      return { version: 1, tasks: { ...parsed.tasks } };
    }
    return { version: 1, tasks: {} };
  } catch {
    return { version: 1, tasks: {} };
  }
}

function _writeMarker(state) {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  const tmpPath = `${mPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmpPath, mPath);
}

/**
 * writeActiveTask(tkId, entry) — read-merge-write the marker, atomic-ish via
 * a temp file + rename. Never throws; returns boolean success.
 */
function writeActiveTask(tkId, entry) {
  try {
    const current = _readRawMarker();
    current.tasks[tkId] = entry;
    _writeMarker(current);
    return true;
  } catch {
    return false;
  }
}

/**
 * pruneActiveTask(tkId) — remove the entry if present. Never throws;
 * returns boolean (true only when an entry was actually removed).
 */
function pruneActiveTask(tkId) {
  try {
    const current = _readRawMarker();
    if (!(tkId in current.tasks)) return false;
    delete current.tasks[tkId];
    _writeMarker(current);
    return true;
  } catch {
    return false;
  }
}

/**
 * findTaskItem(tkId) — the ONE shared data/tasks.json lookup. The top-level
 * `items` field is an ARRAY of task objects (verified at HEAD: 1792+ array
 * elements, no keyed map) — lookup is ALWAYS `items.find(...)`, NEVER
 * `items[tkId]`. A map-shaped `items` (the bug this guards against) is
 * rejected via `Array.isArray` and yields null, same as any other read
 * failure.
 */
function findTaskItem(tkId, { dataDirPath = dataDir() } = {}) {
  try {
    const tasksPath = path.join(dataDirPath, 'tasks.json');
    const raw = fs.readFileSync(tasksPath, 'utf8');
    const parsed = JSON.parse(raw);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (!items) return null;
    return items.find((it) => it && it.id === tkId) || null;
  } catch {
    return null;
  }
}

/**
 * resolveManifestForTask(taskItem, {cwd}) — claim-time-only manifest
 * resolution. From a data/tasks.json item's tags (`plan:<planId>` /
 * `task:<planLocalId>`, format per gsd-tools.cjs's plan-to-tasks tagging):
 *   1. derive the phase via the leading numeric segment of planId
 *   2. locate the phase directory under .planning/phases/<phase>-NN (glob)
 *   3. read <planId>-PLAN.md from that directory
 *   4. slice out the <task id="planLocalId">...</task> block
 *   5. slice its <files_expected>...</files_expected> section
 *   6. parse with gsd-tools.cjs's exported _parseFilesExpectedYaml
 *
 * ANY failure along this chain (missing tags, missing plan file, missing
 * task block, missing files_expected section, parse failure, gsd-tools.cjs
 * unavailable) returns null — callers MUST treat null as "claimed but
 * unenforceable manifest" (allow-with-warning, never deny).
 */
function resolveManifestForTask(taskItem, { cwd = repoRoot() } = {}) {
  try {
    if (!taskItem || !Array.isArray(taskItem.tags)) return null;

    const planTag = taskItem.tags.find((t) => typeof t === 'string' && t.startsWith('plan:'));
    const taskTag = taskItem.tags.find((t) => typeof t === 'string' && t.startsWith('task:'));
    if (!planTag || !taskTag) return null;

    const planId = planTag.slice('plan:'.length);
    const planLocalId = taskTag.slice('task:'.length);
    if (!planId || !planLocalId) return null;

    const phaseMatch = /^(\d+)/.exec(planId);
    if (!phaseMatch) return null;
    const phase = phaseMatch[1];

    const phasesDir = path.join(cwd, '.planning', 'phases');
    let phaseDirName = null;
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const hit = entries.find((e) => e.isDirectory() && e.name.startsWith(`${phase}-`));
    if (hit) phaseDirName = hit.name;
    if (!phaseDirName) return null;

    const planFile = path.join(phasesDir, phaseDirName, `${planId}-PLAN.md`);
    const planContent = fs.readFileSync(planFile, 'utf8');

    const escapedId = planLocalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const taskRe = new RegExp(`<task\\s+id="${escapedId}">([\\s\\S]*?)<\\/task>`, 'i');
    const taskMatch = taskRe.exec(planContent);
    if (!taskMatch) return null;
    const taskBody = taskMatch[1];

    const filesRe = /<files_expected>([\s\S]*?)<\/files_expected>/i;
    const filesMatch = filesRe.exec(taskBody);
    if (!filesMatch) return null;
    const yamlText = filesMatch[1];

    let gsdTools;
    try {
      gsdTools = require('../gsd-tools.cjs');
    } catch {
      return null;
    }
    if (!gsdTools || typeof gsdTools._parseFilesExpectedYaml !== 'function') return null;

    const parsed = gsdTools._parseFilesExpectedYaml(yamlText);
    return {
      modify: Array.isArray(parsed.modify) ? parsed.modify : [],
      create: Array.isArray(parsed.create) ? parsed.create : [],
      delete: Array.isArray(parsed.delete) ? parsed.delete : [],
    };
  } catch {
    return null;
  }
}

module.exports = {
  repoRoot,
  dataDir,
  markerPath,
  readActiveTasks,
  writeActiveTask,
  pruneActiveTask,
  findTaskItem,
  resolveManifestForTask,
};
