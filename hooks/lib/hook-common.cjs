'use strict';

/**
 * hooks/lib/hook-common.cjs — Phase 67 HOOK-05 foundation.
 *
 * The shared hook protocol runtime EVERY blocking gate (Wave 2: manifest,
 * claim, stop, handoff) is built on. This is the highest-blast-radius file
 * in the enforcement layer: a bug here can brick Edit/Write for every
 * session, so the discipline is non-negotiable:
 *
 *   - GSD_HOOKS_ENFORCE=off is checked as the FIRST statement of runGate(),
 *     before any stdin read or fs access — zero side effects when off.
 *   - Default mode is `warn`. Only the literal string `block` enables
 *     denial; unset/unknown values fail TOWARD less enforcement.
 *   - denyPreToolUse() and blockStop() are BOTH structurally warn-first:
 *     each re-checks resolveMode() itself and degrades to warn() with the
 *     SAME reason unless mode === 'block'. No caller bug in any gate can
 *     produce a deny/block shape outside explicit block mode.
 *   - Every failure path (corrupt allowlists, corrupt marker, missing
 *     data/tasks.json, unparseable/timed-out stdin, a thrown handler)
 *     fails OPEN: exit 0, a systemMessage naming the fail-open, best-effort
 *     telemetry. A gate built on runGate() can never exit non-zero and can
 *     never emit a deny/block shape from its failure path.
 *
 * Output shapes below are verbatim from the verified hook contract (see
 * .planning/phases/67-enforcement-hooks/67-CONTEXT.md, verified against
 * code.claude.com/docs/en/hooks.md 2026-07-03) — do NOT re-derive them.
 */

const fs = require('fs');
const path = require('path');

const STDIN_TIMEOUT_MS = 4000;

// ─── Mode resolution ────────────────────────────────────────────────────────

/**
 * resolveMode() — GSD_HOOKS_ENFORCE: 'off' | 'block' pass through as-is;
 * unset, empty, or any other value (including typos like 'banana') resolves
 * to 'warn'. Warn is the release default; `block` is the ONLY value that
 * enables denial.
 */
function resolveMode() {
  const raw = process.env.GSD_HOOKS_ENFORCE;
  if (raw === 'off') return 'off';
  if (raw === 'block') return 'block';
  return 'warn';
}

/**
 * repoRoot() — CLAUDE_PROJECT_DIR when set, else two hops up from this
 * file's directory (hooks/lib/ -> repo root).
 */
function repoRoot() {
  return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

// ─── stdin ──────────────────────────────────────────────────────────────────

/**
 * readStdinJson(cb) — collect stdin, JSON.parse it, and invoke cb(parsed) —
 * or cb(null) on ANY parse failure (caller fails open on null input). A
 * 4000ms timer forces the fail-open path if stdin never closes, keeping
 * the total gate budget safely under the 5s hook registration timeout.
 * cb is invoked exactly once regardless of which path fires first.
 */
function readStdinJson(cb) {
  let called = false;
  const finish = (value) => {
    if (called) return;
    called = true;
    cb(value);
  };

  const timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);

  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(input);
      } catch {
        parsed = null;
      }
      finish(parsed);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  } catch {
    clearTimeout(timer);
    finish(null);
  }
}

// ─── Allowlists + tasks-json context (both fail-open to a safe default) ────

/**
 * loadAllowlists() — GSD_HOOK_ALLOWLISTS_PATH is an AUTHORITATIVE-EXCLUSIVE
 * test seam: when set, it is read unconditionally (even if missing — no
 * fallthrough to the default path). Else reads the generated
 * get-shit-done/config/hook-allowlists.json artifact. Any read/parse
 * failure returns null (callers must treat null as "no allowlist
 * available", never as an empty-but-valid list).
 */
function loadAllowlists() {
  try {
    const p = process.env.GSD_HOOK_ALLOWLISTS_PATH ||
      path.join(repoRoot(), 'get-shit-done', 'config', 'hook-allowlists.json');
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _loadActiveTasks() {
  try {
    const hookState = require('../../get-shit-done/bin/lib/hook-state.cjs');
    return hookState.readActiveTasks();
  } catch {
    return { version: 1, tasks: {} };
  }
}

/**
 * matchesAny(pathStr, patterns) — delegate to gsd-tools.cjs's exported
 * _globToRegExp-based matcher when available; if the require fails for any
 * reason, fall back to exact-string matching only (the fail-OPEN direction
 * for a glob matcher is to under-match, never to silently allow-all).
 */
function matchesAny(pathStr, patterns) {
  if (!Array.isArray(patterns)) return false;
  try {
    // eslint-disable-next-line global-require
    const gsdTools = require('../../get-shit-done/bin/gsd-tools.cjs');
    if (typeof gsdTools._globToRegExp !== 'function') throw new Error('glob helper unavailable');
    for (const p of patterns) {
      if (p === pathStr) return true;
      if (typeof p === 'string' && p.includes('*') && gsdTools._globToRegExp(p).test(pathStr)) return true;
    }
    return false;
  } catch {
    return patterns.includes(pathStr);
  }
}

/**
 * normalizeToolPath(input, root) — extract tool_input.file_path (Edit,
 * Write, MultiEdit, NotebookEdit all use this field), resolve it against
 * root, and return a repo-relative POSIX path. Returns null when the field
 * is absent, non-string, or resolves outside root.
 */
function normalizeToolPath(input, root) {
  try {
    if (!input || typeof input !== 'object') return null;
    const toolInput = input.tool_input;
    if (!toolInput || typeof toolInput !== 'object') return null;
    const fp = toolInput.file_path;
    if (!fp || typeof fp !== 'string') return null;

    const base = root || repoRoot();
    const abs = path.isAbsolute(fp) ? fp : path.resolve(base, fp);
    const rel = path.relative(base, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  } catch {
    return null;
  }
}

// ─── Telemetry (fail-open, metadata-only) ──────────────────────────────────

/**
 * emitGateTelemetry(gate, cls, meta) — lazy-require telemetry.cjs and emit
 * the frozen 'error_class' event type (NO EVENT_TYPES schema change —
 * schema governance). Payload is metadata ONLY: error_class, gate,
 * tool_name, mode — NEVER file paths or content. Swallows all errors.
 */
function emitGateTelemetry(gate, cls, meta = {}) {
  try {
    // eslint-disable-next-line global-require
    const telemetry = require('../../get-shit-done/bin/lib/telemetry.cjs');
    telemetry.emit('error_class', {
      error_class: cls,
      gate,
      tool_name: meta.tool_name,
      mode: meta.mode,
    });
  } catch {
    // Fail-open: telemetry errors must never propagate to the gate.
  }
}

// ─── Output emitters (exact verified shapes) ───────────────────────────────

function _writeAndExit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj));
  } catch {
    // Fail-open: a stdout write failure must still exit 0, empty output.
  }
  process.exit(0);
}

/** allow() — silent allow: exit 0, empty stdout. */
function allow() {
  process.exit(0);
}

/** warn(message) — any gate, any mode: exit 0 + stdout {"systemMessage": message}. */
function warn(message) {
  _writeAndExit({ systemMessage: message });
}

/**
 * denyPreToolUse(reason) — PreToolUse deny, BLOCK MODE ONLY. Structurally
 * warn-first: re-checks resolveMode() itself; any mode other than 'block'
 * degrades to warn(reason) with the identical reason text. The deprecated
 * top-level {"decision":"block"} form is NEVER used for PreToolUse.
 */
function denyPreToolUse(reason) {
  if (resolveMode() !== 'block') return warn(reason);
  return _writeAndExit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * blockStop(reason) — Stop block, BLOCK MODE ONLY. Same structural
 * warn-first guard as denyPreToolUse(): outside block mode this degrades to
 * warn(reason) — the stdout carries NO "decision" key in that case.
 */
function blockStop(reason) {
  if (resolveMode() !== 'block') return warn(reason);
  return _writeAndExit({ decision: 'block', reason });
}

/** sessionStartContext(text) — SessionStart handoff-rehydration channel. */
function sessionStartContext(text) {
  return _writeAndExit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  });
}

// ─── The shared gate entrypoint ─────────────────────────────────────────────

function _failOpen(gateName, mode, err) {
  try {
    emitGateTelemetry(gateName, 'hook_gate_failopen', { tool_name: undefined, mode });
  } catch {
    // Fail-open: telemetry must never block the fail-open response itself.
  }
  const reason = (err && err.message) ? String(err.message).slice(0, 200) : 'unknown error';
  _writeAndExit({ systemMessage: `gsd-hooks: ${gateName} fail-open: ${reason}` });
}

/**
 * runGate(gateName, handler) — THE entrypoint every gate uses.
 *
 * FIRST statement: if resolveMode() === 'off', exit 0 immediately — before
 * any stdin read or fs access (zero side effects, per the kill-switch
 * mandate). Otherwise reads stdin (fail-open on timeout/parse failure),
 * builds ctx = {mode, repoRoot, allowlists, activeTasks} (each context
 * field individually fail-open), and calls handler(input, ctx) inside a
 * try/catch. Any thrown error -> fail-open response, telemetry, exit 0. If
 * handler returns normally without calling an emitter, runGate defaults to
 * a silent allow() so the gate always terminates deterministically.
 */
function runGate(gateName, handler) {
  const mode = resolveMode();
  if (mode === 'off') {
    process.exit(0);
    return;
  }

  readStdinJson((input) => {
    let ctx;
    try {
      ctx = {
        mode,
        repoRoot: repoRoot(),
        allowlists: loadAllowlists(),
        activeTasks: _loadActiveTasks(),
      };
    } catch (err) {
      _failOpen(gateName, mode, err);
      return;
    }

    try {
      handler(input, ctx);
      // Handler returned without emitting — default to silent allow.
      allow();
    } catch (err) {
      _failOpen(gateName, mode, err);
    }
  });
}

// ─── v3.5 compression rewrite primitives (additive — existing exports untouched) ─────

/**
 * readCompressionConfig() — GSD_COMPRESS_CONFIG_PATH is an authoritative test
 * seam (mirrors GSD_HOOK_ALLOWLISTS_PATH). Reads the `compression` block from
 * the resolved config; any failure -> { enabled: false } (fail-open to OFF,
 * opt-in default). INTERNAL — deliberately not exported.
 */
function readCompressionConfig() {
  try {
    const p = process.env.GSD_COMPRESS_CONFIG_PATH ||
      path.join(repoRoot(), '.planning', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const c = cfg && cfg.compression;
    return (c && typeof c === 'object') ? c : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

/**
 * resolveCompressMode() — 'off' | 'on'; default 'off' (opt-in). GSD_COMPRESS=on|off
 * overrides config; any other/unset value falls back to config.compression.enabled.
 * Deliberately NOT keyed on GSD_HOOKS_ENFORCE — compression is orthogonal to
 * enforcement (ARCHITECTURE.md Pattern 1 / Anti-Pattern 1).
 */
function resolveCompressMode() {
  const raw = process.env.GSD_COMPRESS;
  if (raw === 'off') return 'off';
  if (raw === 'on') return 'on';
  return readCompressionConfig().enabled ? 'on' : 'off';
}

/**
 * extractBashCommand(input) — the Bash tool_input.command string, or null for
 * any non-Bash / malformed shape (fail-open to passthrough in the caller).
 */
function extractBashCommand(input) {
  const ti = input && input.tool_input;
  return (ti && typeof ti.command === 'string') ? ti.command : null;
}

/**
 * rewriteBashInput(newCommand) — PRIMARY PreToolUse input-rewrite emitter. Emits
 * the doc-verified shape (HOOK-MECHANISM §1). permissionDecision is ALWAYS
 * 'allow' — this primitive can NEVER deny (that is denyPreToolUse's job; rewrite
 * is not enforcement).
 */
function rewriteBashInput(newCommand) {
  return _writeAndExit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: newCommand },
    },
  });
}

/**
 * runRewriteGate(gateName, handler) — the compression sibling of runGate().
 * Resolves its OWN mode from resolveCompressMode(); when 'off' exits 0
 * immediately (zero side effects, opt-in default). Otherwise reads stdin
 * fail-open, calls handler(input, ctx); a handler that returns without emitting
 * defaults to a silent allow(); any throw fails OPEN. There is NO deny path here
 * — a compression bug can waste tokens, never block a command.
 */
function runRewriteGate(gateName, handler) {
  if (resolveCompressMode() === 'off') { process.exit(0); return; }
  readStdinJson((input) => {
    try {
      handler(input, { mode: 'on', repoRoot: repoRoot() });
      allow();
    } catch (err) {
      _failOpen(gateName, 'on', err);
    }
  });
}

module.exports = {
  resolveMode,
  repoRoot,
  readStdinJson,
  runGate,
  denyPreToolUse,
  warn,
  blockStop,
  sessionStartContext,
  allow,
  loadAllowlists,
  matchesAny,
  emitGateTelemetry,
  normalizeToolPath,
  resolveCompressMode,
  extractBashCommand,
  rewriteBashInput,
  runRewriteGate,
};
