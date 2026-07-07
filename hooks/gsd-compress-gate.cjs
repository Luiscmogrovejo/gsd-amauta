#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-compress-gate.cjs — Phase 74 RWRT-01.
 *
 * PreToolUse gate (matcher: Bash). A THIN wrapper on the Phase-72 rewrite
 * primitives (hooks/lib/hook-common.cjs: runRewriteGate + rewriteBashInput)
 * and the 74-01-01 safety classifier (hooks/lib/compress-classify.cjs:
 * classifyForRewrite). It only DECIDES + EMITS — all safety logic (loop
 * guard, compound passthrough, deny-before-allow, exclude, allowlist) lives
 * in the classifier, the single source of truth both hooks consume.
 *
 * Contract (RWRT-01/03/05):
 *   - compression off -> runRewriteGate exits 0 before any work (opt-in).
 *   - non-Bash / no command -> passthrough (allow unchanged).
 *   - classifier says passthrough (RWRT-03/04/05) -> passthrough.
 *   - compressor wrapper unresolvable (Pitfall 9) -> passthrough (fail-open).
 *   - otherwise -> rewrite the ORIGINAL command to route through the wrapper
 *     via hookSpecificOutput.updatedInput (permissionDecision always 'allow').
 *
 * This gate can NEVER deny and NEVER spawns the command — it only rewrites
 * the command string; the wrapper (get-shit-done/bin/gsd-compress.cjs) runs
 * it once with the real exit code + tee + never-worse (Phase 72). Registration
 * into settings.json and the --enable-compression toggle are Phase 75.
 */

const fs = require('fs');
const path = require('path');
const hookCommon = require('./lib/hook-common.cjs');
const classify = require('./lib/compress-classify.cjs');

// Resolve the compressor wrapper by ABSOLUTE path (Pitfall 9 — a stripped PATH must still find
// it). GSD_COMPRESS_WRAPPER_PATH is an authoritative test seam (point it at /nonexistent to prove
// the compressor-absent fail-open). Returns an absolute path that EXISTS, or null.
function resolveWrapper() {
  const p = process.env.GSD_COMPRESS_WRAPPER_PATH ||
    path.join(hookCommon.repoRoot(), 'get-shit-done', 'bin', 'gsd-compress.cjs');
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

// buildWrappedCommand(original, wrapperPath, opts) — prepend the wrapper invocation to the
// ORIGINAL command string (string concat, NOT re-tokenized — preserves quoting; safe because
// the classifier already rejected every shell metacharacter). Absolute wrapper path.
// TOGL-04: opts.raw emits the `--raw` form so the wrapper bypasses compression for this run.
function buildWrappedCommand(original, wrapperPath, opts) {
  const rawFlag = opts && opts.raw ? '--raw ' : '';
  return 'node ' + wrapperPath + ' ' + rawFlag + '-- ' + original;
}

function _runGate() {
  // runRewriteGate: off (resolveCompressMode) -> exit 0 before any work; else fail-open stdin.
  hookCommon.runRewriteGate('compress-gate', (input) => {
    const command = hookCommon.extractBashCommand(input);
    if (command === null) return;                       // non-Bash / no command -> allow passthrough
    // TOGL-04: a LEADING --raw/--no-compress marker routes the bare command THROUGH the wrapper
    // in raw mode so the PostToolUse hook skips it via isAlreadyWrapped (RWRT-05, no post change).
    if (classify.hasRawBypass(command)) {
      const bare = classify.stripRawBypass(command);
      const wrapper = resolveWrapper();
      if (wrapper && !classify.isCompound(bare)) {
        hookCommon.rewriteBashInput(buildWrappedCommand(bare, wrapper, { raw: true }));
      } else {
        hookCommon.rewriteBashInput(bare);              // no wrapper / compound -> strip marker, passthrough
      }
      return;
    }
    const decision = classify.classifyForRewrite(command);
    if (decision === 'passthrough') return;             // RWRT-03/04/05 -> allow passthrough
    const wrapper = resolveWrapper();
    if (!wrapper) return;                               // RWRT-03 compressor-absent -> allow passthrough
    // RWRT-01: emit the doc-verified updatedInput rewrite (this exits 0).
    hookCommon.rewriteBashInput(buildWrappedCommand(decision.command, wrapper));
  });
}

if (require.main === module) {
  _runGate();
}
module.exports = { resolveWrapper, buildWrappedCommand };
