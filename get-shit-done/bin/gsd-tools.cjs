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
const { execSync } = require('child_process');
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
 * Priority order: frontend > infra > backend > general
 * File patterns are read from agent-capabilities.json (AGT-07 single source of truth).
 * Routing behavior is identical to the previous hardcoded implementation.
 *
 * Infra patterns are path-prefix anchored: only known infra file patterns
 * (Dockerfile*, docker-compose*, .github/workflows/*, terraform/*, k8s/*,
 * nginx.conf) match — NOT any path merely containing "config", "deploy", "ci",
 * "infra" as substrings. This eliminates false positives like src/config.ts and
 * src/deploy-utils.ts being routed to executor-infra.
 */
function routeExecutor(filesStr) {
  const files = (filesStr || '').split(',').map(f => f.trim()).filter(Boolean);
  if (!files.length) return 'executor-general';

  const caps = getCapabilityIndex();
  const joined = files.join('\n');

  // Priority order: frontend > infra > backend > general
  // This order ensures .tsx routes to frontend (not backend via .ts)
  const routingOrder = ['gsd-executor-frontend', 'gsd-executor-infra', 'gsd-executor-backend'];

  for (const agentId of routingOrder) {
    const agent = caps.agents.find(a => a.id === agentId);
    if (!agent || !agent.file_patterns.length) continue;

    for (const pattern of agent.file_patterns) {
      // Convert glob-style pattern to regex
      // *.tsx -> /\.tsx$/i, Dockerfile* -> /(?:^|\/)Dockerfile/i, .github/workflows/* -> /\.github\/workflows\//i
      let regex;
      if (pattern.startsWith('*.')) {
        // Extension match: *.tsx -> match files ending in .tsx
        const ext = pattern.slice(1).replace('.', '\\.');
        regex = new RegExp(`${ext}$`, 'im');
      } else if (pattern.endsWith('/*')) {
        // Directory match: terraform/* -> match paths containing terraform/
        const dir = pattern.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(`(?:^|\\/)${dir}\\/`, 'im');
      } else if (pattern.endsWith('*')) {
        // Prefix match: Dockerfile* -> match filenames starting with Dockerfile
        const prefix = pattern.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(`(?:^|\\/)${prefix}`, 'im');
      } else {
        // Exact match: nginx.conf
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(`(?:^|\\/)${escaped}$`, 'im');
      }

      if (regex.test(joined)) {
        return agentId.replace('gsd-', '');
      }
    }
  }

  return 'executor-general';
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

// Export test-only entry points when imported (not invoked) as a module.
if (require.main !== module) {
  module.exports = {
    manifestCheck,
    GLOBAL_ALLOWLIST,
    ORCHESTRATOR_OWNED,
    MANIFEST_GLOB_BLOCKLIST,
    _parseFilesExpectedYaml,
    _globToRegExp,
    _diffNameStatus,
    routeExecutor,
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
    error('Usage: gsd-tools <command> [args] [--raw] [--cwd <path>]\nCommands: state, resolve-model, find-phase, commit, verify-summary, verify, frontmatter, template, generate-slug, current-timestamp, list-todos, verify-path-exists, config-ensure-section, init');
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
      switch (workflow) {
        case 'execute-phase':
          init.cmdInitExecutePhase(cwd, args[2], raw);
          break;
        case 'plan-phase':
          init.cmdInitPlanPhase(cwd, args[2], raw);
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
          init.cmdInitVerifyWork(cwd, args[2], raw);
          break;
        case 'phase-op':
          init.cmdInitPhaseOp(cwd, args[2], raw);
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

    case 'manifest-check': {
      // HARDEN-01: deterministic per-task manifest enforcement.
      // See manifestCheck() above for the locked API shape.
      const code = await _runManifestCheckCli(args.slice(1), cwd);
      process.exit(code);
      break;
    }

    default:
      error(`Unknown command: ${command}`);
  }
}

if (require.main === module) {
  main();
}
