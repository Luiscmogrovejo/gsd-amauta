'use strict';
/**
 * Plan 39-02: Canary Suite — 50 deterministic tests covering all 10 requirement categories
 * File: tests/39-canary-suite.test.cjs
 *
 * Requirements covered:
 *   FORMAT-01..07: Agent format standard (10-section, version, security, anti-over-engineering)
 *   FRONT-01..07:  Frontend agent rules (progressive gen, mandatory stack, WCAG, Playwright)
 *   TEST-01..08:   Testing pipeline (CoverUp, coverage ratchet, Pact contracts)
 *   SEC-01..06:    Security pipeline (Semgrep, Gitleaks, supply chain, install script)
 *   REVIEW-01..04: Code review agent (detection rules, structured output, approval field)
 *   DATA-01..04:   Data engineering (expand-and-contract, EXPLAIN ANALYZE, migration numbering)
 *   ARCH-01..03:   Architect agent (ADR, API design, N+1 detection, docs/adr/ directory)
 *   COMM-01..05:   Blackboard communication (migrations 014/015, conflict-resolution, handoff, 17 agents)
 *   LIFE-01..05:   Lifecycle management (migration 016, changelog, tool-integrity, versions, operator rules)
 *   ENG-01..05:    Engineering standards (git workflow, error handling, documentation, logging)
 *
 * All tests are DETERMINISTIC grep/fs-based — NOT LLM output quality tests.
 * Uses node:test + node:assert/strict. No child process spawns. Runs in < 5 minutes.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS = path.join(ROOT, 'agents');
const SCRIPTS = path.join(ROOT, 'scripts');
const MIGRATIONS = path.join(ROOT, 'migrations');

/** Read an agent file by base name (no extension). */
function agent(name) {
  return fs.readFileSync(path.join(AGENTS, `${name}.md`), 'utf-8');
}

/** Count how many ## headings are at the top level. */
function sectionCount(content) {
  return (content.match(/^## /gm) || []).length;
}

// ─── FORMAT ──────────────────────────────────────────────────────────────────

describe('FORMAT: agent format standard', () => {
  it('FORMAT: 10-section count for gsd-operator', () => {
    assert.strictEqual(sectionCount(agent('gsd-operator')), 10);
  });

  it('FORMAT: 10-section count for gsd-executor-backend', () => {
    assert.strictEqual(sectionCount(agent('gsd-executor-backend')), 10);
  });

  it('FORMAT: 10-section count for gsd-security', () => {
    assert.strictEqual(sectionCount(agent('gsd-security')), 10);
  });

  it('FORMAT: agents/shared/security-rules.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'shared', 'security-rules.md')),
      'agents/shared/security-rules.md does not exist'
    );
  });

  it('FORMAT: anti-over-engineering mandate present in gsd-executor-general', () => {
    assert.ok(
      agent('gsd-executor-general').includes(
        'Do not add features, refactor code, or make improvements beyond what was explicitly requested.'
      ),
      'gsd-executor-general missing anti-over-engineering mandate'
    );
  });
});

// ─── FRONT ───────────────────────────────────────────────────────────────────

describe('FRONT: frontend agent rules', () => {
  it('FRONT: gsd-executor-frontend.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-executor-frontend.md')),
      'gsd-executor-frontend.md does not exist'
    );
  });

  it('FRONT: progressive generation rule present', () => {
    assert.ok(
      agent('gsd-executor-frontend').includes('progressive'),
      'gsd-executor-frontend missing progressive generation rule'
    );
  });

  it('FRONT: mandatory stack rule present', () => {
    assert.ok(
      agent('gsd-executor-frontend').includes('mandatory stack'),
      'gsd-executor-frontend missing mandatory stack rule'
    );
  });

  it('FRONT: WCAG rule present', () => {
    assert.ok(
      agent('gsd-executor-frontend').includes('WCAG'),
      'gsd-executor-frontend missing WCAG rule'
    );
  });

  it('FRONT: Playwright screenshot rule present', () => {
    assert.ok(
      agent('gsd-executor-frontend').includes('Playwright'),
      'gsd-executor-frontend missing Playwright screenshot rule'
    );
  });
});

// ─── TEST ────────────────────────────────────────────────────────────────────

describe('TEST: testing pipeline rules', () => {
  it('TEST: gsd-tester.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-tester.md')),
      'gsd-tester.md does not exist'
    );
  });

  it('TEST: gsd-qa.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-qa.md')),
      'gsd-qa.md does not exist'
    );
  });

  it('TEST: CoverUp rule present in gsd-tester', () => {
    assert.ok(
      agent('gsd-tester').includes('CoverUp'),
      'gsd-tester missing CoverUp rule'
    );
  });

  it('TEST: coverage ratchet rule present in gsd-qa', () => {
    assert.ok(
      agent('gsd-qa').includes('coverage ratchet'),
      'gsd-qa missing coverage ratchet rule'
    );
  });

  it('TEST: Pact mention present in gsd-tester', () => {
    assert.ok(
      agent('gsd-tester').includes('Pact') || agent('gsd-tester').includes('pact'),
      'gsd-tester missing Pact mention'
    );
  });
});

// ─── SEC ─────────────────────────────────────────────────────────────────────

describe('SEC: security pipeline rules', () => {
  it('SEC: gsd-security.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-security.md')),
      'gsd-security.md does not exist'
    );
  });

  it('SEC: Semgrep rule present in gsd-security', () => {
    assert.ok(
      agent('gsd-security').includes('Semgrep'),
      'gsd-security missing Semgrep rule'
    );
  });

  it('SEC: Gitleaks rule present in gsd-security', () => {
    assert.ok(
      agent('gsd-security').includes('Gitleaks'),
      'gsd-security missing Gitleaks rule'
    );
  });

  it('SEC: supply chain rules in shared security-rules.md (count >= 12)', () => {
    const content = fs.readFileSync(
      path.join(AGENTS, 'shared', 'security-rules.md'),
      'utf-8'
    );
    const bulletCount = (content.match(/^- /gm) || []).length;
    assert.ok(bulletCount >= 12, `security-rules.md has ${bulletCount} bullet rules, expected >= 12`);
  });

  it('SEC: scripts/install-gitleaks.cjs exists', () => {
    assert.ok(
      fs.existsSync(path.join(SCRIPTS, 'install-gitleaks.cjs')),
      'scripts/install-gitleaks.cjs does not exist'
    );
  });
});

// ─── REVIEW ──────────────────────────────────────────────────────────────────

describe('REVIEW: code review agent rules', () => {
  it('REVIEW: gsd-reviewer.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-reviewer.md')),
      'gsd-reviewer.md does not exist'
    );
  });

  it('REVIEW: 10-section format preserved', () => {
    assert.strictEqual(sectionCount(agent('gsd-reviewer')), 10);
  });

  it('REVIEW: detection rules table present', () => {
    assert.ok(
      agent('gsd-reviewer').includes('| # | Rule'),
      'gsd-reviewer missing detection rules table (| # | Rule header)'
    );
  });

  it('REVIEW: structured output schema present (approval field)', () => {
    assert.ok(
      agent('gsd-reviewer').includes('"approval"'),
      'gsd-reviewer missing "approval" field in structured output schema'
    );
  });

  it('REVIEW: request_changes value present', () => {
    assert.ok(
      agent('gsd-reviewer').includes('request_changes'),
      'gsd-reviewer missing request_changes value'
    );
  });
});

// ─── DATA ────────────────────────────────────────────────────────────────────

describe('DATA: data engineering agent rules', () => {
  it('DATA: gsd-executor-data.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-executor-data.md')),
      'gsd-executor-data.md does not exist'
    );
  });

  it('DATA: expand-and-contract rule present', () => {
    assert.ok(
      agent('gsd-executor-data').includes('expand-and-contract'),
      'gsd-executor-data missing expand-and-contract rule'
    );
  });

  it('DATA: EXPLAIN ANALYZE rule present', () => {
    assert.ok(
      agent('gsd-executor-data').includes('EXPLAIN ANALYZE'),
      'gsd-executor-data missing EXPLAIN ANALYZE rule'
    );
  });

  it('DATA: migration numbering rule present', () => {
    assert.ok(
      agent('gsd-executor-data').includes('migration numbering') ||
        agent('gsd-executor-data').includes('dynamic migration'),
      'gsd-executor-data missing migration numbering rule'
    );
  });

  it('DATA: 10-section format preserved', () => {
    assert.strictEqual(sectionCount(agent('gsd-executor-data')), 10);
  });
});

// ─── ARCH ────────────────────────────────────────────────────────────────────

describe('ARCH: architect agent rules', () => {
  it('ARCH: gsd-architect.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'gsd-architect.md')),
      'gsd-architect.md does not exist'
    );
  });

  it('ARCH: ADR rule present', () => {
    assert.ok(
      agent('gsd-architect').includes('ADR'),
      'gsd-architect missing ADR rule'
    );
  });

  it('ARCH: API design review rule present', () => {
    assert.ok(
      agent('gsd-architect').includes('API design'),
      'gsd-architect missing API design review rule'
    );
  });

  it('ARCH: N+1 detection rule present', () => {
    assert.ok(
      agent('gsd-architect').includes('N+1'),
      'gsd-architect missing N+1 detection rule'
    );
  });

  it('ARCH: docs/adr/ directory exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', 'adr')),
      'docs/adr/ directory does not exist'
    );
  });
});

// ─── COMM ────────────────────────────────────────────────────────────────────

describe('COMM: blackboard communication infrastructure', () => {
  it('COMM: migration 014 (agent-findings) exists', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS, '014-agent-findings.sql')),
      'migrations/014-agent-findings.sql does not exist'
    );
  });

  it('COMM: migration 015 (agent-messages) exists', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS, '015-agent-messages.sql')),
      'migrations/015-agent-messages.sql does not exist'
    );
  });

  it('COMM: agents/shared/conflict-resolution.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'shared', 'conflict-resolution.md')),
      'agents/shared/conflict-resolution.md does not exist'
    );
  });

  it('COMM: services/handoff.cjs exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'services', 'handoff.cjs')),
      'services/handoff.cjs does not exist'
    );
  });

  it('COMM: all 17 agents have ### Inter-agent communication section', () => {
    const ALL_17 = [
      'gsd-operator', 'gsd-planner', 'gsd-researcher', 'gsd-roadmapper',
      'gsd-checker', 'gsd-validator', 'gsd-debugger',
      'gsd-executor-backend', 'gsd-executor-frontend', 'gsd-executor-infra', 'gsd-executor-general',
      'gsd-tester', 'gsd-qa', 'gsd-security', 'gsd-reviewer', 'gsd-executor-data', 'gsd-architect',
    ];
    for (const name of ALL_17) {
      assert.ok(
        agent(name).includes('### Inter-agent communication'),
        `${name} missing ### Inter-agent communication`
      );
    }
  });
});

// ─── LIFE ────────────────────────────────────────────────────────────────────

describe('LIFE: lifecycle management infrastructure', () => {
  it('LIFE: migration 016 (agent-metrics) exists', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS, '016-agent-metrics.sql')),
      'migrations/016-agent-metrics.sql does not exist'
    );
  });

  it('LIFE: agents/changelog/ has 17 files', () => {
    const files = fs.readdirSync(path.join(AGENTS, 'changelog')).filter(f => f.endsWith('.md'));
    assert.ok(files.length >= 17, `agents/changelog/ has ${files.length} .md files, expected >= 17`);
  });

  it('LIFE: scripts/tool-integrity.cjs exists', () => {
    assert.ok(
      fs.existsSync(path.join(SCRIPTS, 'tool-integrity.cjs')),
      'scripts/tool-integrity.cjs does not exist'
    );
  });

  it('LIFE: all 17 agents have version 3.0.0', () => {
    const ALL_17 = [
      'gsd-operator', 'gsd-planner', 'gsd-researcher', 'gsd-roadmapper',
      'gsd-checker', 'gsd-validator', 'gsd-debugger',
      'gsd-executor-backend', 'gsd-executor-frontend', 'gsd-executor-infra', 'gsd-executor-general',
      'gsd-tester', 'gsd-qa', 'gsd-security', 'gsd-reviewer', 'gsd-executor-data', 'gsd-architect',
    ];
    for (const name of ALL_17) {
      assert.ok(
        agent(name).includes('version: 3.0.0'),
        `${name} missing version: 3.0.0`
      );
    }
  });

  it('LIFE: gsd-operator has ### Version management (LIFE-01) rules', () => {
    assert.ok(
      agent('gsd-operator').includes('### Version management'),
      'gsd-operator missing ### Version management section'
    );
  });
});

// ─── ENG ─────────────────────────────────────────────────────────────────────

describe('ENG: engineering standards', () => {
  it('ENG: agents/shared/engineering-standards.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS, 'shared', 'engineering-standards.md')),
      'agents/shared/engineering-standards.md does not exist'
    );
  });

  it('ENG-01: git workflow (ENG-01) heading present in shared file', () => {
    const content = fs.readFileSync(
      path.join(AGENTS, 'shared', 'engineering-standards.md'),
      'utf-8'
    );
    assert.ok(
      content.includes('#### Git workflow (ENG-01)'),
      'agents/shared/engineering-standards.md missing #### Git workflow (ENG-01)'
    );
  });

  it('ENG-02: error handling (ENG-02) heading present in shared file', () => {
    const content = fs.readFileSync(
      path.join(AGENTS, 'shared', 'engineering-standards.md'),
      'utf-8'
    );
    assert.ok(
      content.includes('#### Error handling (ENG-02)'),
      'agents/shared/engineering-standards.md missing #### Error handling (ENG-02)'
    );
  });

  it('ENG-03: documentation (ENG-03) heading present in shared file', () => {
    const content = fs.readFileSync(
      path.join(AGENTS, 'shared', 'engineering-standards.md'),
      'utf-8'
    );
    assert.ok(
      content.includes('#### Documentation (ENG-03)'),
      'agents/shared/engineering-standards.md missing #### Documentation (ENG-03)'
    );
  });

  it('ENG-05: structured logging (ENG-05) heading present in shared file', () => {
    const content = fs.readFileSync(
      path.join(AGENTS, 'shared', 'engineering-standards.md'),
      'utf-8'
    );
    assert.ok(
      content.includes('#### Structured logging (ENG-05)'),
      'agents/shared/engineering-standards.md missing #### Structured logging (ENG-05)'
    );
  });
});
