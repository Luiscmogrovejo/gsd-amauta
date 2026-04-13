#!/usr/bin/env node
'use strict';
/**
 * scripts/security-scan.cjs
 *
 * Unified security orchestrator for gsd-amauta.
 *
 * Runs all security tools in sequence with graceful degradation:
 *   1. semgrep        — SAST (if installed)
 *   2. gitleaks       — secrets detection (if installed)
 *   3. npm audit      — dependency vulnerabilities (ALWAYS run)
 *   4. pip-audit      — Python dependency vulnerabilities (if installed)
 *   5. trivy          — container image scanning (if installed)
 *
 * Exit code logic:
 *   0  — clean scan OR only medium/low findings OR all external tools absent
 *   1  — critical/high npm-audit or pip-audit findings with NO fix available
 *
 * Output: reports/security-report.json (created if absent)
 *
 * PORTABILITY CONSTRAINT: exits 0 even when ALL external tools are absent.
 * npm audit is the minimal required scan; it always runs.
 *
 * Usage:
 *   node scripts/security-scan.cjs
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const REPORT_PATH = path.join(REPORTS_DIR, 'security-report.json');

// Docker images to scan with Trivy (locked targets from docker-compose.yml)
const TRIVY_IMAGES = [
  'paradedb/paradedb:latest-pg16',
  'valkey/valkey:8-alpine',
  'python:3.12-slim',
];

// ─────────────────────────────────────────────────────────────────────────────
// Tool availability checks
// ─────────────────────────────────────────────────────────────────────────────

function toolAvailable(name) {
  try {
    execSync(`which ${name} 2>/dev/null || command -v ${name} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function localBinAvailable(name) {
  return fs.existsSync(path.join(ROOT, 'node_modules', '.bin', name));
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding builder
// ─────────────────────────────────────────────────────────────────────────────

function makeFinding({ tool, severity, category, file, line, message, cve, remediation }) {
  return {
    tool: tool || '',
    severity: severity || 'unknown',
    category: category || '',
    file: file || '',
    line: line || 0,
    message: message || '',
    cve: cve || null,
    remediation: remediation || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Semgrep
// ─────────────────────────────────────────────────────────────────────────────

function runSemgrep(findings, tools_run, tools_skipped) {
  if (!toolAvailable('semgrep')) {
    tools_skipped.push('semgrep');
    return;
  }

  tools_run.push('semgrep');

  // Scan key source directories
  const targetDirs = ['get-shit-done/', 'services/', 'bin/']
    .map(d => path.join(ROOT, d))
    .filter(d => fs.existsSync(d))
    .join(' ');

  if (!targetDirs) return;

  let semgrepOutput = '';
  try {
    const configFlags = fs.existsSync(path.join(ROOT, '.semgrep'))
      ? '--config auto --config .semgrep/'
      : '--config auto';

    const result = spawnSync(
      'semgrep',
      ['--json', ...configFlags.split(' '), ...targetDirs.split(' ')],
      { encoding: 'utf-8', cwd: ROOT, timeout: 60000 }
    );
    semgrepOutput = result.stdout || '';
  } catch (err) {
    process.stderr.write(`[gsd-security] semgrep execution error: ${err.message}\n`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(semgrepOutput);
  } catch {
    // If semgrep exits with parsing error, log and continue
    process.stderr.write('[gsd-security] semgrep output could not be parsed as JSON\n');
    return;
  }

  const severityMap = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };
  const semgrepFindings = (parsed.results || []).map(r => makeFinding({
    tool: 'semgrep',
    severity: severityMap[r.extra && r.extra.severity] || 'low',
    category: r.check_id || '',
    file: r.path || '',
    line: r.start && r.start.line || 0,
    message: r.extra && r.extra.message || '',
    cve: null,
    remediation: null,
  }));

  findings.push(...semgrepFindings);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Gitleaks
// ─────────────────────────────────────────────────────────────────────────────

function runGitleaks(findings, tools_run, tools_skipped) {
  const hasGitleaks = toolAvailable('gitleaks') || localBinAvailable('gitleaks');
  if (!hasGitleaks) {
    tools_skipped.push('gitleaks');
    return;
  }

  // Only run if in a git repo
  const gitDir = path.join(ROOT, '.git');
  if (!fs.existsSync(gitDir)) {
    tools_skipped.push('gitleaks');
    return;
  }

  tools_run.push('gitleaks');

  const gitleaksBin = toolAvailable('gitleaks') ? 'gitleaks' : path.join(ROOT, 'node_modules', '.bin', 'gitleaks');
  const gitleaksReportPath = path.join(require('os').tmpdir(), 'gitleaks-report.json');
  const configFlag = fs.existsSync(path.join(ROOT, '.gitleaks.toml'))
    ? `--config ${path.join(ROOT, '.gitleaks.toml')}`
    : '';

  const cmd = [
    gitleaksBin,
    'detect',
    '--source', ROOT,
    configFlag,
    '--report-format', 'json',
    '--report-path', gitleaksReportPath,
    '--no-banner',
  ].filter(Boolean).join(' ');

  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
  } catch {
    // gitleaks exits non-zero when it finds leaks — that's expected
  }

  if (fs.existsSync(gitleaksReportPath)) {
    try {
      const leaks = JSON.parse(fs.readFileSync(gitleaksReportPath, 'utf-8'));
      if (Array.isArray(leaks)) {
        for (const leak of leaks) {
          findings.push(makeFinding({
            tool: 'gitleaks',
            severity: 'high',
            category: leak.RuleID || 'secret-leak',
            file: leak.File || '',
            line: leak.StartLine || 0,
            message: leak.Description || `Secret detected: ${leak.RuleID || 'unknown'}`,
            cve: null,
            remediation: 'Rotate the exposed credential immediately and remove from git history.',
          }));
        }
      }
    } catch {
      process.stderr.write('[gsd-security] Could not parse gitleaks report\n');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. npm audit (ALWAYS run)
// ─────────────────────────────────────────────────────────────────────────────

function runNpmAudit(findings, tools_run) {
  tools_run.push('npm-audit');

  let stdout = '';
  try {
    // npm audit exits non-zero on vulnerabilities — catch the error and read stdout
    const result = spawnSync('npm', ['audit', '--json'], {
      encoding: 'utf-8',
      cwd: ROOT,
    });
    stdout = result.stdout || '';
  } catch (err) {
    process.stderr.write(`[gsd-security] npm audit spawn error: ${err.message}\n`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    process.stderr.write('[gsd-security] npm audit output could not be parsed as JSON\n');
    return;
  }

  // npm audit v2 format: { vulnerabilities: { <pkg>: { severity, via, fixAvailable, ... } } }
  const vulnerabilities = parsed.vulnerabilities || {};
  for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
    const severity = vuln.severity || 'unknown';
    const fixAvailable = vuln.fixAvailable === true || (typeof vuln.fixAvailable === 'object' && vuln.fixAvailable !== null);
    const via = Array.isArray(vuln.via) ? vuln.via : [];
    const cve = via.find(v => v && v.url && v.url.includes('CVE')) || null;

    findings.push(makeFinding({
      tool: 'npm-audit',
      severity,
      category: 'dependency-vulnerability',
      file: 'package.json',
      line: 0,
      message: `${pkgName}@${vuln.range || '?'}: ${severity} vulnerability${vuln.name ? ` in ${vuln.name}` : ''}`,
      cve: cve && cve.url ? cve.url : null,
      // remediation = null means NO fix available (triggers exit 1 for critical/high)
      remediation: fixAvailable ? `Run 'npm audit fix'` : null,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. pip-audit
// ─────────────────────────────────────────────────────────────────────────────

function runPipAudit(findings, tools_run, tools_skipped) {
  if (!toolAvailable('pip-audit')) {
    tools_skipped.push('pip-audit');
    return;
  }

  tools_run.push('pip-audit');

  let stdout = '';
  try {
    const result = spawnSync('pip-audit', ['--format', 'json'], {
      encoding: 'utf-8',
      cwd: ROOT,
    });
    stdout = result.stdout || '';
  } catch (err) {
    process.stderr.write(`[gsd-security] pip-audit error: ${err.message}\n`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    process.stderr.write('[gsd-security] pip-audit output could not be parsed as JSON\n');
    return;
  }

  // pip-audit format: [{ name, version, vulns: [{ id, fix_versions, ... }] }]
  const pkgList = Array.isArray(parsed) ? parsed : (parsed.dependencies || []);
  for (const pkg of pkgList) {
    if (!pkg.vulns || pkg.vulns.length === 0) continue;
    for (const vuln of pkg.vulns) {
      const hasFix = vuln.fix_versions && vuln.fix_versions.length > 0;
      findings.push(makeFinding({
        tool: 'pip-audit',
        severity: vuln.aliases && vuln.aliases.some(a => a.startsWith('CVE')) ? 'high' : 'medium',
        category: 'dependency-vulnerability',
        file: 'requirements.txt',
        line: 0,
        message: `${pkg.name}@${pkg.version}: ${vuln.id}`,
        cve: vuln.id || null,
        remediation: hasFix ? `Upgrade to ${vuln.fix_versions[0]}` : null,
      }));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Trivy
// ─────────────────────────────────────────────────────────────────────────────

function runTrivy(findings, tools_run, tools_skipped) {
  const hasTrivy = toolAvailable('trivy') || localBinAvailable('trivy');
  if (!hasTrivy) {
    tools_skipped.push('trivy');
    return;
  }

  tools_run.push('trivy');

  const trivyBin = toolAvailable('trivy') ? 'trivy' : path.join(ROOT, 'node_modules', '.bin', 'trivy');

  for (const image of TRIVY_IMAGES) {
    let stdout = '';
    try {
      const result = spawnSync(
        trivyBin,
        ['image', '--format', 'json', '--quiet', image],
        { encoding: 'utf-8', cwd: ROOT, timeout: 120000 }
      );
      stdout = result.stdout || '';
    } catch (err) {
      process.stderr.write(`[gsd-security] trivy failed for ${image}: ${err.message}\n`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      continue;
    }

    const results = parsed.Results || [];
    for (const result of results) {
      for (const vuln of (result.Vulnerabilities || [])) {
        const hasFix = Boolean(vuln.FixedVersion);
        findings.push(makeFinding({
          tool: 'trivy',
          severity: (vuln.Severity || 'unknown').toLowerCase(),
          category: 'container-vulnerability',
          file: image,
          line: 0,
          message: `${vuln.PkgName}@${vuln.InstalledVersion}: ${vuln.VulnerabilityID} — ${vuln.Title || ''}`,
          cve: vuln.VulnerabilityID || null,
          remediation: hasFix ? `Upgrade ${vuln.PkgName} to ${vuln.FixedVersion}` : null,
        }));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary builder
// ─────────────────────────────────────────────────────────────────────────────

function buildSummary(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity in summary) summary[f.severity]++;
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const findings = [];
  const tools_run = [];
  const tools_skipped = [];

  // Ensure reports/ directory exists
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Run all scans
  runSemgrep(findings, tools_run, tools_skipped);
  runGitleaks(findings, tools_run, tools_skipped);
  runNpmAudit(findings, tools_run);
  runPipAudit(findings, tools_run, tools_skipped);
  runTrivy(findings, tools_run, tools_skipped);

  const summary = buildSummary(findings);

  const report = {
    scan_date: new Date().toISOString(),
    tools_run,
    tools_skipped,
    findings,
    summary,
  };

  // Write report file
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`[gsd-security] Could not write report: ${err.message}\n`);
  }

  // Console summary
  const findingLine = findings.length === 0
    ? 'no findings'
    : `${findings.length} finding(s) (${summary.critical} critical, ${summary.high} high, ${summary.medium} medium, ${summary.low} low)`;

  console.log(`[gsd-security] Scan complete: ${findingLine}`);
  console.log(`[gsd-security] Tools run: ${tools_run.join(', ') || 'none'}`);
  if (tools_skipped.length > 0) {
    console.log(`[gsd-security] Tools skipped: ${tools_skipped.join(', ')}`);
  }
  console.log(`[gsd-security] Report written to ${REPORT_PATH}`);

  // Exit code logic:
  // Exit 1 ONLY on npm-audit or pip-audit critical/high findings with NO fix available
  const blockers = findings.filter(f =>
    ['npm-audit', 'pip-audit'].includes(f.tool) &&
    ['critical', 'high'].includes(f.severity) &&
    f.remediation === null // no fix available
  );

  if (blockers.length > 0) {
    process.stderr.write(
      `[gsd-security] BLOCKED: ${blockers.length} critical/high finding(s) with no available fix.\n`
    );
    process.exit(1);
  }

  process.exit(0); // ALL other cases — even if all tools are absent
}

main();
