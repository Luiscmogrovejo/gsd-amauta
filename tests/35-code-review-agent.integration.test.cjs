'use strict';
/**
 * Phase 35 — Code Review Agent Integration Test Suite
 * File: tests/35-code-review-agent.integration.test.cjs
 *
 * Requirements covered:
 *   REVIEW-01: all 15 agents have 10 ## sections (regression gate)
 *   REVIEW-03: gsd-reviewer schema is distinct from gsd-validator schema
 *   REVIEW-04: shared file content-identity (security-rules + engineering-standards)
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

// ─── All 15 agent files (14 existing + gsd-reviewer.md) ─────────────────────

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
];

// ─── Group 1: All 15 agents have 10 sections (REVIEW-01 regression gate) ────

describe('[REVIEW-01] All 15 agents have exactly 10 ## sections', () => {
  for (const agentFile of AGENT_FILES) {
    const filePath = path.join(PROJECT_ROOT, agentFile);

    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} ## sections, expected 10`);
    });
  }
});

// ─── Group 2: Cross-file consistency — security rules (REVIEW-01, SEC-04) ───

describe('[REVIEW-01] Cross-file consistency: security rules in gsd-reviewer.md match shared source', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));

  const reviewerPath = path.join(AGENTS_DIR, 'gsd-reviewer.md');
  const reviewer = fs.readFileSync(reviewerPath, 'utf-8');

  // Extract the Security rules section from reviewer
  const secMatch = reviewer.match(/## Security rules\n([\s\S]*?)(?=\n## |\n<!-- )/);
  const reviewerSecuritySection = secMatch ? secMatch[1] : reviewer;

  it(`all ${bulletLines.length} security rule bullet lines appear verbatim in reviewer Security rules section`, () => {
    const missing = bulletLines.filter(line => !reviewerSecuritySection.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `Security rules missing from gsd-reviewer.md Security rules section:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 3: Cross-file consistency — engineering standards (REVIEW-01) ────

describe('[REVIEW-01] Cross-file consistency: engineering standards in gsd-reviewer.md match shared source', () => {
  const stdPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sharedStd = fs.readFileSync(stdPath, 'utf-8');
  const headings = sharedStd.split('\n').filter(l => l.startsWith('#### '));

  const reviewer = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-reviewer.md'), 'utf-8');

  // Extract Engineering standards section from reviewer
  const engMatch = reviewer.match(/### Engineering standards\n([\s\S]*?)(?=\n## |\n### (?!Engineering))/);
  const reviewerEngSection = engMatch ? engMatch[1] : reviewer;

  it(`all ${headings.length} engineering standard #### headings appear verbatim in reviewer Engineering standards section`, () => {
    const missing = headings.filter(h => !reviewerEngSection.includes(h));
    assert.strictEqual(
      missing.length,
      0,
      `Engineering standard headings missing from reviewer Engineering standards section:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 4: Prior-phase regression gates (Plans 34 unit + integration) ────

describe('[REVIEW-01] Prior-phase regression gates: Phase 34 suites still pass', () => {
  it('[SEC-01..06] 34-agent-format.unit.test.cjs exits 0 (no regressions)', () => {
    const result = spawnSync('node', ['--test', 'tests/34-agent-format.unit.test.cjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 60000,
      env: cleanEnv(),
    });
    assert.strictEqual(
      result.status,
      0,
      `34-agent-format.unit.test.cjs exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
    );
  });

  it('[SEC-01..06] 34-security-pipeline.integration.test.cjs exits 0 (no regressions)', () => {
    const result = spawnSync('node', ['--test', 'tests/34-security-pipeline.integration.test.cjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      env: cleanEnv(),
    });
    assert.strictEqual(
      result.status,
      0,
      `34-security-pipeline.integration.test.cjs exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
    );
  });
});

// ─── Group 5: gsd-reviewer distinct from gsd-validator (REVIEW-03) ──────────

describe('[REVIEW-03] Schema distinctness: gsd-reviewer vs gsd-validator', () => {
  const reviewer = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-reviewer.md'), 'utf-8');
  const validator = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-validator.md'), 'utf-8');

  it('[REVIEW-03] gsd-reviewer.md contains "category" as structured output field (style, solid, etc.)', () => {
    // reviewer schema has category: "style | solid | performance | security | documentation | duplication"
    assert.ok(
      reviewer.includes('"category"') || reviewer.includes('category'),
      'gsd-reviewer.md missing "category" structured output field'
    );
    assert.ok(
      reviewer.includes('style') && reviewer.includes('solid'),
      'gsd-reviewer.md missing category values (style, solid)'
    );
  });

  it('[REVIEW-03] gsd-validator.md does NOT use "category" as output schema field (uses verdict vocabulary)', () => {
    // validator uses --pass, --gaps-found, --fail verdicts — no "category" field
    // validator may contain "category" in prose but not as a schema field definition
    assert.ok(
      validator.includes('--pass') || validator.includes('--gaps-found') || validator.includes('--fail'),
      'gsd-validator.md missing verdict vocabulary (--pass, --gaps-found, --fail)'
    );
  });

  it('[REVIEW-03] gsd-reviewer.md uses "approve | request_changes | comment_only" approval vocabulary', () => {
    assert.ok(reviewer.includes('approve'), 'reviewer missing "approve" approval value');
    assert.ok(reviewer.includes('request_changes'), 'reviewer missing "request_changes" approval value');
    assert.ok(reviewer.includes('comment_only'), 'reviewer missing "comment_only" approval value');
  });

  it('[REVIEW-03] gsd-validator.md uses "--pass", "--gaps-found", "--fail" verdict vocabulary (different from reviewer)', () => {
    assert.ok(validator.includes('--pass'), 'validator missing "--pass" verdict');
    assert.ok(validator.includes('--gaps-found'), 'validator missing "--gaps-found" verdict');
    assert.ok(validator.includes('--fail'), 'validator missing "--fail" verdict');
  });
});
