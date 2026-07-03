#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-claim-gate.cjs — Phase 67 HOOK-02.
 *
 * PreToolUse gate: an Edit/Write/MultiEdit/NotebookEdit on a CODE file with
 * no fresh claimed-task marker in the session — no `node
 * get-shit-done/bin/amauta.cjs claim TK-XXXX --agent <agent>` on record —
 * is a violation: deny in block mode, warn otherwise (see
 * hooks/lib/hook-common.cjs — denyPreToolUse() is structurally warn-first
 * and can never emit a deny shape outside GSD_HOOKS_ENFORCE=block). Planning
 * paperwork, docs, and config stay orchestrator-writable without a claim.
 *
 * Zero daemon calls, zero network calls. Built entirely on the Wave-1
 * runtime (hooks/lib/hook-common.cjs) and local state
 * (data/hook-active-tasks.json, already TTL-filtered by
 * hook-state.readActiveTasks()). Every failure path fails open via
 * runGate()'s try/catch.
 *
 * Decision order (locked, .planning/phases/67-enforcement-hooks/67-02-PLAN.md):
 *   1. Mode off             -> exit 0 (handled by runGate before this file runs).
 *   2. No file_path          -> allow.
 *   3. Not a code file       -> allow (planning/docs/config exemption).
 *   4. >=1 fresh marker entry -> allow.
 *   5. Otherwise             -> violation (deny in block mode, warn otherwise).
 *
 * NOTE (executor context): task TK-1806 for this file was registered
 * manually after a dedup glitch in the amauta tracker — its metadata may not
 * match. Plan 67-02-03's task spec in
 * .planning/phases/67-enforcement-hooks/67-02-PLAN.md is authoritative for
 * this file's contract.
 */

const path = require('path');
const hookCommon = require('./lib/hook-common.cjs');

const CLAIM_COMMAND_TEMPLATE = 'node get-shit-done/bin/amauta.cjs claim <TK-ID> --agent <agent>';

// Locked code-file extension set (lowercase, without the leading dot).
const CODE_EXTENSIONS = new Set([
  'cjs', 'mjs', 'js', 'ts', 'tsx', 'jsx',
  'py', 'sql', 'sh', 'bash', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
]);

// Any path with one of these as its first POSIX segment is exempt, even if
// its extension is otherwise in CODE_EXTENSIONS (planning paperwork, docs,
// and config stay orchestrator-writable without a claim).
const EXCLUDED_PREFIXES = ['.planning/', '.claude/', 'docs/', 'node_modules/', 'hooks/dist/'];

/**
 * isCodeFile(relPath) — pure function, exported for unit spot-checks.
 * A repo-relative POSIX path is a "code file" when its extension is in the
 * locked CODE_EXTENSIONS set AND it is not under any EXCLUDED_PREFIXES AND
 * it is not a `.md` file (markdown is never a code file regardless of
 * location).
 */
function isCodeFile(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;

  const normalized = relPath.split(path.sep).join('/');
  if (normalized.toLowerCase().endsWith('.md')) return false;

  for (const prefix of EXCLUDED_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return false;
  }

  const dot = normalized.lastIndexOf('.');
  if (dot === -1 || dot === normalized.length - 1) return false;
  const ext = normalized.slice(dot + 1).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function _freshMarkerCount(ctx) {
  const tasks = (ctx.activeTasks && ctx.activeTasks.tasks && typeof ctx.activeTasks.tasks === 'object')
    ? ctx.activeTasks.tasks
    : {};
  return Object.keys(tasks).length;
}

/** Violation telemetry: 'hook_gate_denied' in block mode, 'hook_gate_warned' otherwise. */
function _emitViolationTelemetry(ctx, toolName) {
  const cls = ctx.mode === 'block' ? 'hook_gate_denied' : 'hook_gate_warned';
  hookCommon.emitGateTelemetry('claim', cls, { tool_name: toolName, mode: ctx.mode });
}

function _runClaimGate() {
  hookCommon.runGate('claim', (input, ctx) => {
    // Step 2: no usable file_path -> allow (also covers Bash-shaped
    // tool_input; Bash is out of scope for this gate).
    const relPath = hookCommon.normalizeToolPath(input, ctx.repoRoot);
    if (relPath === null) return;

    // Step 3: non-code files (planning/docs/config/markdown) are always
    // orchestrator-writable without a claim.
    if (!isCodeFile(relPath)) return;

    // Step 4: at least one fresh marker entry -> allow. This gate does not
    // check WHICH task's manifest covers the path — that is the manifest
    // gate's job; the claim gate only proves a claim exists at all.
    if (_freshMarkerCount(ctx) >= 1) return;

    // Step 5: violation — a code-file write with no claimed task.
    const toolName = (input && typeof input.tool_name === 'string') ? input.tool_name : 'unknown-tool';
    _emitViolationTelemetry(ctx, toolName);
    const reason =
      `${toolName} write to code file '${relPath}' has no claimed Amauta task in this session. ` +
      `Claim a task first: ${CLAIM_COMMAND_TEMPLATE} — ` +
      'an unclaimed code-file write bypasses RPETD logging and validator review.';
    hookCommon.denyPreToolUse(reason);
  });
}

// Only run the gate when this file is the process entrypoint (a real hook
// invocation). When `require()`d as a module — e.g. for isCodeFile() unit
// spot-checks in tests/67-02-claim-gate.test.cjs — this must NOT read stdin
// or call process.exit(), or it would hang/kill the requiring test process.
if (require.main === module) {
  _runClaimGate();
}

module.exports = { isCodeFile };
