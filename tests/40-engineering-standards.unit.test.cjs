'use strict';
/**
 * Phase 40 — Engineering Standards Unit Tests
 * File: tests/40-engineering-standards.unit.test.cjs
 *
 * Requirements covered:
 *   ENG-01: Git workflow standards in all agents
 *   ENG-02: Error handling standards in all agents
 *   ENG-03: Documentation standards in all agents
 *   ENG-04: Configuration management standards in all agents
 *   ENG-05: Structured logging standards in all agents
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

/**
 * Extract the engineering standards block from agent file content.
 * Finds text from `### Engineering standards` to the next `### ` or `## ` heading.
 * @param {string} content - full agent file content
 * @returns {string} trimmed engineering standards block
 */
function extractEngStandards(content) {
  const startMarker = '### Engineering standards';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return '';

  // Find the next ### or ## after the start
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

// ─── Group 1: Source of truth file exists and is well-formed ────────────────

describe('[ENG-01..05] agents/shared/engineering-standards.md: source of truth', () => {
  const srcPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');

  it('file exists', () => {
    assert.ok(fs.existsSync(srcPath), 'agents/shared/engineering-standards.md does not exist');
  });

  it('file starts with ### Engineering standards', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(
      content.trimStart().startsWith('### Engineering standards'),
      'Source file does not start with "### Engineering standards"'
    );
  });

  it('[ENG-01] contains #### Git workflow (ENG-01) sub-heading', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(content.includes('#### Git workflow (ENG-01)'), 'Missing #### Git workflow (ENG-01)');
  });

  it('[ENG-02] contains #### Error handling (ENG-02) sub-heading', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(content.includes('#### Error handling (ENG-02)'), 'Missing #### Error handling (ENG-02)');
  });

  it('[ENG-03] contains #### Documentation (ENG-03) sub-heading', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(content.includes('#### Documentation (ENG-03)'), 'Missing #### Documentation (ENG-03)');
  });

  it('[ENG-04] contains #### Configuration management (ENG-04) sub-heading', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(
      content.includes('#### Configuration management (ENG-04)'),
      'Missing #### Configuration management (ENG-04)'
    );
  });

  it('[ENG-05] contains #### Structured logging (ENG-05) sub-heading', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(content.includes('#### Structured logging (ENG-05)'), 'Missing #### Structured logging (ENG-05)');
  });

  it('has at least 14 bullet rules (lines starting with "- ")', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    const count = (content.match(/^- /gm) || []).length;
    assert.ok(count >= 14, `Expected >= 14 bullet rules, found ${count}`);
  });

  it('has zero ## level headings (only ### and ####)', () => {
    const content = fs.readFileSync(srcPath, 'utf-8');
    const count = (content.match(/^## /gm) || []).length;
    assert.strictEqual(count, 0, `Source file has ${count} ## headings — should have 0`);
  });
});

// ─── Group 2: All 13 agents have identical engineering standards ─────────────

describe('[ENG-01..05] 13 agents (excluding planner): content-identical to source of truth', () => {
  const srcPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sourceOfTruth = fs.readFileSync(srcPath, 'utf-8').trim();

  for (const agentFile of FULL_STANDARD_AGENTS) {
    it(`${agentFile} contains ### Engineering standards`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('### Engineering standards'),
        `${agentFile} missing ### Engineering standards`
      );
    });

    it(`${agentFile} engineering standards block is content-identical to source of truth`, () => {
      const content = readAgent(agentFile);
      const extracted = extractEngStandards(content);
      assert.strictEqual(
        extracted,
        sourceOfTruth,
        `${agentFile} engineering standards block differs from agents/shared/engineering-standards.md`
      );
    });
  }
});

// ─── Group 3: gsd-planner has ONLY git workflow standards (not full ENG) ────

describe('[ENG-01] gsd-planner: git workflow standards only (not full engineering standards)', () => {
  const planner = readAgent('gsd-planner.md');

  it('contains ### Git workflow standards', () => {
    assert.ok(
      planner.includes('### Git workflow standards'),
      'gsd-planner.md missing ### Git workflow standards'
    );
  });

  it('does NOT contain ### Engineering standards', () => {
    assert.ok(
      !planner.includes('### Engineering standards'),
      'gsd-planner.md should NOT contain ### Engineering standards (only git workflow subset)'
    );
  });

  it('[ENG-01] contains conventional commits reference', () => {
    assert.ok(planner.includes('conventional commits'), 'gsd-planner.md missing conventional commits reference');
  });

  it('[ENG-01] contains feat/ branch prefix', () => {
    assert.ok(planner.includes('feat/'), 'gsd-planner.md missing feat/ branch prefix');
  });

  it('[ENG-02] does NOT contain #### Error handling (ENG-02)', () => {
    assert.ok(
      !planner.includes('#### Error handling (ENG-02)'),
      'gsd-planner.md should NOT have #### Error handling (ENG-02) — planner-specific exclusion'
    );
  });

  it('[ENG-04] does NOT contain #### Configuration management (ENG-04)', () => {
    assert.ok(
      !planner.includes('#### Configuration management (ENG-04)'),
      'gsd-planner.md should NOT have #### Configuration management (ENG-04) — planner-specific exclusion'
    );
  });
});

// ─── Group 4: Section count regression — all 14 agents have exactly 10 ## sections

describe('[FORMAT-01] Section count regression: all 14 agents have exactly 10 ## sections', () => {
  for (const agentFile of ALL_14_AGENT_FILES) {
    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = readAgent(agentFile);
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(
        count,
        10,
        `${agentFile} has ${count} ## sections, expected 10`
      );
    });
  }
});

// ─── Group 5: ENG-specific keyword presence in executor agents ───────────────

describe('[ENG-01..05] ENG keyword presence in all 4 executor agents', () => {
  for (const agentFile of EXECUTOR_AGENTS) {
    it(`[ENG-01] ${agentFile} contains "conventional commits"`, () => {
      const content = readAgent(agentFile);
      assert.ok(content.includes('conventional commits'), `${agentFile} missing ENG-01 keyword: conventional commits`);
    });

    it(`[ENG-02] ${agentFile} contains "Structured error objects"`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('Structured error objects'),
        `${agentFile} missing ENG-02 keyword: Structured error objects`
      );
    });

    it(`[ENG-03] ${agentFile} contains "JSDoc on all"`, () => {
      const content = readAgent(agentFile);
      assert.ok(content.includes('JSDoc on all'), `${agentFile} missing ENG-03 keyword: JSDoc on all`);
    });

    it(`[ENG-04] ${agentFile} contains "Never hardcode URLs"`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('Never hardcode URLs'),
        `${agentFile} missing ENG-04 keyword: Never hardcode URLs`
      );
    });

    it(`[ENG-05] ${agentFile} contains "console.log" (in logging standard context)`, () => {
      const content = readAgent(agentFile);
      assert.ok(content.includes('console.log'), `${agentFile} missing ENG-05 keyword: console.log`);
    });
  }
});
