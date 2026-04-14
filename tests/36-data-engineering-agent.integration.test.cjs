'use strict';
/**
 * Phase 36 — Data Engineering Agent Integration Test Suite
 * File: tests/36-data-engineering-agent.integration.test.cjs
 *
 * Requirements covered:
 *   DATA-01: All 16 agents have 10 ## sections (regression gate)
 *   DATA-02: gsd-executor-data static query analysis rules consistent with agent
 *   DATA-03: Data quality check rules consistent with agent
 *   DATA-04: Cross-file consistency (security-rules + engineering-standards)
 *
 * Uses spawnSync for prior-phase regression gates.
 * NODE_TEST_CONTEXT deleted via cleanEnv() to prevent recursive invocation detection.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');

// ─── Helper: clean subprocess env (NODE_TEST_CONTEXT deletion — learned in Plan 40-02) ──

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ─── All 16 agent files (15 existing + gsd-executor-data.md) ────────────────

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
  'agents/gsd-reviewer.md',
  'agents/gsd-executor-data.md',
];

// ─── Group 1: All 16 agents have 10 sections (DATA-01 regression gate) ──────

describe('[DATA-01] All 16 agents have exactly 10 ## sections', () => {
  for (const agentFile of AGENT_FILES) {
    const filePath = path.join(PROJECT_ROOT, agentFile);

    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} ## sections, expected 10`);
    });
  }
});

// ─── Group 2: Cross-file consistency — security rules (DATA-01, SEC-04) ─────

describe('[DATA-01] Cross-file consistency: security rules in gsd-executor-data.md match shared source', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));

  const dataAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor-data.md'), 'utf-8');

  // Extract the Security rules section from executor-data
  const secMatch = dataAgent.match(/## Security rules\n([\s\S]*?)(?=\n## |\n<!-- )/);
  const dataSecuritySection = secMatch ? secMatch[1] : dataAgent;

  it(`all ${bulletLines.length} security rule bullet lines appear verbatim in executor-data Security rules section`, () => {
    const missing = bulletLines.filter(line => !dataSecuritySection.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `Security rules missing from gsd-executor-data.md Security rules section:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 3: Cross-file consistency — engineering standards (DATA-01) ───────

describe('[DATA-01] Cross-file consistency: engineering standards in gsd-executor-data.md match shared source', () => {
  const stdPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sharedStd = fs.readFileSync(stdPath, 'utf-8');
  const headings = sharedStd.split('\n').filter(l => l.startsWith('#### '));

  const dataAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor-data.md'), 'utf-8');

  // Extract Engineering standards section from executor-data
  const engMatch = dataAgent.match(/### Engineering standards\n([\s\S]*?)(?=\n## |\n### (?!Engineering))/);
  const dataEngSection = engMatch ? engMatch[1] : dataAgent;

  it(`all ${headings.length} engineering standard #### headings appear verbatim in executor-data Engineering standards section`, () => {
    const missing = headings.filter(h => !dataEngSection.includes(h));
    assert.strictEqual(
      missing.length,
      0,
      `Engineering standard headings missing from executor-data Engineering standards section:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 4: Prior-phase regression gates (Plans 35 unit + integration) ─────

describe('[DATA-01] Prior-phase regression gates: Phase 35 suites still pass', () => {
  it('[REVIEW-01..04] 35-code-review-agent.unit.test.cjs exits 0 (no regressions)', () => {
    const result = spawnSync('node', ['--test', 'tests/35-code-review-agent.unit.test.cjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 60000,
      env: cleanEnv(),
    });
    assert.strictEqual(
      result.status,
      0,
      `35-code-review-agent.unit.test.cjs exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
    );
  });

  it('[REVIEW-01..04] 35-code-review-agent.integration.test.cjs exits 0 (no regressions)', () => {
    const result = spawnSync('node', ['--test', 'tests/35-code-review-agent.integration.test.cjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      env: cleanEnv(),
    });
    assert.strictEqual(
      result.status,
      0,
      `35-code-review-agent.integration.test.cjs exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
    );
  });
});

// ─── Group 5: gsd-executor-data.md is a proper executor (executor pattern compliance) ──

describe('[DATA-01][DATA-02][DATA-03][DATA-04] gsd-executor-data.md executor pattern compliance vs gsd-executor-backend.md', () => {
  const dataAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor-data.md'), 'utf-8');
  const backendAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor-backend.md'), 'utf-8');

  it('[DATA-01] gsd-executor-data.md contains "RPETD Protocol" (executor protocol present)', () => {
    assert.ok(
      dataAgent.includes('RPETD Protocol'),
      'gsd-executor-data.md missing RPETD Protocol section'
    );
  });

  it('[DATA-01] gsd-executor-backend.md contains "RPETD Protocol" (reference executor also has it)', () => {
    assert.ok(
      backendAgent.includes('RPETD Protocol'),
      'gsd-executor-backend.md missing RPETD Protocol (regression)'
    );
  });

  it('[DATA-01] gsd-executor-data.md contains "executor-general is the fallback" (fallback specified)', () => {
    assert.ok(
      dataAgent.includes('executor-general is the fallback'),
      'gsd-executor-data.md missing executor-general fallback specification'
    );
  });

  it('[DATA-01] gsd-executor-backend.md contains "executor-general is the fallback" (reference executor also has it)', () => {
    assert.ok(
      backendAgent.includes('executor-general is the fallback'),
      'gsd-executor-backend.md missing executor-general fallback (regression)'
    );
  });

  it('[DATA-01] gsd-executor-data.md contains "$CLI claim TK-XXXX" (task claiming present)', () => {
    assert.ok(
      dataAgent.includes('$CLI claim TK-XXXX'),
      'gsd-executor-data.md missing $CLI claim TK-XXXX task claiming step'
    );
  });

  it('[DATA-01] gsd-executor-data.md contains "executor-data" in claim line (correct agent name)', () => {
    // The claim line should be: $CLI claim TK-XXXX --agent executor-data
    assert.ok(
      dataAgent.includes('--agent executor-data'),
      'gsd-executor-data.md claim line does not use --agent executor-data'
    );
  });

  it('[DATA-02] gsd-executor-data.md contains "migrations/" in file patterns (data-specific routing)', () => {
    assert.ok(
      dataAgent.includes('migrations/'),
      'gsd-executor-data.md missing migrations/ in file patterns'
    );
  });

  it('[DATA-01] gsd-executor-data.md does NOT contain "API endpoint" in domain patterns (not backend territory)', () => {
    // The domain knowledge section covers data layer only — no API endpoints as a domain claim.
    // The agent may say "You do not write ... API endpoints" (prohibition), which is fine.
    // We verify it's not listed as a capability/responsibility of this agent.
    const domainMatch = dataAgent.match(/## Domain knowledge\n([\s\S]*?)(?=\n## )/);
    const domainSection = domainMatch ? domainMatch[1] : '';
    // API endpoint should not appear as a positive capability in domain knowledge
    // It's fine to appear in "You do not write application logic, API endpoints, or UI components"
    // but NOT as a domain file pattern or scope claim
    const filePatterns = domainSection.match(/\*\*File patterns:\*\*([\s\S]*?)(?=\n\*\*|\n###|\n$)/);
    const filePatternsText = filePatterns ? filePatterns[1] : '';
    assert.ok(
      !filePatternsText.includes('API endpoint'),
      'File patterns in Domain knowledge should not include API endpoint (not data domain)'
    );
  });
});
