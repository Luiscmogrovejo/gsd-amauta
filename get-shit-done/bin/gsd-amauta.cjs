#!/usr/bin/env node

/**
 * GSD-Amauta CLI — Node.js wrapper for the Amauta task management daemon.
 *
 * Communicates with amauta-daemon.py on localhost:18799 via HTTP.
 * Falls back to direct `python3 amauta.py` invocation if daemon is unreachable.
 *
 * Usage: amauta <command> [args] [--json]
 * (Invoked via: node amauta.cjs | node gsd-amauta.cjs — both delegate here)
 *
 * Commands:
 *   board                               Show task board
 *   stats                               Show statistics
 *   show <id> [--json]                  Show task details
 *   next <agent> [--json]               Get next task for agent
 *   list [--type T] [--status S] [--agent A]  List tasks
 *   add <type> <title> [--options]      Add new task
 *   claim <id> --agent <agent>          Claim a task
 *   rpetd <id> --phase P --content "."  Log RPETD phase
 *   validate <id> --pass/--fail [opts]  Validate a task
 *   note <id> --text "..." [--agent A]  Add note to task
 *   status <id> <new-status>            Change task status
 *   search <query>                      Search tasks
 *   score <id>                          Show priority score
 *   assign <id> --agent <agent>         Assign task
 *   link <id> --dep <dep-id>            Add dependency
 *   unlink <id> --dep <dep-id>          Remove dependency
 *   update <id> [--field val ...]       Update task fields
 *   delete <id>                         Delete task
 *   exec <...args>                      Raw passthrough to amauta.py
 *   daemon start|stop|status|run        Control the daemon
 *
 * Environment:
 *   GSD_AMAUTA_PORT    Daemon port (default: 18799)
 *   GSD_AMAUTA_PY      Path to amauta.py
 *   AMAUTA_DATA_DIR    Task data directory
 *   GSD_AMAUTA_HOST    Daemon host (default: 127.0.0.1)
 */

const http = require('http');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Phase 62 TEL-02: fire-and-forget telemetry emit. Fail-open — a
// missing/broken telemetry module must never change CLI behavior.
function _telemetryEmit(eventType, payload) {
  try { require('./lib/telemetry.cjs').emit(eventType, payload); } catch { /* fail-open */ }
}

// ── Load .env file (skipped in test mode) ─────────────
(function loadDotenv() {
  if (process.env.GSD_AMAUTA_NO_AUTO_START) return;
  for (const f of [path.join(__dirname, '..', '..', '.env'), '/srv/amauta/.env']) {
    try {
      for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k && !(k in process.env)) process.env[k] = v;
      }
      break;
    } catch { /* next */ }
  }
})();

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const HOST = process.env.GSD_AMAUTA_HOST || '127.0.0.1';
const PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);

// PLUGIN_ROOT resolution:
// - In source repo (~/Code/gsd-amauta/get-shit-done/bin/), `../..` = repo root (has amauta.py + services/) ✓
// - When installed (~/.config/opencode/get-shit-done/bin/ or ./.opencode/get-shit-done/bin/), `../..` = runtime root.
//   If amauta.py is not present there, fall back to known source-repo locations.
//   source-repo locations so the CLI's `python3 amauta.py` fallback path remains valid even after install.
function _resolvePluginRoot() {
  const candidates = [
    path.resolve(__dirname, '..', '..'),                     // source repo layout
    path.resolve(__dirname, '..'),                           // installed layout (.../get-shit-done)
  ];
  // Prefer the one that actually contains amauta.py
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'amauta.py'))) return c;
  }
  // Final fallback chain — common dev/install locations
  const home = process.env.HOME || require('os').homedir();
  const fallbacks = [
    path.join(home, 'Code', 'gsd-amauta'),
    path.join(home, 'gsd-amauta'),
    path.join(home, '.config', 'opencode', 'get-shit-done'),
    path.join(home, '.opencode', 'get-shit-done'),
  ];
  for (const c of fallbacks) {
    if (fs.existsSync(path.join(c, 'amauta.py'))) return c;
  }
  // Give up — return the original (broken) path so existing error messages still mention it
  return candidates[0];
}
const PLUGIN_ROOT = _resolvePluginRoot();
const AMAUTA_PY = process.env.GSD_AMAUTA_PY || path.join(PLUGIN_ROOT, 'amauta.py');
const DATA_DIR = process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT, 'data');

// Phase 62 TEL-01/TEL-03: consent-gated local telemetry core (lazy-required
// below at first use so a missing/broken telemetry.cjs never blocks any
// other amauta command).
let _telemetry = null;
function _tel() {
  if (!_telemetry) _telemetry = require(path.join(__dirname, 'lib', 'telemetry.cjs'));
  return _telemetry;
}

function resolveReferencePath(relPath) {
  const candidates = [
    path.join(PLUGIN_ROOT, 'get-shit-done', relPath),
    path.join(PLUGIN_ROOT, relPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
// Daemon script may live in the source repo even when this CLI is installed; check there first.
const DAEMON_SCRIPT = (function() {
  const local = path.join(PLUGIN_ROOT, 'services', 'amauta-daemon.py');
  if (fs.existsSync(local)) return local;
  const home = process.env.HOME || require('os').homedir();
  for (const c of [
    path.join(home, 'Code', 'gsd-amauta', 'services', 'amauta-daemon.py'),
    path.join(home, 'gsd-amauta', 'services', 'amauta-daemon.py'),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return local;
})();

// ═══════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════

/**
 * Make an HTTP request to the daemon.
 * @param {string} method - GET or POST
 * @param {string} urlPath - e.g. /api/board
 * @param {object|null} body - JSON body for POST requests
 * @param {number} timeoutMs - request timeout
 * @returns {Promise<{statusCode: number, data: object}>}
 */
function httpRequest(method, urlPath, body = null, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ statusCode: res.statusCode, data: { output: raw, error: '', exit_code: 0 } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// Daemon Management
// ═══════════════════════════════════════════════════════

/**
 * Check if daemon is running by hitting /health.
 * @returns {Promise<boolean>}
 */
async function isDaemonRunning() {
  try {
    const { statusCode, data } = await httpRequest('GET', '/health', null, 3000);
    return statusCode === 200 && data.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Attempt to start the daemon in the background.
 * @returns {Promise<boolean>} true if daemon started successfully
 */
async function startDaemon() {
  if (!fs.existsSync(DAEMON_SCRIPT)) {
    return false;
  }

  // Use spawn with detached + unref so daemon outlives this process
  const child = spawn('python3', [DAEMON_SCRIPT, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AMAUTA_DATA_DIR: DATA_DIR,
      GSD_AMAUTA_PY: AMAUTA_PY,
      GSD_AMAUTA_PORT: String(PORT),
    },
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      process.stderr.write('ERROR: python3 not found. Install Python 3.9+ to use Amauta daemon.\n');
    }
  });
  child.unref();

  // Wait up to 5 seconds for daemon to come online
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (await isDaemonRunning()) return true;
  }
  return false;
}

/**
 * Ensure daemon is running, start it if needed.
 * Set GSD_AMAUTA_NO_AUTO_START=1 to skip auto-start (useful in tests).
 * @returns {Promise<boolean>}
 */
async function ensureDaemon() {
  if (await isDaemonRunning()) return true;

  // Allow tests/CI to skip auto-start (saves 5s startup wait per test)
  if (process.env.GSD_AMAUTA_NO_AUTO_START === '1') {
    process.stderr.write('WARNING: Daemon not running, using direct CLI (auto-start disabled).\n');
    return false;
  }

  process.stderr.write('Amauta daemon not running, starting...\n');
  const started = await startDaemon();
  if (started) {
    process.stderr.write('Daemon started.\n');
    return true;
  }
  process.stderr.write('WARNING: Could not start daemon, falling back to direct CLI.\n');
  return false;
}

// ═══════════════════════════════════════════════════════
// Direct CLI Fallback
// ═══════════════════════════════════════════════════════

/**
 * Run amauta.py directly when daemon is unavailable.
 * @param {string[]} args - CLI args to pass to amauta.py
 * @returns {{output: string, error: string, exit_code: number}}
 */
function runDirect(args) {
  try {
    const result = execFileSync('python3', [AMAUTA_PY, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        AMAUTA_DATA_DIR: DATA_DIR,
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { output: result, error: '', exit_code: 0 };
  } catch (err) {
    return {
      output: err.stdout || '',
      error: err.stderr || err.message,
      exit_code: err.status || 1,
    };
  }
}

// ═══════════════════════════════════════════════════════
// Output Formatting
// ═══════════════════════════════════════════════════════

/**
 * Print daemon response to stdout.
 * @param {object} data - Response data with output/error/exit_code
 * @param {boolean} jsonMode - If true, output raw JSON
 */
function printResponse(data, jsonMode) {
  if (jsonMode) {
    // Try to parse the output as JSON first (for --json passthrough)
    if (data.output) {
      try {
        const parsed = JSON.parse(data.output);
        process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
        return;
      } catch {
        // output is not JSON, wrap it
      }
    }
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    if (data.output) {
      process.stdout.write(data.output);
      // Ensure trailing newline
      if (!data.output.endsWith('\n')) process.stdout.write('\n');
    }
    if (data.error) {
      process.stderr.write(data.error);
      if (!data.error.endsWith('\n')) process.stderr.write('\n');
    }
  }
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * Parse --key value pairs from argv into an object.
 * @param {string[]} args
 * @param {number} startIndex
 * @returns {object}
 */
function parseFlags(args, startIndex = 0) {
  const flags = {};
  for (let i = startIndex; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Boolean flags (no value)
      if (key === 'pass') { flags.pass_result = true; continue; }
      if (key === 'fail') { flags.pass_result = false; continue; }
      if (key === 'force-reason') {
        const reason = args[i + 1];
        flags.force_reason = (reason !== undefined && !reason.startsWith('--')) ? reason : '';
        if (flags.force_reason) i++;
        continue;
      }
      if (key === 'force') { flags.force = true; continue; }
      // Note: --json is stripped globally before parseFlags is called (see main()),
      // so this branch is a safety fallback only — not normally reached.
      if (key === 'json') { flags.json_output = true; continue; }
      if (key === 'append') { flags.append = true; continue; }
      // Key-value flags
      const nextVal = args[i + 1];
      if (nextVal !== undefined && !nextVal.startsWith('--')) {
        flags[key] = nextVal;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

// ═══════════════════════════════════════════════════════
// Command Handlers
// ═══════════════════════════════════════════════════════

async function cmdBoard(useDaemon, jsonMode) {
  if (useDaemon) {
    const { data } = await httpRequest('GET', '/api/board');
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['board']);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdStats(useDaemon, jsonMode) {
  if (useDaemon) {
    const { data } = await httpRequest('GET', '/api/stats');
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['stats']);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdShow(useDaemon, id, jsonMode, noInherit = false) {
  if (!id) die('Usage: amauta show <id> [--json]');
  const args = jsonMode ? ['show', id, '--json'] : ['show', id];
  if (noInherit) args.push('--no-inherit');
  if (useDaemon) {
    // Use exec for --json passthrough
    if (jsonMode) {
      const { data } = await httpRequest('POST', '/api/exec', { args });
      printResponse(data, jsonMode);
      return data.exit_code || 0;
    }
    const { data } = await httpRequest('GET', `/api/show/${id}`);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdNext(useDaemon, agent, jsonMode) {
  if (!agent) die('Usage: amauta next <agent>');
  if (useDaemon) {
    const { data } = await httpRequest('GET', `/api/next/${agent}`);
    printResponse(data, true); // next always returns JSON
    return data.exit_code || 0;
  }
  const result = runDirect(['next', agent, '--json']);
  printResponse(result, true);
  return result.exit_code;
}

async function cmdList(useDaemon, flags, jsonMode) {
  const queryParts = [];
  if (flags.type) queryParts.push(`type=${encodeURIComponent(flags.type)}`);
  if (flags.status) queryParts.push(`status=${encodeURIComponent(flags.status)}`);
  if (flags.agent) queryParts.push(`agent=${encodeURIComponent(flags.agent)}`);
  const qs = queryParts.length ? `?${queryParts.join('&')}` : '';

  if (useDaemon) {
    const { data } = await httpRequest('GET', `/api/list${qs}`);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const args = ['list'];
  if (flags.type) args.push('--type', flags.type);
  if (flags.status) args.push('--status', flags.status);
  if (flags.agent) args.push('--agent', flags.agent);
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdAdd(useDaemon, argv, jsonMode) {
  // argv: [type, title, ...flags]
  const type = argv[0];
  const title = argv[1];
  if (!type || !title) die('Usage: amauta add <type> <title> [--parent P] [--agent A] [--priority P] ...');
  const flags = parseFlags(argv, 2);
  const body = { type, title, ...flags };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/add', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  // Build direct CLI args
  const args = ['add', type, title];
  if (flags.parent) args.push('--parent', flags.parent);
  if (flags.agent) args.push('--agent', flags.agent);
  if (flags.priority) args.push('--priority', flags.priority);
  if (flags.description) args.push('--description', flags.description);
  if (flags.importance) args.push('--importance', flags.importance);
  if (flags.urgency) args.push('--urgency', flags.urgency);
  if (flags.tags) args.push('--tags', flags.tags);
  if (flags.source) args.push('--source', flags.source);
  if (flags['from-plan']) args.push('--from-plan', flags['from-plan']);
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdClaim(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta claim <id> --agent <agent>');
  const body = { id, ...flags };
  body.project_dir = process.cwd();

  let exitCode;
  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/claim', body);
    printResponse(data, jsonMode);
    exitCode = data.exit_code || 0;
  } else {
    const args = ['claim', id];
    if (flags.agent) args.push('--agent', flags.agent);
    const result = runDirect(args);
    printResponse(result, jsonMode);
    exitCode = result.exit_code;
  }

  // Phase 67 HOOK-05: best-effort claim-marker write. The daemon/direct
  // response never carries the task's tags (just {output,error,exit_code}),
  // so the marker's manifest resolution ALWAYS reads data/tasks.json
  // locally via hook-state's findTaskItem/resolveManifestForTask (zero
  // extra daemon calls, per TK-1747). Wrapped so any failure here — missing
  // module, unreadable tasks.json, read-only marker dir — changes NOTHING
  // about claim's exit code or stdout.
  if (exitCode === 0) {
    try {
      const hookState = require('./lib/hook-state.cjs');
      const item = hookState.findTaskItem(id);
      const tags = (item && Array.isArray(item.tags)) ? item.tags : [];
      const planTag = tags.find((t) => typeof t === 'string' && t.startsWith('plan:'));
      const taskTag = tags.find((t) => typeof t === 'string' && t.startsWith('task:'));
      const planId = planTag ? planTag.slice('plan:'.length) : null;
      const phaseMatch = planId ? /^(\d+)/.exec(planId) : null;
      const filesExpected = item ? hookState.resolveManifestForTask(item) : null;
      hookState.writeActiveTask(id, {
        plan_task_id: taskTag ? taskTag.slice('task:'.length) : null,
        plan_id: planId,
        phase: phaseMatch ? phaseMatch[1] : null,
        agent: flags.agent || (item && item.assigned_to) || null,
        claimed_at: new Date().toISOString(),
        files_expected: filesExpected,
      });
    } catch {
      // Best-effort — marker write failure must never affect claim behavior.
    }
  }

  return exitCode;
}

const VALID_PHASES = new Set(['R', 'P', 'E', 'T', 'D']);

async function cmdRpetd(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta rpetd <id> --phase P --content "..."');
  if (!flags.phase) die('--phase is required (R, P, E, T, or D)');
  const phaseUpper = (flags.phase || '').toUpperCase();
  if (!VALID_PHASES.has(phaseUpper)) die(`Invalid phase "${flags.phase}". Must be one of: R, P, E, T, D`);
  flags.phase = phaseUpper; // Normalize to uppercase before passing to daemon
  if (!flags.content) die('--content is required');
  // Phase 68 MOBL-04: scrub build-log/evidence secrets BEFORE either
  // transport (daemon POST or file-fallback) sees the content, so both
  // inherit the scrub from this one choke point.
  flags.content = scrubEvidence(flags.content);
  const body = { id, ...flags };

  let exitCode = 0;
  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/rpetd', body);
    printResponse(data, jsonMode);
    // Use strict undefined check — exit_code of 0 is falsy but means success
    exitCode = (data.exit_code !== undefined && data.exit_code !== null) ? data.exit_code : 0;
  } else {
    const args = ['rpetd', id, '--phase', flags.phase, '--content', flags.content];
    if (flags.agent) args.push('--agent', flags.agent);
    if (flags.append) args.push('--append');
    const result = runDirect(args);
    printResponse(result, jsonMode);
    exitCode = result.exit_code;
  }

  // TK-0051: Auto-learning capture — store every phase log to memory (best-effort)
  if (exitCode === 0) {
    await autoLearnFromRpetd(useDaemon, id, flags);
  }

  // Phase 20 HANDOFF-05: Store structured context after each phase (best-effort)
  if (exitCode === 0 && useDaemon) {
    await compactRpetdContext(id, flags);
  }

  return exitCode;
}

/**
 * TK-0051: Auto-store RPETD phase content to memory with rpetd_phase source (+1 boost).
 * TK-0052: If D-phase contains LEARNING: block, extract and store with auto_learning source (+3 boost).
 * Best-effort — silent fail if memory daemon is unavailable.
 */
async function autoLearnFromRpetd(useDaemon, taskId, flags) {
  const phase = (flags.phase || '').toUpperCase();
  const content = flags.content || '';
  const agent = flags.agent || '';

  try {
    // Store phase summary to memory (source=rpetd_phase, +1 boost)
    // When daemon is active, amauta.py cmd_rpetd() already stores phase content to PG memory,
    // so we skip the CJS-side store to avoid duplicates. Only write in direct (no-daemon) mode.
    const phaseText = `[${phase}] ${taskId}: ${content.substring(0, 500)}`;

    if (!useDaemon) {
      // File-based fallback: append to .planning/memory/ so phase data is not silently lost
      try {
        const memDir = path.join(process.cwd(), '.planning', 'memory');
        fs.mkdirSync(memDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const memFile = path.join(memDir, `${date}.md`);
        const entry = `- [rpetd_phase] ${new Date().toISOString()}: ${phaseText}\n`;
        fs.appendFileSync(memFile, entry);
      } catch { /* best-effort */ }
    }

    // TK-0052: Extract LEARNING from D-phase and store with higher boost
    // When daemon is active, amauta.py cmd_rpetd() already extracts and stores D-phase learnings
    // as 'session-learning' source. Only write in direct (no-daemon) mode to avoid duplicates.
    if (phase === 'D' && !useDaemon) {
      const learningMatch = content.match(/LEARNING[:\s]+([\s\S]+?)(?=\n(?:##|\n\s*\[[A-Z]\]|\n\s*Parent:|\n\s*Depends)|$)/i);
      if (learningMatch) {
        const learning = learningMatch[1].trim();
        // File-based fallback for D-phase learning
        try {
          const memDir = path.join(process.cwd(), '.planning', 'memory');
          fs.mkdirSync(memDir, { recursive: true });
          const date = new Date().toISOString().split('T')[0];
          const memFile = path.join(memDir, `${date}.md`);
          const entry = `- [auto_learning] ${new Date().toISOString()}: ${taskId} — ${learning}\n`;
          fs.appendFileSync(memFile, entry);
        } catch { /* best-effort */ }
      }
    }
  } catch {
    // Best-effort — don't fail the rpetd command if memory store fails
  }
}

/**
 * Phase 20 HANDOFF-05: After each RPETD phase, compact the conversation into
 * a structured RPETDContext and store it via the daemon.
 *
 * Best-effort — silent fail if daemon endpoint is unavailable.
 * The compact endpoint accepts {messages, task_id, phase} and returns
 * {compiled_view, context_version, stored, stored_id}.
 *
 * In v1, messages is a minimal representation (just the phase content),
 * because full conversation history is not available in the CJS tool.
 * Phase 24 ROUTE-02 will wire LLM-backed compaction.
 */
async function compactRpetdContext(taskId, flags) {
  const phase = (flags.phase || '').toUpperCase();
  const content = flags.content || '';

  try {
    // Build a minimal message representation from the phase content.
    // Full conversation is not available in the CLI path; the daemon
    // fallback extractor will produce a best-effort RPETDContext.
    const messages = [
      { role: 'user', content: `Task ${taskId}: RPETD phase ${phase}` },
      { role: 'assistant', content: content.substring(0, 2000) },
    ];

    const { data } = await httpRequest('POST', '/api/context/compact', {
      messages,
      task_id: taskId,
      phase,
    });

    if (data && data.stored) {
      // Context stored successfully — no output needed (best-effort)
    }
  } catch {
    // Best-effort — don't fail the rpetd command if context compact fails
  }
}

// ─── Validation Gates ────────────────────────────────
// Gate 1 (TK-0029): Branch evidence in E-phase for code tasks
// Gate 2 (TK-0030): LEARNING block in D-phase
// Gate 3 (TK-0046): Test evidence in T-phase — raw output required

const BRANCH_PATTERNS = /\b(feat|fix|chore|refactor|docs|test|hotfix|release|bugfix|feature)\//i;
const LEARNING_PATTERN = /LEARNING[:\s]/i;
// Types exempt from branch/test/PR gates (code-only gates)
// Includes research, docs, marketing, finance, planning types that don't produce code artifacts
const NON_CODE_TYPES = new Set([
  'epic', 'story',                                    // hierarchy containers
  'research', 'spike', 'discovery',                  // investigation tasks
  'docs', 'documentation', 'design', 'spec',         // non-code outputs
  'marketing', 'finance', 'legal', 'planning',       // business operations
  'operations', 'ops',                               // operational tasks
]);

// Test evidence patterns: shell prompts, exit codes, test runner output
const TEST_EVIDENCE_PATTERNS = [
  /(?:^|\n)\s*[\$>]\s+\S/,                                // Shell prompts ($ command or > command)
  /exit\s*code\s*[=:]\s*\d+/i,                            // "exit code: 0"
  /\b(?:PASS|FAIL|PASSED|FAILED)\b/,                       // Test runner verdicts
  /[✓✗✔✘☑☒]\s/,                                          // Unicode check/cross marks
  /\d+\s+(?:passing|failing|passed|failed|tests?)\b/i,    // "12 passing", "3 tests failed"
  /(?:Tests?|Specs?|Suites?)\s*:\s*\d+/i,                 // "Tests: 5", "Suites: 2"
  /(?:npm|yarn|pnpm|jest|vitest|mocha|pytest|cargo|go)\s+test/i, // Test commands
  /(?:^|\n)\s*(?:RUNS?|DONE)\s/,                           // Jest-style RUNS/DONE
  /\bAssertionError\b/,                                    // Assertion failures
  /\berror TS\d+\b/,                                       // TypeScript errors (tsc output)
  /\b(?:BUILD|COMPILE)\s+(?:SUCCEEDED|FAILED|SUCCESS|ERROR)\b/i, // Build results
  /\b(?:OK|FAILED)\s+\(\d+\s+test/i,                      // Python unittest "OK (5 tests..."
  /\bRan\s+\d+\s+tests?\b/i,                              // "Ran 42 tests"
];

async function checkValidationGates(useDaemon, id, flags) {
  if (!flags.pass_result) return []; // Only check gates on --pass

  const gateFailures = [];

  // Fetch task details — prefer JSON to avoid truncated text output
  let taskType = 'task';
  let phases = {}; // { R: '', P: '', E: '', T: '', D: '' }
  let taskData = null; // fallback text
  let notesText = ''; // extracted notes for Gate 4 PR scan (notes may hold PR URLs)
  try {
    if (useDaemon) {
      // Use daemon exec route with --json — always reads from PG, correct path
      const { data } = await httpRequest('POST', '/api/exec', { args: ['show', id, '--json'] });
      const jsonStr = data.output || '';
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        taskType = parsed.type || 'task';
        phases = parsed.rpetd_phases || {};
        // Extract notes text for Gate 4 — notes may contain PR URLs posted after E-phase
        const notes = parsed.notes || [];
        notesText = Array.isArray(notes)
          ? notes.map(n => (typeof n === 'string' ? n : (n && n.text) || '')).join(' ')
          : String(notes || '');
      }
    } else {
      // No daemon — call Python directly via runDirect
      const jsonResult = runDirect(['show', id, '--json']);
      const jsonStr = jsonResult.output || '';
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        taskType = parsed.type || 'task';
        phases = parsed.rpetd_phases || {};
        const notes = parsed.notes || [];
        notesText = Array.isArray(notes)
          ? notes.map(n => (typeof n === 'string' ? n : (n && n.text) || '')).join(' ')
          : String(notes || '');
      }
    }
  } catch {
    // JSON fetch/parse failed — fall back to text output
    try {
      if (useDaemon) {
        const { data } = await httpRequest('GET', `/api/show/${id}`);
        taskData = data.output || '';
      } else {
        const result = runDirect(['show', id]);
        taskData = result.output || '';
      }
    } catch {
      return []; // Can't check gates if show fails — let validation proceed
    }
  }

  // If we got text output but no phases, parse them from text (truncated but better than nothing)
  if (!phases.E && !phases.T && !phases.D && taskData) {
    taskType = (taskData.match(/Type:\s+(\w+)/i) || [])[1] || 'task';
    const extractPhase = (letter, others) => {
      const re = new RegExp(`\\[${letter}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*\\[(?:${others})\\]|\\n\\s*Parent:|\\n\\s*Depends|$)`, 'i');
      return (taskData.match(re) || [])[1] || '';
    };
    phases = {
      R: extractPhase('R', 'PETD'),
      P: extractPhase('P', 'RETD'),
      E: extractPhase('E', 'RPTD'),
      T: extractPhase('T', 'RPED'),
      D: extractPhase('D', 'RPTE'),
    };
  }

  // Check if this is a code task (not epic/story)
  const isCodeTask = !NON_CODE_TYPES.has(taskType);

  // Gate 1: Branch evidence in E-phase (empty E-phase always fails for code tasks)
  if (isCodeTask) {
    const eContent = (phases.E || '').trim();
    if (!eContent) {
      gateFailures.push('BRANCH_EVIDENCE: E-phase is empty. Code tasks require execution evidence with branch name.');
    } else if (!BRANCH_PATTERNS.test(eContent)) {
      const hasBranchEvidence = /branch|git checkout|git switch|merged|PR |pull request/i.test(eContent);
      if (!hasBranchEvidence) {
        gateFailures.push('BRANCH_EVIDENCE: E-phase has no branch name evidence (feat/*, fix/*, etc). Code tasks must show branch work.');
      }
    }
  }

  // Gate 2: LEARNING block — check D-phase first, then all phases (matches amauta.py _has_learning_written)
  // D-phase is the canonical location; if missing there, we also accept it in other phases
  // to be consistent with Python's _has_learning_written() which checks all 5 phases.
  const dContent = (phases.D || '').trim();
  const allPhasesContent = Object.values(phases).join(' ');
  if (!dContent) {
    gateFailures.push('LEARNING_BLOCK: D-phase is empty. All tasks require a Documentation phase with a LEARNING: block.');
  } else if (!LEARNING_PATTERN.test(dContent) && !LEARNING_PATTERN.test(allPhasesContent)) {
    gateFailures.push('LEARNING_BLOCK: No LEARNING: block found in any RPETD phase. Document what was learned in the D-phase.');
  }

  // Gate 3 (TK-0046): Test evidence in T-phase — require raw command output
  if (isCodeTask) {
    const tContent = (phases.T || '').trim();
    if (tContent) {
      const hasTestEvidence = TEST_EVIDENCE_PATTERNS.some(p => p.test(tContent));
      if (!hasTestEvidence) {
        gateFailures.push(
          'TEST_EVIDENCE: T-phase has no raw test output. Paste actual command output ' +
          '(shell prompts with $, exit codes, test results like PASS/FAIL, assertion output).'
        );
      }
    } else {
      // T-phase is empty — always fail for code tasks
      gateFailures.push(
        'TEST_EVIDENCE: T-phase is empty. Code tasks require test execution evidence before validation.'
      );
    }
  }

  // Gate 4: PR URL evidence in D-phase, E-phase, notes, or text fallback (code tasks only)
  if (isCodeTask) {
    // Include notes — PR URLs are often posted as notes after E-phase completes
    const allContent = `${phases.D || ''} ${phases.E || ''} ${notesText} ${taskData || ''}`;
    // Check for PR merge evidence: require past tense "merged" or explicit PR references
    // Deliberately exclude "merge" (noun/present) to avoid false passes on conflict text
    const hasMergeEvidence = /\bmerged\b/i.test(allContent) &&
      !/merge\s+conflict|cannot\s+merge|failed\s+to\s+merge|not\s+merged|auto-?merge\s+failed/i.test(allContent);
    // Require explicit URL or PR number — "pull request" phrase alone is not sufficient
    // (avoids false pass when description merely says "create a pull request")
    const hasPrUrl = /(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s]+\/pull\/\d+/i.test(allContent) ||
                     /\bPR\s*#?\d+\b/i.test(allContent) ||
                     /\bgh\s+pr\s+(?:create|view|merge|list|checkout)\b/i.test(allContent) ||
                     hasMergeEvidence;
    if (!hasPrUrl) {
      gateFailures.push('PR_URL: No PR/merge evidence found in D-phase, E-phase, or notes. Code tasks should reference their PR URL or PR #NNN.');
    }
  }

  return gateFailures;
}

// ─── Evidence Advisory (Phase 11 EXEC-04) ───────────────
// Free-standing advisory check — NOT a numbered gate.
// Called AFTER checkValidationGates(), outputs to stdout, does NOT affect gate failures.
// Kill switch: GSD_E_MANDATE=off -> skip. GSD_E_MANDATE=advisory (default) -> run.

/**
 * Pure logic function — testable without daemon access.
 * Accepts pre-fetched E-phase content + taskType, returns advisory result object.
 */
function _checkEvidenceBlock(eContent, taskType) {
  // Non-code task filter (same set as Gate 1)
  if (NON_CODE_TYPES.has(taskType)) {
    return { advisory: false, reason: 'non-code task' };
  }

  // Empty E-phase
  if (!eContent || !eContent.trim()) {
    return { advisory: true, reason: 'E-phase is empty' };
  }

  // Detect PRE_EXECUTION_EVIDENCE block
  const hasEvidenceBlock = /^PRE_EXECUTION_EVIDENCE:/m.test(eContent);
  if (!hasEvidenceBlock) {
    return { advisory: true, reason: 'PRE_EXECUTION_EVIDENCE block missing from E-phase' };
  }

  // Check for valid skip markers (intentional skips — no advisory)
  const skipPattern = /^PRE_EXECUTION_EVIDENCE:\s*skipped\s*--/m;
  if (skipPattern.test(eContent)) {
    return { advisory: false, reason: 'intentional skip' };
  }

  // Check 4 subfields present (warn on missing, don't fail in v2.6)
  const subfields = ['failure_patterns', 'best_practices', 'existing_style', 'security_checklist'];
  const missingSubfields = subfields.filter(f => !new RegExp(`^\\s+${f}:`, 'm').test(eContent));
  const warnings = [];
  if (missingSubfields.length > 0) {
    warnings.push(`missing subfields: ${missingSubfields.join(', ')}`);
  }

  // Cargo-cult detection: bare single-word responses on applied items trigger advisory
  // Checks for patterns like "  input_validation: applied" (no -- explanation after)
  const bareCargoCultApplied = /^\s+\w+:\s+applied\s*$/m;
  if (bareCargoCultApplied.test(eContent)) {
    warnings.push('cargo-cult: applied items have bare single-word response (missing explanatory note)');
  }
  // Also check for other single-word cargo-cult responses
  const bareCargoCultOther = /^\s+\w+:\s+(checked|done|yes|ok)\s*$/im;
  if (bareCargoCultOther.test(eContent)) {
    warnings.push('cargo-cult: security checklist item has single-word response');
  }

  if (warnings.length > 0) {
    return { advisory: true, reason: warnings.join('; '), partial: true };
  }
  return { advisory: false, reason: 'evidence block present and complete' };
}

/**
 * Pure logic function — testable without daemon access.
 * Checks T-phase content for Phase 12 QA structural blocks.
 * Returns { advisory: bool, reason: string, missing: string[] }
 */
function _checkQaBlocks(tContent, taskType, inheritedSpec, isSecurityTask, isBugTask) {
  // Non-code task filter
  if (NON_CODE_TYPES.has(taskType)) {
    return { advisory: false, reason: 'non-code task', missing: [] };
  }

  // Empty T-phase
  if (!tContent || !tContent.trim()) {
    return { advisory: true, reason: 'T-phase is empty', missing: ['EDGE_CASES', 'REGRESSION'] };
  }

  const missing = [];

  // TASK_CRITERIA block (required for all code tasks -- CONTEXT.md: "Two sections in T-phase")
  const hasTaskCriteria = /^TASK_CRITERIA:/m.test(tContent);
  if (!hasTaskCriteria) missing.push('TASK_CRITERIA');

  // INHERITED_CRITERIA block (required when inherited spec present -- CONTEXT.md: source clarity)
  const hasInheritedCriteria = inheritedSpec ? /^INHERITED_CRITERIA:/m.test(tContent) : false;
  if (inheritedSpec && !hasInheritedCriteria) missing.push('INHERITED_CRITERIA');

  // EDGE_CASES block (required for all code tasks)
  const hasEdgeCases = /^EDGE_CASES:/m.test(tContent);
  if (!hasEdgeCases) missing.push('EDGE_CASES');

  // REGRESSION block (required for all code tasks)
  const hasRegression = /^REGRESSION:/m.test(tContent);
  if (!hasRegression) missing.push('REGRESSION');

  // ADVERSARIAL block (only required if security_sensitive)
  if (isSecurityTask) {
    const hasAdversarial = /^ADVERSARIAL:/m.test(tContent);
    if (!hasAdversarial) missing.push('ADVERSARIAL');
  }

  // QA_REPORT block (expected on all code tasks)
  const hasQaReport = /^QA_REPORT:/m.test(tContent);
  if (!hasQaReport) missing.push('QA_REPORT');

  // Check criterion ID coverage if inherited spec present
  const criterionWarnings = [];
  if (inheritedSpec && inheritedSpec.criteria && Array.isArray(inheritedSpec.criteria)) {
    const totalCriteria = inheritedSpec.criteria.length;
    let referencedCount = 0;
    for (const c of inheritedSpec.criteria) {
      if (c.id && tContent.includes(c.id)) {
        referencedCount++;
      }
    }
    if (referencedCount < totalCriteria) {
      criterionWarnings.push(`${referencedCount}/${totalCriteria} inherited criteria referenced`);
    }
  }

  // Minimum edge case count check (2 per criterion)
  if (hasEdgeCases) {
    const edgeLines = (tContent.match(/^\s+edge_\d+:/gm) || []).length;
    const criterionLines = (tContent.match(/^\s+criterion_\d+:/gm) || []).length;
    if (criterionLines > 0 && edgeLines < criterionLines * 2) {
      criterionWarnings.push(`edge cases: ${edgeLines} found, need >= ${criterionLines * 2} (2 per criterion)`);
    }
  }

  const reasons = [];
  if (missing.length > 0) reasons.push(`missing QA blocks: ${missing.join(', ')}`);
  if (criterionWarnings.length > 0) reasons.push(criterionWarnings.join('; '));

  if (reasons.length > 0) {
    return { advisory: true, reason: reasons.join('; '), missing };
  }
  return { advisory: false, reason: 'QA blocks present and complete', missing: [] };
}

/**
 * Pure logic function — testable without daemon access.
 * Parses `git log --oneline --grep="BG-XXXX" --reverse` output.
 * Returns { hasRed: bool, hasGreen: bool, correctOrder: bool, reason: string }
 */
function _checkRedGreenOrder(gitLogOutput, bugId) {
  const lines = (gitLogOutput || '').split('\n').filter(Boolean);
  let redIdx = -1, greenIdx = -1;

  lines.forEach((line, i) => {
    if (/test\(red\)/i.test(line)) redIdx = i;
    if (/fix\(green\)/i.test(line)) greenIdx = i;
  });

  if (redIdx === -1 && greenIdx === -1) {
    return { hasRed: false, hasGreen: false, correctOrder: false,
             reason: `no red/green commits found for ${bugId}` };
  }
  if (redIdx === -1) {
    return { hasRed: false, hasGreen: true, correctOrder: false,
             reason: 'GREEN commit found but RED commit missing -- must write failing test first' };
  }
  if (greenIdx === -1) {
    return { hasRed: true, hasGreen: false, correctOrder: false,
             reason: 'RED commit found but GREEN commit missing -- fix not committed yet' };
  }
  return {
    hasRed: true, hasGreen: true,
    correctOrder: redIdx < greenIdx,
    reason: redIdx < greenIdx ? 'RED before GREEN (correct)' : 'GREEN before RED (wrong order)',
  };
}

async function checkEvidenceAdvisory(useDaemon, id, flags) {
  // Kill switch check first
  const mandateMode = (process.env.GSD_E_MANDATE || 'advisory').toLowerCase();
  if (mandateMode === 'off') return { advisory: false, reason: 'mandate disabled' };

  // Fetch task data (same daemon/direct pattern as checkValidationGates)
  let taskType = 'task';
  let phases = {};
  try {
    if (useDaemon) {
      const { data } = await httpRequest('POST', '/api/exec', { args: ['show', id, '--json'] });
      const jsonStr = data.output || '';
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        taskType = parsed.type || 'task';
        phases = parsed.rpetd_phases || {};
      }
    } else {
      const jsonResult = runDirect(['show', id, '--json']);
      const jsonStr = jsonResult.output || '';
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        taskType = parsed.type || 'task';
        phases = parsed.rpetd_phases || {};
      }
    }
  } catch {
    return { advisory: false, reason: 'task fetch failed' };
  }

  // Dynamic reference file parsing for checklist item names (extensible, not hardcoded)
  // (Read attempted but result not used to gate — _checkEvidenceBlock uses regex on the block)
  try {
    const refPath = process.env.PRE_EXECUTION_CHECKLIST ||
      resolveReferencePath(path.join('references', 'pre-execution-checklist.md'));
    if (fs.existsSync(refPath)) {
      // Parse checklist item names dynamically from reference file
      // Pattern: lines like "- `input_validation` -- ..."
      fs.readFileSync(refPath, 'utf8').matchAll(/^\s*-\s+`(\w+)`\s+--/gm);
      // Item names are available for future use; current cargo-cult detection uses regex
    }
  } catch { /* use defaults — never block advisory on reference file unavailability */ }

  const eContent = (phases.E || '').trim();
  return _checkEvidenceBlock(eContent, taskType);
}

/**
 * Spec Inheritance + RED-GREEN Advisory (Phase 12 QA-04, QA-05, QA-07, QA-08).
 * Non-blocking: runs after checkEvidenceAdvisory, logs advisory warnings.
 * Same daemon/direct pattern as checkEvidenceAdvisory.
 */
async function checkSpecInheritanceAdvisory(useDaemon, id, flags) {
  // Kill switch check
  const specInherit = (process.env.GSD_T_SPEC_INHERIT || '').toLowerCase();
  if (specInherit === 'false') return { advisory: false, reason: 'spec inheritance disabled' };

  let taskType = 'task';
  let phases = {};
  let inheritedSpec = null;
  let isBugTask = false;
  let isSecurityTask = false;
  let taskId = id;

  try {
    let parsed;
    if (useDaemon) {
      const { data } = await httpRequest('POST', '/api/exec', { args: ['show', id, '--json'] });
      const jsonStr = data.output || '';
      if (jsonStr) parsed = JSON.parse(jsonStr);
    } else {
      const jsonResult = runDirect(['show', id, '--json']);
      const jsonStr = jsonResult.output || '';
      if (jsonStr) parsed = JSON.parse(jsonStr);
    }
    if (parsed) {
      taskType = parsed.type || 'task';
      phases = parsed.rpetd_phases || {};
      inheritedSpec = parsed.inherited_success_criteria || null;
      if (typeof inheritedSpec === 'string') inheritedSpec = null; // "none -- root task" case
      isBugTask = taskType === 'bug' || (taskId || '').startsWith('BG-');
      isSecurityTask = !!(parsed.metadata && parsed.metadata.security_sensitive);
    }
  } catch {
    return { advisory: false, reason: 'task fetch failed' };
  }

  const tContent = (phases.T || '').trim();
  const results = [];

  // 1. Check QA structural blocks
  const qaResult = _checkQaBlocks(tContent, taskType, inheritedSpec, isSecurityTask, isBugTask);
  if (qaResult.advisory) {
    results.push(`QA_BLOCKS: ${qaResult.reason}`);
  }

  // 2. Check RED-GREEN for bug tasks
  if (isBugTask && !flags.force_reason) {
    try {
      const { spawnSync } = require('child_process');
      const gitResult = spawnSync('git', ['log', '--oneline', '--grep=' + taskId, '--reverse'],
        { encoding: 'utf8', timeout: 5000 });
      const gitLog = gitResult.stdout || '';
      const rgResult = _checkRedGreenOrder(gitLog, taskId);
      if (!rgResult.correctOrder) {
        results.push(`RED_GREEN: ${rgResult.reason}`);
      }
    } catch {
      // git log failure is non-fatal for advisory
    }
  }

  if (results.length > 0) {
    return { advisory: true, reason: results.join('; ') };
  }
  return { advisory: false, reason: 'spec inheritance advisory passed' };
}

/**
 * HARDEN-04: Write a structured gaps report for a `gaps_found` verdict.
 *
 * Schema (locked — see plan 13.1-04):
 *   {
 *     phase: string,
 *     timestamp: ISO8601,
 *     task_id: string,
 *     verdict: "gaps_found",
 *     gaps: [{ requirement_id, description }],
 *     non_gaps_observations: [string]
 *   }
 *
 * No `severity` or `priority` fields — the validator vocabulary is locked:
 * every entry in `gaps[]` is equal. Cosmetic findings go in
 * `non_gaps_observations[]` as a pressure-release valve.
 *
 * @param {string} phase        Phase identifier (used in the milestone dir path)
 * @param {string} taskId       Originating task id
 * @param {Array<{requirement_id: string, description: string}>} gaps
 * @param {string[]} nonGapsObservations
 * @returns {string} Absolute path to the written report
 */
function writeGapsReport(phase, taskId, gaps, nonGapsObservations) {
  const safePhase = String(phase || 'unknown').trim() || 'unknown';
  const dir = path.join(process.cwd(), '.planning', 'milestones', safePhase);
  fs.mkdirSync(dir, { recursive: true });
  // ISO8601 with millisecond precision, colons stripped for fs-safe names.
  const now = new Date();
  const isoTs = now.toISOString();
  const fsTs = isoTs.replace(/[:.]/g, '-');
  const reportPath = path.join(dir, `gaps-report-${fsTs}.json`);
  const report = {
    phase: safePhase,
    timestamp: isoTs,
    task_id: taskId,
    verdict: 'gaps_found',
    gaps: Array.isArray(gaps) ? gaps : [],
    non_gaps_observations: Array.isArray(nonGapsObservations) ? nonGapsObservations : [],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return reportPath;
}

async function cmdValidate(useDaemon, id, flags, jsonMode) {
  // HARDEN-04: `validate --help` prints the three-verdict usage string.
  if (flags.help || id === '--help' || id === 'help') {
    process.stdout.write(
      'Usage: amauta validate <id> [--pass|--fail|--gaps-found] [options]\n' +
      '\n' +
      'Verdicts (mutually exclusive):\n' +
      '  --pass              Task passes validation (exit 0)\n' +
      '  --fail              Task fails validation (exit 1)\n' +
      '  --gaps-found        Task has gaps — not a failure, re-plan (exit 2)\n' +
      '\n' +
      'Options:\n' +
      '  --validator <name>  Validator agent id\n' +
      '  --notes "..."       Notes / rejection reason\n' +
      '  --force-reason "..." Override gate checks with justification\n' +
      '  --subtasks "a|b"    Follow-up subtasks (used with --fail)\n' +
      '  --phase <phase>     Phase id for gaps-report path (optional)\n' +
      '  --gap "REQ:desc"    Gap finding — repeatable (used with --gaps-found)\n' +
      '  --non-gaps "..."    Cosmetic observation — repeatable\n' +
      '  --json              JSON output\n'
    );
    return 0;
  }
  if (!id) die('Usage: amauta validate <id> --pass|--fail|--gaps-found [--validator V] [--notes N] [--force-reason "justification"]');

  // HARDEN-04: three verdicts are mutually exclusive
  const verdictFlags = [
    flags.pass_result === true,
    flags.pass_result === false,
    flags.gaps_found === true,
  ].filter(Boolean).length;
  if (verdictFlags > 1) die('validate: --pass, --fail, and --gaps-found are mutually exclusive');
  if (flags.pass_result === undefined && !flags.gaps_found) die('--pass, --fail, or --gaps-found is required');

  // HARDEN-04: --gaps-found verdict short-circuits the gate flow.
  // It writes a structured gaps report and exits with code 2.
  // The validator vocabulary is locked: no severity, no priority, no ranking.
  if (flags.gaps_found) {
    // Resolve phase: explicit --phase flag wins; otherwise derive from the task id
    // (e.g. "13.1-04-01" -> "13.1"); final fallback is "unknown".
    let phase = flags.phase || '';
    if (!phase && typeof id === 'string') {
      const m = id.match(/^([0-9]+(?:\.[0-9]+)?)/);
      if (m) phase = m[1];
    }
    if (!phase) phase = 'unknown';

    // --gap accepts repeated "REQ-ID:description" pairs (collected upstream).
    const rawGaps = Array.isArray(flags.gaps_list) ? flags.gaps_list : [];
    const gaps = rawGaps.map((raw) => {
      const idx = raw.indexOf(':');
      if (idx < 0) die('gap finding must be "REQ-ID:description"');
      const requirementId = raw.slice(0, idx).trim();
      const description = raw.slice(idx + 1).trim();
      if (!requirementId) die('gap finding must be "REQ-ID:description"');
      return { requirement_id: requirementId, description };
    });
    const nonGapsObservations = Array.isArray(flags.non_gaps_list) ? flags.non_gaps_list : [];

    try {
      const reportPath = writeGapsReport(phase, id, gaps, nonGapsObservations);
      if (jsonMode) {
        console.log(JSON.stringify({
          verdict: 'gaps_found',
          phase,
          task_id: id,
          report: reportPath,
          gaps_count: gaps.length,
          non_gaps_count: nonGapsObservations.length,
        }));
      } else {
        console.log(`gaps_found: wrote ${reportPath}`);
        console.log(`  gaps=${gaps.length} non_gaps_observations=${nonGapsObservations.length}`);
      }
    } catch (err) {
      process.stderr.write(`ERROR: failed to write gaps report: ${err.message}\n`);
      return 1;
    }
    _telemetryEmit('validator_verdict', { task_id: id, verdict: 'gaps', gate_failures: 0, gaps: gaps.length });
    return 2;
  }

  // Check validation gates (unless --force-reason)
  if (flags.pass_result && !flags.force_reason) {
    const gateFailures = await checkValidationGates(useDaemon, id, flags);
    if (gateFailures.length > 0) {
      const msg = '\x1b[91mValidation gates failed:\x1b[0m\n' +
        gateFailures.map(g => '  - ' + g).join('\n') +
        '\n\nFix the issues or use --force-reason "justification" to override.';
      if (jsonMode) {
        console.log(JSON.stringify({ error: 'Gate check failed', gates: gateFailures }));
      } else {
        console.error(msg);
      }
      _telemetryEmit('validator_verdict', { task_id: id, verdict: 'fail', gate_failures: gateFailures.length, gaps: 0 });
      return 1;
    }
  }

  // Evidence advisory (Phase 11 EXEC-04) -- non-blocking, logs to stdout
  // Runs on --pass only (no evidence check needed for --fail)
  if (flags.pass_result && !flags.force_reason) {
    try {
      const evidenceResult = await checkEvidenceAdvisory(useDaemon, id, flags);
      if (evidenceResult.advisory) {
        console.log(`[ADVISORY] PRE_EXECUTION_EVIDENCE: ${evidenceResult.reason}`);
      }
    } catch {
      // Advisory is best-effort -- never block validation
    }
  }

  // Spec Inheritance + RED-GREEN Advisory (Phase 12 QA-04, QA-05, QA-07, QA-08) -- non-blocking
  if (flags.pass_result && !flags.force_reason) {
    try {
      const specResult = await checkSpecInheritanceAdvisory(useDaemon, id, flags);
      if (specResult.advisory) {
        console.log(`[ADVISORY] SPEC_INHERITANCE: ${specResult.reason}`);
      }
    } catch {
      // Advisory is best-effort -- never block validation
    }
  }

  const body = { id, ...flags };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/validate', body);

    // Parse server-side gate results from Python output
    const output = data.output || '';
    const gateLines = output.split('\n').filter(l => l.includes('GATE['));

    // JSON mode: parse and forward structured gate JSON from Python --json output
    if (jsonMode && output.trim().startsWith('{')) {
      try {
        const gateJson = JSON.parse(output.trim().split('\n')[0]);
        console.log(JSON.stringify(gateJson, null, 2));
        return gateJson.passed ? 0 : 1;
      } catch { /* fall through to default printResponse */ }
    }

    // Text mode: if server printed gate results, pass through directly
    if (gateLines.length > 0 && !jsonMode) {
      process.stdout.write(output);
      if (data.exit_code !== 0) return data.exit_code;
    } else {
      printResponse(data, jsonMode);
    }

    // TK-0031: SKB promotion on validation pass
    if (flags.pass_result && data.exit_code === 0) {
      await promoteToSKB(useDaemon, id);

      // Wire the validation audit trail — write to gsd_task_validations via /api/validation/record
      // This keeps the PG audit table in sync with the tasks.json validation result.
      await httpRequest('POST', '/api/validation/record', {
        task_id: id,
        validator_id: flags.validator || 'validator',
        status: 'approved',
        evidence: { notes: flags.notes || '' },
      }).catch(e => process.stderr.write(`[best-effort] validation audit write failed: ${e.message || e}\n`));
    } else if (!flags.pass_result && data.exit_code === 0) {
      // Record rejections too
      await httpRequest('POST', '/api/validation/record', {
        task_id: id,
        validator_id: flags.validator || 'validator',
        status: 'rejected',
        rejection_reason: flags.notes || '',
        evidence: { subtasks: flags.subtasks || '' },
      }).catch(e => process.stderr.write(`[best-effort] validation audit write failed: ${e.message || e}\n`));
    }

    _telemetryEmit('validator_verdict', { task_id: id, verdict: flags.pass_result ? 'pass' : 'fail', gate_failures: 0, gaps: 0 });
    return data.exit_code || 0;
  }
  const args = ['validate', id];
  if (flags.pass_result === true) args.push('--pass');
  else args.push('--fail');
  if (flags.validator) args.push('--validator', flags.validator);
  if (flags.notes) args.push('--notes', flags.notes);
  if (flags.force_reason) args.push('--force-reason', flags.force_reason);
  if (flags.subtasks) args.push('--subtasks', flags.subtasks);
  const result = runDirect(args);
  printResponse(result, jsonMode);

  // TK-0031: SKB promotion on validation pass (direct mode)
  if (flags.pass_result && result.exit_code === 0) {
    await promoteToSKB(useDaemon, id);
  }

  // Write validation audit record to file when daemon not available
  // Keeps the validation trail even in no-daemon / no-PG mode
  if (result.exit_code === 0) {
    try {
      const auditDir = path.join(process.cwd(), '.planning', 'memory');
      fs.mkdirSync(auditDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const auditFile = path.join(auditDir, `${date}.md`);
      const status = flags.pass_result ? 'approved' : 'rejected';
      const entry = `- [validation] ${new Date().toISOString()}: ${id} ${status} by ${flags.validator || 'validator'} — ${flags.notes || ''}\n`;
      fs.appendFileSync(auditFile, entry);
    } catch { /* best-effort */ }
  }

  _telemetryEmit('validator_verdict', { task_id: id, verdict: flags.pass_result ? 'pass' : 'fail', gate_failures: 0, gaps: 0 });
  return result.exit_code;
}

/**
 * TK-0031: Promote validated learnings to Shared Knowledge Base.
 * After a task passes validation, extract LEARNING from D-phase
 * and store as an SKB entry.
 */
async function promoteToSKB(useDaemon, taskId) {
  try {
    // Fetch task details to get D-phase content and title
    let taskOutput = '';
    let taskTitle = '';
    if (useDaemon) {
      // Use --json via daemon exec to get full phase content (text show truncates at 300 chars)
      try {
        const { data: jsonData } = await httpRequest('POST', '/api/exec', { args: ['show', taskId, '--json'] });
        const parsed = JSON.parse(jsonData.output || '');
        const dPhase = (parsed.rpetd_phases || {}).D || '';
        taskOutput = `— ${parsed.title || taskId}\n[D] Document:\n${dPhase}`;
      } catch {
        // JSON path failed, fall back to text (may be truncated at 300 chars)
        try {
          const { data } = await httpRequest('GET', `/api/show/${taskId}`);
          taskOutput = data.output || '';
        } catch { /* best-effort */ }
      }
    } else {
      // Use --json to get full phase content (text mode truncates at 300 chars)
      const result = runDirect(['show', taskId, '--json']);
      try {
        const parsed = JSON.parse(result.output || '');
        const dPhase = (parsed.rpetd_phases || {}).D || '';
        // Build synthetic taskOutput for title extraction + LEARNING extraction
        taskOutput = `— ${parsed.title || taskId}\n[D] Document:\n${dPhase}`;
      } catch {
        // JSON parse failed, fall back to text output (may be truncated at 300 chars)
        taskOutput = result.output || '';
      }
    }

    // Extract title
    const titleMatch = taskOutput.match(/— (.+?)$/m);
    taskTitle = titleMatch ? titleMatch[1].trim() : taskId;

    // Extract LEARNING from D-phase (supports multi-line LEARNING blocks)
    const dPhaseMatch = taskOutput.match(/\[D\][^\n]*\n([\s\S]*?)(?=\n\s*\[[RPTE]\]|\n\s*Parent:|\n\s*Depends|$)/i);
    const dContent = dPhaseMatch ? dPhaseMatch[1] : '';
    const learningMatch = dContent.match(/LEARNING[:\s]+([\s\S]+?)(?=\n(?:##|\n\s*\[[A-Z]\]|\n\s*Parent:|\n\s*Depends)|$)/i);

    if (!learningMatch) return; // No learning to promote

    // Trim each line to remove 6-space indentation from text-format output
    const learning = learningMatch[1].split('\n').map(l => l.trimStart()).join('\n').trim();
    if (learning.length < 10) return; // Too short to be valuable

    // Store to SKB — daemon preferred, file fallback for direct mode
    if (useDaemon) {
      await httpRequest('POST', '/api/skb/store', {
        title: `Validated: ${taskTitle}`,
        content: learning,
        category: 'pattern',
        importance: 6,
        source_task: taskId,
      }).catch(e => process.stderr.write(`[best-effort] SKB store failed: ${e.message || e}\n`));
    } else {
      // File-based fallback: append to .planning/memory/ so learning is not lost
      try {
        const memDir = path.join(process.cwd(), '.planning', 'memory');
        fs.mkdirSync(memDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const memFile = path.join(memDir, `${date}.md`);
        const entry = `- [best-practice] ${new Date().toISOString()}: Validated ${taskId} — ${learning}\n`;
        fs.appendFileSync(memFile, entry);
        process.stderr.write(`\x1b[93m[no-daemon]\x1b[0m SKB promotion saved to file: ${memFile}\n`);
      } catch { /* best-effort */ }
    }

    // Also store as memory with best-practice source
    if (useDaemon) {
      await httpRequest('POST', '/api/memory/store', {
        text: learning,
        source: 'best-practice',
        metadata: { from_task: taskId, promoted_from: 'validation' },
      }).catch(e => process.stderr.write(`[best-effort] memory best-practice store failed: ${e.message || e}\n`));
    } else {
      // File fallback already written above — skip duplicate
    }
  } catch {
    // SKB promotion is best-effort — don't fail validation
  }
}

async function cmdNote(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta note <id> --content "..." [--agent A]');
  // amauta.py note subparser uses --content; also accept --text for backward compat
  let noteText = flags.content || flags.text;
  if (!noteText) die('--content is required (also accepts --text)');
  // Phase 68 MOBL-04: scrub build-log/evidence secrets BEFORE either
  // transport (daemon POST or file-fallback) sees the content. Scrub the
  // MERGED noteText (not flags.text alone) — --content is canonical and
  // --text is only the back-compat alias, so scrubbing flags.text alone
  // would miss every canonical --content invocation.
  noteText = scrubEvidence(noteText);
  // Build body using --content as the canonical key for the daemon
  const body = { id, content: noteText };
  if (flags.agent) body.agent = flags.agent;

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/note', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  // Direct path: amauta.py note expects --content
  const args = ['note', id, '--content', noteText];
  if (flags.agent) args.push('--agent', flags.agent);
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdStatus(useDaemon, id, statusTo, flags, jsonMode) {
  if (!id || !statusTo) die('Usage: amauta status <id> <new-status> [--agent A]');
  const body = { id, status_to: statusTo, ...flags };

  let exitCode;
  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/status', body);
    printResponse(data, jsonMode);
    exitCode = data.exit_code || 0;
  } else {
    const args = ['status', id, statusTo];
    if (flags.agent) args.push('--agent', flags.agent);
    const result = runDirect(args);
    printResponse(result, jsonMode);
    exitCode = result.exit_code;
  }

  // Phase 67 HOOK-05: best-effort claim-marker prune on terminal status.
  // Wrapped so any failure here changes nothing about status's exit code.
  if (exitCode === 0) {
    const normalized = String(statusTo || '').toLowerCase();
    if (normalized === 'done' || normalized === 'completed' || normalized === 'cancelled') {
      try {
        require('./lib/hook-state.cjs').pruneActiveTask(id);
      } catch {
        // Best-effort — prune failure must never affect status behavior.
      }
    }
  }

  return exitCode;
}

async function cmdSearch(useDaemon, query, jsonMode) {
  if (!query) die('Usage: amauta search <query>');

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/search', { query });
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['search', query]);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdScore(useDaemon, id, jsonMode) {
  if (!id) die('Usage: amauta score <id>');

  if (useDaemon) {
    const { data } = await httpRequest('GET', `/api/score/${id}`);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['score', id]);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdAssign(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta assign <id> --agent <agent>');
  if (!flags.agent) die('--agent is required');
  const body = { id, agent: flags.agent };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/assign', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  // amauta.py assign subparser: positional "id" then positional "agent" (not --agent)
  const args = ['assign', id, flags.agent];
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdLink(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta link <id> --dep <dep-id>');
  if (!flags.dep) die('--dep is required');

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/exec', { args: ['link', id, flags.dep] });
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['link', id, flags.dep]);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdUnlink(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta unlink <id> --dep <dep-id>');
  if (!flags.dep) die('--dep is required');

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/exec', { args: ['unlink', id, flags.dep] });
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['unlink', id, flags.dep]);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdUpdate(useDaemon, id, argv, jsonMode) {
  if (!id) die('Usage: amauta update <id> [--field val ...]');

  if (useDaemon) {
    // Pass through via exec for complex flag sets
    const args = ['update', id, ...argv.slice(1)];
    const { data } = await httpRequest('POST', '/api/exec', { args });
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['update', id, ...argv.slice(1)]);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdDelete(useDaemon, id, jsonMode) {
  if (!id) die('Usage: amauta delete <id>');

  if (useDaemon) {
    // Use dedicated /api/delete route — 'delete' is NOT in _EXEC_ALLOWLIST
    // and therefore would get a 403 if routed through /api/exec.
    const { data } = await httpRequest('POST', '/api/delete', { id });
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const result = runDirect(['delete', id]);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdExec(useDaemon, rawArgs, jsonMode) {
  if (!rawArgs.length) die('Usage: amauta exec <...args>');

  if (useDaemon) {
    const { statusCode, data } = await httpRequest('POST', '/api/exec', { args: rawArgs });
    printResponse(data, jsonMode);
    // Non-2xx HTTP status = daemon rejected the command (403 = not allowed, 400 = bad request)
    if (statusCode >= 400) return 1;
    return data.exit_code || 0;
  }
  const result = runDirect(rawArgs);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdDaemon(subcommand) {
  if (!subcommand) die('Usage: amauta daemon start|stop|status|run');

  if (subcommand === 'status') {
    const running = await isDaemonRunning();
    if (running) {
      try {
        const { data } = await httpRequest('GET', '/health', null, 3000);
        console.log(`Daemon running on ${HOST}:${PORT} (PID ${data.pid})`);
        console.log(`  Data dir: ${data.data_dir}`);
        console.log(`  amauta.py: ${data.amauta_py}`);
      } catch {
        console.log(`Daemon running on ${HOST}:${PORT}`);
      }
      return 0;
    } else {
      console.log('Daemon not running');
      return 1;
    }
  }

  if (subcommand === 'start') {
    if (await isDaemonRunning()) {
      console.log('Daemon already running');
      return 0;
    }
    const started = await startDaemon();
    if (started) {
      console.log(`Daemon started on ${HOST}:${PORT}`);
      return 0;
    }
    console.error('Failed to start daemon');
    return 1;
  }

  if (subcommand === 'stop') {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      die(`Daemon script not found: ${DAEMON_SCRIPT}`);
    }
    try {
      execFileSync('python3', [DAEMON_SCRIPT, 'stop'], {
        encoding: 'utf-8',
        env: { ...process.env, AMAUTA_DATA_DIR: DATA_DIR },
      });
      console.log('Daemon stopped');
    } catch (err) {
      console.error(err.stdout || err.stderr || err.message);
    }
    return 0;
  }

  if (subcommand === 'run') {
    // Run in foreground — just exec the python daemon
    const child = spawn('python3', [DAEMON_SCRIPT, 'run'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        AMAUTA_DATA_DIR: DATA_DIR,
        GSD_AMAUTA_PY: AMAUTA_PY,
        GSD_AMAUTA_PORT: String(PORT),
      },
    });
    child.on('exit', (code) => process.exit(code || 0));
    return -1; // Signal: don't exit, child is running
  }

  die(`Unknown daemon subcommand: ${subcommand}`);
}

// ═══════════════════════════════════════════════════════
// Evidence Scrub (Phase 68 MOBL-04) — Node twin of
// services/evidence_scrub.py::scrub_text. BOTH runtimes read the SAME
// get-shit-done/config/evidence-scrub-patterns.json registry; neither
// hardcodes a second pattern list (single-source discipline).
// ═══════════════════════════════════════════════════════

const EVIDENCE_SCRUB_PATTERNS_ENV_OVERRIDE = 'GSD_EVIDENCE_SCRUB_PATTERNS_PATH';
const _EVIDENCE_SCRUB_FAILURE_SENTINEL = Symbol('evidence-scrub-load-failed');
let _evidenceScrubPatternsCache = null; // null (unloaded) | SENTINEL | compiled[]
let _evidenceScrubWarned = false;

function _warnEvidenceScrubOnce(message) {
  if (!_evidenceScrubWarned) {
    console.warn(`[gsd-amauta] ${message}`);
    _evidenceScrubWarned = true;
  }
}

/**
 * Load + compile the shared scrub-pattern registry.
 *
 * Path resolution mirrors loadCapabilityCatalog() / capability_schema.py's
 * load_capability_catalog(): env override (test/hook seam, AUTHORITATIVE
 * when set — no fallthrough) -> repo-local candidate -> ~/.claude
 * candidate. Caches a distinct FAILURE SENTINEL (not null) so a broken
 * load short-circuits to "no patterns" on every subsequent call instead of
 * re-reading (and re-failing) the file each time.
 */
function loadEvidenceScrubPatterns(forceReload = false) {
  if (!forceReload) {
    if (_evidenceScrubPatternsCache === _EVIDENCE_SCRUB_FAILURE_SENTINEL) return [];
    if (_evidenceScrubPatternsCache !== null) return _evidenceScrubPatternsCache;
  }

  const envOverride = process.env[EVIDENCE_SCRUB_PATTERNS_ENV_OVERRIDE];
  const candidates = envOverride
    ? [envOverride]
    : [
        path.resolve(__dirname, '..', 'config', 'evidence-scrub-patterns.json'),
        path.join(process.env.HOME || '', '.claude', 'get-shit-done', 'config', 'evidence-scrub-patterns.json'),
      ];

  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const rawPatterns = Array.isArray(data.patterns) ? data.patterns : [];
        const compiled = rawPatterns.map((entry) => ({
          name: entry.name,
          re: new RegExp(entry.regex, (entry.flags === 'i' ? 'i' : '') + 'g'),
          replacement: entry.replacement || `[scrubbed:${entry.name}]`,
        }));
        _evidenceScrubPatternsCache = compiled;
        return _evidenceScrubPatternsCache;
      }
    } catch {
      // fall through to next candidate
    }
  }

  _warnEvidenceScrubOnce(
    'evidence-scrub-patterns.json not found in any candidate path — build-log/evidence secrets will NOT be scrubbed'
  );
  _evidenceScrubPatternsCache = _EVIDENCE_SCRUB_FAILURE_SENTINEL;
  return [];
}

/**
 * Scrub build-log/evidence secrets from text using the shared pattern
 * registry. Returns text unchanged when GSD_EVIDENCE_SCRUB=off (kill
 * switch) or when the registry is empty/unavailable (fail-open — a broken
 * registry never blocks a write). Mirrors services/evidence_scrub.py's
 * scrub_text() exactly (same pattern order, same replacement semantics)
 * so the two runtimes produce byte-identical output — the twin-drift
 * guard the cross-runtime parity test locks in.
 */
function scrubEvidence(text) {
  if (text === null || text === undefined) return text;
  if (process.env.GSD_EVIDENCE_SCRUB === 'off') return text;

  const patterns = loadEvidenceScrubPatterns();
  if (!patterns.length) return text;

  let scrubbed = text;
  for (const p of patterns) {
    // Reset lastIndex — the compiled RegExp is reused (cached) across calls
    // and carries the 'g' flag, so stale lastIndex state would otherwise
    // corrupt subsequent replace() calls.
    p.re.lastIndex = 0;
    scrubbed = scrubbed.replace(p.re, p.replacement);
  }
  return scrubbed;
}

// ═══════════════════════════════════════════════════════
// Capability Commands (Phase 60 TOOL-01/TOOL-02/TOOL-03)
// ═══════════════════════════════════════════════════════
//
// NOTE: 'capability' MUST be an explicit case in the command switch below
// (never fall through to default:) — the default passthrough hits
// /api/exec whose _EXEC_ALLOWLIST (amauta-daemon.py) does not include
// 'capability' and would 403 (60-RESEARCH finding #8).

const CAPABILITY_KIND_VALUES = ['curl-endpoint', 'ssh-host', 'pg', 'redis', 'k3s', 'local-tool'];
const CAPABILITY_SECURITY_CLASS_VALUES = ['read-only', 'read-write', 'secret-bearing', 'destructive'];
const CAPABILITY_AUTH_METHOD_VALUES = ['none', 'bearer-env', 'basic-env', 'dsn-env', 'ssh-key'];
const CAPABILITY_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const CAPABILITY_BUFFER_FILENAME = 'capability-audit-buffer.jsonl';

async function cmdCapability(useDaemon, rest, jsonMode) {
  const subCmd = rest[0];
  if (subCmd === 'list') return cmdCapabilityList(jsonMode);
  if (subCmd === 'audit') return await cmdCapabilityAudit(useDaemon, jsonMode);
  if (subCmd === 'access') return await cmdCapabilityAccess(useDaemon, parseFlags(rest, 1), jsonMode);
  if (subCmd === 'add') return await cmdCapabilityAdd(parseFlags(rest, 1), jsonMode);
  process.stderr.write(
    'Usage:\n' +
    '  amauta capability list [--json]                     Registered reachable systems\n' +
    '  amauta capability audit [--json]                    Declared-vs-actual per executor (exit 0 clean / 2 drift)\n' +
    '  amauta capability access --entry N --agent A [--task TK] [--confirm] [--json]\n' +
    '                                                      Check + audit-log a live-state access\n' +
    '  amauta capability add --name N --kind K --target T --auth-method M [...] [--yes]\n'
  );
  return 1;
}

/**
 * Structural validation of a capability catalog entry. Returns null when
 * valid, else { field } naming the first violation — loud, never a silent
 * omission of the bad entry.
 */
function _validateCapabilityEntryShape(entry) {
  if (!entry || typeof entry !== 'object') return { field: 'entry' };
  if (!entry.name) return { field: 'name' };
  if (!entry.kind || !CAPABILITY_KIND_VALUES.includes(entry.kind)) return { field: 'kind' };
  if (!entry.target) return { field: 'target' };
  if (!entry.auth || !entry.auth.method) return { field: 'auth.method' };
  if (!entry.security_class || !CAPABILITY_SECURITY_CLASS_VALUES.includes(entry.security_class)) return { field: 'security_class' };
  if (!entry.owner) return { field: 'owner' };
  if (!entry.added_at) return { field: 'added_at' };
  return null;
}

function cmdCapabilityList(jsonMode) {
  const { loadCapabilityCatalog } = require(path.join(__dirname, 'gsd-tools.cjs'));
  const catalog = loadCapabilityCatalog();
  const entries = catalog.entries || [];

  for (let i = 0; i < entries.length; i++) {
    const violation = _validateCapabilityEntryShape(entries[i]);
    if (violation) {
      process.stderr.write(JSON.stringify({
        error: 'capability_catalog_invalid',
        entry: entries[i] && entries[i].name ? entries[i].name : i,
        field: violation.field,
      }) + '\n');
      return 1;
    }
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(`Capability Catalog v${catalog.catalog_version} (${entries.length} entries)\n`);
  const rows = entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    security: e.security_class,
    auth: e.auth.env ? `${e.auth.method} env=${e.auth.env}` : e.auth.method,
    target: e.target,
    grants: (e.grants || []).join(','),
  }));
  const cols = [
    ['NAME', 'name'], ['KIND', 'kind'], ['SECURITY', 'security'],
    ['AUTH', 'auth'], ['TARGET', 'target'], ['GRANTS', 'grants'],
  ];
  const widths = cols.map(([header, key]) =>
    Math.max(header.length, ...rows.map((r) => String(r[key] || '').length))
  );
  const renderRow = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd();
  process.stdout.write(renderRow(cols.map(([h]) => h)) + '\n');
  for (const r of rows) {
    process.stdout.write(renderRow(cols.map(([, key]) => r[key])) + '\n');
  }
  return 0;
}

async function cmdCapabilityAudit(useDaemon, jsonMode) {
  let resp = null;
  try {
    resp = await httpRequest('GET', '/api/capability/audit');
  } catch { /* daemon unreachable — fall through below */ }

  if (!resp || resp.statusCode !== 200 || (resp.data && resp.data.error)) {
    process.stderr.write('Warning: daemon unreachable — declared-only view (actual-access data unavailable)\n');
    const { loadCapabilityCatalog } = require(path.join(__dirname, 'gsd-tools.cjs'));
    const catalog = loadCapabilityCatalog();
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ declared_only: true, catalog }, null, 2) + '\n');
    } else {
      process.stdout.write(`Capability Catalog v${catalog.catalog_version} (declared-only view)\n`);
      for (const e of (catalog.entries || [])) {
        const grants = (e.grants || []).join(',') || '(none)';
        process.stdout.write(`  ${e.name}  grants=${grants}\n`);
      }
    }
    return 0;
  }

  const { data } = resp;
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write('AGENT'.padEnd(28) + 'DECLARED'.padEnd(10) + 'USED'.padEnd(8) + 'UNUSED(info)'.padEnd(14) + 'UNEXPLAINED\n');
    for (const a of (data.agents || [])) {
      process.stdout.write(
        String(a.agent).padEnd(28) +
        String(a.declared.length).padEnd(10) +
        String(a.used.length).padEnd(8) +
        String(a.declared_unused.length).padEnd(14) +
        String(a.unexplained.length) + '\n'
      );
    }
    process.stdout.write(`Executors audited: ${data.executor_count}\n`);
    if (data.catalog_schema_errors && data.catalog_schema_errors.length) {
      for (const err of data.catalog_schema_errors) {
        process.stdout.write(`CATALOG SCHEMA DRIFT: ${err}\n`);
      }
    }
    if (data.buffered_pending > 0) {
      process.stdout.write(`Note: ${data.buffered_pending} buffered audit events pending PG flush\n`);
    }
  }
  return data.drift ? 2 : 0;
}

/**
 * Append one JSONL record to the capability-access buffer (fail-open —
 * a write failure here must never block the caller). Mirrors
 * services/capability_access.py's _buffer_access().
 */
function _bufferCapabilityAccess(record) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, CAPABILITY_BUFFER_FILENAME), JSON.stringify(record) + '\n');
  } catch { /* fail-open: never block the caller on a buffer-write failure */ }
}

/**
 * Local-only fail-open re-implementation of services/capability_access.py's
 * check_access() decision table, used when the daemon is unreachable.
 */
function _localCapabilityCheckAccess(entryName, catalog, confirm) {
  const mode = (process.env.GSD_CAPABILITY_ENFORCE || 'warn').toLowerCase();
  const enforceMode = ['warn', 'block', 'off'].includes(mode) ? mode : 'warn';
  const entry = (catalog.entries || []).find((e) => e.name === entryName) || null;

  if (entry && entry.security_class === 'destructive' && !confirm) {
    return { allowed: false, outcome: 'destructive_unconfirmed', enforce_mode: enforceMode, entry, code: 'capability_destructive_unconfirmed', warning: null };
  }

  if (enforceMode === 'off') {
    return { allowed: true, outcome: 'skipped_off', enforce_mode: enforceMode, entry, warning: null };
  }

  if (!entry) {
    if (enforceMode === 'warn') {
      return {
        allowed: true, outcome: 'unlisted_warn', enforce_mode: enforceMode, entry: null,
        warning: `capability_unlisted: '${entryName}' is not in the capability catalog — file a divergence observation`,
      };
    }
    return { allowed: false, outcome: 'unlisted_blocked', enforce_mode: enforceMode, entry: null, code: 'capability_unlisted_blocked', warning: null };
  }

  const method = (entry.auth && entry.auth.method) || '';
  if (method.endsWith('-env')) {
    const envName = entry.auth.env;
    if (!process.env[envName]) {
      return { allowed: false, outcome: 'auth_missing', enforce_mode: enforceMode, entry, code: 'capability_auth_missing', warning: null, env: envName };
    }
  }

  return { allowed: true, outcome: 'allowed', enforce_mode: enforceMode, entry, warning: null };
}

async function cmdCapabilityAccess(useDaemon, flags, jsonMode) {
  const entryName = flags.entry;
  const agentId = flags.agent;
  if (!entryName || !agentId) {
    process.stderr.write('Usage: amauta capability access --entry <name> --agent <agent> [--task <id>] [--confirm] [--json]\n');
    return 1;
  }

  let resp = null;
  try {
    resp = await httpRequest('POST', '/api/capability/access', {
      entry: entryName,
      agent_id: agentId,
      task_id: flags.task,
      confirm: !!flags.confirm,
    });
  } catch { /* daemon unreachable — fall through to local fallback below */ }

  if (resp && resp.statusCode === 200 && resp.data && !resp.data.error) {
    const data = resp.data;
    if (jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return data.allowed ? 0 : 1;
    }
    if (data.allowed) {
      const entry = data.entry || {};
      const auth = entry.auth ? ` [auth: ${entry.auth.method}${entry.auth.env ? ` env=${entry.auth.env}` : ''}]` : '';
      process.stdout.write(`ALLOWED (${data.outcome}) ${entry.name || entryName} -> ${entry.target || ''}${auth}\n`);
      if (data.warning) process.stdout.write(`warning: ${data.warning}\n`);
      return 0;
    }
    process.stdout.write(`REFUSED ${data.code || data.outcome}${data.env ? ` env=${data.env}` : ''}\n`);
    return 1;
  }

  // Daemon-unreachable fallback: fail-open local catalog check + JSONL buffer.
  process.stderr.write('Warning: daemon unreachable — buffered locally\n');
  const { loadCapabilityCatalog } = require(path.join(__dirname, 'gsd-tools.cjs'));
  const catalog = loadCapabilityCatalog();
  const result = _localCapabilityCheckAccess(entryName, catalog, !!flags.confirm);

  if (result.outcome !== 'skipped_off') {
    const entry = result.entry || {};
    _bufferCapabilityAccess({
      ts: new Date().toISOString(),
      task_id: flags.task || 'SYSTEM',
      event_type: result.outcome.startsWith('unlisted') ? 'capability_unlisted' : 'capability_access',
      agent_id: agentId,
      catalog_entry: entryName,
      target: entry.target || entryName,
      security_class: entry.security_class || 'unknown',
      outcome: result.outcome,
      enforce_mode: result.enforce_mode,
    });
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.allowed ? 0 : 1;
  }
  if (result.allowed) {
    const entry = result.entry || {};
    const auth = entry.auth ? ` [auth: ${entry.auth.method}${entry.auth.env ? ` env=${entry.auth.env}` : ''}]` : '';
    process.stdout.write(`ALLOWED (${result.outcome}) ${entry.name || entryName} -> ${entry.target || ''}${auth}\n`);
    if (result.warning) process.stdout.write(`warning: ${result.warning}\n`);
    return 0;
  }
  process.stdout.write(`REFUSED ${result.code || result.outcome}${result.env ? ` env=${result.env}` : ''}\n`);
  return 1;
}

/**
 * Resolve the capability-catalog write path for `capability add`:
 * GSD_CAPABILITY_CATALOG_PATH override first, else the repo-local
 * config/capability-catalog.json if it exists, else the ~/.claude candidate.
 * Mirrors gsd-tools.cjs's loadCapabilityCatalog() candidate order.
 */
function _resolveCapabilityCatalogWritePath() {
  const envOverride = process.env.GSD_CAPABILITY_CATALOG_PATH;
  if (envOverride) return envOverride;
  const repoLocal = path.resolve(__dirname, '..', 'config', 'capability-catalog.json');
  if (fs.existsSync(repoLocal)) return repoLocal;
  return path.join(process.env.HOME || '', '.claude', 'get-shit-done', 'config', 'capability-catalog.json');
}

async function cmdCapabilityAdd(flags, jsonMode) {
  const name = flags.name;
  const kind = flags.kind;
  const target = flags.target;
  const authMethod = flags['auth-method'] || 'none';
  const authEnv = flags['auth-env'];
  const keyRef = flags['key-ref'];
  const securityClass = flags.class;
  const owner = flags.owner || 'operator';
  const grants = flags.grants ? String(flags.grants).split(',').map((g) => g.trim()).filter(Boolean) : [];
  const notes = flags.notes || '';
  const autoYes = !!flags.yes;

  const fail = (error, extra = {}) => {
    process.stderr.write(JSON.stringify({ error, ...extra }) + '\n');
    return 1;
  };

  if (!name || !CAPABILITY_NAME_RE.test(name)) {
    return fail('capability_invalid_name', { name });
  }
  if (!kind || !CAPABILITY_KIND_VALUES.includes(kind)) {
    return fail('capability_invalid_kind', { kind });
  }
  if (!securityClass || !CAPABILITY_SECURITY_CLASS_VALUES.includes(securityClass)) {
    return fail('capability_invalid_security_class', { class: securityClass });
  }
  if (!CAPABILITY_AUTH_METHOD_VALUES.includes(authMethod)) {
    return fail('capability_invalid_auth_method', { method: authMethod });
  }
  if (authMethod.endsWith('-env')) {
    if (!authEnv) return fail('capability_auth_env_required', { method: authMethod });
    if (/:\/\/|\s/.test(authEnv)) return fail('capability_auth_env_not_a_name', { value: authEnv });
  }
  if (authMethod === 'ssh-key' && !keyRef) {
    return fail('capability_key_ref_required', { method: authMethod });
  }
  if (!target || !String(target).trim()) {
    return fail('capability_invalid_target', { target });
  }

  const catalogPath = _resolveCapabilityCatalogWritePath();
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
  } catch (err) {
    return fail('capability_catalog_unreadable', { path: catalogPath, detail: err.message });
  }
  const entries = catalog.entries || (catalog.entries = []);

  if (entries.some((e) => e.name === name)) {
    return fail('capability_duplicate_name', { name });
  }

  const auth = { method: authMethod };
  if (authEnv) auth.env = authEnv;
  if (keyRef) auth.key_ref = keyRef;

  // LOCKED key order: name, kind, target, auth, security_class, owner, grants, added_at, notes
  const newEntry = {
    name,
    kind,
    target,
    auth,
    security_class: securityClass,
    owner,
    grants,
    added_at: new Date().toISOString().slice(0, 10),
    notes,
  };

  process.stdout.write(JSON.stringify(newEntry, null, 2) + '\n');

  if (!autoYes) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question('Add this capability entry to the catalog? [y/N] ', (a) => {
        rl.close();
        resolve(a);
      });
    });
    if (!/^y(es)?$/i.test((answer || '').trim())) {
      process.stdout.write('Aborted.\n');
      return 1;
    }
  }

  entries.push(newEntry);
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  process.stdout.write(`Added '${name}' to capability catalog (${catalogPath})\n`);
  return 0;
}

// ═══════════════════════════════════════════════════════
// Telemetry Commands (Phase 62 TEL-01/TEL-03)
// ═══════════════════════════════════════════════════════

/**
 * The boringly explicit pre-consent disclosure block (TEL-01 — the trust
 * surface, no marketing language). Names all 8 EVENT_TYPES verbatim and
 * states exactly what is / is not collected.
 */
function _telemetryDisclosureText(eventTypes) {
  return (
    'Telemetry disclosure — what would be collected if you enable this:\n' +
    '  Event types: ' + eventTypes.join(', ') + '\n' +
    '  Collected: metadata only -- ids, types, counts, durations, error classes\n' +
    '  Project identity: sent only as a salted hash, never the raw project name\n' +
    '  Never collected: file contents, prompts, memory text, secrets, error messages\n'
  );
}

async function _telemetryEnable(flags, jsonMode) {
  const t = _tel();
  process.stdout.write(_telemetryDisclosureText(t.EVENT_TYPES));

  if (!flags.yes) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question('Enable telemetry? [y/N] ', (a) => {
        rl.close();
        resolve(a);
      });
    });
    if (!/^y(es)?$/i.test((answer || '').trim())) {
      process.stdout.write('telemetry remains OFF\n');
      return 0;
    }
  }

  const cfg = t.readTelemetryConfig();
  const salt = cfg.salt || require('crypto').randomBytes(8).toString('hex');
  const patch = {
    enabled: true,
    consented_at: new Date().toISOString(),
    salt,
  };
  if (flags.sink) patch.sink_url = flags.sink;

  const ok = t.writeTelemetryConfig(patch);
  if (!ok) {
    process.stderr.write('Failed to write telemetry config (no .planning/config.json in this cwd?)\n');
    return 1;
  }
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ enabled: true, consented_at: patch.consented_at }) + '\n');
  } else {
    process.stdout.write('telemetry ENABLED\n');
  }
  return 0;
}

function _telemetryDisable(jsonMode) {
  const t = _tel();
  t.writeTelemetryConfig({ enabled: false });
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ enabled: false }) + '\n');
  } else {
    process.stdout.write('telemetry DISABLED\n');
  }
  return 0;
}

function _telemetryStatus(jsonMode) {
  const t = _tel();
  const cfg = t.readTelemetryConfig();
  let flushState = null;
  try {
    flushState = JSON.parse(fs.readFileSync(t.flushStatePath(), 'utf8'));
  } catch { /* no flush yet */ }

  const result = {
    enabled: !!cfg.enabled,
    consented_at: cfg.consented_at || null,
    sink_url: cfg.sink_url || null,
    buffered_count: t.bufferedCount(),
    last_flush_at: (flushState && flushState.last_flush_at) || null,
    schema_version: t.SCHEMA_VERSION,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(
    `enabled:        ${result.enabled}\n` +
    `consented_at:   ${result.consented_at || '(none)'}\n` +
    `sink_url:       ${result.sink_url || '(none)'}\n` +
    `buffered_count: ${result.buffered_count}\n` +
    `last_flush_at:  ${result.last_flush_at || '(never)'}\n` +
    `schema_version: ${result.schema_version}\n`
  );
  return 0;
}

function _telemetryPreview() {
  const t = _tel();
  const last = t.readLastEvent();
  if (last) {
    process.stdout.write(JSON.stringify(last, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(JSON.stringify(t.sampleEvent(), null, 2) + '\n');
  process.stderr.write('(no captured events yet — synthesized sample of the exact envelope shape)\n');
  return 0;
}

async function _telemetryFlush(jsonMode) {
  const t = _tel();
  const result = await t.flushNow();
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(
      `flushed:   ${result.flushed}\n` +
      `remaining: ${result.remaining}\n` +
      (result.reason ? `reason:    ${result.reason}\n` : '') +
      (result.error ? `error:     ${result.error}\n` : '')
    );
  }
  // A dead sink is reported in the `error` field, never as a failing exit
  // (TEL-03 — a flush attempt against an unreachable sink is not a failure).
  return 0;
}

async function cmdTelemetry(rest, jsonMode) {
  const subCmd = rest[0];
  const flags = parseFlags(rest, 1);

  if (subCmd === 'enable') return await _telemetryEnable(flags, jsonMode);
  if (subCmd === 'disable') return _telemetryDisable(jsonMode);
  if (subCmd === 'status') return _telemetryStatus(jsonMode);
  if (subCmd === 'preview' || subCmd === 'show-payload') return _telemetryPreview();
  if (subCmd === 'flush') return await _telemetryFlush(jsonMode);

  process.stderr.write(
    'Usage:\n' +
    '  amauta telemetry enable [--yes] [--sink URL]   Show disclosure, opt in\n' +
    '  amauta telemetry disable                       Opt out\n' +
    '  amauta telemetry status [--json]                Current consent/buffer state\n' +
    '  amauta telemetry preview  (alias show-payload)  Exact payload preview\n' +
    '  amauta telemetry flush [--json]                 Attempt a sink flush now\n'
  );
  return 1;
}

// ═══════════════════════════════════════════════════════
// Audit Commands (Phase 6)
// ═══════════════════════════════════════════════════════

async function cmdAudit(useDaemon, rest, jsonMode) {
  const subCmd = rest[0];

  if (subCmd === 'show') {
    // audit show TK-XXXX — display full audit trail for a task
    const taskId = rest[1];
    if (!taskId) die('Usage: amauta audit show <task-id>');
    return await cmdAuditShow(useDaemon, taskId, jsonMode);
  }

  if (subCmd === 'export') {
    // audit export [--format json|csv] [--start DATE] [--end DATE]
    const flags = parseFlags(rest, 1);
    return await cmdAuditExport(useDaemon, flags, jsonMode);
  }

  process.stderr.write(
    'Usage:\n' +
    '  amauta audit show <task-id>               Show audit trail for a task\n' +
    '  amauta audit export [--format json|csv] [--start DATE] [--end DATE]\n' +
    '                                            Export audit log\n'
  );
  return 1;
}

async function cmdAuditShow(useDaemon, taskId, jsonMode) {
  if (useDaemon) {
    const { data } = await httpRequest('GET', `/api/audit/query?task_id=${encodeURIComponent(taskId)}&limit=200`);
    if (jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const results = data.results || [];
      if (results.length === 0) {
        process.stdout.write(`No audit entries for ${taskId}\n`);
        return 0;
      }
      process.stdout.write(`\n  Audit Trail for ${taskId} (${results.length} entries)\n`);
      process.stdout.write('  ' + '-'.repeat(60) + '\n');
      for (const entry of results.reverse()) {
        const ts = (entry.created_at || '').replace('T', ' ').substring(0, 19);
        const agent = entry.agent_id || entry.actor || '-';
        const phase = entry.phase ? `[${entry.phase}]` : '';
        const status = entry.status ? `(${entry.status})` : '';
        process.stdout.write(`  ${ts}  ${entry.event_type} ${phase} ${status}  @${agent}\n`);
        if (entry.content) {
          const preview = entry.content.substring(0, 120).replace(/\n/g, ' ');
          process.stdout.write(`    ${preview}${entry.content.length > 120 ? '...' : ''}\n`);
        }
        if (entry.gate_results && Array.isArray(entry.gate_results)) {
          for (const g of entry.gate_results) {
            const icon = g.status === 'PASS' ? 'PASS' : g.status === 'SKIP' ? 'SKIP' : 'FAIL';
            process.stdout.write(`    GATE[${g.gate}]: ${icon} -- ${g.reason || ''}\n`);
          }
        }
      }
      process.stdout.write('  ' + '-'.repeat(60) + '\n');
    }
    return 0;
  }
  // Direct mode: no audit without daemon
  process.stderr.write('Audit commands require the daemon to be running.\n');
  return 1;
}

async function cmdAuditExport(useDaemon, flags, jsonMode) {
  if (!useDaemon) {
    process.stderr.write('Audit commands require the daemon to be running.\n');
    return 1;
  }
  const format = flags.format || 'json';
  const queryParts = [`format=${encodeURIComponent(format)}`];
  if (flags.start) queryParts.push(`start=${encodeURIComponent(flags.start)}`);
  if (flags.end) queryParts.push(`end=${encodeURIComponent(flags.end)}`);
  const qs = queryParts.join('&');

  const { statusCode, data } = await httpRequest('GET', `/api/audit/export?${qs}`);

  if (format === 'csv') {
    // CSV comes back as raw text in the data object
    if (typeof data === 'string') {
      process.stdout.write(data);
    } else if (data.output) {
      process.stdout.write(data.output);
    } else {
      process.stdout.write(JSON.stringify(data));
    }
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
  return statusCode === 200 ? 0 : 1;
}

// ═══════════════════════════════════════════════════════
// Backup Commands (Phase 8: Data Durability)
// ═══════════════════════════════════════════════════════

async function cmdBackup(useDaemon, rest, jsonMode) {
  if (!useDaemon) {
    process.stderr.write('Backup commands require the daemon to be running.\n');
    return 1;
  }

  const subCmd = rest[0];

  if (subCmd === 'create') {
    const flags = parseFlags(rest, 1);
    const body = {};
    if (flags.output) body.output_path = flags.output;

    const { statusCode, data } = await httpRequest('POST', '/api/backup/create', body);
    if (jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      if (data.created) {
        process.stdout.write(`Backup created: ${data.path}\n`);
        process.stdout.write(`  Checksum: ${data.checksum}\n`);
        const counts = data.counts || {};
        for (const [table, count] of Object.entries(counts)) {
          process.stdout.write(`  ${table}: ${count} rows\n`);
        }
      } else {
        process.stderr.write(`Backup failed: ${data.error || 'unknown error'}\n`);
      }
    }
    return statusCode === 200 ? 0 : 1;
  }

  if (subCmd === 'restore') {
    const filePath = rest[1];
    if (!filePath) die('Usage: amauta backup restore <file> [--mode merge|replace]');
    const flags = parseFlags(rest, 2);
    const mode = flags.mode || 'merge';

    const { statusCode, data } = await httpRequest('POST', '/api/backup/restore', {
      file: filePath,
      mode,
    });
    if (jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      if (data.tables_restored !== undefined) {
        process.stdout.write(`Restore complete (mode: ${data.mode})\n`);
        process.stdout.write(`  Schema version: ${data.schema_version}\n`);
        process.stdout.write(`  Tables restored: ${data.tables_restored}\n`);
        const imported = data.rows_imported || {};
        for (const [table, count] of Object.entries(imported)) {
          process.stdout.write(`  ${table}: ${count} rows\n`);
        }
      } else {
        process.stderr.write(`Restore failed: ${data.error || 'unknown error'}\n`);
      }
    }
    return statusCode === 200 ? 0 : 1;
  }

  if (subCmd === 'verify') {
    const filePath = rest[1];
    const qs = filePath ? `?file=${encodeURIComponent(filePath)}` : '';
    const { statusCode, data } = await httpRequest('GET', `/api/backup/verify${qs}`);
    if (jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const valid = data.valid;
      process.stdout.write(`Verification: ${valid ? 'PASSED' : 'FAILED'}\n`);
      for (const check of (data.checks || [])) {
        process.stdout.write(`  [ok] ${check}\n`);
      }
      for (const err of (data.errors || [])) {
        process.stdout.write(`  [FAIL] ${err}\n`);
      }
      if (data.file_size_human) {
        process.stdout.write(`  Size: ${data.file_size_human}\n`);
      }
      if (data.created_at) {
        process.stdout.write(`  Created: ${data.created_at}\n`);
      }
    }
    return statusCode === 200 && data.valid ? 0 : 1;
  }

  if (subCmd === 'list') {
    const { statusCode, data } = await httpRequest('GET', '/api/backup/list');
    if (jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const backups = data.backups || [];
      if (backups.length === 0) {
        process.stdout.write('No backups found.\n');
      } else {
        process.stdout.write(`Backups (${backups.length}):\n`);
        for (const b of backups) {
          process.stdout.write(`  ${b.filename}  ${b.size_human}  ${b.modified}\n`);
        }
      }
    }
    return statusCode === 200 ? 0 : 1;
  }

  process.stderr.write(
    'Usage:\n' +
    '  amauta backup create [--output PATH]     Create a backup\n' +
    '  amauta backup restore <file> [--mode merge|replace]\n' +
    '                                           Restore from backup\n' +
    '  amauta backup verify [file]              Verify backup integrity\n' +
    '  amauta backup list                       List available backups\n'
  );
  return 1;
}

// ── cache-stats: Prompt cache performance (Phase 23 / CACHE-04) ──────────────

async function cmdCacheStats(useDaemon) {
  if (!useDaemon) {
    process.stderr.write('cache-stats requires the daemon to be running.\n');
    return 1;
  }
  const { statusCode, data } = await httpRequest('GET', '/metrics/cache');
  if (data.error) {
    process.stderr.write(`Cache metrics unavailable: ${data.error}\n`);
    return 1;
  }
  const lines = [
    'Prompt Cache Metrics',
    '====================',
    `Hit Rate:           ${(data.hit_rate * 100).toFixed(1)}%`,
    `Tokens Saved:       ${data.total_tokens_saved.toLocaleString()}`,
    `Cost Savings:       $${data.cost_savings_estimate.toFixed(4)}`,
    `Cache Read Tokens:  ${data.cache_read_tokens.toLocaleString()}`,
    `Cache Write Tokens: ${data.cache_creation_tokens.toLocaleString()}`,
    `Total Requests:     ${data.total_requests}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
  return statusCode === 200 ? 0 : 1;
}

// ═══════════════════════════════════════════════════════
// CLI Router
// ═══════════════════════════════════════════════════════

async function main() {
  const rawArgs = process.argv.slice(2);

  // Extract global flags
  const jsonIdx = rawArgs.indexOf('--json');
  let jsonMode = jsonIdx !== -1;
  if (jsonIdx !== -1) rawArgs.splice(jsonIdx, 1);

  // --no-inherit: skip inherited spec resolution in show --json output
  const noInheritIdx = rawArgs.indexOf('--no-inherit');
  const noInherit = noInheritIdx !== -1;
  if (noInheritIdx !== -1) rawArgs.splice(noInheritIdx, 1);  // strip --no-inherit before subcommand dispatch

  // --force-phases=<set>: Phase 42 / SCALE-02 override of the auto-selected RPETD phase set.
  // Accepts: full|rpetd|rpet|pet|pe|e or a comma list like R,P,E,T
  // Stashed into GSD_FORCE_PHASES env so Python (amauta.py / step-orchestrator.py /
  // complexity_scorer.py) can read it via os.environ.get("GSD_FORCE_PHASES").
  // The flag is NOT stripped from rawArgs so it propagates to exec/amauta.py invocations.
  let forcePhasesValue = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--force-phases=')) {
      forcePhasesValue = arg.slice('--force-phases='.length);
      break;
    }
    if (arg === '--force-phases') {
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        forcePhasesValue = next;
      }
      break;
    }
  }
  if (forcePhasesValue) {
    process.env.GSD_FORCE_PHASES = forcePhasesValue;
  }

  // --enable-telemetry: Phase 62 TEL-01 global flag, works on ANY invocation.
  // Stripped from rawArgs before command/rest are derived (mirrors
  // --no-inherit above) so it never leaks into command dispatch or the
  // exec/amauta.py passthrough.
  const enableTelemetryIdx = rawArgs.indexOf('--enable-telemetry');
  const enableTelemetryRequested = enableTelemetryIdx !== -1;
  if (enableTelemetryIdx !== -1) rawArgs.splice(enableTelemetryIdx, 1);

  const command = rawArgs[0];
  const rest = rawArgs.slice(1);

  // --enable-telemetry runs the consent-enable path non-interactively (same
  // effect as `telemetry enable --yes`) BEFORE dispatch. If it was the only
  // argument on the invocation, exit 0 immediately after enabling; otherwise
  // fall through so the rest of the command still dispatches normally.
  if (enableTelemetryRequested) {
    await _telemetryEnable({ yes: true }, jsonMode);
    if (!command) {
      process.exit(0);
    }
  }

  // Phase 62 TEL-01 first-run consent notice (ROADMAP SC1). Fires AT MOST
  // ONCE: if the config file exists but its parsed JSON has no `telemetry`
  // key yet, record {enabled:false, prompted_at, salt} and print a
  // non-blocking notice to stderr (never a readline prompt here —
  // automation-safe). Never creates the config file when it does not
  // exist (non-project cwd safety). Wrapped fail-open: a failure here must
  // never block or crash any other command.
  try {
    const t = _tel();
    const cfgPath = t.configPath();
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !('telemetry' in parsed)) {
        t.writeTelemetryConfig({
          enabled: false,
          consented_at: null,
          prompted_at: new Date().toISOString(),
          salt: require('crypto').randomBytes(8).toString('hex'),
          sink_url: null,
        });
        process.stderr.write(
          'telemetry is OFF by default -- `amauta telemetry enable` opts in; ' +
          '`amauta telemetry preview` shows exactly what would be sent\n'
        );
      }
    }
  } catch {
    // fail-open: the consent notice must never block any command
  }

  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(
      '\n' +
      '  \x1b[36m█████╗ ███╗   ███╗ █████╗ ██╗   ██╗████████╗ █████╗\x1b[0m\n' +
      '  \x1b[36m██╔══██╗████╗ ████║██╔══██╗██║   ██║╚══██╔══╝██╔══██╗\x1b[0m\n' +
      '  \x1b[36m███████║██╔████╔██║███████║██║   ██║   ██║   ███████║\x1b[0m\n' +
      '  \x1b[36m██╔══██║██║╚██╔╝██║██╔══██║██║   ██║   ██║   ██╔══██║\x1b[0m\n' +
      '  \x1b[36m██║  ██║██║ ╚═╝ ██║██║  ██║╚██████╔╝   ██║   ██║  ██║\x1b[0m\n' +
      '  \x1b[36m╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝\x1b[0m\n' +
      '  \x1b[2mv2  ·  Multi-agent task management with RPETD pipeline\x1b[0m\n' +
      '\n' +
      '  \x1b[33mUsage:\x1b[0m  amauta <command> [args] [--json]\n' +
      '\n' +
      '  \x1b[33mTask commands:\x1b[0m\n' +
      '    board                       Kanban view of all tasks\n' +
      '    stats                       Task counts by status\n' +
      '    list [--type T] [--status S] [--agent A]\n' +
      '    show <id> [--json] [--no-inherit]  Full task details\n' +
      '    next <agent> [--json]       Next task for an agent\n' +
      '    search <query>              Full-text task search\n' +
      '    score <id>                  Priority score breakdown\n' +
      '\n' +
      '  \x1b[33mCreate / update:\x1b[0m\n' +
      '    add <type> <title> [--parent ID] [--agent A] [--priority P]\n' +
      '                            type: epic | story | task\n' +
      '    update <id> [--field val ...]\n' +
      '    status <id> <new-status>\n' +
      '    assign <id> --agent <agent>\n' +
      '    note <id> --content "..." [--agent A]\n' +
      '    link <id> --dep <dep-id>    Add dependency\n' +
      '    unlink <id> --dep <dep-id>  Remove dependency\n' +
      '    delete <id>\n' +
      '\n' +
      '  \x1b[33mRPETD pipeline:\x1b[0m\n' +
      '    claim <id> --agent <agent>\n' +
      '    rpetd <id> --phase <R|P|E|T|D> --content "..."\n' +
      '    validate <id> --pass|--fail|--gaps-found (exit 2) --validator <agent> --notes "..."\n' +
      '                [--gap "REQ-ID:description"] [--non-gaps "obs"]\n' +
      '                [--subtasks "Fix A|Add B"] [--force-reason "justification"] [--json]\n' +
      '\n' +
      '  \x1b[33mScale-Adaptive (Phase 42):\x1b[0m\n' +
      '    --force-phases=<set>           Override RPETD phase set for this invocation\n' +
      '                                   set: full|rpetd|rpet|pet|pe|e or R,P,E,T\n' +
      '    task pin-phases <id> <set>     Pin phases for a task (per-task override)\n' +
      '    task pin-phases <id> <set> --clear  Remove existing pin\n' +
      '\n' +
      '  \x1b[33mAudit:\x1b[0m\n' +
      '    audit show <task-id>         Full audit trail for a task\n' +
      '    audit export [--format json|csv] [--start DATE] [--end DATE]\n' +
      '                                 Export audit log report\n' +
      '\n' +
      '  \x1b[33mBackup / Restore:\x1b[0m\n' +
      '    backup create [--output PATH]           Export all data\n' +
      '    backup restore <file> [--mode merge|replace]\n' +
      '    backup verify [file]                    Check integrity\n' +
      '    backup list                             List backups\n' +
      '\n' +
      '  \x1b[33mCache:\x1b[0m\n' +
      '    cache-stats                 Show prompt cache hit rate and cost savings\n' +
      '\n' +
      '  \x1b[33mDaemon:\x1b[0m\n' +
      '    daemon start|stop|status|run\n' +
      '    exec <...args>              Raw passthrough to amauta.py\n' +
      '\n'
    );
    process.exit(1);
  }

  // Daemon subcommand doesn't need the daemon running
  if (command === 'daemon') {
    const exitCode = await cmdDaemon(rest[0]);
    if (exitCode >= 0) process.exit(exitCode);
    return; // daemon run keeps process alive
  }

  // Health check — hit /health directly, no daemon start needed
  if (command === 'health') {
    try {
      const { statusCode, data } = await httpRequest('GET', '/health', null, 3000);
      if (jsonMode) {
        // Compact JSON so callers can grep '"status":"ok"' reliably
        console.log(JSON.stringify(data));
      } else {
        const ok = statusCode === 200 && data.status === 'ok';
        console.log(ok ? 'Daemon: running' : 'Daemon: not running');
        if (data.pg_available !== undefined) {
          console.log(`PostgreSQL: ${data.pg_available ? 'ok' : 'unavailable'}`);
        }
      }
      process.exit(statusCode === 200 ? 0 : 1);
    } catch {
      if (jsonMode) {
        console.log(JSON.stringify({ status: 'error', error: 'daemon not running' }));
      } else {
        console.log('Daemon: not running');
      }
      process.exit(1);
    }
  }

  // For all other commands, ensure daemon is available
  const useDaemon = await ensureDaemon();

  let exitCode = 0;

  // Parse flags from rest args (after the positional args)
  const id = rest[0];

  switch (command) {
    case 'board':
      exitCode = await cmdBoard(useDaemon, jsonMode);
      break;

    case 'stats':
      exitCode = await cmdStats(useDaemon, jsonMode);
      break;

    case 'show':
      exitCode = await cmdShow(useDaemon, id, jsonMode, noInherit);
      break;

    case 'next':
      exitCode = await cmdNext(useDaemon, id, jsonMode);
      break;

    case 'list':
    case 'ls': {
      const flags = parseFlags(rest, 0);
      exitCode = await cmdList(useDaemon, flags, jsonMode);
      break;
    }

    case 'add':
      exitCode = await cmdAdd(useDaemon, rest, jsonMode);
      break;

    case 'claim': {
      const flags = parseFlags(rest, 1);
      exitCode = await cmdClaim(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'rpetd': {
      const flags = parseFlags(rest, 1);
      exitCode = await cmdRpetd(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'validate': {
      // HARDEN-04: collect repeatable --gap / --non-gaps entries and the
      // --gaps-found bool BEFORE parseFlags (which would overwrite repeats).
      const gapsList = [];
      const nonGapsList = [];
      let gapsFound = false;
      const filtered = [rest[0]];
      for (let i = 1; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--gaps-found') { gapsFound = true; continue; }
        if (a === '--gap') { if (rest[i + 1] !== undefined) { gapsList.push(rest[++i]); } continue; }
        if (a === '--non-gaps') { if (rest[i + 1] !== undefined) { nonGapsList.push(rest[++i]); } continue; }
        filtered.push(a);
      }
      const flags = parseFlags(filtered, 1);
      if (gapsFound) flags.gaps_found = true;
      flags.gaps_list = gapsList;
      flags.non_gaps_list = nonGapsList;
      exitCode = await cmdValidate(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'note': {
      const flags = parseFlags(rest, 1);
      exitCode = await cmdNote(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'status': {
      const statusTo = rest[1];
      const flags = parseFlags(rest, 2);
      exitCode = await cmdStatus(useDaemon, id, statusTo, flags, jsonMode);
      break;
    }

    case 'search':
      exitCode = await cmdSearch(useDaemon, rest.join(' '), jsonMode);
      break;

    case 'score':
      exitCode = await cmdScore(useDaemon, id, jsonMode);
      break;

    case 'assign': {
      const flags = parseFlags(rest, 1);
      exitCode = await cmdAssign(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'link': {
      const flags = parseFlags(rest, 1);
      exitCode = await cmdLink(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'unlink': {
      const flags = parseFlags(rest, 1);
      exitCode = await cmdUnlink(useDaemon, id, flags, jsonMode);
      break;
    }

    case 'update':
      exitCode = await cmdUpdate(useDaemon, id, rest, jsonMode);
      break;

    case 'delete':
      exitCode = await cmdDelete(useDaemon, id, jsonMode);
      break;

    case 'exec':
      exitCode = await cmdExec(useDaemon, rest, jsonMode);
      break;

    // Phase 42 / SCALE-02: task subcommand group (pin-phases)
    // Forwards all args to amauta.py 'task ...' so 'node gsd-amauta.cjs task pin-phases TK-XXXX full'
    // reaches 'python3 amauta.py task pin-phases TK-XXXX full'.
    case 'task':
      exitCode = await cmdExec(useDaemon, ['task', ...rest], jsonMode);
      break;

    case 'audit':
      exitCode = await cmdAudit(useDaemon, rest, jsonMode);
      break;

    case 'backup':
      exitCode = await cmdBackup(useDaemon, rest, jsonMode);
      break;

    case 'cache-stats':
      exitCode = await cmdCacheStats(useDaemon);
      break;

    // Phase 60 TOOL-01/02/03: capability verb group — MUST be an explicit
    // case: the default passthrough hits /api/exec whose _EXEC_ALLOWLIST
    // does not include 'capability' and would 403.
    case 'capability':
      exitCode = await cmdCapability(useDaemon, rest, jsonMode);
      break;

    // Phase 62 TEL-01/TEL-03: telemetry verb group — MUST be an explicit
    // case: the default passthrough hits /api/exec whose _EXEC_ALLOWLIST
    // does not include 'telemetry' and would 403 (Phase 60 capability
    // precedent). All-local, no daemon calls.
    case 'telemetry':
      exitCode = await cmdTelemetry(rest, jsonMode);
      break;

    default:
      // Try as passthrough exec
      exitCode = await cmdExec(useDaemon, [command, ...rest], jsonMode);
      break;
  }

  process.exit(exitCode);
}

// Guard: only run main() when executed directly (not when require()'d by tests).
// Also runs when delegated via amauta.cjs wrapper (process.argv[1] ends with /amauta.cjs).
const _isDelegatedEntry = process.argv[1] &&
  (process.argv[1].endsWith('/amauta.cjs') || process.argv[1].endsWith('\\amauta.cjs')) &&
  !process.argv[1].endsWith('/gsd-amauta.cjs') &&
  !process.argv[1].endsWith('\\gsd-amauta.cjs');

if (require.main === module || _isDelegatedEntry) {
  main().catch((err) => {
    _telemetryEmit('error_class', {
      error_class: (err && err.constructor && err.constructor.name) || 'Error',
      code: (err && err.code) || null,
      verb: process.argv[2] || null,
    });
    process.stderr.write(`FATAL: ${err.message}\n`);
    process.exit(1);
  });
}

// Test-only exports — not used in production flow
if (typeof module !== 'undefined' && require.main !== module) {
  module.exports = { _checkEvidenceBlock, checkEvidenceAdvisory, _checkQaBlocks, _checkRedGreenOrder, checkSpecInheritanceAdvisory, writeGapsReport, scrubEvidence, loadEvidenceScrubPatterns };
}
