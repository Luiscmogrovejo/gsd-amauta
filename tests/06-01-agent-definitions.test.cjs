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

const { describe, it, before } = require('node:test');
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

describe('FORMAT-01: 10-section structure in executor agents', () => {
  const EXECUTOR_NAMES = [
    'gsd-executor-backend', 'gsd-executor-frontend',
    'gsd-executor-infra', 'gsd-executor-general'
  ];
  const REQUIRED_SECTIONS = [
    '## Role & identity', '## Domain knowledge', '## Behavioral rules',
    '## Tool access & guidance', '## Task management', '## Examples',
    '## Error handling', '## Security rules', '## Preconditions & constraints'
  ];

  it('21. each executor agent has exactly 10 ## sections', () => {
    for (const name of EXECUTOR_NAMES) {
      const content = agents[name];
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${name} has ${count} ## sections, expected 10`);
    }
  });

  it('22. each executor agent has version: 3.0.0 header', () => {
    for (const name of EXECUTOR_NAMES) {
      assert.ok(agents[name].includes('version: 3.0.0'), `${name} missing version: 3.0.0`);
    }
  });

  for (const section of REQUIRED_SECTIONS) {
    it(`23-31. executor agents have section "${section}"`, () => {
      for (const name of EXECUTOR_NAMES) {
        assert.ok(agents[name].includes(section), `${name} missing section "${section}"`);
      }
    });
  }
});

describe('FORMAT-04: Anti-over-engineering guardrail in executor agents', () => {
  const EXECUTOR_NAMES = [
    'gsd-executor-backend', 'gsd-executor-frontend',
    'gsd-executor-infra', 'gsd-executor-general'
  ];
  it('32. all 4 executor agents contain anti-over-engineering string', () => {
    for (const name of EXECUTOR_NAMES) {
      assert.ok(
        agents[name].includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
        `${name} missing anti-over-engineering guardrail`
      );
    }
  });
});

describe('FORMAT-05: Read-before-edit mandate in executor agents', () => {
  const EXECUTOR_NAMES = [
    'gsd-executor-backend', 'gsd-executor-frontend',
    'gsd-executor-infra', 'gsd-executor-general'
  ];
  it('33. all 4 executor agents contain read-before-edit mandate', () => {
    for (const name of EXECUTOR_NAMES) {
      assert.ok(
        agents[name].includes('Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.'),
        `${name} missing read-before-edit mandate`
      );
    }
  });
});

describe('FORMAT-03: Security rules identical in executor agents', () => {
  const EXECUTOR_NAMES = [
    'gsd-executor-backend', 'gsd-executor-frontend',
    'gsd-executor-infra', 'gsd-executor-general'
  ];
  const SECURITY_RULES = [
    'Parameterized SQL', 'Sanitize and validate ALL user input',
    'Never hardcode secrets', 'HTTPS', 'never expose stack traces',
    'XSS prevention', 'least privilege'
  ];
  it('34. all executor agents contain all 7 security rules', () => {
    for (const name of EXECUTOR_NAMES) {
      for (const rule of SECURITY_RULES) {
        assert.ok(agents[name].includes(rule), `${name} missing security rule: "${rule}"`);
      }
    }
  });
});

describe('PHASE-33: gsd-tester agent format', () => {
  let testerContent;
  before(() => {
    testerContent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-tester.md'), 'utf-8');
  });

  it('33-01. gsd-tester.md exists with correct frontmatter', () => {
    assert.ok(testerContent.includes('name: gsd-tester'), 'Missing name: gsd-tester');
    assert.ok(testerContent.includes('description:'), 'Missing description');
  });

  it('33-02. gsd-tester has exactly 10 ## sections', () => {
    const count = (testerContent.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `Expected 10 ## sections, got ${count}`);
  });

  it('33-03. gsd-tester has version: 3.0.0', () => {
    assert.ok(testerContent.includes('version: 3.0.0'), 'Missing version: 3.0.0');
  });

  it('33-04. gsd-tester has anti-over-engineering mandate', () => {
    assert.ok(
      testerContent.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
      'Missing anti-over-engineering mandate'
    );
  });

  it('33-05. gsd-tester has tester boundary (does not evaluate quality)', () => {
    assert.ok(
      testerContent.includes('You do not evaluate test quality or mutation scores.'),
      'Missing tester boundary statement'
    );
  });

  it('33-06. gsd-tester has security rules (Parameterized SQL)', () => {
    assert.ok(testerContent.includes('Parameterized SQL'), 'Missing security rules');
  });

  it('33-07. gsd-tester has CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = testerContent.split('\n').filter(l => l.trim());
    assert.ok(lines[lines.length - 1].includes('CACHE_BREAKPOINT'), 'Missing CACHE_BREAKPOINT as last line');
  });

  it('33-08. gsd-tester references CoverUp pattern', () => {
    assert.ok(
      testerContent.toLowerCase().includes('coverup') || testerContent.includes('CoverUp'),
      'Missing CoverUp pattern reference'
    );
  });

  it('33-09. gsd-tester references file naming conventions', () => {
    assert.ok(
      testerContent.includes('.unit.test.cjs') || testerContent.includes('.e2e.test.cjs'),
      'Missing file naming conventions'
    );
  });
});

describe('PHASE-33: gsd-qa agent format', () => {
  let qaContent;
  before(() => {
    qaContent = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-qa.md'), 'utf-8');
  });

  it('33-10. gsd-qa.md exists with correct frontmatter', () => {
    assert.ok(qaContent.includes('name: gsd-qa'), 'Missing name: gsd-qa');
    assert.ok(qaContent.includes('description:'), 'Missing description');
  });

  it('33-11. gsd-qa has exactly 10 ## sections', () => {
    const count = (qaContent.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `Expected 10 ## sections, got ${count}`);
  });

  it('33-12. gsd-qa has version: 3.0.0', () => {
    assert.ok(qaContent.includes('version: 3.0.0'), 'Missing version: 3.0.0');
  });

  it('33-13. gsd-qa has anti-over-engineering mandate', () => {
    assert.ok(
      qaContent.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
      'Missing anti-over-engineering mandate'
    );
  });

  it('33-14. gsd-qa has qa boundary (does not generate tests)', () => {
    assert.ok(
      qaContent.includes('You do not generate tests.'),
      'Missing qa boundary statement'
    );
  });

  it('33-15. gsd-qa has security rules (Parameterized SQL)', () => {
    assert.ok(qaContent.includes('Parameterized SQL'), 'Missing security rules');
  });

  it('33-16. gsd-qa has CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = qaContent.split('\n').filter(l => l.trim());
    assert.ok(lines[lines.length - 1].includes('CACHE_BREAKPOINT'), 'Missing CACHE_BREAKPOINT as last line');
  });

  it('33-17. gsd-qa references coverage ratchet', () => {
    assert.ok(
      qaContent.includes('coverage_threshold.json') || qaContent.includes('.coverage_threshold'),
      'Missing coverage ratchet reference'
    );
  });

  it('33-18. gsd-qa references mutation testing threshold', () => {
    assert.ok(
      qaContent.includes('70%') || qaContent.includes('mutation score'),
      'Missing mutation testing threshold'
    );
  });

  it('33-19. gsd-qa references test pyramid', () => {
    assert.ok(
      qaContent.toLowerCase().includes('pyramid'),
      'Missing test pyramid reference'
    );
  });
});
