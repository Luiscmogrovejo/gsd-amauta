#!/usr/bin/env node

/**
 * gsd-amauta init — Single-command setup for GSD-Amauta.
 *
 * Orchestrates:
 *   1. Install agents, commands, skills to ~/.claude/
 *   2. Detect infrastructure (PG local, Docker PG, SQLite fallback)
 *   3. Run database migrations (PG only)
 *   4. Start the amauta daemon
 *   5. Verify the system is operational
 *
 * Usage:
 *   npx gsd-amauta init [options]
 *   node bin/init.cjs [options]
 *
 * Options:
 *   --skip-install    Skip agent/command/skill installation
 *   --skip-daemon     Skip daemon startup
 *   --backend <type>  Force backend: pg, sqlite, auto (default: auto)
 *   --force           Force re-detection even if daemon is running
 *   --json            Output results as JSON
 */

'use strict';

const { execFileSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

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
  backend: 'auto',
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
// Step functions
// ═══════════════════════════════════════════════════════

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
    execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude'], {
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

main().catch((err) => {
  console.error(`${red}Fatal error: ${err.message}${reset}`);
  process.exit(1);
});
