'use strict';
/**
 * Phase 40 — Engineering Standards Integration Tests
 * File: tests/40-engineering-standards.integration.test.cjs
 *
 * Requirements covered:
 *   ENG-01..05: Engineering standards propagated and preserved across all agents
 *
 * Complements the unit test (40-engineering-standards.unit.test.cjs) with:
 *   - Diff verification: all 13 agent copies match source of truth (Node fs comparison)
 *   - Existing mandates preserved: anti-over-engineering + read-before-edit
 *   - Security rules still intact: 12 rules in all 14 agents
 *   - CACHE_BREAKPOINT preserved in all 14 agents
 *   - Full regression gate: prior phase test suites pass
 *
 * Pattern: run-once-reuse for child processes (describe-block level spawnSync).
 * No .skip() flaky markers — conditional tool checks use if/else with console.log.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

/**
 * Extract the engineering standards block from an agent file.
 * Returns text from ### Engineering standards to the next ### or ## heading.
 * @param {string} content
 * @returns {string} trimmed block
 */
function extractEngStandards(content) {
  const startMarker = '### Engineering standards';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return '';

  const afterStart = content.indexOf('\n', startIdx);
  const rest = content.slice(afterStart);
  const nextSection = rest.search(/\n###? /);

  let block;
  if (nextSection === -1) {
    block = content.slice(startIdx);
  } else {
    block = content.slice(startIdx, afterStart + nextSection);
  }
  return block.trim();
}

// ─── Agent file lists ────────────────────────────────────────────────────────

const ALL_14_AGENT_FILES = [
  'gsd-executor-backend.md',
  'gsd-executor-frontend.md',
  'gsd-executor-infra.md',
  'gsd-executor-general.md',
  'gsd-operator.md',
  'gsd-researcher.md',
  'gsd-roadmapper.md',
  'gsd-checker.md',
  'gsd-validator.md',
  'gsd-debugger.md',
  'gsd-tester.md',
  'gsd-qa.md',
  'gsd-security.md',
  'gsd-planner.md',
];

const FULL_STANDARD_AGENTS = [
  'gsd-executor-backend.md',
  'gsd-executor-frontend.md',
  'gsd-executor-infra.md',
  'gsd-executor-general.md',
  'gsd-operator.md',
  'gsd-researcher.md',
  'gsd-roadmapper.md',
  'gsd-checker.md',
  'gsd-validator.md',
  'gsd-debugger.md',
  'gsd-tester.md',
  'gsd-qa.md',
  'gsd-security.md',
];

const EXECUTOR_AGENTS = [
  'gsd-executor-backend.md',
  'gsd-executor-frontend.md',
  'gsd-executor-infra.md',
  'gsd-executor-general.md',
];

// ─── Group 1: diff verification — all 13 agent copies match source of truth ──

describe('[ENG-01..05] Diff verification: 13 agent copies match source of truth', () => {
  const srcPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sourceOfTruth = fs.readFileSync(srcPath, 'utf-8').trim();

  for (const agentFile of FULL_STANDARD_AGENTS) {
    it(`${agentFile} engineering standards block is byte-for-byte identical to source of truth`, () => {
      const content = readAgent(agentFile);
      const extracted = extractEngStandards(content);

      if (extracted !== sourceOfTruth) {
        // Find first differing line to aid debugging
        const srcLines = sourceOfTruth.split('\n');
        const agentLines = extracted.split('\n');
        let firstDiff = -1;
        for (let i = 0; i < Math.max(srcLines.length, agentLines.length); i++) {
          if (srcLines[i] !== agentLines[i]) {
            firstDiff = i;
            break;
          }
        }
        assert.fail(
          `${agentFile}: engineering standards block differs from source.\n` +
          `First differing line ${firstDiff}: ` +
          `source="${srcLines[firstDiff]}" agent="${agentLines[firstDiff]}"`
        );
      }
      assert.ok(true); // explicit pass
    });
  }
});

// ─── Group 2: existing mandates preserved — anti-over-engineering + read-before-edit

describe('[FORMAT-04][FORMAT-03] Existing mandates preserved in all 14 agents', () => {
  const ANTI_OVER_ENG = 'Do not add features, refactor code, or make improvements beyond what was explicitly requested.';
  const READ_BEFORE_EDIT = 'Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.';

  for (const agentFile of ALL_14_AGENT_FILES) {
    it(`${agentFile} has anti-over-engineering mandate`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes(ANTI_OVER_ENG),
        `${agentFile} missing anti-over-engineering mandate`
      );
    });
  }

  // Read-before-edit mandate is present in executor + tester/qa/security agents
  for (const agentFile of [...EXECUTOR_AGENTS, 'gsd-tester.md', 'gsd-qa.md', 'gsd-security.md']) {
    it(`${agentFile} has read-before-edit mandate`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes(READ_BEFORE_EDIT),
        `${agentFile} missing read-before-edit mandate`
      );
    });
  }
});

// ─── Group 3: security rules still intact — 12 rules in all 14 agents ────────

describe('[SEC-04] Security rules preserved: 12 rules still intact in all 14 agents', () => {
  for (const agentFile of ALL_14_AGENT_FILES) {
    it(`${agentFile} has ## Security rules section`, () => {
      const content = readAgent(agentFile);
      assert.ok(content.includes('## Security rules'), `${agentFile} missing ## Security rules section`);
    });

    it(`${agentFile} has Parameterized SQL security rule (first rule)`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('Parameterized SQL'),
        `${agentFile} missing Parameterized SQL security rule`
      );
    });

    it(`${agentFile} has supply chain rule: 7 days ago (last supply chain rule)`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('7 days ago'),
        `${agentFile} missing "7 days ago" supply chain rule`
      );
    });
  }
});

// ─── Group 4: CACHE_BREAKPOINT preserved in all 14 agents ────────────────────

describe('[FORMAT] CACHE_BREAKPOINT end-of-file marker preserved in all 14 agents', () => {
  for (const agentFile of ALL_14_AGENT_FILES) {
    it(`${agentFile} has CACHE_BREAKPOINT`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('CACHE_BREAKPOINT'),
        `${agentFile} missing CACHE_BREAKPOINT end-of-file marker`
      );
    });
  }
});

// ─── Group 5: full regression gate ───────────────────────────────────────────
//
// Note: node:test recursive invocation detection prevents nested `node --test`
// calls when this file is itself run with `node --test`. We spawn a fresh node
// process with NODE_TEST_CONTEXT unset so the inner runner is independent.

describe('[ENG-01..05] Full regression gate: prior phase test suites pass', () => {
  // Run once at describe-block level and reuse across all it() assertions.
  // Spawn a fresh node process (not inheriting NODE_TEST_CONTEXT) to avoid
  // the recursive run() detection in node:test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync('node', [
    '--test',
    'tests/31-format-regression.test.cjs',
    'tests/33-agent-format.unit.test.cjs',
    'tests/34-agent-format.unit.test.cjs',
    'tests/40-engineering-standards.unit.test.cjs',
  ], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 60000,
    env,
  });

  it('regression gate exits 0 (all prior phase tests pass)', () => {
    assert.strictEqual(
      result.status,
      0,
      `Regression gate failed with exit ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('regression gate output contains "fail 0" (node:test summary in stderr)', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('fail 0'),
      `Regression gate did not report "fail 0".\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });
});
