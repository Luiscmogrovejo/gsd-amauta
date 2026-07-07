#!/usr/bin/env node
'use strict';
const path = require('path');
const hookCommon = require('./lib/hook-common.cjs');
const classify = require('./lib/compress-classify.cjs');
const { applyChain, neverWorse } = require('../get-shit-done/bin/gsd-compress.cjs');

// Load the generic fallback filter (FILT-06, shipped Phase 73). Absent -> identity passthrough
// (defensive; prod now has generic.cjs so it loads and compresses non-allowlisted output).
// GSD_COMPRESS_GENERIC_PATH is an authoritative test seam.
function loadGenericChain() {
  const p = process.env.GSD_COMPRESS_GENERIC_PATH ||
    path.join(__dirname, '..', 'get-shit-done', 'bin', 'lib', 'compress-filters', 'generic.cjs');
  try {
    const mod = require(p);
    if (mod && typeof mod.transform === 'function') return [mod.transform];
  } catch { /* fall through */ }
  return [(stdout) => (typeof stdout === 'string' ? stdout : '')]; // identity fallback
}

// extractToolOutputText(input) — PostToolUse stdin carries the result under `tool_output`
// ({ type:'text', text } per docs); tolerate a bare-string form too. Returns string or null.
function extractToolOutputText(input) {
  const to = input && input.tool_output;
  if (typeof to === 'string') return to;
  if (to && typeof to.text === 'string') return to.text;
  return null;
}

// buildPostOutput(command, outputText, _chainOverride) — PURE. Applies the post guards then
// compresses; returns the compressed string ONLY if strictly smaller (never-worse), else null
// (passthrough). Reuses Phase-72 applyChain (fail-open to raw) + neverWorse. Exported for tests.
function buildPostOutput(command, outputText, _chainOverride) {
  if (typeof outputText !== 'string') return null;
  if (classify.classifyForPost(command) !== 'compress') return null; // RWRT-05 wrapped / RWRT-03 excluded
  const head = classify.extractHead(command);
  const chain = _chainOverride || loadGenericChain();
  const filtered = applyChain(head, outputText, '', 0, chain); // COMP-04 fail-open to raw inside
  const result = neverWorse(filtered, outputText);             // COMP-03 never larger
  return result.length < outputText.length ? result : null;
}

function _runGate() {
  hookCommon.runPostGate('compress-post', (input) => {
    const command = hookCommon.extractBashCommand(input);
    if (command === null) return;                     // no command -> passthrough
    const out = extractToolOutputText(input);
    if (out === null) return;                         // no text output -> passthrough
    const compressed = buildPostOutput(command, out); // NO re-run — pure text transform
    if (compressed !== null) hookCommon.rewriteToolOutput(compressed); // RWRT-02 (exits)
    // else: return -> runPostGate exits 0, original output kept.
  });
}

if (require.main === module) {
  _runGate();
}
module.exports = { buildPostOutput, extractToolOutputText, loadGenericChain };
