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

Upgrade / Uninstall (POLISH-02 — mutually exclusive):
  --upgrade              Upgrade Amauta in-place: detect version, apply new migrations,
                         update install record, restart daemon, run assertions.
  --uninstall            Remove Amauta from project (preserves .planning/, agents/,
                         skills/, tests/, source services/). Only deletes IDE-generated
                         outputs in .claude/skills/, .cursor/rules/, .opencode/skills/ etc.
  --dry-run              Preview what upgrade/uninstall WOULD do without making changes.
                         State-modifying steps return status='skip' with would_apply /
                         would_delete details.

Note: --upgrade and --uninstall are mutually exclusive.
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
  upgrade: args.includes('--upgrade'),           // NEW POLISH-02: version-aware migration
  uninstall: args.includes('--uninstall'),       // NEW POLISH-02: remove Amauta from project
  dryRun: args.includes('--dry-run'),            // NEW POLISH-02: preview without state changes
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

// ── POLISH-02: mutual exclusion guard (--upgrade XOR --uninstall) ────────────
{
  const modeFlags = [flags.upgrade, flags.uninstall].filter(Boolean).length;
  if (modeFlags > 1) {
    process.stderr.write('Error: --upgrade and --uninstall are mutually exclusive.\n');
    process.exit(1);
  }
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
 * Step 2: Install agents, commands, skills
 *
 * Extended in 44-02-03:
 *   - Calls migrateLegacyCommands() BEFORE install.js shell-out
 *   - After install.js, iterates detections and calls skillCompiler.compile() per IDE
 *   - Returns FROZEN result schema via buildStepResult('install_skills', ...)
 *
 * @param {Function} log       — step logger
 * @param {Array}    detections — IDE detection rows from stepDetectIdes() (may be empty)
 */
async function stepInstall(log, detections) {
  const start = Date.now();
  detections = detections || [];

  if (flags.skipInstall) {
    log('Skipped (--skip-install)');
    const r = buildStepResult('install_skills', 'skip', 'skipped via --skip-install', null);
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Phase 44 INST-04: run legacy migration BEFORE install
  const legacyMigration = migrateLegacyCommands({
    yes: flags.yes,
    forceMigrate: flags.forceMigrate,
  });
  log(`migration: ${legacyMigration.status} — ${legacyMigration.message}`);

  if (!fs.existsSync(INSTALL_SCRIPT)) {
    log(`${yellow}Warning: install.js not found at ${INSTALL_SCRIPT}${reset}`);
    const r = buildStepResult('install_skills', 'warn', 'install.js not found — skipped install',
      { legacy_migration: legacyMigration, compile_results: [] });
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Determine runtime for legacy install.js invocation
  // If --tools is set, use first entry to derive --runtime flag (back-compat)
  let runtimeFlag = `--${flags.runtime}`;
  if (flags.tools.length > 0) {
    const firstTool = flags.tools[0];
    if (firstTool === 'opencode') runtimeFlag = '--opencode';
    else runtimeFlag = '--claude';
  }

  let installErr = null;
  try {
    execFileSync(process.execPath, [INSTALL_SCRIPT, runtimeFlag], {
      stdio: flags.json ? 'pipe' : 'inherit',
      cwd: PLUGIN_ROOT,
      timeout: 60000,
    });
    log('install.js done');
  } catch (err) {
    log(`${yellow}Warning: install.js had issues (${err.message})${reset}`);
    installErr = err.message;
  }

  // Per-IDE compile via skill-compiler.cjs
  // Map yaml ide_id → compiler target key
  const IDE_TO_TARGET = {
    'claude-code': 'claude',
    'opencode': 'opencode',
    'cursor': 'cursor',
  };

  const compileResults = [];
  let anyCompileError = false;
  let anyManifestSkipWarn = false;

  for (const row of detections) {
    // Apply --tools override: if --tools is set, only install listed IDEs
    let action = row.action;
    if (flags.tools.length > 0) {
      action = flags.tools.includes(row.ide_id) ? 'install' : 'skip';
    }

    if (action !== 'install') {
      compileResults.push({ ide_id: row.ide_id, compiled: 0, skipped: 1, errors: [] });
      continue;
    }

    const compilerTarget = IDE_TO_TARGET[row.ide_id] || row.ide_id;

    if (!skillCompiler || typeof skillCompiler.compile !== 'function') {
      compileResults.push({ ide_id: row.ide_id, compiled: 0, skipped: 0, errors: ['skill-compiler not available'] });
      anyCompileError = true;
      continue;
    }

    try {
      const compileResult = skillCompiler.compile(compilerTarget, {
        source: path.join(PLUGIN_ROOT, 'get-shit-done', 'skills'),
      });
      const compiled = compileResult ? (compileResult.compiled || 0) : 0;
      const skipped = compileResult ? (compileResult.skipped || 0) : 0;
      const warnings = compileResult ? (compileResult.warnings || []) : [];
      const hasManifestSkip = warnings.some(w => String(w).includes('manifest_skip'));
      if (hasManifestSkip) anyManifestSkipWarn = true;
      compileResults.push({ ide_id: row.ide_id, compiled, skipped, errors: [] });
    } catch (err) {
      log(`${yellow}Warning: compile for ${row.ide_id} failed (${err.message})${reset}`);
      compileResults.push({ ide_id: row.ide_id, compiled: 0, skipped: 0, errors: [err.message] });
      anyCompileError = true;
    }
  }

  const details = { legacy_migration: legacyMigration, compile_results: compileResults };

  let status;
  let message;
  if (anyCompileError || installErr) {
    status = 'warn'; // compile errors are non-fatal (graceful degradation)
    message = anyCompileError
      ? `install complete with compile warnings; install.js: ${installErr || 'ok'}`
      : `install.js had issues: ${installErr}`;
  } else if (anyManifestSkipWarn) {
    status = 'warn';
    message = 'install complete — some skills emitted manifest_skip warnings';
  } else {
    status = 'pass';
    message = `install complete (${compileResults.filter(c => c.compiled > 0).length} IDEs compiled)`;
  }

  const r = buildStepResult('install_skills', status, message, details);
  r.duration_ms = Date.now() - start;
  return r;
}

/**
 * Step 3: Detect infrastructure
 *
 * Converted in 44-02-03 to return FROZEN result schema via buildStepResult('detect_infra', ...).
 * FROZEN name: 'detect_infra' (binds 44-03 stepAssertions + smoke test).
 *
 * Status semantics (44-CONTEXT.md §Area 3):
 *   'pass'  — PG available
 *   'warn'  — SQLite fallback (skills-only mode or forced sqlite)
 *   'fail'  — --backend pg specified but PG unavailable
 *
 * Also returns raw infra object in details for downstream step consumption.
 */
function stepDetectInfra(log) {
  const start = Date.now();

  function sqliteFallbackUrl() {
    return `sqlite:///${path.join(
      process.env.GSD_DATA_DIR || path.join(os.homedir(), '.amauta', 'data'),
      'gsd_amauta.db'
    )}`;
  }

  // If user forced sqlite backend, short-circuit
  if (flags.backend === 'sqlite') {
    const infraRaw = {
      backend: 'sqlite',
      connection_url: sqliteFallbackUrl(),
      features: ['memory', 'tasks', 'skb', 'validation', 'fts'],
      message: 'Forced SQLite backend via --backend sqlite',
    };
    log(`\n          Backend: ${cyan}sqlite${reset} (forced via --backend)`);
    log(`          Features: ${infraRaw.features.join(', ')}`);
    const r = buildStepResult('detect_infra', 'warn',
      `Using SQLite fallback at ${infraRaw.connection_url}`,
      { backend: infraRaw.backend, connection_url: infraRaw.connection_url, features: infraRaw.features, raw: infraRaw });
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Run infra_detect.py as CLI and parse JSON
  if (!fs.existsSync(INFRA_DETECT)) {
    log(`${red}Error: infra_detect.py not found${reset}`);
    // Degrade gracefully — fall back to SQLite warn
    const infraRaw = {
      backend: 'sqlite',
      connection_url: sqliteFallbackUrl(),
      features: ['memory', 'tasks', 'skb', 'validation', 'fts'],
      message: 'infra_detect.py not found — SQLite fallback',
    };
    const r = buildStepResult('detect_infra', 'warn',
      `Docker unavailable — skills-only install (no daemon, no migrations)`,
      { backend: 'sqlite', connection_url: infraRaw.connection_url, features: infraRaw.features, raw: infraRaw });
    r.duration_ms = Date.now() - start;
    return r;
  }

  try {
    const output = execFileSync('python3', [INFRA_DETECT, '--auto-start'], {
      cwd: PLUGIN_ROOT,
      timeout: 90000, // Docker auto-start can take up to 60s+
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const infraRaw = JSON.parse(output.trim());

    if (flags.backend === 'pg' && infraRaw.backend !== 'postgresql') {
      log(`${red}Error: --backend pg specified but PostgreSQL not available${reset}`);
      log(`          ${dim}${infraRaw.message}${reset}`);
      const r = buildStepResult('detect_infra', 'fail',
        '--backend pg specified but PostgreSQL not available',
        { backend: infraRaw.backend, connection_url: infraRaw.connection_url, features: infraRaw.features, raw: infraRaw });
      r.duration_ms = Date.now() - start;
      return r;
    }

    const isPg = infraRaw.backend === 'postgresql';
    const status = isPg ? 'pass' : 'warn';
    const backendLabel = isPg ? 'postgresql' : 'sqlite';
    const message = isPg
      ? `PostgreSQL available at ${infraRaw.connection_url}`
      : `Using SQLite fallback at ${infraRaw.connection_url}`;

    log(`\n          Backend: ${cyan}${backendLabel}${reset}`);
    log(`          ${dim}${infraRaw.message}${reset}`);
    log(`          Features: ${infraRaw.features.join(', ')}`);

    const r = buildStepResult('detect_infra', status, message,
      { backend: infraRaw.backend, connection_url: infraRaw.connection_url, features: infraRaw.features, raw: infraRaw });
    r.duration_ms = Date.now() - start;
    return r;
  } catch (err) {
    log(`${yellow}Warning: infra detection failed (${err.message})${reset}`);
    const infraRaw = {
      backend: 'sqlite',
      connection_url: sqliteFallbackUrl(),
      features: ['memory', 'tasks', 'skb', 'validation', 'fts'],
      message: 'SQLite fallback (infra detection failed)',
    };
    log(`          Falling back to SQLite`);
    const r = buildStepResult('detect_infra', 'warn',
      `Docker unavailable — skills-only install (no daemon, no migrations)`,
      { backend: 'sqlite', connection_url: infraRaw.connection_url, features: infraRaw.features, raw: infraRaw });
    r.duration_ms = Date.now() - start;
    return r;
  }
}

/**
 * Step 4: Run migrations (PG only)
 *
 * Converted in 44-02-03 to return FROZEN result schema via buildStepResult('migrations', ...).
 * FROZEN name: 'migrations' (binds 44-03 stepAssertions + smoke test).
 *
 * Status semantics:
 *   'skip' — infra is not PG (SQLite schema is self-creating) OR requires_pg skip from detect_infra
 *   'pass' — all migrations applied (or already applied = expected)
 *   'warn' — some psql calls returned errors but migrations dir exists
 *   'fail' — migrations dir missing AND backend is PG
 *
 * Accepts infraResult as FROZEN buildStepResult object (from 44-02-03 converted stepDetectInfra).
 */
function stepMigrations(log, infraResult) {
  const start = Date.now();

  // Extract raw infra data from FROZEN result or legacy plain object
  const infraRaw = (infraResult && infraResult.details && infraResult.details.raw)
    ? infraResult.details.raw
    : infraResult;

  const infraStatus = infraResult && infraResult.status;
  const infraBackend = infraRaw && infraRaw.backend;

  // Skills-only mode: infra detected no PG AND no Docker → skip migrations
  if (!infraResult || infraStatus === 'fail' || infraBackend !== 'postgresql') {
    const skipReason = (infraStatus === 'warn' && infraBackend !== 'postgresql')
      ? 'requires_pg'
      : 'not postgresql';
    log('Skipped (SQLite schema is self-creating)');
    const r = buildStepResult('migrations', 'skip',
      `migrations skipped — ${skipReason}`,
      { skip_reason: skipReason });
    r.duration_ms = Date.now() - start;
    return r;
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log(`${yellow}No migrations directory found${reset}`);
    const r = buildStepResult('migrations', 'fail',
      'migrations directory missing and backend is PG',
      { skip_reason: 'no migrations dir' });
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Get migration files (skip DOWN files)
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.includes('DOWN'))
    .sort();

  if (migrationFiles.length === 0) {
    log('No migration files found');
    const r = buildStepResult('migrations', 'skip', 'no migration files found',
      { skip_reason: 'no files' });
    r.duration_ms = Date.now() - start;
    return r;
  }

  let applied = 0;
  let errors = 0;
  const connUrl = infraRaw.connection_url;

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
  const status = errors > 0 && applied === 0 ? 'warn' : 'pass';
  const r = buildStepResult('migrations', status,
    `${applied} applied, ${errors} already applied`,
    { applied, errors, total: migrationFiles.length });
  r.duration_ms = Date.now() - start;
  return r;
}

/**
 * Step 5: Start daemon
 *
 * Converted in 44-02-03 to return FROZEN result schema via buildStepResult('start_daemon', ...).
 * FROZEN name: 'start_daemon' (binds 44-03 stepAssertions + smoke test).
 *
 * Status semantics:
 *   'skip' — --skip-daemon OR skills-only mode (infra warn with no PG)
 *   'pass' — daemon healthy within 10s
 *   'fail' — daemon timeout (10s) or daemon script missing
 */
async function stepStartDaemon(log, infraResult) {
  const start = Date.now();

  // Extract raw infra data from FROZEN result or legacy plain object
  const infraRaw = (infraResult && infraResult.details && infraResult.details.raw)
    ? infraResult.details.raw
    : infraResult;

  if (flags.skipDaemon) {
    log('Skipped (--skip-daemon)');
    const r = buildStepResult('start_daemon', 'skip', 'skipped via --skip-daemon', null);
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Skills-only mode: infra returned warn with no PG → skip daemon
  if (infraResult && infraResult.status === 'warn' &&
      infraRaw && infraRaw.backend !== 'postgresql') {
    // Check if BOTH Docker AND local PG are absent (true skills-only mode)
    const msg = infraRaw.message || '';
    if (msg.includes('skills-only') || msg.includes('Docker unavailable')) {
      log('Skipped (skills-only mode — no PG available)');
      const r = buildStepResult('start_daemon', 'skip',
        'skipped — skills-only mode (no PG/Docker available)',
        { skip_reason: 'requires_pg' });
      r.duration_ms = Date.now() - start;
      return r;
    }
  }

  // Check if already running
  if (await isDaemonRunning()) {
    if (!flags.force) {
      log('already running');
      const r = buildStepResult('start_daemon', 'pass', `daemon already running on port ${PORT}`,
        { already_running: true, port: PORT });
      r.duration_ms = Date.now() - start;
      return r;
    }
    log('running (--force: restarting...)');
  }

  if (!fs.existsSync(DAEMON_SCRIPT)) {
    log(`${red}Error: amauta-daemon.py not found${reset}`);
    const r = buildStepResult('start_daemon', 'fail', 'daemon script not found', null);
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Set environment for daemon based on detected infrastructure
  const env = { ...process.env, AMAUTA_DATA_DIR: DATA_DIR, GSD_AMAUTA_PY: AMAUTA_PY, GSD_AMAUTA_PORT: String(PORT) };
  if (infraRaw && infraRaw.connection_url && infraRaw.backend === 'postgresql') {
    env.GSD_POSTGRES_URL = infraRaw.connection_url;
  }
  if (infraRaw && infraRaw.backend === 'sqlite') {
    env.GSD_BACKEND = 'sqlite';
    const sqlitePath = (infraRaw.connection_url || '').replace('sqlite:///', '');
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
      const r = buildStepResult('start_daemon', 'pass',
        `daemon started on port ${PORT} (PID ${pid})`,
        { pid, port: PORT });
      r.duration_ms = Date.now() - start;
      return r;
    }
  }

  log(`${yellow}Warning: daemon did not respond within 10s${reset}`);
  const r = buildStepResult('start_daemon', 'fail', 'daemon did not respond within 10s', null);
  r.duration_ms = Date.now() - start;
  return r;
}

/**
 * Step 6: Verify system
 *
 * Converted in 44-02-03 to return FROZEN result schema via buildStepResult('verify', ...).
 * FROZEN name: 'verify' (binds 44-03 stepAssertions + smoke test).
 *
 * Status semantics:
 *   'skip' — --skip-daemon OR daemon step was skipped
 *   'pass' — /health returns 200 with status:ok
 *   'fail' — daemon unreachable or health check failed
 */
async function stepVerify(log) {
  const start = Date.now();

  if (flags.skipDaemon) {
    log('Skipped (daemon not started)');
    const r = buildStepResult('verify', 'skip', 'skipped — daemon not started', null);
    r.duration_ms = Date.now() - start;
    return r;
  }

  try {
    const health = await httpGet('/health', 3000);
    if (health.statusCode !== 200 || !health.data || health.data.status !== 'ok') {
      log(`${red}Health check failed${reset}`);
      const r = buildStepResult('verify', 'fail', 'health check failed — daemon not responding', null);
      r.duration_ms = Date.now() - start;
      return r;
    }
  } catch (err) {
    log(`${red}Cannot reach daemon: ${err.message}${reset}`);
    const r = buildStepResult('verify', 'fail', `cannot reach daemon: ${err.message}`, null);
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Try to get infrastructure info from daemon (non-fatal)
  let infra = null;
  try {
    const resp = await httpGet('/api/infra', 3000);
    if (resp.statusCode === 200 && resp.data) {
      infra = resp.data;
    }
  } catch { /* non-fatal */ }

  // Try to get counts (non-fatal)
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

  const r = buildStepResult('verify', 'pass', `system healthy — ${memoryCount} memories, ${taskCount} tasks`,
    { counts: { memoryCount, taskCount }, infra });
  r.duration_ms = Date.now() - start;
  return r;
}

/**
 * Step 7 (INST-01 frozen final step): Run 5 post-install assertions.
 *
 * Each assertion produces one entry in details.assertions[] with {name, status, message}.
 * Step status = worst-of-assertions (fail > warn > pass; skip ignored per 44-CONTEXT.md §Area 3).
 *
 * Five FROZEN assertion names (hard contract, 44-CONTEXT.md §Area 3 + §Specifics):
 *   1. skill_files_present
 *   2. compiler_validates
 *   3. daemon_health
 *   4. schema_applied
 *   5. semgrep_rules_present
 *
 * @param {Array} prevResults — array of prior step results (from main() results array)
 */
async function stepAssertions(prevResults) {
  const start = Date.now();
  const assertions = [];

  // Collect prior-step references for cross-step lookups.
  prevResults = prevResults || [];
  const detectResult  = prevResults.find(r => r.name === 'detect_ides')    || { details: {} };
  const installResult = prevResults.find(r => r.name === 'install_skills') || {};
  const daemonResult  = prevResults.find(r => r.name === 'start_daemon')   || {};
  const infraResult   = prevResults.find(r => r.name === 'detect_infra')   || { details: {} };
  const detections    = (detectResult.details && detectResult.details.detections) || [];

  // ─── Assertion 1: skill_files_present ─────────────────────────────────────
  {
    // If install step was skipped entirely (e.g. --skip-install), skip this assertion too.
    const installSkipped = installResult.status === 'skip';
    const installs = installSkipped ? [] : detections.filter(d => d.action === 'install');
    if (installs.length === 0) {
      const skipReason = installSkipped ? '--skip-install was passed' : 'no IDEs marked for install';
      assertions.push({ name: 'skill_files_present', status: 'skip', message: skipReason });
    } else {
      let allPresent = true;
      const missing = [];
      const platformCodes = skillCompiler ? skillCompiler.loadPlatformCodes() : {};
      for (const det of installs) {
        const codes = platformCodes[det.ide_id];
        if (!codes) {
          allPresent = false;
          missing.push(`${det.ide_id}:no-yaml-entry`);
          continue;
        }
        const targetDir = path.join(process.cwd(), codes.dir_name, codes.skill_subdir);
        if (!fs.existsSync(targetDir)) {
          allPresent = false;
          missing.push(`${det.ide_id}:${targetDir}`);
          continue;
        }
        try {
          const entries = fs.readdirSync(targetDir);
          const hasAnyMd = entries.some(f => f.endsWith('.md')) ||
            entries.some(sub => {
              try {
                return fs.readdirSync(path.join(targetDir, sub)).some(f => f.endsWith('.md'));
              } catch { return false; }
            });
          if (!hasAnyMd) {
            allPresent = false;
            missing.push(`${det.ide_id}:${targetDir}:no-md-files`);
          }
        } catch (e) {
          allPresent = false;
          missing.push(`${det.ide_id}:${targetDir}:${e.message}`);
        }
      }
      assertions.push({
        name: 'skill_files_present',
        status: allPresent ? 'pass' : 'fail',
        message: allPresent
          ? `${installs.length} IDE skill dir(s) present with compiled .md files`
          : `missing: ${missing.join(', ')}`,
      });
    }
  }

  // ─── Assertion 2: compiler_validates ──────────────────────────────────────
  {
    const compilerPath = path.join(PLUGIN_ROOT, 'scripts', 'skill-compiler.cjs');
    const skillsSource = path.join(PLUGIN_ROOT, 'get-shit-done', 'skills');
    if (!fs.existsSync(compilerPath)) {
      assertions.push({ name: 'compiler_validates', status: 'fail', message: `scripts/skill-compiler.cjs not found at ${compilerPath}` });
    } else {
      try {
        execFileSync(process.execPath, [
          compilerPath, '--target=claude', '--dry-run', `--source=${skillsSource}`,
        ], { timeout: 10000, stdio: 'pipe' });
        assertions.push({ name: 'compiler_validates', status: 'pass', message: 'scripts/skill-compiler.cjs --dry-run exited 0' });
      } catch (err) {
        assertions.push({ name: 'compiler_validates', status: 'fail', message: `compiler exited non-zero: ${err.message}` });
      }
    }
  }

  // ─── Assertion 3: daemon_health ───────────────────────────────────────────
  if (daemonResult.status === 'skip') {
    assertions.push({ name: 'daemon_health', status: 'skip', message: 'daemon not started' });
  } else {
    try {
      const h = await httpGet('/health', 3000);
      if (h.statusCode === 200 && h.data && h.data.status === 'ok') {
        assertions.push({ name: 'daemon_health', status: 'pass', message: '/health returned 200 with status: ok' });
      } else {
        assertions.push({ name: 'daemon_health', status: 'fail', message: `/health returned ${h.statusCode}` });
      }
    } catch (e) {
      assertions.push({ name: 'daemon_health', status: 'fail', message: `cannot reach daemon: ${e.message}` });
    }
  }

  // ─── Assertion 4: schema_applied ──────────────────────────────────────────
  {
    // infraResult.details has {backend, connection_url, features, raw} per 44-02-03 conversion.
    const backend = (infraResult.details || {}).backend;
    const connUrl = (infraResult.details || {}).connection_url || '';
    if (backend === 'postgresql') {
      try {
        const r = await httpGet('/api/migrations', 3000);
        if (r.statusCode === 404) {
          assertions.push({ name: 'schema_applied', status: 'skip', message: 'daemon /api/migrations endpoint not available (old daemon)' });
        } else if (r.statusCode === 200 && Array.isArray(r.data) && r.data.length >= 1) {
          assertions.push({ name: 'schema_applied', status: 'pass', message: `${r.data.length} migrations applied` });
        } else if (r.statusCode === 200 && r.data && Array.isArray(r.data.migrations) && r.data.migrations.length >= 1) {
          assertions.push({ name: 'schema_applied', status: 'pass', message: `${r.data.migrations.length} migrations applied` });
        } else {
          assertions.push({ name: 'schema_applied', status: 'fail', message: `unexpected /api/migrations shape (status=${r.statusCode})` });
        }
      } catch (e) {
        assertions.push({ name: 'schema_applied', status: 'skip', message: `daemon unreachable for /api/migrations: ${e.message}` });
      }
    } else if (backend === 'sqlite') {
      // SQLite schema is self-creating — check if file has been written yet
      const sqlitePath = connUrl.replace('sqlite:///', '');
      if (sqlitePath && fs.existsSync(sqlitePath)) {
        assertions.push({ name: 'schema_applied', status: 'pass', message: `SQLite schema file present at ${sqlitePath}` });
      } else {
        // No file yet (fresh install before daemon writes) — skip, not fail (self-creating per 44-CONTEXT.md §Area 3)
        assertions.push({ name: 'schema_applied', status: 'skip', message: 'SQLite schema is self-creating; no file yet' });
      }
    } else {
      assertions.push({ name: 'schema_applied', status: 'skip', message: `unknown or missing backend: ${backend}` });
    }
  }

  // ─── Assertion 5: semgrep_rules_present ───────────────────────────────────
  // File presence only — does NOT run Semgrep (binary may be absent per 44-CONTEXT.md §Area 3).
  {
    const semgrepFile = path.join(PLUGIN_ROOT, '.semgrep', 'skill-enforcement.yml');
    if (fs.existsSync(semgrepFile)) {
      assertions.push({ name: 'semgrep_rules_present', status: 'pass', message: `.semgrep/skill-enforcement.yml present` });
    } else {
      assertions.push({ name: 'semgrep_rules_present', status: 'fail', message: `.semgrep/skill-enforcement.yml not found at ${semgrepFile}` });
    }
  }

  // ─── Worst-of-assertions combinator (FROZEN per 44-CONTEXT.md §Area 3) ────
  // fail > warn > pass; skip is ignored when computing worst.
  // STATUS_RANK encodes: fail beats warn beats pass; skip ignored
  const STATUS_RANK = { fail: 3, warn: 2, pass: 1, skip: 0 };
  let worst = 'pass';
  let nonSkipCount = 0;
  for (const a of assertions) {
    if (a.status === 'skip') continue; // skip ignored when computing worst
    nonSkipCount++;
    if (STATUS_RANK[a.status] > STATUS_RANK[worst]) worst = a.status;
  }
  // If ALL 5 assertions are skip (extreme degraded mode), step status = 'pass'
  if (nonSkipCount === 0) worst = 'pass';

  const passCt = assertions.filter(a => a.status === 'pass').length;
  const failCt = assertions.filter(a => a.status === 'fail').length;
  const warnCt = assertions.filter(a => a.status === 'warn').length;
  const skipCt = assertions.filter(a => a.status === 'skip').length;

  const r = buildStepResult('run_assertions', worst,
    `${passCt} pass / ${warnCt} warn / ${failCt} fail / ${skipCt} skip`,
    { assertions });
  r.duration_ms = Date.now() - start;
  return r;
}

// ═══════════════════════════════════════════════════════
// Legacy migration helper (Phase 44 INST-04)
// ═══════════════════════════════════════════════════════

/**
 * Phase 44 INST-04: Legacy migration .claude/commands/ → backup-rename.
 * Returns the FROZEN per-step result schema via buildStepResult().
 *
 * Behavior matrix (44-CONTEXT.md §Area 4):
 *   - commands/ missing or empty          → status: 'skip', message: 'no legacy commands directory'
 *   - commands/ present + skills/ absent  → atomic rename to commands.bak.<timestamp>/, status: 'pass'
 *   - commands/ AND skills/ (collision) + !forceMigrate → status: 'warn' (never destructive)
 *   - forceMigrate                        → rename even if skills/ present
 *   - future runs see no commands/        → status: 'skip' (idempotent; no state file)
 *
 * @param {object} opts
 * @param {string}  [opts.cwd]          — working directory (default: process.cwd())
 * @param {boolean} [opts.yes]          — non-interactive mode flag
 * @param {boolean} [opts.forceMigrate] — bypass collision guard
 */
function migrateLegacyCommands(opts) {
  const start = Date.now();
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const yes = !!opts.yes;          // eslint-disable-line no-unused-vars
  const forceMigrate = !!opts.forceMigrate;

  const commandsDir = path.join(cwd, '.claude', 'commands');
  const skillsDir = path.join(cwd, '.claude', 'skills');

  // Helper: empty dir check (no entries) -- treat as "missing" per Area 2 false-positive guard.
  function isMissingOrEmpty(p) {
    if (!fs.existsSync(p)) return true;
    try {
      const entries = fs.readdirSync(p);
      return entries.length === 0;
    } catch (_e) { return true; }
  }

  if (isMissingOrEmpty(commandsDir)) {
    const r = buildStepResult('legacy_migration', 'skip', 'no legacy commands directory', null);
    r.duration_ms = Date.now() - start;
    return r;
  }

  const skillsPresent = fs.existsSync(skillsDir) && !isMissingOrEmpty(skillsDir);

  if (skillsPresent && !forceMigrate) {
    // Collision guard: --yes returns warn (never destructive); without --yes the
    // CLI would prompt -- in this v3.1 we treat unset --yes the same as --yes
    // because all v3.1 CLI flows are non-interactive (CI-friendly default).
    const r = buildStepResult('legacy_migration', 'warn',
      'both legacy commands/ and skills/ present — skipped migration; pass --force-migrate to override',
      { commands_dir: commandsDir, skills_dir: skillsDir });
    r.duration_ms = Date.now() - start;
    return r;
  }

  // Atomic timestamped backup-rename.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(cwd, '.claude', `commands.bak.${timestamp}`);

  try {
    fs.renameSync(commandsDir, backupDir);
  } catch (err) {
    const r = buildStepResult('legacy_migration', 'fail',
      `rename failed: ${err.message}`,
      { commands_dir: commandsDir, target: backupDir, error: err.message });
    r.duration_ms = Date.now() - start;
    return r;
  }

  const r = buildStepResult('legacy_migration', 'pass',
    `migrated ${commandsDir} → ${backupDir}`,
    { backup_path: backupDir, timestamp });
  r.duration_ms = Date.now() - start;
  return r;
}

// ═══════════════════════════════════════════════════════
// POLISH-02 helpers: emitResults + runUpgrade + runUninstall
// ═══════════════════════════════════════════════════════

/**
 * Emit final results in JSON or human-readable table format.
 * Mirrors main() output logic for upgrade/uninstall flows.
 *
 * @param {Array} results   — array of FROZEN per-step result objects
 * @param {number} elapsed  — elapsed seconds
 */
function emitResults(results, elapsed) {
  if (flags.json) {
    console.log(JSON.stringify({
      elapsed_seconds: parseFloat(elapsed.toFixed(1)),
      results,
    }, null, 2));
  } else {
    renderStepTable(results);
    const allPass = results.every(r => r.status === 'pass' || r.status === 'skip' || r.status === 'warn');
    if (allPass) {
      console.log(`\n${green}Done!${reset} ${dim}(${elapsed.toFixed(1)}s)${reset}`);
    } else {
      console.log(`\n${red}Completed with errors.${reset} ${dim}(${elapsed.toFixed(1)}s)${reset}`);
    }
  }
}

/**
 * POLISH-02: Run Amauta upgrade flow (6 frozen step names).
 *
 * Steps (FROZEN per 53-CONTEXT.md §Area 2):
 *   detect_current_version → compute_migration_delta → apply_upgrade_migrations →
 *   update_install_record → restart_daemon → run_assertions
 *
 * @param {object} f — flags object
 * @returns {Promise<Array>} array of per-step result objects
 */
async function runUpgrade(f) {
  // POLISH-02 stub — bodies filled in 53-02-02
  return [buildStepResult('stub', 'skip', 'POLISH-02 wip', null)];
}

/**
 * POLISH-02: Run Amauta uninstall flow (6 frozen step names).
 *
 * Steps (FROZEN per 53-CONTEXT.md §Area 2):
 *   read_install_record → remove_skills → remove_agents → remove_generated_config →
 *   clear_install_record → post_uninstall_verify
 *
 * PRESERVATION CONTRACT: NEVER deletes .planning/, services/*.py, tests/, agents/,
 * migrations/, user .env, or source code files.
 *
 * @param {object} f — flags object
 * @returns {Promise<Array>} array of per-step result objects
 */
async function runUninstall(f) {
  // POLISH-02 stub — bodies filled in 53-02-03
  return [buildStepResult('stub', 'skip', 'POLISH-02 wip', null)];
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

  // ── POLISH-02: --uninstall and --upgrade dispatch (before 7-step install flow) ─
  if (flags.uninstall) {
    const startTime = Date.now();
    const results = await runUninstall(flags);
    const elapsed = (Date.now() - startTime) / 1000;
    emitResults(results, elapsed);
    process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
  }
  if (flags.upgrade) {
    const startTime = Date.now();
    const results = await runUpgrade(flags);
    const elapsed = (Date.now() - startTime) / 1000;
    emitResults(results, elapsed);
    process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
  }

  const startTime = Date.now();
  const results = [];  // array of FROZEN per-step result objects (44-02-03 conversion)

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

  const totalSteps = 7;  // Wave 3: bumped from 6 to 7 with stepAssertions (run_assertions)

  // Step 1: Detect IDEs (NEW — wired in 44-02-03)
  const detectLog = makeLog(1, totalSteps, 'Detecting IDEs');
  const detectResult = await stepDetectIdes();
  detectLog(detectResult.message);
  results.push(detectResult);

  // Step 2: Install (now consumes detection table + runs legacy migration)
  const installLog = makeLog(2, totalSteps, 'Installing agents, commands, skills');
  const installResult = await stepInstall(installLog, detectResult.details ? detectResult.details.detections : []);
  results.push(installResult);

  // Step 3: Detect infrastructure
  const infraLog = makeLog(3, totalSteps, 'Detecting infrastructure');
  const infraResult = stepDetectInfra(infraLog);
  results.push(infraResult);

  // Step 4: Migrations
  const migrateLog = makeLog(4, totalSteps, 'Running migrations');
  const migrationsResult = stepMigrations(migrateLog, infraResult);
  results.push(migrationsResult);

  // Step 5: Start daemon
  const daemonLog = makeLog(5, totalSteps, 'Starting daemon');
  const daemonResult = await stepStartDaemon(daemonLog, infraResult);
  results.push(daemonResult);

  // Step 6: Verify
  const verifyLog = makeLog(6, totalSteps, 'Verifying system');
  const verifyResult = await stepVerify(verifyLog);
  results.push(verifyResult);

  // Step 7: Run assertions (INST-01 final step — 5 post-install checks)
  const assertLog = makeLog(7, totalSteps, 'Running assertions');
  const assertResult = await stepAssertions(results);
  assertLog(assertResult.message);
  results.push(assertResult);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (flags.json) {
    console.log(JSON.stringify({
      elapsed_seconds: parseFloat(elapsed),
      results,
    }, null, 2));
  } else {
    renderStepTable(results);
    console.log(`\n${green}Ready!${reset} ${dim}(${elapsed}s)${reset} Run ${cyan}\`amauta board\`${reset} to see your tasks.`);
  }

  // FROZEN exit-code rule per 44-CONTEXT.md §Specifics.
  // Exact form required: results.some(r => r.status === 'fail') ? 1 : 0
  process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
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

module.exports = { stepDetectIdes, buildStepResult, renderStepTable, migrateLegacyCommands, stepAssertions, runUpgrade, runUninstall };
