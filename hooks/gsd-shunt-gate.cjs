#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-shunt-gate.cjs — token-saving read shunt.
 *
 * PreToolUse gate (matcher: Read|Bash). Keeps whole reads of large files out
 * of an expensive model's context and points the caller at cheaper routes:
 * a targeted read (offset/limit), a local `gsd-rlm query` for line ranges, or
 * the Haiku worker in get-shit-done/bin/gsd-shunt.cjs.
 *
 * Contract:
 *   - Mode comes from resolveShuntMode() — GSD_SHUNT=on|warn|off, else
 *     `.planning/config.json` `shunt.enabled`; default OFF (opt-in). It is
 *     deliberately NOT keyed on GSD_HOOKS_ENFORCE: the enforcement gates run
 *     warn-first, and a shunt that only warns saves no tokens.
 *   - Read  : denied when the file is over the line or byte threshold and the
 *     call has no offset/limit. Targeted reads always pass.
 *   - Bash  : denied when a bare cat/head/tail/less/more/bat dumps such a
 *     file. Pipelines and compound commands are targeted reads and pass.
 *   - Applies in the main thread AND in subagents (executors are where the
 *     reads happen). Only the worker agents and GSD_SHUNT_EXEMPT_AGENTS pass.
 *   - Never blocks: images/PDFs/notebooks, missing files, plan files an
 *     executor must hold whole (GSD_SHUNT_EXEMPT_RE), or anything when off.
 *   - Fails OPEN: any error allows the call. This gate can cost tokens when
 *     it breaks; it can never brick Read.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const hookCommon = require('./lib/hook-common.cjs');

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ipynb', '.svg', '.ico']);
const DUMP_CMDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat']);
const DEFAULT_EXEMPT_AGENTS = ['gsd-bulk-reader', 'gsd-code-writer', 'bulk-reader', 'code-writer'];
// Plan files are the executor's contract: it must hold them whole.
const DEFAULT_EXEMPT_RE = '(^|/)[^/]*PLAN\\.md$';

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readShuntConfig() {
  try {
    const p = process.env.GSD_SHUNT_CONFIG_PATH ||
      path.join(hookCommon.repoRoot(), '.planning', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = cfg && cfg.shunt;
    return (s && typeof s === 'object') ? s : {};
  } catch {
    return {};
  }
}

/** resolveShuntMode() — 'off' | 'warn' | 'on'; default 'off' (opt-in). */
function resolveShuntMode() {
  const raw = process.env.GSD_SHUNT;
  if (raw === 'off' || raw === 'warn' || raw === 'on') return raw;
  return readShuntConfig().enabled ? 'on' : 'off';
}

function thresholds() {
  const cfg = readShuntConfig();
  return {
    minLines: intEnv('GSD_SHUNT_MIN_LINES', cfg.min_lines > 0 ? cfg.min_lines : 400),
    minBytes: intEnv('GSD_SHUNT_MIN_BYTES', cfg.min_bytes > 0 ? cfg.min_bytes : 40000),
  };
}

function exemptAgents() {
  const extra = (process.env.GSD_SHUNT_EXEMPT_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set(DEFAULT_EXEMPT_AGENTS.concat(extra));
}

function exemptPathRe() {
  try {
    return new RegExp(process.env.GSD_SHUNT_EXEMPT_RE || DEFAULT_EXEMPT_RE);
  } catch {
    return new RegExp(DEFAULT_EXEMPT_RE);
  }
}

function countLines(file, cap) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    let lines = 0;
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < n; i++) {
        if (buf[i] === 10 && ++lines >= cap) return lines;
      }
    }
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/** bigFile(p, cwd, t) — {path, lines, bytes} when over a threshold, else null. */
function bigFile(p, cwd, t) {
  if (!p || typeof p !== 'string') return null;
  let abs = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  if (!path.isAbsolute(abs)) abs = path.join(cwd || process.cwd(), abs);
  if (SKIP_EXT.has(path.extname(abs).toLowerCase())) return null;
  if (exemptPathRe().test(abs.split(path.sep).join('/'))) return null;
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const lines = countLines(abs, t.minLines);
  if (lines < t.minLines && st.size < t.minBytes) return null;
  return { path: abs, lines, bytes: st.size, capped: lines >= t.minLines };
}

/** Minimal POSIX-ish tokenizer; returns null on an unterminated quote. */
function shellSplit(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i]; has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
    }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

/** bashTargets(cmd) — files a bare dump command would print whole; [] otherwise. */
function bashTargets(cmd) {
  if (!cmd || /[|;&><`$(\n]/.test(cmd)) return [];
  const parts = shellSplit(cmd);
  if (!parts || parts.length === 0) return [];
  const prog = path.basename(parts[0]);
  if (!DUMP_CMDS.has(prog)) return [];
  const rest = parts.slice(1);
  if ((prog === 'head' || prog === 'tail') && rest.some(a => a.startsWith('-'))) return [];
  return rest.filter(a => !a.startsWith('-'));
}

function workerPath() {
  const candidates = [
    process.env.GSD_SHUNT_WORKER_PATH,
    path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-shunt.cjs'),
    path.join(hookCommon.repoRoot(), 'get-shit-done', 'bin', 'gsd-shunt.cjs'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return 'gsd-shunt.cjs';
}

function message(hit) {
  const kb = Math.round(hit.bytes / 1024);
  const w = workerPath();
  return (
    `gsd-shunt: ${hit.path} is large (${hit.lines}${hit.capped ? '+' : ''} lines, ${kb} KB); ` +
    'a whole-file read is blocked to save context. Pick the cheapest route that answers your need: ' +
    `(1) to edit or inspect a known part, Read it again with offset/limit (Grep first for line numbers); ` +
    `(2) to locate code, run: gsd-rlm query "<what you need>" --paths ${hit.path} — it returns line ranges; ` +
    `(3) to understand the whole file, run: node ${w} bulk-read --question "<question>" --paths ${hit.path} ` +
    '(a Haiku worker reads it and returns bullets with line numbers; verify lines with a targeted read before editing). ' +
    'Debugging, design and security review stay with you: read the relevant ranges directly. ' +
    'If the full file is truly required, say so; the operator can set GSD_SHUNT=off.'
  );
}

function logEvent(event) {
  try {
    const file = process.env.GSD_SHUNT_LOG ||
      path.join(os.homedir(), '.amauta', 'shunt', 'log.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
  } catch {
    // Metrics are best-effort; never block on them.
  }
}

/**
 * decide(input) — pure decision. Returns null (allow) or
 * {hit, tool, agent} for a call that should be shunted.
 */
function decide(input) {
  if (!input || typeof input !== 'object') return null;
  const agent = input.agent_type || null;
  if (agent && exemptAgents().has(agent)) return null;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const t = thresholds();
  if (tool === 'Read') {
    if (ti.offset !== undefined && ti.offset !== null) return null;
    if (ti.limit !== undefined && ti.limit !== null) return null;
    const hit = bigFile(ti.file_path, input.cwd, t);
    return hit ? { hit, tool, agent } : null;
  }
  if (tool === 'Bash') {
    for (const p of bashTargets(ti.command || '')) {
      const hit = bigFile(p, input.cwd, t);
      if (hit) return { hit, tool, agent };
    }
  }
  return null;
}

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj)); } catch { /* fail open */ }
  process.exit(0);
}

function _runGate() {
  const mode = resolveShuntMode();
  if (mode === 'off') { process.exit(0); return; }
  hookCommon.readStdinJson((input) => {
    try {
      const d = decide(input);
      if (!d) { process.exit(0); return; }
      logEvent({
        ts: Math.floor(Date.now() / 1000),
        event: mode === 'on' ? 'blocked' : 'warned',
        session: input.session_id || null,
        agent: d.agent || 'main',
        tool: d.tool,
        path: d.hit.path,
        lines: d.hit.lines,
        bytes: d.hit.bytes,
      });
      const reason = message(d.hit);
      if (mode === 'warn') { emit({ systemMessage: reason }); return; }
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      });
    } catch {
      process.exit(0); // fail open
    }
  });
}

if (require.main === module) {
  _runGate();
}
module.exports = { resolveShuntMode, thresholds, bigFile, bashTargets, shellSplit, decide, message };
