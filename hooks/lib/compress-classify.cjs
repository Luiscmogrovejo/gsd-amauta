'use strict';
const fs = require('fs');
const path = require('path');

function repoRoot() {
  return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

// ── Loop guard (RWRT-05): the wrapper sentinel appears in the command, OR the wrapper
//    marked the process env. Either => never rewrite/re-compress. Checked FIRST by callers.
const WRAPPER_SENTINEL = 'gsd-compress';
function isAlreadyWrapped(command) {
  if (process.env.GSD_COMPRESS_ACTIVE === '1') return true;
  return typeof command === 'string' && command.includes(WRAPPER_SENTINEL);
}

// ── Compound passthrough (RWRT-03): any shell metacharacter, subshell, heredoc, newline,
//    or a LEADING env-assignment (FOO=bar cmd) => not a bare simple command => passthrough.
//    NOTE: quotes are NOT metacharacters here — we prepend a prefix to the ORIGINAL string and
//    let the outer shell re-parse, so quoting is preserved by construction (Pitfall 4).
function isCompound(command) {
  if (typeof command !== 'string' || command.trim() === '') return true;
  if (/[|<>&;`]/.test(command)) return true;        // pipe, redirect, background, seq, backtick
  if (command.includes('$(')) return true;           // command substitution
  if (/[()]/.test(command)) return true;             // subshell
  if (/\n/.test(command)) return true;               // multiline / heredoc body
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return true; // leading env-assignment
  return false;
}

// ── head/verb extraction (safe only AFTER isCompound() is false).
function extractHead(command) {
  if (typeof command !== 'string') return null;
  const toks = command.trim().split(/\s+/).filter(Boolean);
  return toks.length ? toks[0] : null;
}
function extractVerb(command) {
  const toks = (command || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 1; i < toks.length; i++) { if (!toks[i].startsWith('-')) return toks[i]; }
  return null;
}

// ── Destructive denylist (RWRT-04). GSD_COMPRESS_DENYLIST_PATH authoritative-exclusive seam
//    (mirrors loadAllowlists). Returns null on ANY failure — callers MUST treat null as
//    "cannot verify safety => passthrough" (Pitfall 5 fail-open-to-no-compression).
function loadDenylist() {
  try {
    const p = process.env.GSD_COMPRESS_DENYLIST_PATH ||
      path.join(repoRoot(), 'get-shit-done', 'config', 'compress-denylist.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}
// isDestructive(command, dl): true = deny. dl===null is handled by the caller (passthrough).
function isDestructive(command, dl) {
  if (!dl || typeof dl !== 'object') return true; // unverifiable => treat as destructive (deny rewrite)
  const head = extractHead(command);
  const verb = extractVerb(command);
  if (Array.isArray(dl.deny_all_programs) && dl.deny_all_programs.includes(head)) return true;
  if (dl.deny_verbs && Array.isArray(dl.deny_verbs[head]) && verb && dl.deny_verbs[head].includes(verb)) return true;
  if (Array.isArray(dl.deny_patterns)) {
    for (const pat of dl.deny_patterns) {
      try { if (new RegExp(pat, 'i').test(command)) return true; } catch { /* bad pattern -> skip */ }
    }
  }
  return false;
}

// ── Exclude list (RWRT-03): .planning/config.json compression.exclude_commands.
//    Own seam (GSD_COMPRESS_CONFIG_PATH) so this module needs nothing from hook-common.
function loadExcludeList() {
  try {
    const p = process.env.GSD_COMPRESS_CONFIG_PATH ||
      path.join(repoRoot(), '.planning', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ex = cfg && cfg.compression && cfg.compression.exclude_commands;
    return Array.isArray(ex) ? ex : [];
  } catch { return []; }
}
function isExcluded(command) {
  const head = extractHead(command);
  for (const e of loadExcludeList()) {
    if (typeof e !== 'string') continue;
    if (command === e || command.trim() === e || head === e) return true;
  }
  return false;
}

// ── Allowlist lookup (RWRT-01 eligibility). Delegate the registry read to the Phase-72
//    loader (single source). An entry matches when head ∈ entry.heads and, if the entry
//    declares subcommands, verb ∈ entry.subcommands. Prod registry (v1.1) matches
//    git/test/list/search/docker; returns null only on a genuine registry miss.
function lookupAllowlist(command) {
  let reg;
  try { reg = require('../../get-shit-done/bin/lib/compress-filters/index.cjs').loadRegistry(); }
  catch { return null; }
  const entries = (reg && Array.isArray(reg.entries)) ? reg.entries : [];
  const head = extractHead(command);
  const verb = extractVerb(command);
  for (const e of entries) {
    if (!e || e.enabled === false || !Array.isArray(e.heads) || !e.heads.includes(head)) continue;
    if (Array.isArray(e.subcommands) && e.subcommands.length) {
      if (verb && e.subcommands.includes(verb)) return e;
      continue;
    }
    return e;
  }
  return null;
}

// ── PreToolUse decision (deny-before-allow ORDER is the whole safety contract).
//    Returns 'passthrough' | { rewrite: true, command }.
function classifyForRewrite(command) {
  if (isAlreadyWrapped(command)) return 'passthrough';   // RWRT-05 FIRST
  if (isCompound(command)) return 'passthrough';         // RWRT-03 metachar
  const dl = loadDenylist();
  if (dl === null) return 'passthrough';                 // RWRT-04 fail-open-to-no-rewrite
  if (isDestructive(command, dl)) return 'passthrough';  // RWRT-04 deny-BEFORE-allow
  if (isExcluded(command)) return 'passthrough';         // RWRT-03 exclude
  const entry = lookupAllowlist(command);                // RWRT-03 unknown => null
  if (!entry) return 'passthrough';
  return { rewrite: true, command };                     // RWRT-01 (gate resolves wrapper path + emits)
}

// ── PostToolUse decision: compress unless already-wrapped (RWRT-05) or excluded (RWRT-03).
//    Allowlisted commands normally arrive already-wrapped (their tool_input.command is the
//    'node .../gsd-compress.cjs -- ...' form) and are thus naturally skipped; the net safely
//    catches everything the pre-gate did not. Returns 'passthrough' | 'compress'.
function classifyForPost(command) {
  if (isAlreadyWrapped(command)) return 'passthrough';
  if (isExcluded(command)) return 'passthrough';
  return 'compress';
}

module.exports = {
  isAlreadyWrapped, isCompound, extractHead, extractVerb,
  loadDenylist, isDestructive, isExcluded, lookupAllowlist,
  classifyForRewrite, classifyForPost, WRAPPER_SENTINEL,
};
