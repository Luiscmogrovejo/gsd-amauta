'use strict';
/**
 * skill-semgrep-runner.cjs — Semgrep wrapper for Phase 43 / SKILL-04.
 *
 * Runs .semgrep/skill-enforcement.yml against SKILL.md files.
 * Reads mutation verb list from get-shit-done/references/mutation_verbs.txt.
 *
 * Exit codes (deterministic):
 *   0 = pass (no ERROR-severity violations found)
 *   1 = violations found (HARD BLOCK)
 *   2 = semgrep binary not installed (WARN-only — infrastructure gap)
 *   3 = config or target error
 *
 * Exported functions (for tests):
 *   runEnforcement(targetDir, configPath)  -> {exitCode, findings, durationMs}
 *   loadMutationVerbs(verbsPath)           -> string[]
 *   checkSemgrepInstalled()                -> boolean
 *
 * CLI:
 *   node scripts/skill-semgrep-runner.cjs [targetDir] [--config=<path>] [--json]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ─── Default paths ────────────────────────────────────────────────────────────

const DEFAULT_TARGET_DIR = 'get-shit-done/skills';
const DEFAULT_CONFIG_PATH = '.semgrep/skill-enforcement.yml';
const DEFAULT_VERBS_PATH = 'get-shit-done/references/mutation_verbs.txt';

// ─── checkSemgrepInstalled ────────────────────────────────────────────────────

/**
 * Check whether the semgrep binary is on PATH.
 * @returns {boolean}
 */
function checkSemgrepInstalled() {
  const result = spawnSync('semgrep', ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  return result.status === 0;
}

// ─── loadMutationVerbs ────────────────────────────────────────────────────────

/**
 * Read mutation_verbs.txt, strip comment lines (starting with #) and blank
 * lines. Returns array of verb strings, one per non-comment line.
 *
 * @param {string} [verbsPath] - Path to mutation_verbs.txt
 * @returns {string[]}
 */
function loadMutationVerbs(verbsPath) {
  const resolvedPath = verbsPath || DEFAULT_VERBS_PATH;
  if (!fs.existsSync(resolvedPath)) {
    return [];
  }
  const content = fs.readFileSync(resolvedPath, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

// ─── runEnforcement ───────────────────────────────────────────────────────────

/**
 * Run Semgrep enforcement against targetDir using configPath.
 *
 * @param {string} [targetDir] - Directory to scan (default: get-shit-done/skills)
 * @param {string} [configPath] - Semgrep config file path (default: .semgrep/skill-enforcement.yml)
 * @returns {{ exitCode: number, findings: Array<object>, durationMs: number }}
 */
function runEnforcement(targetDir, configPath) {
  const resolvedTarget = targetDir || DEFAULT_TARGET_DIR;
  const resolvedConfig = configPath || DEFAULT_CONFIG_PATH;

  // Exit 2 immediately if semgrep is not installed
  if (!checkSemgrepInstalled()) {
    return { exitCode: 2, findings: [], durationMs: 0 };
  }

  // Validate config file exists
  if (!fs.existsSync(resolvedConfig)) {
    return {
      exitCode: 3,
      findings: [],
      durationMs: 0,
      error: `Config file not found: ${resolvedConfig}`,
    };
  }

  // Validate target dir exists
  if (!fs.existsSync(resolvedTarget)) {
    return {
      exitCode: 3,
      findings: [],
      durationMs: 0,
      error: `Target directory not found: ${resolvedTarget}`,
    };
  }

  const startMs = Date.now();

  // Invoke semgrep with JSON output for structured parsing
  const argv = [
    '--config', resolvedConfig,
    '--json',
    '--quiet',
    resolvedTarget,
  ];

  const result = spawnSync('semgrep', argv, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });

  const durationMs = Date.now() - startMs;

  // semgrep exit codes:
  //   0 = no findings
  //   1 = findings found
  //   2 = error (bad config, bad args, etc.)
  if (result.status === 2) {
    // semgrep config/invocation error
    return {
      exitCode: 3,
      findings: [],
      durationMs,
      error: result.stderr || 'semgrep exited with code 2 (config error)',
    };
  }

  // Parse semgrep JSON output
  let semgrepOutput = null;
  let findings = [];

  if (result.stdout && result.stdout.trim()) {
    try {
      semgrepOutput = JSON.parse(result.stdout);
    } catch (_e) {
      return {
        exitCode: 3,
        findings: [],
        durationMs,
        error: `Failed to parse semgrep JSON output: ${_e.message}`,
      };
    }
  }

  if (semgrepOutput && Array.isArray(semgrepOutput.results)) {
    // Filter to ERROR-severity findings
    findings = semgrepOutput.results.filter(
      f => f.extra && f.extra.severity === 'ERROR'
    );
  }

  // Return 0 if no ERROR-severity findings, 1 if any
  const exitCode = findings.length > 0 ? 1 : 0;
  return { exitCode, findings, durationMs };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

exports.runEnforcement = runEnforcement;
exports.loadMutationVerbs = loadMutationVerbs;
exports.checkSemgrepInstalled = checkSemgrepInstalled;

// ─── CLI entry-point ──────────────────────────────────────────────────────────

if (require.main === module) {
  // Parse argv
  const args = process.argv.slice(2);
  let targetDir = DEFAULT_TARGET_DIR;
  let configPath = DEFAULT_CONFIG_PATH;
  let jsonOutput = false;

  for (const arg of args) {
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else if (arg === '--json') {
      jsonOutput = true;
    } else if (!arg.startsWith('--')) {
      targetDir = arg;
    }
  }

  // Check semgrep installed first
  if (!checkSemgrepInstalled()) {
    process.stderr.write(
      'WARN [semgrep-missing] semgrep not found in PATH; install with: pip install semgrep\n'
    );
    process.exit(2);
  }

  // Validate config exists
  if (!fs.existsSync(configPath)) {
    process.stderr.write(
      `ERROR [config-missing] Config file not found: ${configPath}\n`
    );
    process.exit(3);
  }

  // Validate target dir exists
  if (!fs.existsSync(targetDir)) {
    process.stderr.write(
      `ERROR [target-missing] Target directory not found: ${targetDir}\n`
    );
    process.exit(3);
  }

  // Run enforcement
  const { exitCode, findings, durationMs, error } = runEnforcement(targetDir, configPath);

  if (exitCode === 3) {
    process.stderr.write(`ERROR [semgrep-error] ${error || 'Semgrep config error'}\n`);
    process.exit(3);
  }

  if (exitCode === 2) {
    process.stderr.write(
      'WARN [semgrep-missing] semgrep not found in PATH; install with: pip install semgrep\n'
    );
    process.exit(2);
  }

  if (exitCode === 1) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ findings }, null, 2) + '\n');
    } else {
      for (const f of findings) {
        const filePath = f.path || f.extra?.engine_kind || '<unknown>';
        const line = f.start ? f.start.line : '?';
        const ruleId = f.check_id || '<unknown>';
        const msg = (f.extra && f.extra.message) || '<no message>';
        process.stdout.write(`[${ruleId}] ${filePath}:${line} — ${msg}\n`);
      }
    }
    process.stderr.write(
      `[skill-semgrep-runner] FAIL: ${findings.length} violation(s) found in ${durationMs}ms.\n`
    );
    process.exit(1);
  }

  // exitCode === 0 — clean pass
  process.stderr.write(
    `[skill-semgrep-runner] PASS: no violations in ${durationMs}ms.\n`
  );
  process.exit(0);
}
