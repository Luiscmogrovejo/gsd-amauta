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
// - When installed (~/.claude/get-shit-done/bin/), `../..` = ~/.claude (no amauta.py). Fall back to known
//   source-repo locations so the CLI's `python3 amauta.py` fallback path remains valid even after install.
function _resolvePluginRoot() {
  const candidates = [
    path.resolve(__dirname, '..', '..'),                     // source repo layout
    path.resolve(__dirname, '..'),                           // installed layout (~/.claude/get-shit-done)
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
    path.join(home, '.claude', 'get-shit-done'),
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

async function cmdShow(useDaemon, id, jsonMode) {
  if (!id) die('Usage: amauta show <id> [--json]');
  const args = jsonMode ? ['show', id, '--json'] : ['show', id];
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
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

async function cmdClaim(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta claim <id> --agent <agent>');
  const body = { id, ...flags };
  body.project_dir = process.cwd();

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/claim', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const args = ['claim', id];
  if (flags.agent) args.push('--agent', flags.agent);
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
}

const VALID_PHASES = new Set(['R', 'P', 'E', 'T', 'D']);

async function cmdRpetd(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta rpetd <id> --phase P --content "..."');
  if (!flags.phase) die('--phase is required (R, P, E, T, or D)');
  const phaseUpper = (flags.phase || '').toUpperCase();
  if (!VALID_PHASES.has(phaseUpper)) die(`Invalid phase "${flags.phase}". Must be one of: R, P, E, T, D`);
  flags.phase = phaseUpper; // Normalize to uppercase before passing to daemon
  if (!flags.content) die('--content is required');
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
      '/Users/luismogrovejo/.claude/get-shit-done/references/pre-execution-checklist.md';
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

async function cmdValidate(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta validate <id> --pass/--fail [--validator V] [--notes N] [--force-reason "justification"]');
  if (flags.pass_result === undefined) die('--pass or --fail is required');

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
  const noteText = flags.content || flags.text;
  if (!noteText) die('--content is required (also accepts --text)');
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

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/status', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const args = ['status', id, statusTo];
  if (flags.agent) args.push('--agent', flags.agent);
  const result = runDirect(args);
  printResponse(result, jsonMode);
  return result.exit_code;
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

// ═══════════════════════════════════════════════════════
// CLI Router
// ═══════════════════════════════════════════════════════

async function main() {
  const rawArgs = process.argv.slice(2);

  // Extract global flags
  const jsonIdx = rawArgs.indexOf('--json');
  let jsonMode = jsonIdx !== -1;
  if (jsonIdx !== -1) rawArgs.splice(jsonIdx, 1);

  const command = rawArgs[0];
  const rest = rawArgs.slice(1);

  if (!command) {
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
      '    show <id> [--json]          Full task details\n' +
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
      '    validate <id> --pass|--fail --validator <agent> --notes "..."\n' +
      '                [--subtasks "Fix A|Add B"] [--force-reason "justification"] [--json]\n' +
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
      exitCode = await cmdShow(useDaemon, id, jsonMode);
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
      const flags = parseFlags(rest, 1);
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

    case 'audit':
      exitCode = await cmdAudit(useDaemon, rest, jsonMode);
      break;

    case 'backup':
      exitCode = await cmdBackup(useDaemon, rest, jsonMode);
      break;

    default:
      // Try as passthrough exec
      exitCode = await cmdExec(useDaemon, [command, ...rest], jsonMode);
      break;
  }

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});

// Test-only exports — not used in production flow
if (typeof module !== 'undefined' && require.main !== module) {
  module.exports = { _checkEvidenceBlock, checkEvidenceAdvisory };
}
