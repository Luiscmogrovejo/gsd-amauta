#!/usr/bin/env node

/**
 * GSD Tools — CLI utility for GSD workflow operations
 *
 * Replaces repetitive inline bash patterns across ~50 GSD command/workflow/agent files.
 * Centralizes: config parsing, model resolution, phase lookup, git commits, summary verification.
 *
 * Usage: node gsd-tools.cjs <command> [args] [--raw]
 *
 * Atomic Commands:
 *   state load                         Load project config + state
 *   state json                         Output STATE.md frontmatter as JSON
 *   state update <field> <value>       Update a STATE.md field
 *   state get [section]                Get STATE.md content or section
 *   state patch --field val ...        Batch update STATE.md fields
 *   resolve-model <agent-type>         Get model for agent based on profile
 *   find-phase <phase>                 Find phase directory by number
 *   commit <message> [--files f1 f2]   Commit planning docs
 *   verify-summary <path>              Verify a SUMMARY.md file
 *   generate-slug <text>               Convert text to URL-safe slug
 *   current-timestamp [format]         Get timestamp (full|date|filename)
 *   list-todos [area]                  Count and enumerate pending todos
 *   verify-path-exists <path>          Check file/directory existence
 *   config-ensure-section              Initialize .planning/config.json
 *   history-digest                     Aggregate all SUMMARY.md data
 *   summary-extract <path> [--fields]  Extract structured data from SUMMARY.md
 *   state-snapshot                     Structured parse of STATE.md
 *   phase-plan-index <phase>           Index plans with waves and status
 *   websearch <query>                  Search web via Brave API (if configured)
 *     [--limit N] [--freshness day|week|month]
 *   route-executor <files>             Determine executor agent for comma-separated file list
 *                                      Output: {"executor": "executor-backend"} etc.
 *   reindex [path] [--force]           Trigger rlm-service /reindex for code files in path
 *   agent-stats [--raw]                Fetch per-agent metrics summary from daemon
 *                                      Output: human-readable table (default) or JSON (--raw)
 *
 * Scale-Adaptive Intelligence (Phase 42 SCALE-01):
 *   complexity-score <plan_path>       Compute complexity score for a plan/task
 *     [--task-id ID]                   Associate with a specific task (reads pinned_phases)
 *     [--phase N]                      Phase number
 *     [--workflow NAME]                Workflow name (plan-phase|execute-phase)
 *                                      Output: JSON with score, chosen_phases, banner
 *   complexity-complete <task_id>      Write a task_completions row at workflow close
 *     --phase N                        Phase number
 *     --workflow NAME                  Workflow name
 *     --outcome LABEL                  validator_pass|task_fail|gaps_found|manifest_overshoot|escalation_fired
 *     --phases-run R,P,E,T             Comma-separated list of phases actually run
 *     --feature-vector @file           Path to JSON file containing feature vector
 *     --raw-score N                    Raw complexity score
 *     [--escalation-history @file]     Path to JSON file with escalation events
 *   complexity-escalate <task_id>     Re-score after divergence; append escalation flags (Phase 42 SCALE-04)
 *     --phase N                        Phase number
 *     --workflow NAME                  Workflow name (default: execute-phase)
 *     [--executor-report @file]        Path to JSON file with executor report
 *     [--validator-report @file]       Path to JSON file with validator report
 *     Output: JSON with escalated, fired_triggers, new_score, new_chosen_phases, cap_hit, banner
 *     Graceful: prints fallback JSON and exits 0 when daemon unreachable
 *
 * Phase Operations:
 *   phase next-decimal <phase>         Calculate next decimal phase number
 *   phase add <description>            Append new phase to roadmap + create dir
 *   phase insert <after> <description> Insert decimal phase after existing
 *   phase remove <phase> [--force]     Remove phase, renumber all subsequent
 *   phase complete <phase>             Mark phase done, update state + roadmap
 *
 * Roadmap Operations:
 *   roadmap get-phase <phase>          Extract phase section from ROADMAP.md
 *   roadmap analyze                    Full roadmap parse with disk status
 *   roadmap update-plan-progress <N>   Update progress table row from disk (PLAN vs SUMMARY counts)
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
 *
 * Milestone Operations:
 *   milestone complete <version>       Archive milestone, create MILESTONES.md
 *     [--name <name>]
 *     [--archive-phases]               Move phase dirs to milestones/vX.Y-phases/
 *
 * Validation:
 *   validate consistency               Check phase numbering, disk/roadmap sync
 *   validate health [--repair]         Check .planning/ integrity, optionally repair
 *
 * Progress:
 *   progress [json|table|bar]          Render progress in various formats
 *
 * Todos:
 *   todo complete <filename>           Move todo from pending to completed
 *
 * Scaffolding:
 *   scaffold context --phase <N>       Create CONTEXT.md template
 *   scaffold uat --phase <N>           Create UAT.md template
 *   scaffold verification --phase <N>  Create VERIFICATION.md template
 *   scaffold phase-dir --phase <N>     Create phase directory
 *     --name <name>
 *
 * Frontmatter CRUD:
 *   frontmatter get <file> [--field k] Extract frontmatter as JSON
 *   frontmatter set <file> --field k   Update single frontmatter field
 *     --value jsonVal
 *   frontmatter merge <file>           Merge JSON into frontmatter
 *     --data '{json}'
 *   frontmatter validate <file>        Validate required fields
 *     --schema plan|summary|verification
 *
 * Verification Suite:
 *   verify plan-structure <file>       Check PLAN.md structure + tasks
 *   verify phase-completeness <phase>  Check all plans have summaries
 *   verify references <file>           Check @-refs + paths resolve
 *   verify commits <h1> [h2] ...      Batch verify commit hashes
 *   verify artifacts <plan-file>       Check must_haves.artifacts
 *   verify key-links <plan-file>       Check must_haves.key_links
 *
 * Template Fill:
 *   template fill summary --phase N    Create pre-filled SUMMARY.md
 *     [--plan M] [--name "..."]
 *     [--fields '{json}']
 *   template fill plan --phase N       Create pre-filled PLAN.md
 *     [--plan M] [--type execute|tdd]
 *     [--wave N] [--fields '{json}']
 *   template fill verification         Create pre-filled VERIFICATION.md
 *     --phase N [--fields '{json}']
 *
 * State Progression:
 *   state advance-plan                 Increment plan counter
 *   state record-metric --phase N      Record execution metrics
 *     --plan M --duration Xmin
 *     [--tasks N] [--files N]
 *   state update-progress              Recalculate progress bar
 *   state add-decision --summary "..."  Add decision to STATE.md
 *     [--phase N] [--rationale "..."]
 *     [--summary-file path] [--rationale-file path]
 *   state add-blocker --text "..."     Add blocker
 *     [--text-file path]
 *   state resolve-blocker --text "..." Remove blocker
 *   state record-session               Update session continuity
 *     --stopped-at "..."
 *     [--resume-file path]
 *
 * Compound Commands (workflow-specific initialization):
 *   init execute-phase <phase>         All context for execute-phase workflow
 *   init plan-phase <phase>            All context for plan-phase workflow
 *   init new-project                   All context for new-project workflow
 *   init new-milestone                 All context for new-milestone workflow
 *   init quick <description>           All context for quick workflow
 *   init resume                        All context for resume-project workflow
 *   init verify-work <phase>           All context for verify-work workflow
 *   init phase-op <phase>              Generic phase operation context
 *   init todos [area]                  All context for todo workflows
 *   init milestone-op                  All context for milestone operations
 *   init map-codebase                  All context for map-codebase workflow
 *   init progress                      All context for progress workflow
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { error } = require('./lib/core.cjs');
const state = require('./lib/state.cjs');
const phase = require('./lib/phase.cjs');
const roadmap = require('./lib/roadmap.cjs');
const verify = require('./lib/verify.cjs');
const config = require('./lib/config.cjs');
const template = require('./lib/template.cjs');
const milestone = require('./lib/milestone.cjs');
const commands = require('./lib/commands.cjs');
const init = require('./lib/init.cjs');
const frontmatter = require('./lib/frontmatter.cjs');

// ─── Routing Helper ───────────────────────────────────────────────────────────

// Routing data flow (AGT-07):
//   agent-capabilities.json (source of truth)
//     -> routeExecutor() reads file_patterns per agent
//     -> execute-phase.md calls `gsd-tools.cjs route-executor`
//     -> execute-plan.md documents the same routing

// Agent capability index -- loaded once for routing
let _capabilityIndex = null;
function getCapabilityIndex() {
  if (!_capabilityIndex) {
    try {
      const capPath = path.join(__dirname, '..', 'agent-capabilities.json');
      _capabilityIndex = JSON.parse(fs.readFileSync(capPath, 'utf-8'));
    } catch (e) {
      _capabilityIndex = { agents: [] };
    }
  }
  return _capabilityIndex;
}

/**
 * route-executor: Determine which executor agent should handle a set of files.
 *
 * Input: comma-separated file paths (from plan files_modified)
 * Output: one of: executor-frontend, executor-backend, executor-infra, executor-general
 *
 * Specificity-wins selection (DEBT-04): collects ALL matching (agent, pattern) pairs,
 * then selects the winner by highest specificity score. On tie, falls back to the
 * established priority order: frontend (0) > infra (1) > backend (2) > general (3).
 *
 * Specificity scoring:
 *   Exact match (no wildcard):          pattern.length + 1000
 *   Directory prefix match (dir/*):     pattern.length + 100
 *   Filename prefix match (Prefix*):    pattern.length + 50
 *   Extension match (*.ext):            pattern.length
 *
 * Infra patterns are path-prefix anchored: only known infra file patterns
 * (Dockerfile*, docker-compose*, .github/workflows/*, terraform/*, k8s/*,
 * nginx.conf) match — NOT any path merely containing "config", "deploy", "ci",
 * "infra" as substrings. This eliminates false positives like src/config.ts and
 * src/deploy-utils.ts being routed to executor-infra.
 */

/**
 * Classify a glob pattern and return its specificity score.
 * Longer/more-specific patterns score higher; exact matches score highest.
 */
function patternSpecificityScore(pattern) {
  if (pattern.startsWith('*.')) {
    // Extension match: *.tsx — base score only (pattern length)
    return pattern.length;
  } else if (pattern.endsWith('/*')) {
    // Directory prefix match: k8s/*, .github/workflows/*
    return pattern.length + 100;
  } else if (pattern.endsWith('*')) {
    // Filename prefix match: Dockerfile*, docker-compose*
    return pattern.length + 50;
  } else {
    // Exact match: nginx.conf
    return pattern.length + 1000;
  }
}

/**
 * Build a regex for a glob pattern using the same rules as before.
 */
function patternToRegex(pattern) {
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1).replace('.', '\\.');
    return new RegExp(`${ext}$`, 'im');
  } else if (pattern.endsWith('/*')) {
    const dir = pattern.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\/)${dir}\\/`, 'im');
  } else if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\/)${prefix}`, 'im');
  } else {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\/)${escaped}$`, 'im');
  }
}

function routeExecutor(filesStr) {
  const files = (filesStr || '').split(',').map(f => f.trim()).filter(Boolean);
  if (!files.length) return 'executor-general';

  const caps = getCapabilityIndex();
  const joined = files.join('\n');

  // Priority order as tiebreaker: frontend (0) > infra (1) > backend (2)
  const routingOrder = ['gsd-executor-frontend', 'gsd-executor-infra', 'gsd-executor-backend'];
  const priorityMap = Object.fromEntries(routingOrder.map((id, i) => [id, i]));

  // Collect ALL matching (agentId, pattern, specificityScore) across all agents
  const matches = [];

  for (const agentId of routingOrder) {
    const agent = caps.agents.find(a => a.id === agentId);
    if (!agent || !agent.file_patterns.length) continue;

    for (const pattern of agent.file_patterns) {
      const regex = patternToRegex(pattern);
      if (regex.test(joined)) {
        matches.push({
          agentId,
          pattern,
          score: patternSpecificityScore(pattern),
          priority: priorityMap[agentId],
        });
      }
    }
  }

  if (!matches.length) return 'executor-general';

  // Sort: highest specificity score first; on tie, lowest priority index (frontend wins)
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.priority - b.priority;
  });

  return matches[0].agentId.replace('gsd-', '');
}

// ─── Circuit Breaker (BEHAV-02) ─────────────────────────────────────────────
//
// State stored in Valkey at key `cb:{agent_name}`.
// Value JSON: { state: "closed"|"open"|"half_open", failures: N, last_failure: ISO8601 }
// Thresholds: 3 consecutive failures → OPEN; 60s TTL → HALF_OPEN probe.
// EXEMPT: gsd-executor-general has NO circuit breaker — it is the last resort.
//         If gsd-executor-general fails, surface to the user; do not reroute.

const CB_FAILURE_THRESHOLD = 3;
const CB_OPEN_TTL_SECONDS = 60;
const CB_EXEMPT_AGENTS = new Set(['gsd-executor-general', 'executor-general']);

/**
 * circuitBreakerCheck(agentName) — check if an agent's circuit breaker is OPEN.
 *
 * Returns: { allowed: bool, state: "closed"|"open"|"half_open", failures: N }
 *   allowed: true  → agent may proceed (state is closed or half_open probe)
 *   allowed: false → agent is in OPEN state; caller must route to executor-general
 *
 * gsd-executor-general is always allowed (CB exempt).
 */
async function circuitBreakerCheck(agentName) {
  if (CB_EXEMPT_AGENTS.has(agentName)) {
    return { allowed: true, state: 'exempt', failures: 0, exempt: true };
  }

  const redisUrl = process.env.GSD_REDIS_URL || 'redis://127.0.0.1:6379/0';
  const key = `cb:${agentName}`;

  try {
    // Dynamic import to avoid hard dependency when redis unavailable
    const redis = require('redis');
    const client = redis.createClient({ url: redisUrl });
    await client.connect().catch(() => null);

    const raw = await client.get(key).catch(() => null);
    await client.quit().catch(() => null);

    if (!raw) {
      // No state stored → closed (fresh start)
      return { allowed: true, state: 'closed', failures: 0 };
    }

    const cb = JSON.parse(raw);

    if (cb.state === 'open') {
      // Check if TTL has expired (half-open probe window)
      const lastFailureMs = new Date(cb.last_failure).getTime();
      const elapsedSeconds = (Date.now() - lastFailureMs) / 1000;
      if (elapsedSeconds >= CB_OPEN_TTL_SECONDS) {
        // Transition to half_open — allow one probe attempt
        return { allowed: true, state: 'half_open', failures: cb.failures };
      }
      // Still OPEN — block
      return { allowed: false, state: 'open', failures: cb.failures };
    }

    return { allowed: true, state: cb.state || 'closed', failures: cb.failures || 0 };
  } catch (err) {
    // Valkey unavailable → fail open (allow, but log)
    process.stderr.write(`[circuit-breaker] Valkey unavailable: ${err.message} — failing open\n`);
    return { allowed: true, state: 'unknown', failures: 0, failOpen: true };
  }
}

/**
 * circuitBreakerRecord(agentName, outcome) — record a task outcome.
 * outcome: "success" | "failure"
 *
 * success → reset failures to 0, state to "closed"
 * failure → increment failures; if >= CB_FAILURE_THRESHOLD, state to "open"
 *
 * gsd-executor-general is always exempt — this is a no-op for that agent.
 */
async function circuitBreakerRecord(agentName, outcome) {
  if (CB_EXEMPT_AGENTS.has(agentName)) return { exempt: true };

  const redisUrl = process.env.GSD_REDIS_URL || 'redis://127.0.0.1:6379/0';
  const key = `cb:${agentName}`;

  try {
    const redis = require('redis');
    const client = redis.createClient({ url: redisUrl });
    await client.connect().catch(() => null);

    const raw = await client.get(key).catch(() => null);
    const current = raw ? JSON.parse(raw) : { state: 'closed', failures: 0, last_failure: null };

    let next;
    if (outcome === 'success') {
      next = { state: 'closed', failures: 0, last_failure: current.last_failure };
    } else {
      const newFailures = (current.failures || 0) + 1;
      next = {
        state: newFailures >= CB_FAILURE_THRESHOLD ? 'open' : 'closed',
        failures: newFailures,
        last_failure: new Date().toISOString(),
      };
    }

    await client.set(key, JSON.stringify(next)).catch(() => null);
    await client.quit().catch(() => null);

    return { agentName, outcome, newState: next.state, failures: next.failures };
  } catch (err) {
    process.stderr.write(`[circuit-breaker] Valkey unavailable: ${err.message} — skipping record\n`);
    return { error: err.message, skipped: true };
  }
}

// ─── Lint After Edit (BEHAV-04) ─────────────────────────────────────────────
//
// Advisory lint check after each executor commit. Does NOT block — findings
// are logged to VERIFICATION block in SUMMARY.md as lint_report JSON.
//
// JS/CJS detection order: npx eslint → eslint → node --check (syntax-only)
// Python detection order: ruff check → python3 -m py_compile (syntax-only)
//
// lint_report schema: { linter, exit_code, findings[], fallback_used }
// findings[]: { file, line, rule, message, severity }

function _detectLinter(fileExt) {
  const { execSync } = require('child_process');
  const _try = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };

  if (['.js', '.cjs', '.mjs', '.ts', '.tsx'].includes(fileExt)) {
    if (_try('npx eslint --version')) return { linter: 'eslint', cmd: 'npx eslint', fallback: false };
    if (_try('eslint --version')) return { linter: 'eslint', cmd: 'eslint', fallback: true };
    return { linter: 'node-check', cmd: 'node --check', fallback: true };
  }
  if (fileExt === '.py') {
    if (_try('ruff --version')) return { linter: 'ruff', cmd: 'ruff check', fallback: false };
    return { linter: 'py_compile', cmd: 'python3 -m py_compile', fallback: true };
  }
  return null; // No linter for this file type
}

/**
 * lintAfterEdit(filePath, options?) — run language-appropriate linter on a file.
 *
 * Returns lint_report object:
 * {
 *   linter: "eslint"|"ruff"|"node-check"|"py_compile"|"none",
 *   exit_code: 0,
 *   findings: [{ file, line, rule, message, severity }],
 *   fallback_used: bool
 * }
 *
 * Always returns a lint_report — never throws. Empty findings[] on clean file.
 * Returns linter: "none" if no linter detected for this file type.
 */
function lintAfterEdit(filePath, options = {}) {
  const path = require('path');
  const { execSync } = require('child_process');
  const fs = require('fs');

  // Graceful no-op for non-existent files
  if (!filePath || !fs.existsSync(filePath)) {
    return { linter: 'none', exit_code: 0, findings: [], fallback_used: false };
  }

  const ext = path.extname(filePath).toLowerCase();
  const detected = _detectLinter(ext);

  if (!detected) {
    return { linter: 'none', exit_code: 0, findings: [], fallback_used: false };
  }

  let exit_code = 0;
  let findings = [];
  let rawOutput = '';

  try {
    if (detected.linter === 'eslint') {
      // eslint --format json for structured output
      try {
        rawOutput = execSync(`${detected.cmd} --format json "${filePath}" 2>/dev/null || true`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const parsed = JSON.parse(rawOutput);
        findings = (parsed[0]?.messages || []).map(m => ({
          file: filePath,
          line: m.line || 0,
          rule: m.ruleId || 'unknown',
          message: m.message,
          severity: m.severity === 2 ? 'error' : 'warning',
        }));
        exit_code = findings.some(f => f.severity === 'error') ? 1 : 0;
      } catch { findings = []; exit_code = 0; }

    } else if (detected.linter === 'node-check') {
      try {
        execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
        exit_code = 0;
      } catch (e) {
        exit_code = 1;
        const stderr = (e.stderr || '').toString();
        const match = stderr.match(/^.*:(\d+).*$/m);
        findings = [{ file: filePath, line: match ? parseInt(match[1]) : 0, rule: 'syntax', message: stderr.trim().split('\n')[0], severity: 'error' }];
      }

    } else if (detected.linter === 'ruff') {
      try {
        rawOutput = execSync(`${detected.cmd} --output-format json "${filePath}" 2>/dev/null`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const parsed = JSON.parse(rawOutput || '[]');
        findings = parsed.map(r => ({
          file: filePath, line: r.location?.row || 0, rule: r.code || 'unknown',
          message: r.message, severity: 'error',
        }));
        exit_code = findings.length > 0 ? 1 : 0;
      } catch { findings = []; exit_code = 0; }

    } else if (detected.linter === 'py_compile') {
      try {
        execSync(`python3 -m py_compile "${filePath}"`, { stdio: 'pipe' });
        exit_code = 0;
      } catch (e) {
        exit_code = 1;
        const stderr = (e.stderr || '').toString();
        findings = [{ file: filePath, line: 0, rule: 'syntax', message: stderr.trim().split('\n')[0], severity: 'error' }];
      }
    }
  } catch (outer) {
    // Total failure — return empty findings, not an error
    return { linter: detected.linter, exit_code: 0, findings: [], fallback_used: detected.fallback };
  }

  return {
    linter: detected.linter,
    exit_code,
    findings,
    fallback_used: detected.fallback,
  };
}

// ─── Feature List (BEHAV-05) ─────────────────────────────────────────────────
//
// One feature_list.json per PLAN.md, stored alongside it in .planning/phases/XX-name/.
// Filename: {plan_id}-feature_list.json (e.g. 28-01-feature_list.json).
//
// Schema: { plan_id, generated_at, features: [ {feature_id, task_id, description, status, test_file, last_verified} ] }
// status: "pending" | "passing" | "failing"
//
// featureListGenerate: reads PLAN.md acceptance_criteria blocks → generates feature_list.json
// featureListUpdate: runs tests → overwrites status fields (not appended — overwrite is the current snapshot)

/**
 * featureListGenerate(planFile) — parse PLAN.md acceptance_criteria blocks
 * and generate the corresponding {plan_id}-feature_list.json.
 *
 * Each <task> block becomes one feature entry.
 * feature_id: "{plan_id}-F{N}" (e.g. "28-01-F01")
 * description: first acceptance_criteria bullet point (trimmed)
 * status: "pending" (initial; updated by featureListUpdate)
 * test_file: inferred from files_expected create[] entries matching tests/
 * last_verified: null (initial)
 */
function featureListGenerate(planFile) {
  const fs = require('fs');
  const path = require('path');

  const content = fs.readFileSync(planFile, 'utf8');

  // Extract plan_id from frontmatter
  const planIdMatch = content.match(/^plan_id:\s*(.+)$/m);
  const planId = planIdMatch ? planIdMatch[1].trim() : path.basename(planFile, '-PLAN.md');

  // Extract task blocks with their acceptance_criteria and files_expected
  const taskPattern = /<task\s+id="([^"]+)"[\s\S]*?<\/task>/g;
  const acPattern = /<acceptance_criteria>([\s\S]*?)<\/acceptance_criteria>/;
  const filesPattern = /<files_expected>([\s\S]*?)<\/files_expected>/;
  const testFilePattern = /tests\/[^\s'"<>]+/g;

  const features = [];
  let taskMatch;
  let featureN = 1;

  while ((taskMatch = taskPattern.exec(content)) !== null) {
    const taskBlock = taskMatch[0];
    const taskId = taskMatch[1];

    const acMatch = taskBlock.match(acPattern);
    const firstBullet = acMatch
      ? (acMatch[1].trim().split('\n').find(l => l.trim().startsWith('-')) || '').replace(/^-\s*/, '').trim()
      : `Task ${taskId} acceptance criteria`;

    const filesMatch = taskBlock.match(filesPattern);
    const filesContent = filesMatch ? filesMatch[1] : '';
    const testFiles = [...filesContent.matchAll(testFilePattern)].map(m => m[0]);
    const testFile = testFiles.length > 0 ? testFiles[0] : null;

    features.push({
      feature_id: `${planId}-F${String(featureN).padStart(2, '0')}`,
      task_id: taskId,
      description: firstBullet.slice(0, 200), // cap at 200 chars for token budget
      status: 'pending',
      test_file: testFile,
      last_verified: null,
    });
    featureN++;
  }

  const outDir = path.dirname(planFile);
  const outFile = path.join(outDir, `${planId}-feature_list.json`);
  const payload = {
    plan_id: planId,
    generated_at: new Date().toISOString(),
    features,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
  return { plan_id: planId, feature_count: features.length, output_file: outFile };
}

/**
 * featureListUpdate(featureListFile) — run tests associated with each feature
 * and overwrite status fields.
 *
 * For each feature with a test_file: run `node --test {test_file}` (CJS)
 * or `python3 -m pytest {test_file}` (Python). Update status based on exit code.
 * Overwrites the file (not append) — the file is the current state snapshot.
 */
function featureListUpdate(featureListFile) {
  const fs = require('fs');
  const { execSync } = require('child_process');

  const payload = JSON.parse(fs.readFileSync(featureListFile, 'utf8'));
  let anyFailing = false;

  for (const feature of payload.features) {
    if (!feature.test_file) {
      // No test file — leave as pending (cannot auto-verify)
      continue;
    }
    try {
      const isJs = feature.test_file.endsWith('.test.cjs') || feature.test_file.endsWith('.test.js');
      const cmd = isJs
        ? `node --test "${feature.test_file}" 2>&1`
        : `python3 -m pytest "${feature.test_file}" -q 2>&1`;
      execSync(cmd, { stdio: 'ignore', timeout: 60000 });
      feature.status = 'passing';
    } catch {
      feature.status = 'failing';
      anyFailing = true;
    }
    feature.last_verified = new Date().toISOString();
  }

  payload.last_updated = new Date().toISOString();
  fs.writeFileSync(featureListFile, JSON.stringify(payload, null, 2) + '\n');
  return { plan_id: payload.plan_id, any_failing: anyFailing, feature_count: payload.features.length };
}

// ─── Manifest Check (HARDEN-01) ──────────────────────────────────────────────

// Global allowlist for orchestrator-generated files that are permitted to drift
// outside a task's files_expected: manifest. Paths matching these globs are
// stripped from `unexpected_*` violation arrays before the halt decision.
// Reviewed whenever a new orchestrator-generated artifact type is introduced.
const GLOBAL_ALLOWLIST = [
  'package-lock.json',
  '.planning/STATE.md',
  'coverage/**',
  // Orchestrator-emitted audit artifacts — same bucket as coverage/**.
  // Validator reads these as input; they must not count as manifest drift.
  // Added in 13.1-05-05 (Wave 1 + Wave 2 fold-ins). See Observations #1
  // in 13.1-01-SUMMARY.md and Observation #1 in 13.1-04-SUMMARY.md.
  '.planning/milestones/**/manifest-violation-*.json',
  '.planning/milestones/**/gaps-report-*.json',
];

// Files that only the orchestrator may write. An executor diff touching any of
// these triggers an immediate hard halt (`halt_orchestrator_owned`) regardless
// of the per-task manifest or the `GSD_MANIFEST_CHECK=warn` override.
const ORCHESTRATOR_OWNED = [
  '.planning/STATE.md',
  '.planning/ROADMAP.md',
  '.planning/REQUIREMENTS.md',
];

// Overly broad globs that defeat the purpose of a manifest. Any manifest
// containing one of these strings as a declared path is rejected before the
// diff is compared.
const MANIFEST_GLOB_BLOCKLIST = ['**/*.md', '**/*', '*'];

/**
 * Canonical phase-directory resolver. Resolution order:
 *   1. opts.phase (explicit override) wins
 *   2. else parse leading numeric segment from taskIdOrPhase
 *      (e.g. "13.1-04-01" -> "13.1", "9-03-02" -> "9")
 *   3. else fall back to literal "unknown"
 *
 * Returns the resolved phase identifier as a string. Callers compose
 * full directory paths themselves (typically
 * `.planning/milestones/<phase>/...`).
 *
 * Added in 13.1-05-05 (Wave 2 fold-in) to replace ad-hoc inline copies
 * such as the one in `gsd-amauta.cjs` cmdValidate. Existing inline
 * copies are NOT refactored in this task — refactoring is a separate
 * concern and explicitly out of scope per plan 13.1-05-05 scope-guard.
 */
function resolvePhaseDir(taskIdOrPhase, opts = {}) {
  if (opts && typeof opts.phase === 'string' && opts.phase.length > 0) {
    return opts.phase;
  }
  if (typeof taskIdOrPhase === 'string' && taskIdOrPhase.length > 0) {
    // Match leading numeric segment, optionally with a single dot
    // (e.g. "13.1", "9", "13.1.2"). Stop at the first hyphen or EOS.
    const m = taskIdOrPhase.match(/^(\d+(?:\.\d+)*)(?:-|$)/);
    if (m) return m[1];
  }
  return 'unknown';
}

/**
 * Compile a glob (supports `*`, `**`, path-segment wildcards) into a RegExp
 * that matches against full POSIX-style paths. This is a minimal matcher to
 * avoid adding a runtime dep — it covers the shapes actually used in plan
 * manifests (`tests/13.1-*.test.cjs`, `get-shit-done/bin/*.cjs`, explicit
 * paths). Unsupported glob features (brace expansion, extglob) are NOT
 * implemented; callers should use explicit paths for anything exotic.
 */
function _globToRegExp(glob) {
  // Escape regex metacharacters except `*` and `/`
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` -> match any number of path segments
        re += '.*';
        i += 2;
        // Swallow a trailing `/` so `**/` matches zero or more segments
        if (glob[i] === '/') i += 1;
      } else {
        // Single `*` -> match anything except `/`
        re += '[^/]*';
        i += 1;
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function _matchesAny(pathStr, patterns) {
  for (const p of patterns) {
    if (p === pathStr) return true;
    if (p.includes('*')) {
      if (_globToRegExp(p).test(pathStr)) return true;
    }
  }
  return false;
}

/**
 * Minimal YAML loader for `files_expected:` manifest fragments.
 * Supports ONLY:
 *   - top-level key: value mappings where value is a flat list
 *   - inline empty lists: `key: []`
 *   - multi-line lists with `- item` entries
 *
 * Any unsupported construct yields `null` for that key (missing field), which
 * triggers the "must declare all of modify, create, delete" error upstream.
 */
function _parseFilesExpectedYaml(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const result = {};
  let currentKey = null;
  for (let raw of lines) {
    // Strip comments and trailing whitespace
    const hashIdx = raw.indexOf('#');
    if (hashIdx !== -1) raw = raw.slice(0, hashIdx);
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // Top-level key
    const topMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (topMatch && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-')) {
      currentKey = topMatch[1];
      const rest = topMatch[2];
      if (rest === '' || rest === undefined) {
        result[currentKey] = [];
      } else if (rest === '[]') {
        result[currentKey] = [];
        currentKey = null;
      } else {
        // Inline scalar — unsupported for our use case
        result[currentKey] = rest;
        currentKey = null;
      }
      continue;
    }

    // List item under current key
    const listMatch = /^\s*-\s*(.+)$/.exec(line);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = [];
      }
      let value = listMatch[1].trim();
      // Strip wrapping quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[currentKey].push(value);
    }
  }
  return result;
}

function _diffNameStatus(before, after, cwd) {
  const out = execSync(
    `git diff --name-status ${before} ${after}`,
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const modified = [];
  const created = [];
  const deleted = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (status.startsWith('M')) {
      if (parts[1]) modified.push(parts[1]);
    } else if (status.startsWith('A')) {
      if (parts[1]) created.push(parts[1]);
    } else if (status.startsWith('D')) {
      if (parts[1]) deleted.push(parts[1]);
    } else if (status.startsWith('R') || status.startsWith('C')) {
      // Rename/copy: R100\told\tnew  -> delete(old) + create(new)
      if (parts[1]) deleted.push(parts[1]);
      if (parts[2]) created.push(parts[2]);
    } else if (status.startsWith('T')) {
      // Type change — treat as modify
      if (parts[1]) modified.push(parts[1]);
    }
  }
  return { modified, created, deleted };
}

function _expectedMatches(expectedList, actualList) {
  // Returns { matched: Set<actualPath>, unmatchedExpected: string[] }
  const matched = new Set();
  const unmatchedExpected = [];
  for (const expected of expectedList) {
    let hit = false;
    if (expected.includes('*')) {
      const re = _globToRegExp(expected);
      for (const actual of actualList) {
        if (re.test(actual)) {
          matched.add(actual);
          hit = true;
        }
      }
    } else {
      if (actualList.includes(expected)) {
        matched.add(expected);
        hit = true;
      }
    }
    if (!hit) unmatchedExpected.push(expected);
  }
  return { matched, unmatchedExpected };
}

/**
 * manifestCheck — deterministic per-task manifest enforcement.
 * See plan 13.1-01 task 13.1-01-01 for the locked API shape.
 *
 * Returns: { ok, reportPath, action }
 *   ok       — false on `halt` / `halt_orchestrator_owned`, true otherwise
 *   reportPath — path to JSON violation report, or null if no report written
 *   action   — 'pass' | 'warn' | 'halt' | 'halt_orchestrator_owned'
 */
async function manifestCheck({ phase, wave, taskId, filesExpected, gitShaBefore, gitShaAfter, envOverride, cwd }) {
  cwd = cwd || process.cwd();

  // Validate manifest: all three keys present (empty list allowed)
  const required = ['modify', 'create', 'delete'];
  for (const key of required) {
    if (!Array.isArray(filesExpected[key])) {
      throw new Error('manifest-check: files_expected must declare all of modify, create, delete (use [] for empty)');
    }
  }

  // Reject overly broad globs
  for (const key of required) {
    for (const entry of filesExpected[key]) {
      if (MANIFEST_GLOB_BLOCKLIST.includes(entry)) {
        throw new Error(`manifest-check: overly broad glob "${entry}" rejected — use explicit paths or narrower globs`);
      }
    }
  }

  // Compute actual diff
  const actual = _diffNameStatus(gitShaBefore, gitShaAfter, cwd);

  // Check orchestrator-owned files first — always hard halt
  const orchestratorHits = [];
  for (const p of [...actual.modified, ...actual.created]) {
    if (_matchesAny(p, ORCHESTRATOR_OWNED)) {
      orchestratorHits.push(p);
    }
  }

  // Expected vs actual
  const modMatch = _expectedMatches(filesExpected.modify, actual.modified);
  const crtMatch = _expectedMatches(filesExpected.create, actual.created);
  const delMatch = _expectedMatches(filesExpected.delete, actual.deleted);

  const unexpected_modifies = actual.modified.filter(p => !modMatch.matched.has(p));
  const unexpected_creates = actual.created.filter(p => !crtMatch.matched.has(p));
  const unexpected_deletes = actual.deleted.filter(p => !delMatch.matched.has(p));
  const missing_creates = crtMatch.unmatchedExpected.slice();

  // Apply global allowlist (does NOT cover orchestrator-owned files, which
  // already shorted to a hard halt above)
  const filterAllowlist = arr => arr.filter(p => !_matchesAny(p, GLOBAL_ALLOWLIST));
  const violations = {
    unexpected_modifies: filterAllowlist(unexpected_modifies),
    unexpected_creates: filterAllowlist(unexpected_creates),
    unexpected_deletes: filterAllowlist(unexpected_deletes),
    missing_creates,
  };

  const hasViolations =
    violations.unexpected_modifies.length > 0 ||
    violations.unexpected_creates.length > 0 ||
    violations.unexpected_deletes.length > 0 ||
    violations.missing_creates.length > 0;

  if (orchestratorHits.length === 0 && !hasViolations) {
    return { ok: true, reportPath: null, action: 'pass' };
  }

  // Decide action
  const warnOverride = envOverride === 'warn' || process.env.GSD_MANIFEST_CHECK === 'warn';
  let action;
  if (orchestratorHits.length > 0) {
    action = 'halt_orchestrator_owned';
  } else if (warnOverride) {
    action = 'warn';
  } else {
    action = 'halt';
  }

  // Write violation report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const phaseDir = path.join(cwd, '.planning', 'milestones');
  // Find the phase directory matching the given phase number (e.g. 13.1 -> .../13.1-*)
  let targetDir = null;
  try {
    // Look one level down for milestone subdir (e.g. v2.2-phases) then phase dirs
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return null;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith(`${phase}-`) || ent.name === String(phase)) {
          return path.join(dir, ent.name);
        }
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const sub = path.join(dir, ent.name);
        const hit = walk(sub);
        if (hit) return hit;
      }
      return null;
    };
    targetDir = walk(phaseDir);
  } catch (_) {
    targetDir = null;
  }
  if (!targetDir) {
    // Fall back to a flat directory under .planning/milestones/<phase>/
    targetDir = path.join(phaseDir, String(phase));
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (_) {}

  const reportPath = path.join(targetDir, `manifest-violation-${timestamp}.json`);
  const report = {
    phase,
    wave,
    task_id: taskId,
    expected: {
      modify: filesExpected.modify,
      create: filesExpected.create,
      delete: filesExpected.delete,
    },
    actual: {
      modified: actual.modified,
      created: actual.created,
      deleted: actual.deleted,
    },
    violations,
    git_sha_before: gitShaBefore,
    git_sha_after: gitShaAfter,
    timestamp: new Date().toISOString(),
    orchestrator_action: action,
  };
  if (orchestratorHits.length > 0) {
    report.orchestrator_owned_hits = orchestratorHits;
  }

  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  } catch (err) {
    // Report-write failure is non-fatal here — surface via stderr and continue
    process.stderr.write(`manifest-check: failed to write violation report: ${err.message}\n`);
    return { ok: action === 'warn', reportPath: null, action };
  }

  return {
    ok: action === 'warn',
    reportPath,
    action,
  };
}

function _manifestCheckHelp() {
  return [
    'Usage: gsd-tools manifest-check [options]',
    '',
    'Options:',
    '  --phase <n>            Phase id (e.g. 13.1)',
    '  --wave <n>             Wave number within the phase',
    '  --task-id <id>         Task id (e.g. 13.1-01-01)',
    '  --files-expected <p>   Path to YAML file containing modify/create/delete lists',
    '  --before <sha>         Git sha BEFORE the task',
    '  --after <sha>          Git sha AFTER the task',
    '',
    'Environment:',
    '  GSD_MANIFEST_CHECK=warn   Downgrade halts to warnings (logged in orchestrator_action)',
    '',
    'Exit codes:',
    '  0  pass or warn',
    '  1  halt or halt_orchestrator_owned',
    '',
  ].join('\n');
}

async function _runManifestCheckCli(args, cwd) {
  const getFlag = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : null;
  };

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(_manifestCheckHelp());
    return 0;
  }

  const phase = getFlag('--phase');
  const wave = getFlag('--wave');
  const taskId = getFlag('--task-id');
  const filesExpectedPath = getFlag('--files-expected');
  const before = getFlag('--before');
  const after = getFlag('--after');

  const missing = [];
  if (!phase) missing.push('--phase');
  if (!wave) missing.push('--wave');
  if (!taskId) missing.push('--task-id');
  if (!filesExpectedPath) missing.push('--files-expected');
  if (!before) missing.push('--before');
  if (!after) missing.push('--after');
  if (missing.length) {
    process.stderr.write(`manifest-check: missing required flags: ${missing.join(', ')}\n`);
    process.stderr.write(_manifestCheckHelp());
    return 1;
  }

  const resolved = path.isAbsolute(filesExpectedPath) ? filesExpectedPath : path.join(cwd, filesExpectedPath);
  if (!fs.existsSync(resolved)) {
    process.stderr.write(`manifest-check: files-expected file not found: ${resolved}\n`);
    return 1;
  }
  const yamlText = fs.readFileSync(resolved, 'utf-8');
  const parsed = _parseFilesExpectedYaml(yamlText);

  try {
    const result = await manifestCheck({
      phase,
      wave,
      taskId,
      filesExpected: parsed,
      gitShaBefore: before,
      gitShaAfter: after,
      cwd,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.action === 'halt' || result.action === 'halt_orchestrator_owned') {
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`manifest-check: ${err.message}\n`);
    return 1;
  }
}

// --- Plan-to-Tasks (PLAN-02..05) -----------------------------------------------

/**
 * _validatePlanShape(planContent) — Pass 0 shape validation.
 * Returns {valid: bool, errors: [], taskCount: N, tasks: [{id,agent,files,depends_on}]}.
 *
 * Checks:
 *  - <story> block is present
 *  - every <task> has <agent>, <files_expected>, <acceptance_criteria>
 *  - task count <= 10 (returns cap error if exceeded)
 *  - all <depends_on> references are valid intra-plan task IDs
 */
function _validatePlanShape(planContent) {
  const errors = [];

  // Check <story> block
  if (!/<story[\s>]/i.test(planContent)) {
    errors.push({ code: 'missing_story', message: 'PLAN.md is missing a <story> block — required for phases >= 14.' });
    return { valid: false, errors, taskCount: 0, tasks: [] };
  }

  // Extract all task blocks
  const taskRe = /<task\s+id="([^"]+)">([\s\S]*?)<\/task>/gi;
  const tasks = [];
  let m;
  while ((m = taskRe.exec(planContent)) !== null) {
    const id = m[1];
    const body = m[2];

    const getField = (name) => {
      const re = new RegExp(`<${name}>(\\s*[\\s\\S]*?\\s*)<\\/${name}>`, 'i');
      const match = body.match(re);
      return match ? match[1].trim() : null;
    };

    const titleField = getField('title');
    const agentField = getField('agent');
    const criteriaField = getField('acceptance_criteria');
    const filesField = getField('files_expected');
    const dependsOnField = getField('depends_on');

    // Parse depends_on as JSON array
    let dependsOn = [];
    if (dependsOnField) {
      try {
        dependsOn = JSON.parse(dependsOnField.trim());
        if (!Array.isArray(dependsOn)) dependsOn = [];
      } catch (_) {
        dependsOn = [];
      }
    }

    // Parse files_expected via existing helper
    let filesExpected = { modify: [], create: [], delete: [] };
    if (filesField) {
      try {
        filesExpected = _parseFilesExpectedYaml(filesField);
      } catch (_) {
        filesExpected = { modify: [], create: [], delete: [] };
      }
    }

    tasks.push({ id, title: titleField, agent: agentField, filesExpected, dependsOn, hasFiles: !!filesField, hasCriteria: !!criteriaField });
  }

  // Validate each task has required fields
  for (const task of tasks) {
    if (!task.agent) {
      errors.push({ code: 'missing_agent', taskId: task.id, message: `Task ${task.id} is missing <agent> field.` });
    }
    if (!task.hasFiles) {
      errors.push({ code: 'missing_files_expected', taskId: task.id, message: `Task ${task.id} is missing <files_expected> block (HARDEN-01 mandate).` });
    }
    if (!task.hasCriteria) {
      errors.push({ code: 'missing_acceptance_criteria', taskId: task.id, message: `Task ${task.id} is missing <acceptance_criteria>.` });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, taskCount: tasks.length, tasks };
  }

  // Check task count cap
  if (tasks.length > 10) {
    errors.push({ code: 'cap_exceeded', cap: 10, actual: tasks.length, message: `Plan has ${tasks.length} tasks, exceeding the 10-task cap (PLAN-05 mandate).` });
    return { valid: false, errors, taskCount: tasks.length, tasks };
  }

  // Validate intra-plan depends_on references
  const taskIds = new Set(tasks.map(t => t.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        errors.push({ code: 'invalid_depends_on', taskId: task.id, dep, message: `Task ${task.id} depends_on "${dep}" which is not a task ID in this plan.` });
      }
    }
  }

  return { valid: errors.length === 0, errors, taskCount: tasks.length, tasks };
}

/**
 * _detectCycles(tasks) — DFS-based cycle detection.
 * tasks: array of {id, dependsOn: [ids]}
 * Returns {hasCycle: bool, cycle: [id, ...]}
 */
function _detectCycles(tasks) {
  const adj = {};
  for (const t of tasks) {
    adj[t.id] = t.dependsOn || [];
  }

  const visited = new Set();
  const inStack = new Set();
  let foundCycle = null;

  function dfs(nodeId, stack) {
    if (foundCycle) return;
    if (inStack.has(nodeId)) {
      // Cycle found — reconstruct the cycle path from the stack
      const cycleStart = stack.indexOf(nodeId);
      foundCycle = [...stack.slice(cycleStart), nodeId];
      return;
    }
    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    inStack.add(nodeId);
    stack.push(nodeId);

    for (const dep of (adj[nodeId] || [])) {
      dfs(dep, stack);
      if (foundCycle) return;
    }

    stack.pop();
    inStack.delete(nodeId);
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) {
      dfs(t.id, []);
    }
    if (foundCycle) break;
  }

  return foundCycle ? { hasCycle: true, cycle: foundCycle } : { hasCycle: false, cycle: [] };
}

/**
 * _checkAgentConflicts(tasks) — check planner <agent> against routeExecutor().
 * tasks: array of {id, agent, filesExpected: {modify, create, delete}}
 * Returns {conflicts: [{taskId, planAgent, computedAgent, files}]}
 */
function _checkAgentConflicts(tasks) {
  const conflicts = [];
  for (const task of tasks) {
    const files = [
      ...(task.filesExpected.modify || []),
      ...(task.filesExpected.create || []),
    ];
    if (files.length === 0) continue;
    const computedAgent = routeExecutor(files.join(','));
    const planAgent = (task.agent || '').trim();

    if (planAgent && computedAgent && planAgent !== computedAgent) {
      conflicts.push({ taskId: task.id, planAgent, computedAgent, files });
    }
  }
  return { conflicts };
}

/**
 * _filesDisjointSplit(tasks) — find the best split boundary for an over-cap plan.
 * tasks: array of {id, filesExpected: {modify, create, delete}}
 * Returns {suggested_split_index, split_rationale, new_plan_files}
 */
function _filesDisjointSplit(tasks) {
  if (tasks.length === 0) return { suggested_split_index: null, split_rationale: 'no_tasks', new_plan_files: [] };

  const getFiles = (t) => new Set([
    ...(t.filesExpected.modify || []),
    ...(t.filesExpected.create || []),
  ]);

  // Try every candidate boundary i (tasks[0..i] vs tasks[i+1..N-1])
  const candidates = [];
  for (let i = 0; i < tasks.length - 1; i++) {
    const leftFiles = new Set();
    for (let j = 0; j <= i; j++) {
      for (const f of getFiles(tasks[j])) leftFiles.add(f);
    }
    const rightFiles = new Set();
    for (let j = i + 1; j < tasks.length; j++) {
      for (const f of getFiles(tasks[j])) rightFiles.add(f);
    }
    // Count overlap
    let overlapCount = 0;
    for (const f of leftFiles) {
      if (rightFiles.has(f)) overlapCount++;
    }
    candidates.push({ index: i + 1, overlapCount });
  }

  // Find fully disjoint boundary
  const disjoint = candidates.find(c => c.overlapCount === 0);
  if (disjoint) {
    return {
      suggested_split_index: disjoint.index,
      split_rationale: `disjoint_at_${disjoint.index}`,
      new_plan_files: [],
    };
  }

  // All tasks touch same files (all candidates have overlap with everyone)
  // Check if ALL candidates have the max possible overlap (no clean cut anywhere)
  const minOverlap = Math.min(...candidates.map(c => c.overlapCount));
  const allMax = candidates.every(c => c.overlapCount === candidates[0].overlapCount);

  // If only one candidate and overlap > 0, it's "all overlap with everyone"
  if (allMax && candidates.length >= 1) {
    const minCand = candidates.find(c => c.overlapCount === minOverlap);
    // If minOverlap is equal across all, no meaningful split
    // Check: are ALL files shared across all tasks?
    const allFiles = new Set();
    for (const t of tasks) {
      for (const f of getFiles(t)) allFiles.add(f);
    }
    // If every task touches every file that overlaps, return null
    if (allMax && minOverlap === candidates[0].overlapCount) {
      // Pick the cut with least overlap (even if non-zero)
      const best = candidates.reduce((a, b) => a.overlapCount <= b.overlapCount ? a : b);
      // If every candidate has the same overlap and it's max overlap possible, no clean split
      const leftFilesAtBest = new Set();
      for (let j = 0; j < best.index; j++) {
        for (const f of getFiles(tasks[j])) leftFilesAtBest.add(f);
      }
      const rightFilesAtBest = new Set();
      for (let j = best.index; j < tasks.length; j++) {
        for (const f of getFiles(tasks[j])) rightFilesAtBest.add(f);
      }
      // If all files overlap (same file in every task), return no_disjoint_prefix
      if (leftFilesAtBest.size > 0 && rightFilesAtBest.size > 0) {
        let allOverlap = true;
        for (const f of leftFilesAtBest) {
          if (!rightFilesAtBest.has(f)) { allOverlap = false; break; }
        }
        if (allOverlap) {
          return { suggested_split_index: null, split_rationale: 'no_disjoint_prefix', new_plan_files: [] };
        }
      }
      return {
        suggested_split_index: best.index,
        split_rationale: `least_overlap_at_${best.index}`,
        overlap_count: best.overlapCount,
        new_plan_files: [],
      };
    }
  }

  // Fallback: least overlap cut
  const best = candidates.reduce((a, b) => a.overlapCount <= b.overlapCount ? a : b);
  return {
    suggested_split_index: best.index,
    split_rationale: `least_overlap_at_${best.index}`,
    overlap_count: best.overlapCount,
    new_plan_files: [],
  };
}

/**
 * _renderDagText(tasks) — ASCII DAG rendering, max 500 chars.
 * tasks: array of {id, dependsOn: [ids]}
 * Returns string.
 */
function _renderDagText(tasks) {
  const lines = [];
  for (const task of tasks) {
    if (task.dependsOn && task.dependsOn.length > 0) {
      for (const dep of task.dependsOn) {
        lines.push(`${dep} -> ${task.id}`);
      }
    } else {
      lines.push(`${task.id} (no deps)`);
    }
  }
  const full = lines.join('\n');
  if (full.length <= 500) return full;
  // Truncate to ensure total output stays <= 500 chars
  const marker = '\n...(full DAG in sidecar file)';
  const truncated = full.slice(0, 500 - marker.length);
  return truncated + marker;
}

/**
 * _diffPlanVsAmauta(planTasks, amautaTasks) — structural drift detection.
 * Compares title, agent, files_expected (modify/create/delete), depends_on.
 * Does NOT compare read_first, action, acceptance_criteria.
 * Returns {drifted: bool, divergence_type, diffs: [{taskId, field, planValue, amautaValue}]}
 */
function _diffPlanVsAmauta(planTasks, amautaTasks) {
  const diffs = [];
  const amautaById = {};
  for (const t of (amautaTasks || [])) {
    // Primary: metadata.plan_local_id
    let lid = (t.metadata && t.metadata.plan_local_id) ? t.metadata.plan_local_id : null;
    // Secondary: tag "task:<plan_local_id>"
    if (!lid) {
      const tags = Array.isArray(t.tags) ? t.tags : [];
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.startsWith('task:')) {
          lid = tag.slice('task:'.length);
          break;
        }
      }
    }
    // Fallback: use amauta item id
    if (!lid) lid = t.id;
    amautaById[lid] = t;
  }

  for (const planTask of (planTasks || [])) {
    const aTask = amautaById[planTask.id];
    if (!aTask) continue;

    // Compare title
    if (planTask.title !== aTask.title) {
      diffs.push({ taskId: planTask.id, field: 'title', planValue: planTask.title, amautaValue: aTask.title });
    }
    // Compare agent
    const planAgent = planTask.agent || '';
    const amautaAgent = aTask.assigned_to || '';
    if (planAgent !== amautaAgent) {
      diffs.push({ taskId: planTask.id, field: 'agent', planValue: planAgent, amautaValue: amautaAgent });
    }
    // Compare files_expected fields
    const fe = planTask.filesExpected || { modify: [], create: [], delete: [] };
    const afe = (aTask.files_expected) || { modify: [], create: [], delete: [] };
    for (const key of ['modify', 'create', 'delete']) {
      const pVal = JSON.stringify((fe[key] || []).slice().sort());
      const aVal = JSON.stringify((afe[key] || []).slice().sort());
      if (pVal !== aVal) {
        diffs.push({ taskId: planTask.id, field: `files_expected.${key}`, planValue: fe[key] || [], amautaValue: afe[key] || [] });
      }
    }
    // Compare depends_on
    const pDeps = JSON.stringify((planTask.dependsOn || []).slice().sort());
    const aDeps = JSON.stringify((aTask.dependencies || []).slice().sort());
    if (pDeps !== aDeps) {
      diffs.push({ taskId: planTask.id, field: 'depends_on', planValue: planTask.dependsOn || [], amautaValue: aTask.dependencies || [] });
    }
  }

  return {
    drifted: diffs.length > 0,
    divergence_type: diffs.length > 0 ? 'plan_amauta_drift' : null,
    diffs,
  };
}

/**
 * planToTasks(planFilePath, opts) — Parse a PLAN.md and run Pass 0 validation.
 *
 * Pass 0: validate plan shape (story, fields, cap, cycles, agent conflicts).
 * Returns structured result for Pass 1+2 (Plan 14-03).
 */
async function planToTasks(planFilePath, opts) {
  opts = opts || {};

  // Kill switch
  if (process.env.GSD_P_AUTO_TASK === 'false') {
    process.stderr.write('[plan-to-tasks] GSD_P_AUTO_TASK=false — skipping plan registration.\n');
    return { skipped: true, reason: 'kill_switch' };
  }

  const cwd = opts.cwd || process.cwd();
  const resolved = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const planContent = fs.readFileSync(resolved, 'utf-8');

  // Extract plan_id from frontmatter
  const planIdMatch = planContent.match(/^plan_id:\s*(.+)$/m);
  const planId = planIdMatch ? planIdMatch[1].trim() : null;

  // Run _validatePlanShape — hard error if invalid
  const shapeResult = _validatePlanShape(planContent);
  if (!shapeResult.valid) {
    const capError = shapeResult.errors.find(e => e.code === 'cap_exceeded');
    if (capError) {
      const splitResult = _filesDisjointSplit(shapeResult.tasks);
      return {
        error: 'cap_exceeded',
        cap: capError.cap,
        actual: capError.actual,
        suggested_split_index: splitResult.suggested_split_index,
        split_rationale: splitResult.split_rationale,
        new_plan_files: splitResult.new_plan_files || [],
      };
    }
    return { error: 'validation_failed', errors: shapeResult.errors };
  }

  const tasks = shapeResult.tasks;

  // Run _detectCycles — hard error if cycle found
  const cycleResult = _detectCycles(tasks);
  if (cycleResult.hasCycle) {
    return {
      error: 'cycle_detected',
      cycle: cycleResult.cycle,
      message: `Dependency cycle detected: ${cycleResult.cycle.join(' -> ')}. Zero tasks created.`,
    };
  }

  // Run _checkAgentConflicts — halt if any conflict
  const conflictResult = _checkAgentConflicts(tasks);
  if (conflictResult.conflicts.length > 0) {
    return {
      error: 'agent_assignment_conflict',
      divergence_type: 'agent_assignment_conflict',
      conflicts: conflictResult.conflicts,
      message: `Agent assignment conflicts detected. Plan must be corrected before registration.`,
    };
  }

  // Pass 0 complete — proceed to Pass 0.5/1/2 (Plan 14-03)

  // ── Resolve amautaCjs path ───────────────────────────────────────────────
  const amautaCjs = path.join(__dirname, 'gsd-amauta.cjs');

  // ── Helpers ─────────────────────────────────────────────────────────────
  const _spawnOpts = { encoding: 'utf-8', timeout: 30000, env: { ...process.env } };

  // spawnAmauta — thin wrapper: spawnSync('node', [amautaCjs, ...args])
  function spawnAmauta(args) {
    return spawnSync('node', [amautaCjs, ...args], _spawnOpts);
  }

  function stripAnsi(str) {
    return (str || '').replace(/\x1b\[[0-9;]*m/g, '');
  }

  function extractId(stdout, prefix) {
    // Matches ST-XXXX or TK-XXXX from "Created story ST-0012: ..." style output
    const cleaned = stripAnsi(stdout || '');
    const re = new RegExp(`${prefix}-[0-9]+`, 'i');
    const m = cleaned.match(re);
    return m ? m[0].toUpperCase() : null;
  }

  // ── Parse story block for Pass 0.5 ──────────────────────────────────────
  const storyMatch = planContent.match(/<story>([\s\S]*?)<\/story>/i);
  const storyBody = storyMatch ? storyMatch[1].trim() : '';
  const storyTitleMatch = storyBody.match(/<title>([\s\S]*?)<\/title>/i);
  const storyCriteriaMatch = storyBody.match(/<success_criteria>([\s\S]*?)<\/success_criteria>/i);
  const storyTitle = storyTitleMatch ? storyTitleMatch[1].trim() : `Plan ${planId} Story`;
  const storyCriteria = storyCriteriaMatch ? storyCriteriaMatch[1].trim() : 'Plan tasks complete.';

  // ── Extract acceptance_criteria text for each task ───────────────────────
  const taskCriteriaMap = {};
  const taskBlockRe = /<task\s+id="([^"]+)">([\s\S]*?)<\/task>/gi;
  let tmatch;
  while ((tmatch = taskBlockRe.exec(planContent)) !== null) {
    const tid = tmatch[1];
    const tbody = tmatch[2];
    const acMatch = tbody.match(/<acceptance_criteria>([\s\S]*?)<\/acceptance_criteria>/i);
    if (acMatch) {
      const lines = acMatch[1].split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-'))
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(Boolean);
      taskCriteriaMap[tid] = lines.length > 0 ? lines : [acMatch[1].trim()];
    } else {
      taskCriteriaMap[tid] = [];
    }
  }

  // ── Idempotency lookup: read tasks.json directly ────────────────────────
  // DATA_DIR is discovered from env (same as gsd-amauta.cjs) or default
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const dataDir = process.env.AMAUTA_DATA_DIR || path.join(pluginRoot, 'data');
  const tasksFile = path.join(dataDir, 'tasks.json');

  let allItems = [];
  try {
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    const parsed = JSON.parse(raw);
    allItems = parsed.items || [];
  } catch (_) {
    // If tasks.json doesn't exist yet (fresh install), continue with empty list
    allItems = [];
  }

  // Build plan-local-id -> amauta task mapping.
  // Primary lookup: metadata.plan_local_id (set by post-creation note call).
  // Secondary lookup: tags array containing "task:<plan_local_id>" (set at creation via --tags).
  const existingByPlanLocalId = {};
  for (const item of allItems) {
    // Primary: metadata.plan_local_id
    const plid = (item.metadata && item.metadata.plan_local_id) ? item.metadata.plan_local_id : null;
    if (plid) {
      existingByPlanLocalId[plid] = item;
    }
    // Secondary: tags array, e.g. ["plan:14-03", "task:14-03-01"]
    const tags = Array.isArray(item.tags) ? item.tags : [];
    for (const tag of tags) {
      if (typeof tag === 'string' && tag.startsWith('task:')) {
        const tagPlid = tag.slice('task:'.length);
        if (tagPlid && !existingByPlanLocalId[tagPlid]) {
          existingByPlanLocalId[tagPlid] = item;
        }
      }
    }
  }

  // Check if a story already exists for this plan_id
  const existingStory = allItems.find(item =>
    item.type === 'story' &&
    item.metadata &&
    (item.metadata.plan_id === planId || item.metadata.plan_local_id === planId)
  );

  // Count how many plan tasks already exist
  const planTaskIds = tasks.map(t => t.id);
  const alreadyExistingTasks = planTaskIds.filter(id => !!existingByPlanLocalId[id]);

  if (alreadyExistingTasks.length === tasks.length && tasks.length > 0) {
    // ALL tasks exist — check for drift
    const amautaTaskList = planTaskIds.map(id => existingByPlanLocalId[id]).filter(Boolean);
    const driftResult = _diffPlanVsAmauta(tasks, amautaTaskList);
    if (driftResult.drifted) {
      return {
        error: 'plan_amauta_drift',
        divergence_type: 'plan_amauta_drift',
        diffs: driftResult.diffs,
        message: 'Plan has drifted from amauta task records. Reconcile before re-running.',
      };
    }
    // No drift — idempotent skip
    return {
      skipped: true,
      reason: 'already_registered',
      story_id: existingStory ? existingStory.id : null,
      task_ids: planTaskIds.map(id => ({
        plan_local_id: id,
        amauta_id: existingByPlanLocalId[id] ? existingByPlanLocalId[id].id : null,
      })),
    };
  }

  // ── Pass 0.5: Story creation ─────────────────────────────────────────────
  let storyId;
  if (existingStory) {
    storyId = existingStory.id;
  } else {
    // Pass 0.5: story creation
    const _storyRaw = spawnSync('node', [
      amautaCjs, 'add', 'story', storyTitle,
      '--agent', 'operator',
      '--criteria', storyCriteria,
    ], _spawnOpts);
    storyId = extractId(_storyRaw.stdout, 'ST');
    if (!storyId) {
      return {
        error: 'story_creation_failed',
        message: `Pass 0.5: failed to extract ST-ID from stdout. Raw: ${(_storyRaw.stdout || '').slice(0, 200)}`,
        stderr: (_storyRaw.stderr || '').slice(0, 200),
      };
    }
    // Stamp plan_id on story metadata via note (best-effort)
    spawnSync('node', [amautaCjs, 'note', storyId, '--content', `plan_id:${planId}`], _spawnOpts);
  }

  // ── Pass 1: Task creation ────────────────────────────────────────────────
  const taskIdMap = {}; // plan_local_id -> amauta TK-ID
  const createdTaskIds = [];
  const skippedTaskIds = [];
  const failedTasks = [];

  for (const task of tasks) {
    // Check if already exists
    if (existingByPlanLocalId[task.id]) {
      taskIdMap[task.id] = existingByPlanLocalId[task.id].id;
      skippedTaskIds.push({ plan_local_id: task.id, amauta_id: existingByPlanLocalId[task.id].id });
      continue;
    }

    const criteria = taskCriteriaMap[task.id] || [];
    const criteriaStr = criteria.length > 0 ? criteria.join(' | ') : task.title;

    const addResult = spawnAmauta([
      'add', 'task', task.title,
      '--parent', storyId,
      '--agent', task.agent,
      '--criteria', criteriaStr,
      '--source', 'plan-to-tasks',
      '--from-plan', planId,
      '--tags', `plan:${planId},task:${task.id}`,
    ]);

    // Check for DEDUP BLOCKED in stdout
    if (stripAnsi(addResult.stdout).includes('DEDUP BLOCKED')) {
      process.stderr.write(`[plan-to-tasks] DEDUP BLOCKED for task ${task.id} — unexpected (--from-plan should bypass). Continuing.\n`);
      failedTasks.push({ plan_local_id: task.id, reason: 'dedup_blocked', stdout: addResult.stdout.slice(0, 200) });
      continue;
    }

    if (addResult.status !== 0) {
      process.stderr.write(`[plan-to-tasks] Task creation failed for ${task.id}: exit ${addResult.status}\n`);
      failedTasks.push({ plan_local_id: task.id, reason: 'creation_failed', exit_code: addResult.status, stderr: addResult.stderr.slice(0, 200) });
      continue;
    }

    const tkId = extractId(addResult.stdout, 'TK');
    if (!tkId) {
      process.stderr.write(`[plan-to-tasks] Could not extract TK-ID for task ${task.id}. stdout: ${addResult.stdout.slice(0, 100)}\n`);
      failedTasks.push({ plan_local_id: task.id, reason: 'id_extraction_failed', stdout: addResult.stdout.slice(0, 200) });
      continue;
    }

    taskIdMap[task.id] = tkId;
    createdTaskIds.push({ plan_local_id: task.id, amauta_id: tkId });
  }

  // ── Pass 2: Dependency linking ───────────────────────────────────────────
  const createdLinks = [];
  const skippedLinks = [];
  const failedLinks = [];

  for (const task of tasks) {
    if (!task.dependsOn || task.dependsOn.length === 0) continue;
    const taskAmautaId = taskIdMap[task.id];
    if (!taskAmautaId) continue; // task wasn't created — skip linking

    for (const depPlanId of task.dependsOn) {
      const depAmautaId = taskIdMap[depPlanId];
      if (!depAmautaId) {
        process.stderr.write(`[plan-to-tasks] Dep ${depPlanId} has no amauta ID — skipping link from ${task.id}.\n`);
        failedLinks.push({ from: task.id, to: depPlanId, reason: 'dep_not_found' });
        continue;
      }

      const linkResult = spawnAmauta(['link', taskAmautaId, '--dep', depAmautaId]);

      if (linkResult.status === 0) {
        const out = stripAnsi(linkResult.stdout);
        if (out.includes('already') || out.includes('exists')) {
          skippedLinks.push({ from: task.id, to: depPlanId });
        } else {
          createdLinks.push({ from: task.id, to: depPlanId, from_id: taskAmautaId, to_id: depAmautaId });
        }
      } else {
        const out = stripAnsi(linkResult.stdout + linkResult.stderr);
        if (out.toLowerCase().includes('cycle')) {
          process.stderr.write(`[plan-to-tasks] Cycle detected by daemon when linking ${taskAmautaId} -> ${depAmautaId}. Skipping.\n`);
          failedLinks.push({ from: task.id, to: depPlanId, reason: 'cycle_detected_by_daemon' });
        } else {
          failedLinks.push({ from: task.id, to: depPlanId, reason: 'link_failed', exit_code: linkResult.status });
        }
      }
    }
  }

  // ── PLAN_REGISTRATION block ──────────────────────────────────────────────
  // Get inherited_criteria_count by calling show on the story
  let inheritedCount = 0;
  try {
    const showResult = spawnAmauta(['show', storyId, '--json']);
    if (showResult.status === 0) {
      const parsed = JSON.parse(showResult.stdout);
      const sc = parsed.success_criteria || parsed.inherited_success_criteria || [];
      inheritedCount = Array.isArray(sc) ? sc.length : (typeof sc === 'string' && sc ? 1 : 0);
    }
  } catch (_) {
    inheritedCount = 0;
  }

  // Build agent_assignments map
  const agentMap = {};
  for (const task of tasks) {
    const tkId = taskIdMap[task.id];
    if (tkId) {
      const allFiles = [
        ...(task.filesExpected.modify || []),
        ...(task.filesExpected.create || []),
      ];
      const computed = routeExecutor(allFiles.join(','));
      agentMap[tkId] = {
        agent: task.agent,
        reasoning: `routeExecutor(${allFiles.slice(0, 3).join(',')}) -> ${computed}`,
      };
    }
  }

  // Build edges list (plan-local IDs)
  const edgeList = [];
  for (const task of tasks) {
    for (const dep of (task.dependsOn || [])) {
      edgeList.push([dep, task.id]);
    }
  }

  const dagText = _renderDagText(tasks);

  const registration = {
    plan_id: planId,
    story_id: storyId,
    task_count: tasks.length,
    cap: 10,
    task_ids: taskIdMap,
    agent_assignments: agentMap,
    edges: edgeList,
    dag_text: dagText.length > 500 ? dagText.slice(0, 500) : dagText,
    inherited_criteria_count: inheritedCount,
  };

  // Enforce 1500-char total limit — truncate dag_text first if needed
  const regStr = JSON.stringify(registration);
  if (regStr.length > 1500) {
    const excess = regStr.length - 1500;
    const currentDag = registration.dag_text;
    const truncLen = Math.max(0, currentDag.length - excess - 10);
    registration.dag_text = currentDag.slice(0, truncLen) + '...(truncated)';
  }

  return {
    success: failedTasks.length === 0 && failedLinks.length === 0,
    pass0: 'complete',
    plan_id: planId,
    story_id: storyId,
    tasks_created: createdTaskIds,
    tasks_skipped: skippedTaskIds,
    links_created: createdLinks,
    links_skipped: skippedLinks,
    failed_tasks: failedTasks,
    failed_links: failedLinks,
    registration,
  };
}

// Export test-only entry points when imported (not invoked) as a module.
if (require.main !== module) {
  module.exports = {
    manifestCheck,
    GLOBAL_ALLOWLIST,
    ORCHESTRATOR_OWNED,
    MANIFEST_GLOB_BLOCKLIST,
    resolvePhaseDir,
    _parseFilesExpectedYaml,
    _globToRegExp,
    _diffNameStatus,
    routeExecutor,
    circuitBreakerCheck,
    circuitBreakerRecord,
    lintAfterEdit,
    _detectLinter,
    featureListGenerate,
    featureListUpdate,
    planToTasks,
    _validatePlanShape,
    _detectCycles,
    _checkAgentConflicts,
    _filesDisjointSplit,
    _renderDagText,
    _diffPlanVsAmauta,
  };
}

// ─── CLI Router ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Optional cwd override for sandboxed subagents running outside project root.
  let cwd = process.cwd();
  const cwdEqArg = args.find(arg => arg.startsWith('--cwd='));
  const cwdIdx = args.indexOf('--cwd');
  if (cwdEqArg) {
    const value = cwdEqArg.slice('--cwd='.length).trim();
    if (!value) error('Missing value for --cwd');
    args.splice(args.indexOf(cwdEqArg), 1);
    cwd = path.resolve(value);
  } else if (cwdIdx !== -1) {
    const value = args[cwdIdx + 1];
    if (!value || value.startsWith('--')) error('Missing value for --cwd');
    args.splice(cwdIdx, 2);
    cwd = path.resolve(value);
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    error(`Invalid --cwd: ${cwd}`);
  }

  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1;
  if (rawIndex !== -1) args.splice(rawIndex, 1);

  const command = args[0];

  if (!command) {
    error('Usage: gsd-tools <command> [args] [--raw] [--cwd <path>]\nCommands: state, resolve-model, find-phase, commit, verify-summary, verify, frontmatter, template, generate-slug, current-timestamp, list-todos, verify-path-exists, config-ensure-section, init, complexity-score, complexity-complete, complexity-escalate');
  }

  switch (command) {
    case 'state': {
      const subcommand = args[1];
      if (subcommand === 'json') {
        state.cmdStateJson(cwd, raw);
      } else if (subcommand === 'update') {
        state.cmdStateUpdate(cwd, args[2], args[3]);
      } else if (subcommand === 'get') {
        state.cmdStateGet(cwd, args[2], raw);
      } else if (subcommand === 'patch') {
        const patches = {};
        for (let i = 2; i < args.length; i += 2) {
          const key = args[i].replace(/^--/, '');
          const value = args[i + 1];
          if (key && value !== undefined) {
            patches[key] = value;
          }
        }
        state.cmdStatePatch(cwd, patches, raw);
      } else if (subcommand === 'advance-plan') {
        state.cmdStateAdvancePlan(cwd, raw);
      } else if (subcommand === 'record-metric') {
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const durationIdx = args.indexOf('--duration');
        const tasksIdx = args.indexOf('--tasks');
        const filesIdx = args.indexOf('--files');
        state.cmdStateRecordMetric(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          duration: durationIdx !== -1 ? args[durationIdx + 1] : null,
          tasks: tasksIdx !== -1 ? args[tasksIdx + 1] : null,
          files: filesIdx !== -1 ? args[filesIdx + 1] : null,
        }, raw);
      } else if (subcommand === 'update-progress') {
        state.cmdStateUpdateProgress(cwd, raw);
      } else if (subcommand === 'add-decision') {
        const phaseIdx = args.indexOf('--phase');
        const summaryIdx = args.indexOf('--summary');
        const summaryFileIdx = args.indexOf('--summary-file');
        const rationaleIdx = args.indexOf('--rationale');
        const rationaleFileIdx = args.indexOf('--rationale-file');
        state.cmdStateAddDecision(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          summary: summaryIdx !== -1 ? args[summaryIdx + 1] : null,
          summary_file: summaryFileIdx !== -1 ? args[summaryFileIdx + 1] : null,
          rationale: rationaleIdx !== -1 ? args[rationaleIdx + 1] : '',
          rationale_file: rationaleFileIdx !== -1 ? args[rationaleFileIdx + 1] : null,
        }, raw);
      } else if (subcommand === 'add-blocker') {
        const textIdx = args.indexOf('--text');
        const textFileIdx = args.indexOf('--text-file');
        state.cmdStateAddBlocker(cwd, {
          text: textIdx !== -1 ? args[textIdx + 1] : null,
          text_file: textFileIdx !== -1 ? args[textFileIdx + 1] : null,
        }, raw);
      } else if (subcommand === 'resolve-blocker') {
        const textIdx = args.indexOf('--text');
        state.cmdStateResolveBlocker(cwd, textIdx !== -1 ? args[textIdx + 1] : null, raw);
      } else if (subcommand === 'record-session') {
        const stoppedIdx = args.indexOf('--stopped-at');
        const resumeIdx = args.indexOf('--resume-file');
        state.cmdStateRecordSession(cwd, {
          stopped_at: stoppedIdx !== -1 ? args[stoppedIdx + 1] : null,
          resume_file: resumeIdx !== -1 ? args[resumeIdx + 1] : 'None',
        }, raw);
      } else {
        state.cmdStateLoad(cwd, raw);
      }
      break;
    }

    case 'resolve-model': {
      commands.cmdResolveModel(cwd, args[1], raw);
      break;
    }

    case 'find-phase': {
      phase.cmdFindPhase(cwd, args[1], raw);
      break;
    }

    case 'commit': {
      const amend = args.includes('--amend');
      const filesIndex = args.indexOf('--files');
      // Collect all positional args between command name and first flag,
      // then join them — handles both quoted ("multi word msg") and
      // unquoted (multi word msg) invocations from different shells
      const endIndex = filesIndex !== -1 ? filesIndex : args.length;
      const messageArgs = args.slice(1, endIndex).filter(a => !a.startsWith('--'));
      const message = messageArgs.join(' ') || undefined;
      const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
      commands.cmdCommit(cwd, message, files, raw, amend);
      break;
    }

    case 'verify-summary': {
      const summaryPath = args[1];
      const countIndex = args.indexOf('--check-count');
      const checkCount = countIndex !== -1 ? parseInt(args[countIndex + 1], 10) : 2;
      verify.cmdVerifySummary(cwd, summaryPath, checkCount, raw);
      break;
    }

    case 'template': {
      const subcommand = args[1];
      if (subcommand === 'select') {
        template.cmdTemplateSelect(cwd, args[2], raw);
      } else if (subcommand === 'fill') {
        const templateType = args[2];
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const nameIdx = args.indexOf('--name');
        const typeIdx = args.indexOf('--type');
        const waveIdx = args.indexOf('--wave');
        const fieldsIdx = args.indexOf('--fields');
        template.cmdTemplateFill(cwd, templateType, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          name: nameIdx !== -1 ? args[nameIdx + 1] : null,
          type: typeIdx !== -1 ? args[typeIdx + 1] : 'execute',
          wave: waveIdx !== -1 ? args[waveIdx + 1] : '1',
          fields: fieldsIdx !== -1 ? JSON.parse(args[fieldsIdx + 1]) : {},
        }, raw);
      } else {
        error('Unknown template subcommand. Available: select, fill');
      }
      break;
    }

    case 'frontmatter': {
      const subcommand = args[1];
      const file = args[2];
      if (subcommand === 'get') {
        const fieldIdx = args.indexOf('--field');
        frontmatter.cmdFrontmatterGet(cwd, file, fieldIdx !== -1 ? args[fieldIdx + 1] : null, raw);
      } else if (subcommand === 'set') {
        const fieldIdx = args.indexOf('--field');
        const valueIdx = args.indexOf('--value');
        frontmatter.cmdFrontmatterSet(cwd, file, fieldIdx !== -1 ? args[fieldIdx + 1] : null, valueIdx !== -1 ? args[valueIdx + 1] : undefined, raw);
      } else if (subcommand === 'merge') {
        const dataIdx = args.indexOf('--data');
        frontmatter.cmdFrontmatterMerge(cwd, file, dataIdx !== -1 ? args[dataIdx + 1] : null, raw);
      } else if (subcommand === 'validate') {
        const schemaIdx = args.indexOf('--schema');
        frontmatter.cmdFrontmatterValidate(cwd, file, schemaIdx !== -1 ? args[schemaIdx + 1] : null, raw);
      } else {
        error('Unknown frontmatter subcommand. Available: get, set, merge, validate');
      }
      break;
    }

    case 'verify': {
      const subcommand = args[1];
      if (subcommand === 'plan-structure') {
        verify.cmdVerifyPlanStructure(cwd, args[2], raw);
      } else if (subcommand === 'phase-completeness') {
        verify.cmdVerifyPhaseCompleteness(cwd, args[2], raw);
      } else if (subcommand === 'references') {
        verify.cmdVerifyReferences(cwd, args[2], raw);
      } else if (subcommand === 'commits') {
        verify.cmdVerifyCommits(cwd, args.slice(2), raw);
      } else if (subcommand === 'artifacts') {
        verify.cmdVerifyArtifacts(cwd, args[2], raw);
      } else if (subcommand === 'key-links') {
        verify.cmdVerifyKeyLinks(cwd, args[2], raw);
      } else {
        error('Unknown verify subcommand. Available: plan-structure, phase-completeness, references, commits, artifacts, key-links');
      }
      break;
    }

    case 'generate-slug': {
      commands.cmdGenerateSlug(args[1], raw);
      break;
    }

    case 'current-timestamp': {
      commands.cmdCurrentTimestamp(args[1] || 'full', raw);
      break;
    }

    case 'list-todos': {
      commands.cmdListTodos(cwd, args[1], raw);
      break;
    }

    case 'verify-path-exists': {
      commands.cmdVerifyPathExists(cwd, args[1], raw);
      break;
    }

    case 'config-ensure-section': {
      config.cmdConfigEnsureSection(cwd, raw);
      break;
    }

    case 'config-set': {
      config.cmdConfigSet(cwd, args[1], args[2], raw);
      break;
    }

    case 'config-get': {
      config.cmdConfigGet(cwd, args[1], raw);
      break;
    }

    case 'history-digest': {
      commands.cmdHistoryDigest(cwd, raw);
      break;
    }

    case 'phases': {
      const subcommand = args[1];
      if (subcommand === 'list') {
        const typeIndex = args.indexOf('--type');
        const phaseIndex = args.indexOf('--phase');
        const options = {
          type: typeIndex !== -1 ? args[typeIndex + 1] : null,
          phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
          includeArchived: args.includes('--include-archived'),
        };
        phase.cmdPhasesList(cwd, options, raw);
      } else {
        error('Unknown phases subcommand. Available: list');
      }
      break;
    }

    case 'roadmap': {
      const subcommand = args[1];
      if (subcommand === 'get-phase') {
        roadmap.cmdRoadmapGetPhase(cwd, args[2], raw);
      } else if (subcommand === 'analyze') {
        roadmap.cmdRoadmapAnalyze(cwd, raw);
      } else if (subcommand === 'update-plan-progress') {
        roadmap.cmdRoadmapUpdatePlanProgress(cwd, args[2], raw);
      } else {
        error('Unknown roadmap subcommand. Available: get-phase, analyze, update-plan-progress');
      }
      break;
    }

    case 'requirements': {
      const subcommand = args[1];
      if (subcommand === 'mark-complete') {
        milestone.cmdRequirementsMarkComplete(cwd, args.slice(2), raw);
      } else {
        error('Unknown requirements subcommand. Available: mark-complete');
      }
      break;
    }

    case 'phase': {
      const subcommand = args[1];
      if (subcommand === 'next-decimal') {
        phase.cmdPhaseNextDecimal(cwd, args[2], raw);
      } else if (subcommand === 'add') {
        phase.cmdPhaseAdd(cwd, args.slice(2).join(' '), raw);
      } else if (subcommand === 'insert') {
        phase.cmdPhaseInsert(cwd, args[2], args.slice(3).join(' '), raw);
      } else if (subcommand === 'remove') {
        const forceFlag = args.includes('--force');
        phase.cmdPhaseRemove(cwd, args[2], { force: forceFlag }, raw);
      } else if (subcommand === 'complete') {
        phase.cmdPhaseComplete(cwd, args[2], raw);
      } else {
        error('Unknown phase subcommand. Available: next-decimal, add, insert, remove, complete');
      }
      break;
    }

    case 'milestone': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        const nameIndex = args.indexOf('--name');
        const archivePhases = args.includes('--archive-phases');
        // Collect --name value (everything after --name until next flag or end)
        let milestoneName = null;
        if (nameIndex !== -1) {
          const nameArgs = [];
          for (let i = nameIndex + 1; i < args.length; i++) {
            if (args[i].startsWith('--')) break;
            nameArgs.push(args[i]);
          }
          milestoneName = nameArgs.join(' ') || null;
        }
        milestone.cmdMilestoneComplete(cwd, args[2], { name: milestoneName, archivePhases }, raw);
      } else {
        error('Unknown milestone subcommand. Available: complete');
      }
      break;
    }

    case 'validate': {
      const subcommand = args[1];
      if (subcommand === 'consistency') {
        verify.cmdValidateConsistency(cwd, raw);
      } else if (subcommand === 'health') {
        const repairFlag = args.includes('--repair');
        verify.cmdValidateHealth(cwd, { repair: repairFlag }, raw);
      } else {
        error('Unknown validate subcommand. Available: consistency, health');
      }
      break;
    }

    case 'progress': {
      const subcommand = args[1] || 'json';
      commands.cmdProgressRender(cwd, subcommand, raw);
      break;
    }

    case 'todo': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        commands.cmdTodoComplete(cwd, args[2], raw);
      } else {
        error('Unknown todo subcommand. Available: complete');
      }
      break;
    }

    case 'scaffold': {
      const scaffoldType = args[1];
      const phaseIndex = args.indexOf('--phase');
      const nameIndex = args.indexOf('--name');
      const scaffoldOptions = {
        phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
        name: nameIndex !== -1 ? args.slice(nameIndex + 1).join(' ') : null,
      };
      commands.cmdScaffold(cwd, scaffoldType, scaffoldOptions, raw);
      break;
    }

    case 'init': {
      const workflow = args[1];

      // Extract --phase-dir override (RESOLVE-02)
      let phaseDirOverride = null;
      const phaseDirIdx = args.indexOf('--phase-dir');
      if (phaseDirIdx !== -1) {
        phaseDirOverride = args[phaseDirIdx + 1] || null;
        // Remove --phase-dir and its value from args so they don't interfere
        args.splice(phaseDirIdx, 2);
      }
      // Also handle --phase-dir=value form
      const phaseDirEqArg = args.find(a => a.startsWith('--phase-dir='));
      if (phaseDirEqArg) {
        phaseDirOverride = phaseDirEqArg.split('=').slice(1).join('=');
        args.splice(args.indexOf(phaseDirEqArg), 1);
      }

      switch (workflow) {
        case 'execute-phase':
          init.cmdInitExecutePhase(cwd, args[2], raw, phaseDirOverride);
          break;
        case 'plan-phase':
          init.cmdInitPlanPhase(cwd, args[2], raw, phaseDirOverride);
          break;
        case 'new-project':
          init.cmdInitNewProject(cwd, raw);
          break;
        case 'new-milestone':
          init.cmdInitNewMilestone(cwd, raw);
          break;
        case 'quick':
          init.cmdInitQuick(cwd, args.slice(2).join(' '), raw);
          break;
        case 'resume':
          init.cmdInitResume(cwd, raw);
          break;
        case 'verify-work':
          init.cmdInitVerifyWork(cwd, args[2], raw, phaseDirOverride);
          break;
        case 'phase-op':
          init.cmdInitPhaseOp(cwd, args[2], raw, phaseDirOverride);
          break;
        case 'todos':
          init.cmdInitTodos(cwd, args[2], raw);
          break;
        case 'milestone-op':
          init.cmdInitMilestoneOp(cwd, raw);
          break;
        case 'map-codebase':
          init.cmdInitMapCodebase(cwd, raw);
          break;
        case 'progress':
          init.cmdInitProgress(cwd, raw);
          break;
        default:
          error(`Unknown init workflow: ${workflow}\nAvailable: execute-phase, plan-phase, new-project, new-milestone, quick, resume, verify-work, phase-op, todos, milestone-op, map-codebase, progress`);
      }
      break;
    }

    case 'phase-plan-index': {
      phase.cmdPhasePlanIndex(cwd, args[1], raw);
      break;
    }

    case 'state-snapshot': {
      state.cmdStateSnapshot(cwd, raw);
      break;
    }

    case 'summary-extract': {
      const summaryPath = args[1];
      const fieldsIndex = args.indexOf('--fields');
      const fields = fieldsIndex !== -1 ? args[fieldsIndex + 1].split(',') : null;
      commands.cmdSummaryExtract(cwd, summaryPath, fields, raw);
      break;
    }

    case 'websearch': {
      const query = args[1];
      const limitIdx = args.indexOf('--limit');
      const freshnessIdx = args.indexOf('--freshness');
      await commands.cmdWebsearch(query, {
        limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10,
        freshness: freshnessIdx !== -1 ? args[freshnessIdx + 1] : null,
      }, raw);
      break;
    }

    case 'route-executor': {
      // Determine which executor agent should handle a set of files.
      // Input: comma-separated file paths (args[1])
      // Output: JSON {"executor": "executor-backend"} etc.
      const executor = routeExecutor(args[1]);
      process.stdout.write(JSON.stringify({ executor }) + '\n');
      break;
    }

    case 'lint-after-edit': {
      const filePath = args[1];
      if (!filePath) { process.stderr.write('Usage: gsd-tools lint-after-edit <file_path>\n'); process.exit(1); }
      const report = lintAfterEdit(filePath);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.exit_code); // exit non-zero if findings — caller decides to block or not
      break;
    }

    case 'feature-list-generate': {
      const planFile = args[1];
      if (!planFile) { process.stderr.write('Usage: gsd-tools feature-list-generate <plan_file>\n'); process.exit(1); }
      const result = featureListGenerate(planFile);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }

    case 'feature-list-update': {
      const flFile = args[1];
      if (!flFile) { process.stderr.write('Usage: gsd-tools feature-list-update <feature_list_file>\n'); process.exit(1); }
      const result = featureListUpdate(flFile);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.any_failing ? 2 : 0); // exit 2 if any failing
      break;
    }

    case 'circuit-breaker-check': {
      const agentName = args[1];
      if (!agentName) { process.stderr.write('Usage: gsd-tools circuit-breaker-check <agent_name>\n'); process.exit(1); }
      const result = await circuitBreakerCheck(agentName);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.allowed ? 0 : 2); // exit 2 = CB open (caller can check)
      break;
    }

    case 'circuit-breaker-record': {
      const agentName = args[1];
      const outcome = args[2]; // "success" or "failure"
      if (!agentName || !['success', 'failure'].includes(outcome)) {
        process.stderr.write('Usage: gsd-tools circuit-breaker-record <agent_name> success|failure\n');
        process.exit(1);
      }
      const result = await circuitBreakerRecord(agentName, outcome);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }

    case 'manifest-check': {
      // HARDEN-01: deterministic per-task manifest enforcement.
      // See manifestCheck() above for the locked API shape.
      const code = await _runManifestCheckCli(args.slice(1), cwd);
      process.exit(code);
      break;
    }

    case 'plan-to-tasks': {
      const planFile = args[1];
      if (!planFile) { error('Usage: gsd-tools plan-to-tasks <plan-file>'); break; }
      const result = await planToTasks(planFile, { cwd });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.error ? 1 : 0);
      break;
    }

    case 'reindex': {
      // Phase 27 RLM-02: trigger explicit full re-index of code files via rlm-service /reindex endpoint
      const targetDir = args[1] || '.';
      const forceFlag = args.includes('--force');
      const body = JSON.stringify({ path: targetDir, force: forceFlag });
      const http = require('http');
      await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: parseInt(process.env.GSD_RLM_PORT || '18798'),
          path: '/reindex',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { process.stdout.write(JSON.stringify(JSON.parse(data), null, 2) + '\n'); }
            catch { process.stdout.write(data + '\n'); }
            resolve();
          });
        });
        req.on('error', (e) => { reject(new Error(`reindex failed: ${e.message}`)); });
        req.write(body);
        req.end();
      });
      break;
    }

    case 'agent-stats': {
      // Phase 39 LIFE-02: fetch per-agent aggregated metrics from daemon GET /api/metrics/stats
      const http = require('http');
      const rawFlag = args.includes('--raw');
      const daemonPort = parseInt(process.env.AMAUTA_PORT || '18799');

      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: daemonPort,
          path: '/api/metrics/stats',
          method: 'GET',
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = null; }

            if (rawFlag || !parsed) {
              process.stdout.write((parsed ? JSON.stringify(parsed, null, 2) : data) + '\n');
              resolve();
              return;
            }

            // Human-readable table output
            const rows = Array.isArray(parsed) ? parsed : (parsed.stats || [parsed]);
            if (rows.length === 0) {
              process.stdout.write('No agent metrics recorded yet.\n');
              resolve();
              return;
            }

            const header = [
              'Agent'.padEnd(30),
              'Tasks'.padStart(6),
              'Avg Time(ms)'.padStart(13),
              'Avg Tokens'.padStart(11),
              'Error Rate'.padStart(11),
              'Pass Rate'.padStart(10),
            ].join('  ');
            const sep = '-'.repeat(header.length);

            process.stdout.write(header + '\n' + sep + '\n');
            for (const row of rows) {
              const line = [
                String(row.agent_name || row.agent || '').padEnd(30),
                String(row.tasks_completed || row.count || 0).padStart(6),
                String(row.avg_time_ms != null ? Number(row.avg_time_ms).toFixed(0) : '-').padStart(13),
                String(row.avg_tokens != null ? Number(row.avg_tokens).toFixed(0) : '-').padStart(11),
                String(row.error_rate != null ? Number(row.error_rate).toFixed(3) : '-').padStart(11),
                String(row.pass_rate != null ? Number(row.pass_rate).toFixed(3) : '-').padStart(10),
              ].join('  ');
              process.stdout.write(line + '\n');
            }
            resolve();
          });
        });

        req.on('error', () => {
          process.stdout.write(JSON.stringify({ error: 'Daemon not available' }) + '\n');
          process.exitCode = 1;
          resolve();
        });

        req.end();
      });
      break;
    }

    case 'step-handoff': {
      // Phase 41 SHARD-05: CLI wrappers for step handoff daemon endpoints.
      // Allows workflow.md routers and step files to persist/load StepHandoff objects.
      // GET /api/steps/{workflow}/{phase} — load current handoff
      // POST /api/steps/{workflow}/{phase}/handoff — save step handoff
      const op = args[1]; // 'get' or 'save'
      const workflow = args[2];
      const phase = args[3];
      if (!op || !workflow || !phase) {
        process.stderr.write('Usage: gsd-tools step-handoff <get|save> <workflow> <phase> [--data JSON]\n');
        process.exit(1);
      }
      const DAEMON_URL = process.env.AMAUTA_DAEMON_URL || 'http://127.0.0.1:18799';
      if (op === 'get') {
        await new Promise((resolve) => {
          const url = new URL(`${DAEMON_URL}/api/steps/${workflow}/${phase}`);
          const http = require('http');
          const req = http.request(url, { method: 'GET' }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try { process.stdout.write(JSON.stringify(JSON.parse(data)) + '\n'); }
              catch { process.stdout.write(data + '\n'); }
              resolve();
            });
          });
          req.on('error', () => {
            process.stdout.write(JSON.stringify({ error: 'Daemon not available', step_id: null }) + '\n');
            resolve();
          });
          req.end();
        });
      } else if (op === 'save') {
        const dataArg = args.indexOf('--data');
        let body;
        if (dataArg !== -1) {
          body = args[dataArg + 1];
        } else {
          // Read from stdin
          body = require('fs').readFileSync('/dev/stdin', 'utf8');
        }
        await new Promise((resolve) => {
          const http = require('http');
          const url = new URL(`${DAEMON_URL}/api/steps/${workflow}/${phase}/handoff`);
          const bodyBuf = Buffer.from(body || '{}', 'utf8');
          const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.byteLength },
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try { process.stdout.write(JSON.stringify(JSON.parse(data)) + '\n'); }
              catch { process.stdout.write(data + '\n'); }
              resolve();
            });
          });
          req.on('error', () => {
            process.stdout.write(JSON.stringify({ error: 'Daemon not available' }) + '\n');
            process.exitCode = 1;
            resolve();
          });
          req.write(bodyBuf);
          req.end();
        });
      } else {
        process.stderr.write(`Unknown step-handoff operation: ${op}. Use 'get' or 'save'.\n`);
        process.exit(1);
      }
      break;
    }

    case 'complexity-score': {
      // Phase 42 SCALE-01: compute complexity score for a plan/task.
      // POST to daemon /api/complexity/score; graceful degradation on daemon-down.
      const planPath   = args[1] || '';
      const taskIdIdx  = args.indexOf('--task-id');
      const phaseIdx2  = args.indexOf('--phase');
      const workflowIdx = args.indexOf('--workflow');
      const scoreBody  = JSON.stringify({
        plan_path:     planPath,
        task_id:       taskIdIdx !== -1 ? args[taskIdIdx + 1] : '',
        phase_number:  phaseIdx2 !== -1 ? parseInt(args[phaseIdx2 + 1], 10) : 0,
        workflow_name: workflowIdx !== -1 ? args[workflowIdx + 1] : 'execute-phase',
        task_meta:     {},
      });
      const _daemonPort = parseInt(process.env.GSD_AMAUTA_PORT || process.env.AMAUTA_PORT || '18799');
      const _fallback = JSON.stringify({
        score: 0,
        chosen_phases: ['R', 'P', 'E', 'T', 'D'],
        override_source: 'fallback',
        banner: 'Phase 42 score: 0/100 → fallback (daemon-down).',
        fallback: true,
      });
      await new Promise((resolve) => {
        const http = require('http');
        const req = http.request({
          hostname: '127.0.0.1',
          port: _daemonPort,
          path: '/api/complexity/score',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(scoreBody) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { process.stdout.write(JSON.stringify(JSON.parse(data), null, 2) + '\n'); }
            catch { process.stdout.write(data + '\n'); }
            resolve();
          });
        });
        req.on('error', () => {
          process.stdout.write(_fallback + '\n');
          resolve();
        });
        req.write(scoreBody);
        req.end();
      });
      break;
    }

    case 'complexity-complete': {
      // Phase 42 SCALE-01: write task_completions row at workflow close.
      // POST to daemon /api/complexity/complete; graceful degradation on daemon-down.
      const cTaskId         = args[1] || '';
      const cPhaseIdx       = args.indexOf('--phase');
      const cWorkflowIdx    = args.indexOf('--workflow');
      const cOutcomeIdx     = args.indexOf('--outcome');
      const cPhasesRunIdx   = args.indexOf('--phases-run');
      const cFVIdx          = args.indexOf('--feature-vector');
      const cRawScoreIdx    = args.indexOf('--raw-score');
      const cEscIdx         = args.indexOf('--escalation-history');

      // --feature-vector @file reads JSON from the given path
      let _fv = {};
      if (cFVIdx !== -1) {
        const fvArg = args[cFVIdx + 1] || '';
        const fvPath = fvArg.startsWith('@') ? fvArg.slice(1) : fvArg;
        try { _fv = JSON.parse(fs.readFileSync(fvPath, 'utf8')); } catch { _fv = {}; }
      }

      // --escalation-history @file (optional)
      let _escHist = [];
      if (cEscIdx !== -1) {
        const escArg = args[cEscIdx + 1] || '';
        try {
          const escContent = typeof escArg === 'string' && escArg.startsWith('@')
            ? fs.readFileSync(escArg.slice(1), 'utf8')
            : escArg;
          const parsed = JSON.parse(escContent);
          _escHist = Array.isArray(parsed) ? parsed : [parsed];
        } catch { _escHist = []; }
      }

      // --phases-run R,P,E,T → array
      const phasesRunStr = cPhasesRunIdx !== -1 ? (args[cPhasesRunIdx + 1] || '') : '';
      const phasesRunArr = phasesRunStr ? phasesRunStr.split(',').map(p => p.trim().toUpperCase()).filter(Boolean) : [];

      const completeBody = JSON.stringify({
        task_id:            cTaskId,
        phase_number:       cPhaseIdx !== -1 ? parseInt(args[cPhaseIdx + 1], 10) : 0,
        workflow_name:      cWorkflowIdx !== -1 ? args[cWorkflowIdx + 1] : 'execute-phase',
        feature_vector:     _fv,
        raw_score:          cRawScoreIdx !== -1 ? parseInt(args[cRawScoreIdx + 1], 10) : 0,
        chosen_phases:      phasesRunArr,
        phases_run:         phasesRunArr,
        outcome_label:      cOutcomeIdx !== -1 ? args[cOutcomeIdx + 1] : 'task_fail',
        escalation_history: _escHist,
      });
      const _daemonPort2 = parseInt(process.env.GSD_AMAUTA_PORT || process.env.AMAUTA_PORT || '18799');
      const _failResp = JSON.stringify({ stored: false, reason: 'daemon-unreachable' });
      await new Promise((resolve) => {
        const http = require('http');
        const req = http.request({
          hostname: '127.0.0.1',
          port: _daemonPort2,
          path: '/api/complexity/complete',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(completeBody) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { process.stdout.write(JSON.stringify(JSON.parse(data), null, 2) + '\n'); }
            catch { process.stdout.write(data + '\n'); }
            resolve();
          });
        });
        req.on('error', () => {
          process.stdout.write(_failResp + '\n');
          resolve();
        });
        req.write(completeBody);
        req.end();
      });
      break;
    }

    case 'complexity-escalate': {
      // Phase 42 SCALE-04: re-score after divergence event; append escalation flags.
      // POST to daemon /api/complexity/escalate; graceful degradation on daemon-down.
      const escTaskId      = args[1] || '';
      const escPhaseIdx    = args.indexOf('--phase');
      const escWfIdx       = args.indexOf('--workflow');
      const escExecIdx     = args.indexOf('--executor-report');
      const escValIdx      = args.indexOf('--validator-report');

      // --executor-report @file reads JSON from path
      let _execRpt = null;
      if (escExecIdx !== -1) {
        const execArg = args[escExecIdx + 1] || '';
        const execPath = execArg.startsWith('@') ? execArg.slice(1) : execArg;
        try { _execRpt = JSON.parse(fs.readFileSync(execPath, 'utf8')); } catch { _execRpt = null; }
      }

      // --validator-report @file reads JSON from path
      let _valRpt = null;
      if (escValIdx !== -1) {
        const valArg = args[escValIdx + 1] || '';
        const valPath = valArg.startsWith('@') ? valArg.slice(1) : valArg;
        try { _valRpt = JSON.parse(fs.readFileSync(valPath, 'utf8')); } catch { _valRpt = null; }
      }

      const escalateBody = JSON.stringify({
        task_id:          escTaskId,
        phase_number:     escPhaseIdx !== -1 ? parseInt(args[escPhaseIdx + 1], 10) : 0,
        workflow_name:    escWfIdx !== -1 ? args[escWfIdx + 1] : 'execute-phase',
        executor_report:  _execRpt,
        validator_report: _valRpt,
      });

      const _escPort = parseInt(process.env.GSD_AMAUTA_PORT || process.env.AMAUTA_PORT || '18799');
      const _escFallback = JSON.stringify({
        escalated: false,
        reason: 'daemon-unreachable',
        banner: 'ESCALATION: daemon down — escalation suspended.',
      });

      await new Promise((resolve) => {
        const http = require('http');
        const req = http.request({
          hostname: '127.0.0.1',
          port: _escPort,
          path: '/api/complexity/escalate',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(escalateBody) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = { banner: data }; }
            // Always print banner to stderr in bold so it is visible above other output
            const banner = parsed.banner || '';
            if (banner) {
              process.stderr.write(`\x1b[1m${banner}\x1b[0m\n`);
            }
            try { process.stdout.write(JSON.stringify(parsed, null, 2) + '\n'); }
            catch { process.stdout.write(data + '\n'); }
            resolve();
          });
        });
        req.on('error', () => {
          const fb = JSON.parse(_escFallback);
          process.stderr.write(`\x1b[1m${fb.banner}\x1b[0m\n`);
          process.stdout.write(_escFallback + '\n');
          resolve();
        });
        req.write(escalateBody);
        req.end();
      });
      break;
    }

    default:
      error(`Unknown command: ${command}`);
  }
}

if (require.main === module) {
  main();
}
