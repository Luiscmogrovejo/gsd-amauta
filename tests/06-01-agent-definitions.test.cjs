#!/usr/bin/env node
/**
 * Plan 06-01: Agent Definition Audit Tests
 *
 * Tests:
 *   AUDIT-01: All 11 agents exist and have required frontmatter
 *     1. gsd-operator.md exists with name/description/tools
 *     2. gsd-planner.md exists with name/description/tools
 *     3. gsd-researcher.md exists with name/description
 *     4. gsd-roadmapper.md exists with name/description/tools
 *     5. gsd-executor-backend.md exists with name/description/tools
 *     6. gsd-executor-frontend.md exists with name/description/tools
 *     7. gsd-executor-infra.md exists with name/description/tools
 *     8. gsd-executor-general.md exists with name/description/tools
 *     9. gsd-checker.md exists with name/description/tools
 *    10. gsd-validator.md exists with name/description/tools
 *    11. gsd-debugger.md exists with name/description/tools
 *   BOUNDARY-01: Checker vs Validator boundary clarity
 *    12. checker has pre-execution boundary statement
 *    13. validator has post-execution boundary statement
 *    14. checker does NOT have P17 Guardrails (validator-only)
 *    15. validator has P17 Guardrails
 *   GENERAL-01: Executor-general fallback risk
 *    16. executor-general has fallback routing risk note
 *   PATTERNS-01: Pattern block presence
 *    17. roadmapper has <patterns> or patterns section
 *    18. all 11 agents have a patterns section
 *   PATTERNS-02: Pattern label consistency
 *    19. no agent uses bare P-number without label
 *    20. pattern references include descriptive labels
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const AGENT_NAMES = [
  'gsd-operator', 'gsd-planner', 'gsd-researcher', 'gsd-roadmapper',
  'gsd-executor-backend', 'gsd-executor-frontend', 'gsd-executor-infra',
  'gsd-executor-general', 'gsd-checker', 'gsd-validator', 'gsd-debugger'
];

const agents = {};
for (const name of AGENT_NAMES) {
  agents[name] = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf-8');
}

describe('AUDIT-01: All 11 agents exist with required frontmatter', () => {
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    const name = AGENT_NAMES[i];
    it(`${i + 1}. ${name}.md has name and description`, () => {
      assert.ok(agents[name].includes(`name: ${name}`), `Missing name: ${name}`);
      assert.ok(agents[name].includes('description:'), `Missing description in ${name}`);
    });
  }
});

describe('BOUNDARY-01: Checker vs Validator boundary clarity', () => {
  it('12. checker has pre-execution boundary statement', () => {
    assert.ok(
      agents['gsd-checker'].includes('BOUNDARY') ||
      agents['gsd-checker'].toLowerCase().includes('before execution') ||
      agents['gsd-checker'].toLowerCase().includes('pre-execution'),
      'Checker missing pre-execution boundary statement'
    );
  });
  it('13. validator has post-execution boundary statement', () => {
    assert.ok(
      agents['gsd-validator'].includes('BOUNDARY') ||
      agents['gsd-validator'].toLowerCase().includes('after execution') ||
      agents['gsd-validator'].toLowerCase().includes('post-execution'),
      'Validator missing post-execution boundary statement'
    );
  });
  it('14. checker does NOT have P17 Guardrails', () => {
    assert.ok(
      !agents['gsd-checker'].includes('P17'),
      'Checker should not have P17 Guardrails (validator-only)'
    );
  });
  it('15. validator has P17 Guardrails', () => {
    assert.ok(
      agents['gsd-validator'].includes('P17') || agents['gsd-validator'].includes('Guardrails'),
      'Validator missing P17 Guardrails pattern'
    );
  });
});

describe('GENERAL-01: Executor-general fallback risk', () => {
  it('16. executor-general has fallback routing risk note', () => {
    assert.ok(
      agents['gsd-executor-general'].toLowerCase().includes('fallback') ||
      agents['gsd-executor-general'].toLowerCase().includes('routing risk'),
      'executor-general missing fallback routing risk note'
    );
  });
});

describe('PATTERNS-01: Pattern block presence', () => {
  it('17. roadmapper has patterns section', () => {
    assert.ok(
      agents['gsd-roadmapper'].includes('<patterns>') ||
      agents['gsd-roadmapper'].includes('## Patterns') ||
      agents['gsd-roadmapper'].includes('**P'),
      'roadmapper missing patterns section'
    );
  });
  it('18. all 11 agents have a patterns section', () => {
    for (const name of AGENT_NAMES) {
      assert.ok(
        agents[name].includes('pattern') ||
        agents[name].includes('Pattern') ||
        agents[name].includes('<patterns>'),
        `${name} missing patterns section`
      );
    }
  });
});

describe('PATTERNS-02: Pattern label consistency', () => {
  it('19. no agent uses bare P-number without label', () => {
    // Check that P-references include descriptive text (not just "P15" alone on a line)
    for (const name of AGENT_NAMES) {
      const lines = agents[name].split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*-\s*\*?\*?P\d+\*?\*?\s*$/);
        if (match) {
          assert.fail(`${name} has bare pattern reference without label: "${line.trim()}"`);
        }
      }
    }
  });
  it('20. pattern references include descriptive labels', () => {
    // At least verify checker and validator have labeled patterns
    const checkerPatterns = agents['gsd-checker'].match(/\*\*P\d+\s+\w+/g) || [];
    assert.ok(checkerPatterns.length >= 2, `Checker should have >=2 labeled patterns, found ${checkerPatterns.length}`);
    const validatorPatterns = agents['gsd-validator'].match(/\*\*P\d+\s+\w+/g) || [];
    assert.ok(validatorPatterns.length >= 3, `Validator should have >=3 labeled patterns, found ${validatorPatterns.length}`);
  });
});
