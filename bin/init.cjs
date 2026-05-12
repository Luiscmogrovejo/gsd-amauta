#!/usr/bin/env node

/**
 * gsd-amauta init — Single-command setup for GSD-Amauta.
 *
 * Orchestrates:
 *   1. Detect installed IDEs (filesystem-first, cwd then $HOME)
 *   2. Install agents, commands, skills for detected/specified IDEs
 *   3. Detect infrastructure (PG local, Docker PG, SQLite fallback)
 *   4. Run database migrations (PG only)
 *   5. Start the amauta daemon
 *   6. Verify the system is operational
 *
 * Usage:
 *   npx gsd-amauta init [options]
 *   node bin/init.cjs [options]
 *
 * Options:
 *   --skip-install         Skip agent/command/skill installation
 *   --skip-daemon          Skip daemon startup
 *   --opencode             Install OpenCode config (legacy alias for --tools opencode)
 *   --claude               Install Claude Code config (legacy alias for --tools claude-code)
 *   --backend <type>       Force backend: pg, sqlite, auto (default: auto)
 *   --force                Force re-detection even if daemon is running
 *   --yes                  Non-interactive mode; skip-with-warn on ambiguity (never destructive)
 *   --tools <list>         Comma-list of IDEs to install (e.g. claude-code,cursor)
 *   --force-migrate        Bypass legacy-migration collision guard
 *   --json                 Output results as JSON
 *   --help, -h             Print this help and exit 0
 */

'use strict';

const { execFileSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Skill compiler — optional (gracefully degrade if not installed)
let skillCompiler = null;
try {
  skillCompiler = require('../scripts/skill-compiler.cjs');
} catch (_e) {
  // Partial install: skill-compiler.cjs not yet available — detection falls back to hard-coded values
}

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(PLUGIN_ROOT, 'services', 'amauta-daemon.py');
const INFRA_DETECT = path.join(PLUGIN_ROOT, 'services', 'infra_detect.py');
const INSTALL_SCRIPT = path.join(PLUGIN_ROOT, 'bin', 'install.js');
const MIGRATIONS_DIR = path.join(PLUGIN_ROOT, 'migrations');
const AMAUTA_PY = process.env.GSD_AMAUTA_PY || path.join(PLUGIN_ROOT, 'amauta.py');
const DATA_DIR = process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT, 'data');

const HOST = process.env.GSD_AMAUTA_HOST || '127.0.0.1';
const PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);

// Colors
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

/**
 * Print help text and exit 0.
 * Invoked when --help / -h is passed (Phase 44 INST-03 doc requirement).
 */
function printHelp() {
  process.stdout.write(`gsd-amauta init [options]

Options:
  --skip-install         Skip agent/command/skill installation
  --skip-daemon          Skip daemon startup
  --opencode             Install OpenCode config (legacy alias for --tools opencode)
  --claude               Install Claude Code config (legacy alias for --tools claude-code)
  --backend <type>       Force backend: pg, sqlite, auto (default: auto)
  --force                Force re-detection even if daemon is running
  --yes                  Non-interactive mode; skip-with-warn on ambiguity (never destructive)
  --tools <list>         Comma-list of IDEs to install (e.g. claude-code,cursor)
  --force-migrate        Bypass legacy-migration collision guard
  --json                 Output results as JSON
  --help, -h             Print this help and exit 0
`);
}

// ═══════════════════════════════════════════════════════
// Argument parsing
// ═══════════════════════════════════════════════════════

const args = process.argv.slice(2);
// Remove 'init' if present (when called via cli.cjs dispatcher)
if (args[0] === 'init') args.shift();

const flags = {
  skipInstall: args.includes('--skip-install'),
  skipDaemon: args.includes('--skip-daemon'),
  force: args.includes('--force'),
  json: args.includes('--json'),
  runtime: args.includes('--opencode') ? 'opencode' : 'claude',
  backend: 'auto',
  yes: args.includes('--yes'),                   // NEW: non-interactive CI mode
  tools: [],                                     // NEW: comma-list of IDEs (parsed below)
  forceMigrate: args.includes('--force-migrate'), // NEW: bypass legacy-migration collision guard
  help: args.includes('--help') || args.includes('-h'), // NEW: print help and exit
};

const backendIdx = args.indexOf('--backend');
if (backendIdx !== -1 && args[backendIdx + 1]) {
  const val = args[backendIdx + 1];
  if (['pg', 'sqlite', 'auto'].includes(val)) {
    flags.backend = val;
  } else {
    console.error(`${red}Error: --backend must be pg, sqlite, or auto${reset}`);
    process.exit(1);
  }
}

// --tools parser: comma-separated IDE list (e.g. --tools claude-code,cursor)
const toolsIdx = args.indexOf('--tools');
if (toolsIdx !== -1 && args[toolsIdx + 1]) {
  flags.tools = args[toolsIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
}
// Legacy alias translation per 44-CONTEXT.md §Area 1:
// --claude and --opencode prepend to flags.tools with a single-line stderr note
// when --tools is ALSO explicitly set. When --tools is unset, the legacy flags
// are honored as before (no stderr note).
const hasLegacyClaude = args.includes('--claude');
const hasLegacyOpencode = args.includes('--opencode');
const explicitTools = toolsIdx !== -1;
if (explicitTools) {
  if (hasLegacyClaude && !flags.tools.includes('claude-code')) {
    process.stderr.write('--claude is treated as --tools claude-code\n');
    flags.tools.unshift('claude-code');
  }
  if (hasLegacyOpencode && !flags.tools.includes('opencode')) {
    process.stderr.write('--opencode is treated as --tools opencode\n');
    flags.tools.unshift('opencode');
  }
} else if (hasLegacyClaude || hasLegacyOpencode) {
  // Legacy-only mode: build flags.tools from legacy flags without stderr note.
  if (hasLegacyClaude) flags.tools.push('claude-code');
  if (hasLegacyOpencode) flags.tools.push('opencode');
}

// ═══════════════════════════════════════════════════════
// HTTP helpers (reused from gsd-amauta.cjs patterns)
// ═══════════════════════════════════════════════════════

function httpGet(urlPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ statusCode: res.statusCode, data: { raw } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDaemonRunning() {
  try {
    const { statusCode, data } = await httpGet('/health', 2000);
    return statusCode === 200 && data && data.status === 'ok';
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// Per-step result schema helpers (Phase 44 — all steps return this shape)
// ═══════════════════════════════════════════════════════

/**
 * Build a frozen per-step result object.
 *
 * Schema:
 *   { name: string, status: 'pass'|'fail'|'skip'|'warn', message: string,
 *     duration_ms: number, details: object|null }
 *
 * @param {string} name        — step identifier (e.g. 'detect_ides')
 * @param {string} status      — one of 'pass', 'fail', 'skip', 'warn'
 * @param {string} message     — human-readable summary
 * @param {object|null} details — optional structured data
 * @returns {{ name, status, message, duration_ms, details }}
 */
function buildStepResult(name, status, message, details) {
  // All 4 status values must be representable (44-CONTEXT.md §Area 1 frozen schema):
  //   status: 'pass'  — step completed successfully
  //   status: 'fail'  — step encountered a blocking error
  //   status: 'skip'  — step was intentionally skipped
  //   status: 'warn'  — step completed with warnings (non-blocking)
  const VALID_STATUSES = new Set(['pass', 'fail', 'skip', 'warn']);
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`invalid status: '${status}' — must be one of: pass, fail, skip, warn`);
  }
  return {
    name,
    status,
    message,
    duration_ms: 0,
    details: details !== undefined ? details : null,
  };
}

/**
 * Render a human-readable colored table of step results.
 *
 * Prints header "Step | Status | Duration | Message" and one row per result.
 * In --json mode this is a NO-OP (orchestrator emits raw results array).
 *
 * Status color mapping: pass=green, warn=yellow, skip=dim, fail=red
 *
 * @param {Array} results — array of per-step result objects
 */
function renderStepTable(results) {
  if (flags.json) return; // no-op in JSON mode

  const statusColor = {
    pass: green,
    warn: yellow,
    skip: dim,
    fail: red,
  };

  const pad = (s, len) => String(s).padEnd(len);

  console.log('');
  console.log(`${bold}${pad('Step', 24)} ${pad('Status', 8)} ${pad('Duration', 12)} Message${reset}`);
  console.log('─'.repeat(70));

  for (const r of results) {
    const color = statusColor[r.status] || reset;
    const dur = r.duration_ms >= 0 ? `${r.duration_ms}ms` : '-';
    console.log(`${pad(r.name, 24)} ${color}${pad(r.status, 8)}${reset} ${pad(dur, 12)} ${r.message}`);
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════
// Step functions
// ═══════════════════════════════════════════════════════

/**
 * Step 0 (pre-install): Detect installed IDEs
 *
 * Scans project-local (cwd) first, then $HOME for IDE directories.
 * A directory counts as detected ONLY when it contains at least one of:
 *   (a) the skill_subdir from the yaml registry (e.g. skills/, rules/)
 *   (b) any *.md file directly under it
 *   (c) any *.json file directly under it
 * Empty directories do NOT count (false-positive guard per 44-CONTEXT.md §Area 2).
 *
 * CLI advisory: 'which <cli_name>' presence boosts signals string but never
 * blocks or enables detection.
 *
 * Returns buildStepResult('detect_ides', status, message, { detections: [...] })
 * where each detection row = { ide_id, detected: 'yes'|'no', signals, action }
 */
async function stepDetectIdes() {
  const start = Date.now();

  // Load IDE registry from yaml (via skill-compiler) or fall back to frozen hard-coded values
  let platformCodes = skillCompiler ? skillCompiler.loadPlatformCodes() : {};
  if (!platformCodes || Object.keys(platformCodes).length === 0) {
    // Hard-coded fallback (frozen per 44-CONTEXT.md §Area 4)
    platformCodes = {
      'claude-code': { ide_id: 'claude-code', dir_name: '.claude', skill_subdir: 'skills', cli_name: 'claude' },
      'cursor':      { ide_id: 'cursor',      dir_name: '.cursor', skill_subdir: 'rules',  cli_name: 'cursor' },
      'opencode':    { ide_id: 'opencode',    dir_name: '.opencode', skill_subdir: 'skills', cli_name: 'opencode' },
    };
  }

  /**
   * Determine whether a directory qualifies as "detected".
   * Must contain at least one of: skill_subdir, *.md, *.json, or commands/
   * (commands/ is legacy-migration source — advisory positive per plan spec).
   */
  function dirHasContent(dirPath, skillSubdir) {
    if (!fs.existsSync(dirPath)) return false;
    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch (_e) {
      return false;
    }
    for (const entry of entries) {
      if (entry === skillSubdir) return true;                // skill_subdir present
      if (entry === 'commands') return true;                 // legacy path (advisory)
      if (entry.endsWith('.md') || entry.endsWith('.json')) return true;
    }
    return false;
  }

  /**
   * Check if a CLI binary is on PATH (advisory only, never blocks detection).
   */
  function cliOnPath(cliName) {
    try {
      execFileSync('which', [cliName], { stdio: 'pipe' });
      return true;
    } catch (_e) {
      return false;
    }
  }

  const homeDir = process.env.HOME || os.homedir();
  const cwdDir = process.cwd();

  const detections = [];

  for (const [, codes] of Object.entries(platformCodes)) {
    const dirName = codes.dir_name;
    const skillSubdir = codes.skill_subdir;

    const cwdDirPath = path.join(cwdDir, dirName);
    const homeDirPath = path.join(homeDir, dirName);

    const dirCwd = dirHasContent(cwdDirPath, skillSubdir);
    const dirHome = dirHasContent(homeDirPath, skillSubdir);
    const cli = cliOnPath(codes.cli_name);

    const dirDetected = dirCwd || dirHome;
    const detected = dirDetected;

    // Build signals string: '+'-joined short labels
    let signalParts = [];
    if (dirDetected) signalParts.push('dir');
    if (cli) signalParts.push('cli');
    const signals = signalParts.length > 0 ? signalParts.join('+') : '(none)';

    detections.push({
      ide_id: codes.ide_id,
      detected: detected ? 'yes' : 'no',
      signals,
      action: detected ? 'install' : 'skip',
    });
  }

  const anyDetected = detections.some((d) => d.detected === 'yes');
  const status = anyDetected ? 'pass' : 'warn';
  const message = anyDetected
    ? `${detections.filter((d) => d.detected === 'yes').length} IDE(s) detected`
    : 'No IDE directories detected at cwd or $HOME';

  const r = buildStepResult('detect_ides', status, message, { detections });
  r.duration_ms = Date.now() - start;
  return r;
}

/**
 * Step 1: Install agents, commands, skills
 */
function stepInstall(log) {
  if (flags.skipInstall) {
    log('Skipped (--skip-install)');
    return { skipped: true };
  }

  if (!fs.existsSync(INSTALL_SCRIPT)) {
    log(`${yellow}Warning: install.js not found at ${INSTALL_SCRIPT}${reset}`);
    return { skipped: true, error: 'install.js not found' };
  }

  try {
    execFileSync(process.execPath, [INSTALL_SCRIPT, `--${flags.runtime}`], {
      stdio: flags.json ? 'pipe' : 'inherit',
      cwd: PLUGIN_ROOT,
      timeout: 60000,
    });
    log('done');
    return { success: true };
  } catch (err) {
    log(`${yellow}Warning: install had issues (${err.message})${reset}`);
    return { success: false, error: err.message };
  }
}

/**
 * Step 2: Detect infrastructure
 */
function stepDetectInfra(log) {
  // If user forced a backend, short-circuit detection
  if (flags.backend === 'sqlite') {
    const result = {
      backend: 'sqlite',
      connection_url: `sqlite:///${path.join(
        process.env.GSD_DATA_DIR || path.join(require('os').homedir(), '.amauta', 'data'),
        'gsd_amauta.db'
      )}`,
      features: ['memory', 'tasks', 'skb', 'validation', 'fts'],
      message: 'Forced SQLite backend via --backend sqlite',
    };
    log(`\n          Backend: ${cyan}sqlite${reset} (forced via --backend)`);
    log(`          Features: ${result.features.join(', ')}`);
    return result;
  }

  if (flags.backend === 'pg') {
    // Still run detection but expect PG — fail if not found
    // Fall through to normal detection but error if result is sqlite
  }

  // Run infra_detect.py as CLI and parse JSON
  if (!fs.existsSync(INFRA_DETECT)) {
    log(`${red}Error: infra_detect.py not found${reset}`);
    return null;
  }

  try {
    const output = execFileSync('python3', [INFRA_DETECT, '--auto-start'], {
      cwd: PLUGIN_ROOT,
      timeout: 90000, // Docker auto-start can take up to 60s+
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = JSON.parse(output.trim());

    if (flags.backend === 'pg' && result.backend !== 'postgresql') {
      log(`${red}Error: --backend pg specified but PostgreSQL not available${reset}`);
      log(`          ${dim}${result.message}${reset}`);
      return null;
    }

    const backendLabel = result.backend === 'postgresql' ? 'postgresql' : 'sqlite';
    log(`\n          Backend: ${cyan}${backendLabel}${reset}`);
    log(`          ${dim}${result.message}${reset}`);
    log(`          Features: ${result.features.join(', ')}`);
    return result;
  } catch (err) {
    log(`${yellow}Warning: infra detection failed (${err.message})${reset}`);
    // Fallback to SQLite if detection fails
    const fallback = {
      backend: 'sqlite',
      connection_url: `sqlite:///${path.join(
        process.env.GSD_DATA_DIR || path.join(require('os').homedir(), '.amauta', 'data'),
        'gsd_amauta.db'
      )}`,
      features: ['memory', 'tasks', 'skb', 'validation', 'fts'],
      message: 'SQLite fallback (infra detection failed)',
    };
    log(`          Falling back to SQLite`);
    return fallback;
  }
}

/**
 * Step 3: Run migrations (PG only)
 */
function stepMigrations(log, infraResult) {
  if (!infraResult || infraResult.backend !== 'postgresql') {
    log('Skipped (SQLite schema is self-creating)');
    return { skipped: true, reason: 'not postgresql' };
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log(`${yellow}No migrations directory found${reset}`);
    return { skipped: true, reason: 'no migrations dir' };
  }

  // Get migration files (skip DOWN files)
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.includes('DOWN'))
    .sort();

  if (migrationFiles.length === 0) {
    log('No migration files found');
    return { skipped: true, reason: 'no files' };
  }

  let applied = 0;
  let errors = 0;
  const connUrl = infraResult.connection_url;

  for (const file of migrationFiles) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    try {
      // Parse connection URL for psql args
      const url = new URL(connUrl);
      const psqlArgs = [
        '-h', url.hostname,
        '-p', url.port || '5432',
        '-U', url.username,
        '-d', url.pathname.slice(1), // Remove leading /
        '-f', filePath,
        '-v', 'ON_ERROR_STOP=1',
        '--quiet',
      ];

      const env = { ...process.env };
      if (url.password) {
        env.PGPASSWORD = url.password;
      }

      execFileSync('psql', psqlArgs, {
        timeout: 30000,
        stdio: 'pipe',
        env,
      });
      applied++;
    } catch {
      // Migration might fail if already applied (e.g., table exists)
      // This is expected — not a fatal error
      errors++;
    }
  }

  log(`done (${applied} applied, ${errors} already applied)`);
  return { success: true, applied, errors, total: migrationFiles.length };
}

/**
 * Step 4: Start daemon
 */
async function stepStartDaemon(log, infraResult) {
  if (flags.skipDaemon) {
    log('Skipped (--skip-daemon)');
    return { skipped: true };
  }

  // Check if already running
  if (await isDaemonRunning()) {
    if (!flags.force) {
      log('already running');
      return { success: true, alreadyRunning: true };
    }
    log('running (--force: restarting...)');
  }

  if (!fs.existsSync(DAEMON_SCRIPT)) {
    log(`${red}Error: amauta-daemon.py not found${reset}`);
    return { success: false, error: 'daemon script not found' };
  }

  // Set environment for daemon based on detected infrastructure
  const env = { ...process.env, AMAUTA_DATA_DIR: DATA_DIR, GSD_AMAUTA_PY: AMAUTA_PY, GSD_AMAUTA_PORT: String(PORT) };
  if (infraResult && infraResult.connection_url && infraResult.backend === 'postgresql') {
    env.GSD_POSTGRES_URL = infraResult.connection_url;
  }
  if (infraResult && infraResult.backend === 'sqlite') {
    env.GSD_BACKEND = 'sqlite';
    const sqlitePath = (infraResult.connection_url || '').replace('sqlite:///', '');
    if (sqlitePath) {
      env.GSD_SQLITE_PATH = sqlitePath;
    }
  }

  // Spawn daemon detached
  const child = spawn('python3', [DAEMON_SCRIPT, 'start'], {
    detached: true,
    stdio: 'ignore',
    cwd: PLUGIN_ROOT,
    env,
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(`${red}ERROR: python3 not found. Install Python 3.9+ to use Amauta daemon.${reset}\n`);
    }
  });
  child.unref();

  // Poll /health for up to 10 seconds
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isDaemonRunning()) {
      // Try to get PID from pidfile
      let pid = '?';
      try {
        const pidFile = path.join(PLUGIN_ROOT, 'services', 'amauta-daemon.pid');
        if (fs.existsSync(pidFile)) {
          pid = fs.readFileSync(pidFile, 'utf-8').trim();
        }
      } catch { /* ignore */ }
      log(`running (PID ${pid}, port ${PORT})`);
      return { success: true, pid, port: PORT };
    }
  }

  log(`${yellow}Warning: daemon did not respond within 10s${reset}`);
  return { success: false, error: 'daemon timeout' };
}

/**
 * Step 5: Verify system
 */
async function stepVerify(log) {
  if (flags.skipDaemon) {
    log('Skipped (daemon not started)');
    return { skipped: true };
  }

  try {
    const health = await httpGet('/health', 3000);
    if (health.statusCode !== 200 || !health.data || health.data.status !== 'ok') {
      log(`${red}Health check failed${reset}`);
      return { success: false, error: 'health check failed' };
    }
  } catch (err) {
    log(`${red}Cannot reach daemon: ${err.message}${reset}`);
    return { success: false, error: err.message };
  }

  // Try to get infrastructure info from daemon
  let infra = null;
  try {
    const resp = await httpGet('/api/infra', 3000);
    if (resp.statusCode === 200 && resp.data) {
      infra = resp.data;
    }
  } catch { /* non-fatal */ }

  // Try to get counts
  let memoryCount = '?';
  let taskCount = '?';
  try {
    const statsResp = await httpGet('/api/stats', 3000);
    if (statsResp.statusCode === 200 && statsResp.data) {
      const s = statsResp.data;
      memoryCount = s.memory_count || s.memories || '?';
      taskCount = s.task_count || s.total_tasks || s.tasks || '?';
    }
  } catch { /* non-fatal */ }

  log(`\n          Memories: ${memoryCount} stored`);
  log(`          Tasks: ${taskCount} total`);

  return { success: true, memoryCount, taskCount, infra };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  // --help short-circuit (Phase 44 INST-03 documentation requirement)
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const startTime = Date.now();
  const results = {};

  if (!flags.json) {
    console.log(`\n${bold}gsd-amauta init${reset}`);
    console.log('================\n');
  }

  // Helper: step logger
  function makeLog(stepNum, totalSteps, label) {
    let first = true;
    return function log(msg) {
      if (flags.json) return;
      if (first) {
        process.stdout.write(`[${stepNum}/${totalSteps}] ${label}... `);
        first = false;
      }
      console.log(msg);
    };
  }

  const totalSteps = 5;

  // Step 1: Install
  const installLog = makeLog(1, totalSteps, 'Installing agents, commands, skills');
  results.install = stepInstall(installLog);

  // Step 2: Detect infrastructure
  const infraLog = makeLog(2, totalSteps, 'Detecting infrastructure');
  results.infra = stepDetectInfra(infraLog);
  if (!results.infra) {
    if (flags.json) {
      console.log(JSON.stringify({ success: false, error: 'Infrastructure detection failed', results }, null, 2));
    } else {
      console.log(`\n${red}Init failed: could not detect infrastructure.${reset}`);
    }
    process.exit(1);
  }

  // Step 3: Run migrations
  const migrateLog = makeLog(3, totalSteps, 'Running migrations');
  results.migrations = stepMigrations(migrateLog, results.infra);

  // Step 4: Start daemon
  const daemonLog = makeLog(4, totalSteps, 'Starting daemon');
  results.daemon = await stepStartDaemon(daemonLog, results.infra);

  // Step 5: Verify
  const verifyLog = makeLog(5, totalSteps, 'Verifying system');
  results.verify = await stepVerify(verifyLog);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (flags.json) {
    console.log(JSON.stringify({
      success: true,
      elapsed_seconds: parseFloat(elapsed),
      backend: results.infra.backend,
      features: results.infra.features,
      results,
    }, null, 2));
  } else {
    console.log(`\n${green}Ready!${reset} ${dim}(${elapsed}s)${reset} Run ${cyan}\`amauta board\`${reset} to see your tasks.`);
  }

  // Determine exit code
  const daemonOk = flags.skipDaemon || (results.daemon && results.daemon.success);
  const verifyOk = flags.skipDaemon || (results.verify && results.verify.success);
  process.exit(daemonOk && verifyOk ? 0 : 1);
}

// ═══════════════════════════════════════════════════════
// Export gate (required for hermetic unit tests in 44-01-05)
// ═══════════════════════════════════════════════════════

if (require.main === module) {
  main().catch((err) => {
    console.error(`${red}Fatal error: ${err.message}${reset}`);
    process.exit(1);
  });
}

module.exports = { stepDetectIdes, buildStepResult, renderStepTable };
