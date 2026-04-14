'use strict';
/**
 * Phase 37 -- Architect Agent Integration Test Suite
 * File: tests/37-architect-agent.integration.test.cjs
 *
 * Requirements covered:
 *   ARCH-01: All 17 agents have 10 ## sections (regression gate); ADR directory structure
 *   ARCH-02: Cross-file consistency (security-rules + engineering-standards)
 *   ARCH-03: Architect-specific boundary and N+1 pattern verification
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
const ADR_DIR = path.join(PROJECT_ROOT, 'docs', 'adr');

// ─── Helper: clean subprocess env (NODE_TEST_CONTEXT deletion — learned in Plan 40-02) ──

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ─── All 17 agent files (16 existing + gsd-architect.md) ─────────────────────

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
  'agents/gsd-architect.md',
];

// ─── Group 1: All 17 agents have 10 sections (ARCH-01 regression gate) ───────

describe('[ARCH-01] All 17 agents have exactly 10 ## sections', () => {
  for (const agentFile of AGENT_FILES) {
    const filePath = path.join(PROJECT_ROOT, agentFile);

    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} ## sections, expected 10`);
    });
  }
});

// ─── Group 2: Cross-file consistency -- security rules (ARCH-01, SEC-04) ─────

describe('[ARCH-01] Cross-file consistency: security rules in gsd-architect.md match shared source', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));

  const architectAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-architect.md'), 'utf-8');

  // Extract the Security rules section from architect
  const secMatch = architectAgent.match(/## Security rules\n([\s\S]*?)(?=\n## |\n<!-- )/);
  const architectSecuritySection = secMatch ? secMatch[1] : architectAgent;

  it(`all ${bulletLines.length} security rule bullet lines appear verbatim in gsd-architect.md Security rules section`, () => {
    const missing = bulletLines.filter(line => !architectSecuritySection.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `Security rules missing from gsd-architect.md Security rules section:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 3: Cross-file consistency -- engineering standards (ARCH-01) ───────

describe('[ARCH-01] Cross-file consistency: engineering standards in gsd-architect.md match shared source', () => {
  const stdPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sharedStd = fs.readFileSync(stdPath, 'utf-8');
  const headings = sharedStd.split('\n').filter(l => l.startsWith('#### '));

  const architectAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-architect.md'), 'utf-8');

  // Extract Engineering standards section from architect
  const engMatch = architectAgent.match(/### Engineering standards\n([\s\S]*?)(?=\n## |\n### (?!Engineering))/);
  const architectEngSection = engMatch ? engMatch[1] : architectAgent;

  it(`all ${headings.length} engineering standard #### headings appear verbatim in gsd-architect.md Engineering standards section`, () => {
    const missing = headings.filter(h => !architectEngSection.includes(h));
    assert.strictEqual(
      missing.length,
      0,
      `Engineering standard headings missing from architect Engineering standards section:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 4: Prior-phase regression gates (Phases 35, 36) ───────────────────

describe('[ARCH-01] Prior-phase regression gates: Phase 35 and 36 suites still pass', () => {
  it('[REVIEW-01..04] 36-data-engineering-agent.unit.test.cjs exits 0 (no regressions)', () => {
    const result = spawnSync('node', ['--test', 'tests/36-data-engineering-agent.unit.test.cjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 60000,
      env: cleanEnv(),
    });
    assert.strictEqual(
      result.status,
      0,
      `36-data-engineering-agent.unit.test.cjs exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
    );
  });

  it('[DATA-01..04] 36-data-engineering-agent.integration.test.cjs exits 0 (no regressions)', () => {
    const result = spawnSync('node', ['--test', 'tests/36-data-engineering-agent.integration.test.cjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      env: cleanEnv(),
    });
    assert.strictEqual(
      result.status,
      0,
      `36-data-engineering-agent.integration.test.cjs exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
    );
  });
});

// ─── Group 5: Architect-specific boundary and pattern verification ─────────────

describe('[ARCH-01][ARCH-02][ARCH-03] gsd-architect.md: boundary compliance and non-overlap verification', () => {
  const architectAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-architect.md'), 'utf-8');
  const reviewerAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-reviewer.md'), 'utf-8');
  const executorDataAgent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor-data.md'), 'utf-8');

  it('[ARCH-01] gsd-architect.md contains "RPETD Protocol" (protocol present)', () => {
    assert.ok(
      architectAgent.includes('RPETD Protocol'),
      'gsd-architect.md missing RPETD Protocol section'
    );
  });

  it('[ARCH-01] gsd-architect.md contains "gsd-executor-general is the fallback" (fallback specified)', () => {
    assert.ok(
      architectAgent.includes('gsd-executor-general is the fallback'),
      'gsd-architect.md missing gsd-executor-general fallback specification'
    );
  });

  it('[ARCH-01] gsd-architect.md contains "$CLI claim TK-XXXX" (task claiming present)', () => {
    assert.ok(
      architectAgent.includes('$CLI claim TK-XXXX'),
      'gsd-architect.md missing $CLI claim TK-XXXX task claiming step'
    );
  });

  it('[ARCH-01] gsd-architect.md contains "gsd-architect" in claim line (correct agent name)', () => {
    assert.ok(
      architectAgent.includes('--agent gsd-architect'),
      'gsd-architect.md claim line does not use --agent gsd-architect'
    );
  });

  it('[ARCH-01] gsd-architect.md contains "review mode" AND "write mode" (hybrid nature)', () => {
    assert.ok(architectAgent.includes('review mode'), 'gsd-architect.md missing "review mode"');
    assert.ok(architectAgent.includes('write mode'), 'gsd-architect.md missing "write mode"');
  });

  it('[ARCH-01] gsd-architect.md does NOT contain "500 lines" (reviewer god-class rule, not architect)', () => {
    assert.ok(
      !architectAgent.includes('500 lines'),
      'gsd-architect.md should NOT contain "500 lines" threshold (that is reviewer\'s god class rule)'
    );
  });

  it('[ARCH-01] gsd-reviewer.md contains "You review code and produce findings" (code-level scope, distinct from architect)', () => {
    assert.ok(
      reviewerAgent.includes('You review code and produce findings'),
      'gsd-reviewer.md missing "You review code and produce findings" boundary'
    );
  });

  it('[ARCH-03] gsd-executor-data.md contains "Static analysis of SQL" (SQL-level N+1 vs architect design-level)', () => {
    assert.ok(
      executorDataAgent.includes('Static analysis of SQL'),
      'gsd-executor-data.md missing "Static analysis of SQL" — SQL-level N+1 detection distinct from architect design-level'
    );
  });
});

// ─── Group 6: ADR directory verification (ARCH-01) ────────────────────────────

describe('[ARCH-01] ADR directory: structure and content verification', () => {

  it('[ARCH-01] docs/adr/ directory exists with at least 2 files', () => {
    assert.ok(
      fs.existsSync(ADR_DIR),
      'docs/adr/ directory does not exist'
    );
    const files = fs.readdirSync(ADR_DIR).filter(f => f.endsWith('.md'));
    assert.ok(
      files.length >= 2,
      `docs/adr/ has ${files.length} .md files, expected >= 2`
    );
  });

  it('[ARCH-01] docs/adr/000-template.md has all 5 section headings', () => {
    const template = fs.readFileSync(path.join(ADR_DIR, '000-template.md'), 'utf-8');
    assert.ok(template.includes('## Status'), 'Missing ## Status in ADR template');
    assert.ok(template.includes('## Context'), 'Missing ## Context in ADR template');
    assert.ok(template.includes('## Decision'), 'Missing ## Decision in ADR template');
    assert.ok(template.includes('## Consequences'), 'Missing ## Consequences in ADR template');
    assert.ok(template.includes('Alternatives'), 'Missing Alternatives in ADR template');
  });

  it('[ARCH-01] docs/adr/001-postgresql-pgvector.md has accepted status and mentions pgvector', () => {
    const adr = fs.readFileSync(path.join(ADR_DIR, '001-postgresql-pgvector.md'), 'utf-8');
    assert.ok(adr.includes('accepted'), 'ADR 001 missing accepted status');
    assert.ok(adr.includes('pgvector'), 'ADR 001 missing pgvector mention');
  });
});
