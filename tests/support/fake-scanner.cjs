'use strict';
/**
 * Hermetic stand-ins for the three security scanners (Phase 88, plan 88-16-07).
 *
 * 88-CONTEXT.md: "semgrep installed where it is supported, and a hermetic
 * fake-scanner variant covers the behaviour where it is not." The fakes here
 * run on **every** cell, not only where the real tool is missing: a fake that
 * runs on one platform is a second, untested code path on all the others, and
 * the thing under test — how the pipeline PARSES a scanner's output and what
 * policy it applies to it — does not need a real scanner at all.
 *
 * Built on `tests/support/fake-exe.cjs` (plan 88-14), so each fake is a `.cmd`
 * shim on Windows and a `#!` script on POSIX, written into a directory the
 * caller prepends to PATH. Nothing is downloaded and nothing touches the
 * network: the hermetic guard would refuse it anyway.
 *
 * Each fake emits fixture JSON in the REAL tool's output shape and exits with
 * the REAL tool's convention, so a parser that works against the fake works
 * against the tool:
 *
 * | tool     | clean | findings | shape                                   |
 * |----------|-------|----------|-----------------------------------------|
 * | semgrep  | 0     | 1        | `{results: [{check_id, path, extra:{severity, message}}], errors: []}` |
 * | gitleaks | 0     | 1        | a JSON ARRAY of `{Description, File, RuleID, Secret}` |
 * | trivy    | 0     | 0 (with findings in the report) | `{Results: [{Target, Vulnerabilities: [...]}]}` |
 *
 * @example
 *   const { writeFakeScanner, fakeScannerPath } = require('./support/fake-scanner.cjs');
 *   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-scanners-'));
 *   writeFakeScanner(dir, 'semgrep', { findings: 1 });
 *   const env = { ...process.env, PATH: fakeScannerPath(dir) };
 *
 * @module tests/support/fake-scanner
 */

const path = require('path');
const { writeFakeExe, prependPath } = require('./fake-exe.cjs');

/** The tools this module can stand in for. */
const TOOLS = ['semgrep', 'gitleaks', 'trivy'];

/** Versions the fakes report, so a `--version` probe looks real. */
const FAKE_VERSIONS = {
  semgrep: '1.183.0',
  gitleaks: '8.18.4',
  trivy: '0.76.1',
};

/**
 * One semgrep finding in the real `--json` shape.
 * @param {number} i index, so several findings differ
 * @param {string} severity `ERROR` is the only severity the runner counts
 * @returns {object}
 */
function semgrepFinding(i, severity) {
  return {
    check_id: 'gsd-fake-rule-' + i,
    path: 'FAKE/SKILL.md',
    start: { line: 1 + i, col: 1 },
    end: { line: 1 + i, col: 20 },
    extra: {
      severity,
      message: 'fake-scanner synthetic finding ' + i,
      metadata: { source: 'tests/support/fake-scanner.cjs' },
    },
  };
}

/**
 * The JavaScript body of a fake scanner: print fixture JSON, exit with the
 * tool's own convention.
 *
 * @param {string} tool one of {@link TOOLS}
 * @param {{findings?: number, severity?: string, reportPathFlag?: string}} opts
 * @returns {string} the Node source the shim runs
 */
function fakeBody(tool, opts) {
  const findings = Number(opts.findings || 0);
  const severity = JSON.stringify(opts.severity || 'ERROR');
  const version = JSON.stringify(FAKE_VERSIONS[tool]);
  const mkSemgrep = JSON.stringify(
    Array.from({ length: findings }, (_, i) => semgrepFinding(i, opts.severity || 'ERROR'))
  );

  if (tool === 'semgrep') {
    return [
      'const argv = process.argv.slice(2);',
      `if (argv.includes('--version')) { process.stdout.write(${version} + '\\n'); process.exit(0); }`,
      `const results = ${mkSemgrep};`,
      `process.stdout.write(JSON.stringify({ version: ${version}, results, errors: [], paths: { scanned: [] } }));`,
      `process.exit(results.some((r) => r.extra.severity === ${severity}) ? 1 : 0);`,
    ].join('\n');
  }

  if (tool === 'gitleaks') {
    // gitleaks writes its report to --report-path and exits 1 when it found
    // something. Its JSON document is a bare ARRAY, not an object.
    return [
      "const fs = require('fs');",
      'const argv = process.argv.slice(2);',
      `if (argv.includes('version') || argv.includes('--version')) { process.stdout.write('v' + ${version} + '\\n'); process.exit(0); }`,
      `const findings = Array.from({ length: ${findings} }, (_, i) => ({`,
      "  Description: 'fake-scanner synthetic secret ' + i,",
      "  File: 'tests/fixtures/test-secret.txt',",
      "  RuleID: 'gsd-fake-secret-' + i,",
      "  Secret: 'FAKE-SECRET-' + i,",
      '  StartLine: 1 + i,',
      '}));',
      "const at = argv.indexOf('--report-path');",
      'if (at !== -1 && argv[at + 1]) fs.writeFileSync(argv[at + 1], JSON.stringify(findings));',
      'else process.stdout.write(JSON.stringify(findings));',
      'process.exit(findings.length > 0 ? 1 : 0);',
    ].join('\n');
  }

  // trivy: the report lives in stdout (or --output) and the exit code is 0
  // unless --exit-code was passed.
  return [
    "const fs = require('fs');",
    'const argv = process.argv.slice(2);',
    `if (argv.includes('--version')) { process.stdout.write('Version: ' + ${version} + '\\n'); process.exit(0); }`,
    `const vulns = Array.from({ length: ${findings} }, (_, i) => ({`,
    "  VulnerabilityID: 'GSD-FAKE-' + i,",
    "  PkgName: 'fake-package',",
    "  InstalledVersion: '0.0.' + i,",
    "  Severity: 'HIGH',",
    "  Title: 'fake-scanner synthetic vulnerability ' + i,",
    '}));',
    "const report = { SchemaVersion: 2, Results: vulns.length ? [{ Target: 'fake-target', Class: 'os-pkgs', Vulnerabilities: vulns }] : [] };",
    "const at = argv.indexOf('--output');",
    'if (at !== -1 && argv[at + 1]) fs.writeFileSync(argv[at + 1], JSON.stringify(report));',
    'else process.stdout.write(JSON.stringify(report));',
    "const ec = argv.indexOf('--exit-code');",
    'const wanted = ec !== -1 && argv[ec + 1] ? Number(argv[ec + 1]) : 0;',
    'process.exit(vulns.length > 0 ? wanted : 0);',
  ].join('\n');
}

/**
 * Write a fake scanner into `dir` and return its path.
 *
 * @param {string} dir an existing directory, normally a fresh `mkdtemp`
 * @param {string} tool one of {@link TOOLS}
 * @param {{findings?: number, severity?: string}} [opts]
 *   `findings` is how many synthetic findings to report (0 = a clean scan);
 *   `severity` is the semgrep severity, `ERROR` by default, because the
 *   enforcement runner counts only ERROR rows.
 * @returns {string} the path written (the `.cmd` shim on Windows)
 * @throws {Error} when `tool` is not one this module knows
 * @example
 *   writeFakeScanner(dir, 'gitleaks', { findings: 2 });
 */
function writeFakeScanner(dir, tool, opts = {}) {
  if (!TOOLS.includes(tool)) {
    throw new Error('fake-scanner: unknown tool ' + tool + '; expected one of ' + TOOLS.join(', '));
  }
  return writeFakeExe(dir, tool, { node: fakeBody(tool, opts) });
}

/**
 * A PATH with the fake directory in front.
 *
 * @param {string} dir the directory the fakes were written into
 * @param {string} [base=process.env.PATH] the PATH to extend
 * @returns {string} the new PATH value
 */
function fakeScannerPath(dir, base = process.env.PATH) {
  return prependPath([path.resolve(dir)], base);
}

module.exports = { FAKE_VERSIONS, TOOLS, fakeScannerPath, writeFakeScanner };
