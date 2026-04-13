#!/usr/bin/env node
/**
 * Plan 31-02: Format Standard Regression Suite
 *
 * FORMAT-01: 10-section structure in all 11 agents
 * FORMAT-02: 2-4 few-shot examples per agent
 * FORMAT-03: Security rules identical in all 11 agents
 * FORMAT-04: Anti-over-engineering guardrail in all 11 agents
 * FORMAT-05: Read-before-edit mandate in all 4 executor agents
 * FORMAT-06: AGENTS.md constraint in all 11 agents
 * FORMAT-07: Behavioral regression — existing structure preserved
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const ALL_AGENT_NAMES = [
  'gsd-operator', 'gsd-planner', 'gsd-researcher', 'gsd-roadmapper',
  'gsd-executor-backend', 'gsd-executor-frontend', 'gsd-executor-infra',
  'gsd-executor-general', 'gsd-checker', 'gsd-validator', 'gsd-debugger'
];
const EXECUTOR_NAMES = [
  'gsd-executor-backend', 'gsd-executor-frontend',
  'gsd-executor-infra', 'gsd-executor-general'
];
const NON_EXECUTOR_NAMES = ALL_AGENT_NAMES.filter(n => !EXECUTOR_NAMES.includes(n));

const agents = {};
for (const name of ALL_AGENT_NAMES) {
  agents[name] = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf-8');
}

// ─── FORMAT-01: 10-section structure ──────────────────────────────────────────

describe('FORMAT-01: 10-section structure in all 11 agents', () => {
  for (const name of ALL_AGENT_NAMES) {
    it(`${name} has exactly 10 ## sections`, () => {
      const count = (agents[name].match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${name} has ${count} ## sections, expected 10`);
    });
  }
});

describe('FORMAT-01: version header in all 11 agents', () => {
  it('all 11 agents contain version: 3.0.0', () => {
    for (const name of ALL_AGENT_NAMES) {
      assert.ok(
        agents[name].includes('version: 3.0.0'),
        `${name} missing version: 3.0.0`
      );
    }
  });
});

describe('FORMAT-01: required sections present in all 11 agents', () => {
  const REQUIRED_SECTIONS = [
    '## Role & identity',
    '## Domain knowledge',
    '## Behavioral rules',
    '## Tool access & guidance',
    '## Task management',
    '## Examples',
    '## Error handling',
    '## Security rules',
    '## Preconditions & constraints'
  ];

  for (const section of REQUIRED_SECTIONS) {
    it(`all 11 agents have section "${section}"`, () => {
      for (const name of ALL_AGENT_NAMES) {
        assert.ok(
          agents[name].includes(section),
          `${name} missing section "${section}"`
        );
      }
    });
  }
});

// ─── FORMAT-02: few-shot examples ─────────────────────────────────────────────

describe('FORMAT-02: few-shot examples present in all 11 agents', () => {
  it('all 11 agents have at least one example block', () => {
    for (const name of ALL_AGENT_NAMES) {
      const hasExample =
        agents[name].includes('**Input:') ||
        agents[name].includes('**Example') ||
        agents[name].match(/### Example \d/) !== null ||
        agents[name].match(/\*\*Example \d/) !== null;
      assert.ok(hasExample, `${name} missing example block (no **Input:, **Example, or ### Example N)`);
    }
  });
});

// ─── FORMAT-03: security rules identical ─────────────────────────────────────

describe('FORMAT-03: security rules identical across all 11 agents', () => {
  const SECURITY_RULES = [
    'Parameterized SQL — never string concatenation',
    'Sanitize and validate ALL user input',
    'Never hardcode secrets, API keys, or credentials',
    'Use HTTPS for all external calls',
    'Proper error handling (never expose stack traces)',
    'Escape output in templates (XSS prevention)',
    'Follow least privilege for file/network access'
  ];

  for (const rule of SECURITY_RULES) {
    it(`all 11 agents contain security rule: "${rule}"`, () => {
      for (const name of ALL_AGENT_NAMES) {
        assert.ok(
          agents[name].includes(rule),
          `${name} missing security rule: "${rule}"`
        );
      }
    });
  }
});

// ─── FORMAT-04: anti-over-engineering guardrail ───────────────────────────────

describe('FORMAT-04: anti-over-engineering guardrail in all 11 agents', () => {
  it('all 11 agents contain exact anti-over-engineering string', () => {
    const GUARDRAIL = 'Do not add features, refactor code, or make improvements beyond what was explicitly requested.';
    for (const name of ALL_AGENT_NAMES) {
      assert.ok(
        agents[name].includes(GUARDRAIL),
        `${name} missing anti-over-engineering guardrail`
      );
    }
  });
});

// ─── FORMAT-05: read-before-edit mandate ─────────────────────────────────────

describe('FORMAT-05: read-before-edit mandate in executor agents only', () => {
  it('all 4 executor agents contain read-before-edit mandate', () => {
    const MANDATE = 'Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.';
    for (const name of EXECUTOR_NAMES) {
      assert.ok(
        agents[name].includes(MANDATE),
        `${name} missing read-before-edit mandate`
      );
    }
  });

  it('non-executor agents do NOT contain read-before-edit mandate', () => {
    const MANDATE = 'Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.';
    for (const name of NON_EXECUTOR_NAMES) {
      assert.ok(
        !agents[name].includes(MANDATE),
        `${name} should not have read-before-edit mandate (executor-only)`
      );
    }
  });
});

// ─── FORMAT-06: AGENTS.md constraint ─────────────────────────────────────────

describe('FORMAT-06: AGENTS.md constraint in all 11 agents', () => {
  it('all 11 agents contain AGENTS.md cannot create/modify constraint', () => {
    for (const name of ALL_AGENT_NAMES) {
      const hasConstraint =
        agents[name].includes('cannot create or modify AGENTS.md') ||
        agents[name].includes('CANNOT create or modify AGENTS.md') ||
        agents[name].includes('Never create or modify AGENTS.md');
      assert.ok(hasConstraint, `${name} missing AGENTS.md constraint`);
    }
  });
});

// ─── Phase 23: CACHE_BREAKPOINT preserved ────────────────────────────────────

describe('Phase 23: CACHE_BREAKPOINT preserved in all 11 agents', () => {
  it('all 11 agents contain CACHE_BREAKPOINT marker', () => {
    for (const name of ALL_AGENT_NAMES) {
      assert.ok(
        agents[name].includes('<!-- CACHE_BREAKPOINT -->'),
        `${name} missing <!-- CACHE_BREAKPOINT --> marker`
      );
    }
  });
});

// ─── FORMAT-07: frontmatter preserved ────────────────────────────────────────

describe('FORMAT-07: frontmatter preserved in all 11 agents', () => {
  it('all 11 agents have valid YAML frontmatter with name and description', () => {
    for (const name of ALL_AGENT_NAMES) {
      const content = agents[name];
      assert.ok(content.startsWith('---'), `${name} does not start with --- (frontmatter)`);
      assert.ok(content.includes('name:'), `${name} missing name: in frontmatter`);
      assert.ok(content.includes('description:'), `${name} missing description: in frontmatter`);
    }
  });
});
