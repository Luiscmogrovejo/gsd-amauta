'use strict';
/**
 * Phase 34 — Security Pipeline Agent Format Regression Suite
 * File: tests/34-agent-format.unit.test.cjs
 *
 * Requirements covered:
 *   SEC-01: gsd-security agent exists in correct v3.0.0 10-section format
 *   SEC-02: gsd-security references scanning tools and graceful degradation
 *   SEC-04: Supply chain rules (12 rules) propagated to all 14 agent files
 *
 * Pure file-system reads only — no child processes, no network.
 * Uses node:test + node:assert/strict (no external test framework).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');

// ─── Helper ────────────────────────────────────────────────────────────────

function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

// ─── Group 1: gsd-security.md format (SEC-01, SEC-02) ─────────────────────

describe('[SEC-01][SEC-02] gsd-security.md: v3.0.0 10-section format', () => {
  const security = readAgent('gsd-security.md');

  it('[FORMAT] file exists', () => {
    assert.ok(fs.existsSync(path.join(AGENTS_DIR, 'gsd-security.md')));
  });

  it('[FORMAT] exactly 10 ## sections', () => {
    const count = (security.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-security.md has ${count} ## sections, expected 10`);
  });

  it('[BOUNDARY] boundary verbatim: "You scan and report. You do not fix code — that\'s the executor\'s job."', () => {
    assert.ok(
      security.includes("You scan and report. You do not fix code — that's the executor's job."),
      'Missing boundary verbatim string'
    );
  });

  it('[FORMAT-04] anti-over-engineering mandate verbatim', () => {
    assert.ok(
      security.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
      'Missing anti-over-engineering mandate'
    );
  });

  it('[FORMAT-03] read-before-edit mandate verbatim', () => {
    assert.ok(
      security.includes('Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.'),
      'Missing read-before-edit mandate'
    );
  });

  it('[FORMAT] AGENTS.md constraint: "You CANNOT create or modify AGENTS.md"', () => {
    assert.ok(
      security.includes('You CANNOT create or modify AGENTS.md'),
      'Missing AGENTS.md constraint'
    );
  });

  it('[FORMAT] CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = security.split('\n').filter(l => l.trim());
    assert.ok(
      lines[lines.length - 1].includes('CACHE_BREAKPOINT'),
      `Last non-empty line is not CACHE_BREAKPOINT: "${lines[lines.length - 1]}"`
    );
  });

  it('[FORMAT] frontmatter name: gsd-security', () => {
    assert.ok(security.includes('name: gsd-security'), 'Missing frontmatter name: gsd-security');
  });

  it('[SEC-02] tools_skipped schema key present', () => {
    assert.ok(security.includes('tools_skipped'), 'Missing tools_skipped schema key');
  });

  it('[SEC-01] output schema: scan_date key present', () => {
    assert.ok(security.includes('scan_date'), 'Missing scan_date in output schema');
  });

  it('[SEC-01] output schema: findings key present', () => {
    assert.ok(security.includes('findings'), 'Missing findings in output schema');
  });

  it('[SEC-02] graceful degradation rule: tools_skipped in behavioral rules', () => {
    assert.ok(
      security.includes('tools_skipped'),
      'Missing graceful degradation tools_skipped[] reference'
    );
  });

  it('[SEC-03] npm audit always-run rule present', () => {
    assert.ok(
      security.includes('npm audit'),
      'Missing npm audit rule (npm audit must always run)'
    );
  });
});

// ─── Group 2: shared/security-rules.md has exactly 12 rules (SEC-04) ──────

describe('[SEC-04] agents/shared/security-rules.md: 12-rule supply chain set', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const rules = fs.readFileSync(rulesPath, 'utf-8');

  it('file has exactly 12 bullet points (lines starting with "- ")', () => {
    const count = (rules.match(/^- /gm) || []).length;
    assert.strictEqual(count, 12, `Expected 12 rules, found ${count}`);
  });

  it('supply chain rule: "npm ci" present', () => {
    assert.ok(rules.includes('npm ci'), 'Missing "npm ci" supply chain rule');
  });

  it('supply chain rule: "Pin exact versions" present', () => {
    assert.ok(rules.includes('Pin exact versions'), 'Missing "Pin exact versions" rule');
  });

  it('supply chain rule: "Commit lockfiles" present', () => {
    assert.ok(rules.includes('Commit lockfiles'), 'Missing "Commit lockfiles" rule');
  });

  it('supply chain rule: "1,000 weekly downloads" present', () => {
    assert.ok(rules.includes('1,000 weekly downloads'), 'Missing 1,000 weekly downloads rule');
  });

  it('original rule preserved: "Parameterized SQL"', () => {
    assert.ok(rules.includes('Parameterized SQL'), 'Original "Parameterized SQL" rule missing');
  });

  it('original rule preserved: "Follow least privilege"', () => {
    assert.ok(rules.includes('Follow least privilege'), 'Original "Follow least privilege" rule missing');
  });
});

// ─── Group 3: Supply chain propagation to ALL 14 agent files (SEC-04) ─────

const AGENT_FILES = [
  'agents/gsd-operator.md',
  'agents/gsd-planner.md',
  'agents/gsd-researcher.md',
  'agents/gsd-roadmapper.md',
  'agents/gsd-checker.md',
  'agents/gsd-validator.md',
  'agents/gsd-debugger.md',
  'agents/gsd-executor-backend.md',
  'agents/gsd-executor-frontend.md',
  'agents/gsd-executor-infra.md',
  'agents/gsd-executor-general.md',
  'agents/gsd-tester.md',
  'agents/gsd-qa.md',
  'agents/gsd-security.md',
];

describe('[SEC-04] Supply chain rule propagation: all 14 agents have "npm ci" + 10 sections', () => {
  for (const agentFile of AGENT_FILES) {
    const filePath = path.join(ROOT, agentFile);

    it(`${agentFile} contains supply chain rule (npm ci)`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('npm ci'), `${agentFile} missing supply chain rule (npm ci)`);
    });

    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} sections, expected 10`);
    });
  }
});

// ─── Group 4: Fixture files (SEC-01, SEC-02) ──────────────────────────────

describe('[SEC-01][SEC-02] Test fixture files exist and contain expected patterns', () => {
  const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');

  it('tests/fixtures/34-vulnerable.js exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '34-vulnerable.js')),
      'Missing tests/fixtures/34-vulnerable.js'
    );
  });

  it('tests/fixtures/34-vulnerable.js contains SQL injection pattern', () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, '34-vulnerable.js'), 'utf-8');
    assert.ok(
      content.includes('SQL') || content.toUpperCase().includes('INJECTION'),
      'Missing SQL/injection reference in vulnerable fixture'
    );
  });

  it('tests/fixtures/34-vulnerable.js contains getUserById or searchUsers functions', () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, '34-vulnerable.js'), 'utf-8');
    assert.ok(
      content.includes('getUserById') || content.includes('searchUsers'),
      'Missing expected function names in vulnerable fixture'
    );
  });

  it('tests/fixtures/34-test-secret.txt exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '34-test-secret.txt')),
      'Missing tests/fixtures/34-test-secret.txt'
    );
  });

  it('tests/fixtures/34-test-secret.txt contains detectable key pattern (API_KEY or GITHUB_TOKEN)', () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, '34-test-secret.txt'), 'utf-8');
    assert.ok(
      content.includes('API_KEY') || content.includes('GITHUB_TOKEN'),
      'Missing detectable key pattern in secret fixture'
    );
  });

  it('tests/fixtures/34-test-secret.txt is documented as a test-only fixture', () => {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, '34-test-secret.txt'), 'utf-8');
    assert.ok(
      content.includes('testing-only') || content.includes('NOT a real') || content.includes('testing purposes'),
      'Missing test-only disclaimer in secret fixture'
    );
  });
});

// ─── Group 5: Configuration files (SEC-02, SEC-06) ────────────────────────

describe('[SEC-02][SEC-06] Configuration files: .gitleaks.toml and .semgrep rules', () => {
  it('.gitleaks.toml exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, '.gitleaks.toml')),
      'Missing .gitleaks.toml'
    );
  });

  it('.gitleaks.toml contains tests/fixtures allowlist', () => {
    const content = fs.readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf-8');
    assert.ok(
      content.includes('tests/fixtures'),
      '.gitleaks.toml missing tests/fixtures allowlist'
    );
  });

  it('.semgrep/gsd-amauta-rules.yml exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, '.semgrep', 'gsd-amauta-rules.yml')),
      'Missing .semgrep/gsd-amauta-rules.yml'
    );
  });

  it('.semgrep/gsd-amauta-rules.yml contains gsd-raw-sql-injection rule ID', () => {
    const content = fs.readFileSync(path.join(ROOT, '.semgrep', 'gsd-amauta-rules.yml'), 'utf-8');
    assert.ok(content.includes('gsd-raw-sql-injection'), 'Missing gsd-raw-sql-injection rule');
  });

  it('.semgrep/gsd-amauta-rules.yml contains gsd-hardcoded-localhost rule ID', () => {
    const content = fs.readFileSync(path.join(ROOT, '.semgrep', 'gsd-amauta-rules.yml'), 'utf-8');
    assert.ok(content.includes('gsd-hardcoded-localhost'), 'Missing gsd-hardcoded-localhost rule');
  });

  it('.semgrep/gsd-amauta-rules.yml contains gsd-subprocess-shell-true rule ID', () => {
    const content = fs.readFileSync(path.join(ROOT, '.semgrep', 'gsd-amauta-rules.yml'), 'utf-8');
    assert.ok(content.includes('gsd-subprocess-shell-true'), 'Missing gsd-subprocess-shell-true rule');
  });
});
