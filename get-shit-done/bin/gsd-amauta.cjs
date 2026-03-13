#!/usr/bin/env node

/**
 * GSD-Amauta CLI — Node.js wrapper for the Amauta task management daemon.
 *
 * Communicates with amauta-daemon.py on localhost:18799 via HTTP.
 * Falls back to direct `python3 amauta.py` invocation if daemon is unreachable.
 *
 * Usage: node gsd-amauta.cjs <command> [args] [--json]
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

// ═══════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════

const HOST = process.env.GSD_AMAUTA_HOST || '127.0.0.1';
const PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const AMAUTA_PY = process.env.GSD_AMAUTA_PY || path.join(PLUGIN_ROOT, 'amauta.py');
const DATA_DIR = process.env.AMAUTA_DATA_DIR || path.join(PLUGIN_ROOT, 'data');
const DAEMON_SCRIPT = path.join(PLUGIN_ROOT, 'services', 'amauta-daemon.py');

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
 * @returns {Promise<boolean>}
 */
async function ensureDaemon() {
  if (await isDaemonRunning()) return true;

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
      if (key === 'force') { flags.force = true; continue; }
      if (key === 'json') { flags.json_output = true; continue; }
      if (key === 'append') { flags.append = true; continue; }
      // Key-value flags
      const nextVal = args[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
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

async function cmdRpetd(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta rpetd <id> --phase P --content "..."');
  if (!flags.phase) die('--phase is required (R, P, E, T, or D)');
  if (!flags.content) die('--content is required');
  const body = { id, ...flags };

  let exitCode = 0;
  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/rpetd', body);
    printResponse(data, jsonMode);
    exitCode = data.exit_code || 0;
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
    const phaseText = `[${phase}] ${taskId}: ${content.substring(0, 500)}`;
    const phaseBody = {
      text: phaseText,
      source: 'rpetd_phase',
      agent_id: agent,
      metadata: JSON.stringify({ task_id: taskId, phase, timestamp: new Date().toISOString() }),
    };

    if (useDaemon) {
      await httpRequest('POST', '/api/memory/store', phaseBody).catch(() => {});
    }
    // In direct mode, skip memory auto-store (requires daemon for PG)

    // TK-0052: Extract LEARNING from D-phase and store with higher boost
    if (phase === 'D') {
      const learningMatch = content.match(/LEARNING[:\s]+(.+?)(?:\n|$)/i);
      if (learningMatch) {
        const learning = learningMatch[1].trim();
        const learnBody = {
          text: `${taskId} — ${learning}`,
          source: 'auto_learning',
          agent_id: agent,
          tags: taskId,
          metadata: JSON.stringify({ task_id: taskId, extracted_from: 'D-phase', timestamp: new Date().toISOString() }),
        };

        if (useDaemon) {
          await httpRequest('POST', '/api/memory/store', learnBody).catch(() => {});
        }
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
const NON_CODE_TYPES = new Set(['epic', 'story']); // These are exempt from branch gate and test gate

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
  try {
    if (useDaemon) {
      // Use daemon exec route with --json — always reads from PG, correct path
      const { data } = await httpRequest('POST', '/api/exec', { args: ['show', id, '--json'] });
      const jsonStr = data.output || '';
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        taskType = parsed.type || 'task';
        phases = parsed.rpetd_phases || {};
      }
    } else {
      // No daemon — call Python directly via runDirect
      const jsonResult = runDirect(['show', id, '--json']);
      const jsonStr = jsonResult.stdout || jsonResult.output || '';
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        taskType = parsed.type || 'task';
        phases = parsed.rpetd_phases || {};
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
        taskData = result.stdout || result.output || '';
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

  // Gate 1: Branch evidence in E-phase
  if (isCodeTask) {
    const eContent = (phases.E || '').trim();
    if (eContent) {
      if (!BRANCH_PATTERNS.test(eContent)) {
        const hasBranchEvidence = /branch|git checkout|git switch|merged|PR |pull request/i.test(eContent);
        if (!hasBranchEvidence) {
          gateFailures.push('BRANCH_EVIDENCE: E-phase has no branch name evidence (feat/*, fix/*, etc). Code tasks must show branch work.');
        }
      }
    }
  }

  // Gate 2: LEARNING block in D-phase
  const dContent = (phases.D || '').trim();
  if (dContent && !LEARNING_PATTERN.test(dContent)) {
    gateFailures.push('LEARNING_BLOCK: D-phase has no LEARNING: block. Document what was learned.');
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

  return gateFailures;
}

async function cmdValidate(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta validate <id> --pass/--fail [--validator V] [--notes N] [--force]');
  if (flags.pass_result === undefined) die('--pass or --fail is required');

  // Check validation gates (unless --force)
  if (flags.pass_result && !flags.force) {
    const gateFailures = await checkValidationGates(useDaemon, id, flags);
    if (gateFailures.length > 0) {
      const msg = '\x1b[91mValidation gates failed:\x1b[0m\n' +
        gateFailures.map(g => '  - ' + g).join('\n') +
        '\n\nFix the issues or use --force to override.';
      if (jsonMode) {
        console.log(JSON.stringify({ error: 'Gate check failed', gates: gateFailures }));
      } else {
        console.error(msg);
      }
      return 1;
    }
  }

  const body = { id, ...flags };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/validate', body);
    printResponse(data, jsonMode);

    // TK-0031: SKB promotion on validation pass
    if (flags.pass_result && data.exit_code === 0) {
      await promoteToSKB(useDaemon, id);
    }

    return data.exit_code || 0;
  }
  const args = ['validate', id];
  if (flags.pass_result === true) args.push('--pass');
  else args.push('--fail');
  if (flags.validator) args.push('--validator', flags.validator);
  if (flags.notes) args.push('--notes', flags.notes);
  if (flags.force) args.push('--force');
  if (flags.subtasks) args.push('--subtasks', flags.subtasks);
  const result = runDirect(args);
  printResponse(result, jsonMode);

  // TK-0031: SKB promotion on validation pass (direct mode)
  if (flags.pass_result && result.exit_code === 0) {
    await promoteToSKB(useDaemon, id);
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
      const { data } = await httpRequest('GET', `/api/show/${taskId}`);
      taskOutput = data.output || '';
    } else {
      const result = runDirect(['show', taskId]);
      taskOutput = result.stdout || result.output || '';
    }

    // Extract title
    const titleMatch = taskOutput.match(/— (.+?)$/m);
    taskTitle = titleMatch ? titleMatch[1].trim() : taskId;

    // Extract LEARNING from D-phase
    const dPhaseMatch = taskOutput.match(/\[D\][^\n]*\n([\s\S]*?)(?=\n\s*\[[RPTE]\]|\n\s*Parent:|\n\s*Depends|$)/i);
    const dContent = dPhaseMatch ? dPhaseMatch[1] : '';
    const learningMatch = dContent.match(/LEARNING[:\s]+(.+?)(?:\n|$)/i);

    if (!learningMatch) return; // No learning to promote

    const learning = learningMatch[1].trim();
    if (learning.length < 10) return; // Too short to be valuable

    // Store to SKB via daemon
    if (useDaemon) {
      await httpRequest('POST', '/api/skb/store', {
        title: `Validated: ${taskTitle}`,
        content: learning,
        category: 'pattern',
        importance: 6,
        source_task: taskId,
      }).catch(() => {}); // Silent fail — SKB promotion is best-effort
    }

    // Also store as memory with best-practice source
    if (useDaemon) {
      await httpRequest('POST', '/api/memory/store', {
        text: learning,
        source: 'best-practice',
        metadata: { from_task: taskId, promoted_from: 'validation' },
      }).catch(() => {});
    }
  } catch {
    // SKB promotion is best-effort — don't fail validation
  }
}

async function cmdNote(useDaemon, id, flags, jsonMode) {
  if (!id) die('Usage: amauta note <id> --text "..." [--agent A]');
  if (!flags.text) die('--text is required');
  const body = { id, ...flags };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/note', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const args = ['note', id, '--text', flags.text];
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
  const body = { id, ...flags };

  if (useDaemon) {
    const { data } = await httpRequest('POST', '/api/assign', body);
    printResponse(data, jsonMode);
    return data.exit_code || 0;
  }
  const args = ['assign', id, '--agent', flags.agent];
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
    const { data } = await httpRequest('POST', '/api/exec', { args: ['delete', id] });
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
    const { data } = await httpRequest('POST', '/api/exec', { args: rawArgs });
    printResponse(data, jsonMode);
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
      '  \x1b[2mv1  ·  Multi-agent task management with RPETD pipeline\x1b[0m\n' +
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
      '    note <id> --text "..." [--agent A]\n' +
      '    link <id> --dep <dep-id>    Add dependency\n' +
      '    unlink <id> --dep <dep-id>  Remove dependency\n' +
      '    delete <id>\n' +
      '\n' +
      '  \x1b[33mRPETD pipeline:\x1b[0m\n' +
      '    claim <id> --agent <agent>\n' +
      '    rpetd <id> --phase <R|P|E|T|D> --content "..."\n' +
      '    validate <id> --pass|--fail --validator <agent> --notes "..."\n' +
      '                [--subtasks "Fix A|Add B"] [--force]\n' +
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
