#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-manifest-gate.cjs — Phase 67 HOOK-01.
 *
 * PreToolUse gate: an Edit/Write/MultiEdit/NotebookEdit outside the union of
 * {active claimed tasks' files_expected} ∪ GLOBAL_ALLOWLIST is a manifest
 * violation — deny in block mode, warn otherwise (see hooks/lib/hook-common.cjs
 * for the structural warn-first guarantee: denyPreToolUse() itself re-checks
 * mode and can never emit a deny shape outside GSD_HOOKS_ENFORCE=block).
 * Writes to ORCHESTRATOR_OWNED paths are violations regardless of manifest,
 * but ONLY when an executor-agent claim is active (an orchestrator/operator
 * session with no executor claim is unaffected — see 67-CONTEXT.md pitfall 7,
 * orchestrator lockout). Both lists come EXCLUSIVELY from the generated
 * get-shit-done/config/hook-allowlists.json artifact (single-source mandate —
 * this file NEVER hand-copies GLOBAL_ALLOWLIST/ORCHESTRATOR_OWNED contents).
 *
 * Zero daemon calls, zero network calls. Built entirely on the Wave-1 runtime
 * (hooks/lib/hook-common.cjs) and local state (data/hook-active-tasks.json,
 * get-shit-done/config/hook-allowlists.json). Every failure path fails open
 * via runGate()'s try/catch — this handler is never invoked outside that
 * wrapper's guarantees.
 *
 * Decision order (locked, .planning/phases/67-enforcement-hooks/67-02-PLAN.md):
 *   1. Mode off            -> exit 0 (handled by runGate before this file runs).
 *   2. No file_path         -> allow.
 *   3. No fresh marker entries -> allow silently (the claim gate owns this case).
 *   3a. Allowlists artifact unavailable/corrupt -> allow + warn (fail-open;
 *       Verification Criteria #5 — never crash or deny on missing/corrupt data).
 *   4. Path in global_allowlist -> allow.
 *   5. Path in orchestrator_owned -> deny iff an active entry's agent is an
 *      executor; else allow.
 *   6. Path in the union of active tasks' modify/create -> allow.
 *   7. Any active task has files_expected: null -> allow + warn (unenforceable).
 *   8. Otherwise -> violation (deny in block mode, warn otherwise).
 */

const hookCommon = require('./lib/hook-common.cjs');

const DIVERGENCE_SENTENCE =
  'File a divergence report per get-shit-done/references/divergence-protocol.md ' +
  'or re-plan — do not silently absorb scope.';

/** Render a files_expected list, truncated to `max` entries with a "+N more" tail. */
function _truncateList(list, max = 30) {
  if (!Array.isArray(list) || list.length === 0) return '[]';
  if (list.length <= max) return JSON.stringify(list);
  const shown = JSON.stringify(list.slice(0, max));
  return `${shown.slice(0, -1)},"+${list.length - max} more"]`;
}

/** Compact per-task manifest rendering used in the step-8 deny/warn reason. */
function _renderManifestUnion(activeEntries) {
  const lines = [];
  for (const { id, entry } of activeEntries) {
    const fe = entry && entry.files_expected;
    if (!fe) {
      lines.push(`${id}: files_expected=null (unenforceable)`);
      continue;
    }
    lines.push(`${id} modify=${_truncateList(fe.modify)} create=${_truncateList(fe.create)}`);
  }
  return lines.join('; ');
}

function _activeEntries(ctx) {
  const tasks = (ctx.activeTasks && ctx.activeTasks.tasks && typeof ctx.activeTasks.tasks === 'object')
    ? ctx.activeTasks.tasks
    : {};
  return Object.keys(tasks).map((id) => ({ id, entry: tasks[id] }));
}

function _isExecutorAgent(agent) {
  return typeof agent === 'string' && agent.startsWith('executor');
}

/** Violation telemetry: 'hook_gate_denied' in block mode, 'hook_gate_warned' otherwise. */
function _emitViolationTelemetry(ctx, toolName) {
  const cls = ctx.mode === 'block' ? 'hook_gate_denied' : 'hook_gate_warned';
  hookCommon.emitGateTelemetry('manifest', cls, { tool_name: toolName, mode: ctx.mode });
}

hookCommon.runGate('manifest', (input, ctx) => {
  // Step 2: no usable file_path -> allow (defensive no-op, also covers
  // Bash-shaped tool_input — Bash is out of scope for this gate entirely).
  const relPath = hookCommon.normalizeToolPath(input, ctx.repoRoot);
  if (relPath === null) return;

  // Step 3: no fresh marker entries -> allow silently. The claim gate is the
  // ONLY gate that reports a no-claim session; double-reporting here would
  // spam every unclaimed write with two separate violations.
  const activeEntries = _activeEntries(ctx);
  if (activeEntries.length === 0) return;

  const toolName = (input && typeof input.tool_name === 'string') ? input.tool_name : 'unknown-tool';

  // Fail-open: hookCommon.loadAllowlists() returns null on ANY read/parse
  // failure (missing/corrupt artifact). Without a valid global_allowlist /
  // orchestrator_owned list we cannot safely evaluate a violation, so this
  // gate allows with a warning rather than risk a deny built on absent data
  // (Verification Criteria #5 — corrupting the allowlists artifact must
  // yield allow, never a crash or deny).
  const allowlists = ctx.allowlists;
  if (!allowlists || typeof allowlists !== 'object') {
    hookCommon.warn(
      `gsd-manifest-gate: hook-allowlists.json unavailable or unparseable — allowing ${toolName} on ` +
      `'${relPath}' without denial (fail-open).`
    );
    return;
  }
  const globalAllowlist = Array.isArray(allowlists.global_allowlist) ? allowlists.global_allowlist : [];
  const orchestratorOwned = Array.isArray(allowlists.orchestrator_owned) ? allowlists.orchestrator_owned : [];

  // Step 4: global allowlist.
  if (hookCommon.matchesAny(relPath, globalAllowlist)) return;

  // Step 5: orchestrator-owned invariant — applies ONLY when an active claim
  // belongs to an executor agent (orchestrator/operator sessions are unaffected).
  if (hookCommon.matchesAny(relPath, orchestratorOwned)) {
    const executorActive = activeEntries.some(({ entry }) => _isExecutorAgent(entry && entry.agent));
    if (!executorActive) return;

    _emitViolationTelemetry(ctx, toolName);
    const reason =
      `${toolName} write to '${relPath}' targets an orchestrator-owned path — only the ` +
      'orchestrator may write .planning/STATE.md, .planning/ROADMAP.md, and ' +
      '.planning/REQUIREMENTS.md, regardless of any active task\'s files_expected manifest. ' +
      DIVERGENCE_SENTENCE;
    hookCommon.denyPreToolUse(reason);
    return;
  }

  // Step 6: union of active tasks' modify + create.
  const unionPatterns = [];
  for (const { entry } of activeEntries) {
    const fe = entry && entry.files_expected;
    if (!fe) continue;
    if (Array.isArray(fe.modify)) unionPatterns.push(...fe.modify);
    if (Array.isArray(fe.create)) unionPatterns.push(...fe.create);
  }
  if (hookCommon.matchesAny(relPath, unionPatterns)) return;

  // Step 7: at least one active task has an unenforceable (null) manifest —
  // allow with a warning rather than deny on a manifest we cannot evaluate.
  const hasUnenforceable = activeEntries.some(({ entry }) => !entry || entry.files_expected == null);
  if (hasUnenforceable) {
    hookCommon.warn(
      `gsd-manifest-gate: an active claimed task has no enforceable manifest (files_expected: null) — ` +
      `allowing ${toolName} on '${relPath}' without denial.`
    );
    return;
  }

  // Step 8: violation — outside every active manifest and the global allowlist.
  _emitViolationTelemetry(ctx, toolName);
  const manifestUnion = _renderManifestUnion(activeEntries);
  const reason =
    `${toolName} write to '${relPath}' is outside every active task's files_expected manifest ` +
    `[${manifestUnion}] and not in the global allowlist. ` +
    DIVERGENCE_SENTENCE;
  hookCommon.denyPreToolUse(reason);
});
