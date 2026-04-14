'use strict';
/**
 * Phase 37 -- Architect Agent Unit Test Suite
 * File: tests/37-architect-agent.unit.test.cjs
 *
 * Requirements covered:
 *   ARCH-01: ADR management (Michael Nygard template, docs/adr/, dynamic numbering)
 *   ARCH-02: API design review rules (5 checks: naming, http_method, pagination, error_format, versioning)
 *   ARCH-03: N+1 detection at design level (plan text, not SQL)
 *
 * Pure file-system reads only -- no child processes, no network.
 * Uses node:test + node:assert/strict (no external test framework).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

function readFixture(filename) {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
}

function readADR(filename) {
  return fs.readFileSync(path.join(ADR_DIR, filename), 'utf-8');
}

// ─── Group 1: gsd-architect.md format (ARCH-01, ARCH-02, ARCH-03) ─────────────

describe('[ARCH-01][ARCH-02][ARCH-03] gsd-architect.md: v3.0.0 10-section format', () => {
  const data = readAgent('gsd-architect.md');

  it('[ARCH-01] file exists', () => {
    assert.ok(fs.existsSync(path.join(AGENTS_DIR, 'gsd-architect.md')));
  });

  it('[ARCH-01] exactly 10 ## sections', () => {
    const count = (data.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-architect.md has ${count} ## sections, expected 10`);
  });

  it('[ARCH-01] version header: ## version: 3.0.0', () => {
    assert.ok(data.includes('## version: 3.0.0'), 'Missing ## version: 3.0.0');
  });

  it('[ARCH-01] frontmatter name: gsd-architect', () => {
    assert.ok(data.includes('name: gsd-architect'), 'Missing frontmatter name: gsd-architect');
  });

  it('[ARCH-01] boundary verbatim: "You evaluate designs and document decisions"', () => {
    assert.ok(
      data.includes('You evaluate designs and document decisions'),
      'Missing "You evaluate designs and document decisions" boundary statement'
    );
  });

  it('[ARCH-01] no-code boundary: "You do not write application code"', () => {
    assert.ok(
      data.includes('You do not write application code'),
      'Missing "You do not write application code" boundary'
    );
  });

  it('[ARCH-03] temporal boundary: "You NEVER review source code directly"', () => {
    assert.ok(
      data.includes('You NEVER review source code directly'),
      'Missing "You NEVER review source code directly" temporal boundary'
    );
  });

  it('[ARCH-01] anti-over-engineering mandate verbatim', () => {
    assert.ok(
      data.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
      'Missing anti-over-engineering mandate'
    );
  });

  it('[ARCH-01] read-before-edit mandate verbatim', () => {
    assert.ok(
      data.includes('Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.'),
      'Missing read-before-edit mandate'
    );
  });

  it('[ARCH-01] AGENTS.md constraint present', () => {
    assert.ok(
      data.includes('You CANNOT create or modify AGENTS.md'),
      'Missing AGENTS.md constraint'
    );
  });

  it('[ARCH-01] CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = data.split('\n').filter(l => l.trim());
    assert.ok(
      lines[lines.length - 1].includes('CACHE_BREAKPOINT'),
      `Last non-empty line is not CACHE_BREAKPOINT: "${lines[lines.length - 1]}"`
    );
  });

  it('[ARCH-01] hybrid nature: "review mode" AND "write mode"', () => {
    assert.ok(data.includes('review mode'), 'Missing "review mode"');
    assert.ok(data.includes('write mode'), 'Missing "write mode"');
  });

  it('[ARCH-02] advisory: file contains "ADVISORY" or "advisory"', () => {
    assert.ok(
      data.includes('ADVISORY') || data.includes('advisory'),
      'Missing ADVISORY/advisory designation'
    );
  });
});

// ─── Group 2: ADR rules (ARCH-01) ────────────────────────────────────────────

describe('[ARCH-01] ADR rules: Michael Nygard template, dynamic numbering, lifecycle', () => {
  const data = readAgent('gsd-architect.md');

  it('[ARCH-01] ADR mentioned in agent', () => {
    assert.ok(data.includes('ADR'), 'Missing ADR reference');
  });

  it('[ARCH-01] ADR path: docs/adr/ mentioned', () => {
    assert.ok(data.includes('docs/adr/'), 'Missing docs/adr/ path reference');
  });

  it('[ARCH-01] ADR dynamic numbering: "highest" mentioned', () => {
    assert.ok(
      data.includes('highest'),
      'Missing dynamic numbering rule ("highest")'
    );
  });

  it('[ARCH-01] ADR template attribution: Michael Nygard', () => {
    assert.ok(
      data.includes('Michael Nygard') || data.includes('Nygard'),
      'Missing Michael Nygard attribution'
    );
  });

  it('[ARCH-01] ADR status values: proposed, accepted, deprecated, superseded', () => {
    assert.ok(data.includes('proposed'), 'Missing ADR status: proposed');
    assert.ok(data.includes('accepted'), 'Missing ADR status: accepted');
    assert.ok(data.includes('deprecated'), 'Missing ADR status: deprecated');
    assert.ok(data.includes('superseded'), 'Missing ADR status: superseded');
  });

  it('[ARCH-01] ADR sections: Status, Context, Decision, Consequences, Alternatives', () => {
    assert.ok(data.includes('## Status') || data.includes('### Status'), 'Missing ## Status or ### Status ADR section');
    assert.ok(data.includes('## Context') || data.includes('### Context'), 'Missing Context ADR section');
    assert.ok(data.includes('## Decision') || data.includes('### Decision'), 'Missing Decision ADR section');
    assert.ok(data.includes('## Consequences') || data.includes('### Consequences'), 'Missing Consequences ADR section');
    assert.ok(data.includes('Alternatives'), 'Missing Alternatives ADR section');
  });

  it('[ARCH-01] ADR new-only rule: "creates NEW ADRs only"', () => {
    assert.ok(
      data.includes('creates NEW ADRs only') || data.includes('creates new only') || data.toLowerCase().includes('never updates existing'),
      'Missing ADR new-only rule'
    );
  });

  it('[ARCH-01] Significant decisions: 2+ technologies listed as trigger', () => {
    assert.ok(
      data.includes('2+ technologies') || data.includes('changing data schema') || data.includes('new service'),
      'Missing significant decision triggers (2+ technologies, changing data schema, new service)'
    );
  });
});

// ─── Group 3: API review rules (ARCH-02) ─────────────────────────────────────

describe('[ARCH-02] API design review rules: all 5 checks present', () => {
  const data = readAgent('gsd-architect.md');

  it('[ARCH-02] Rule 1 -- naming: kebab-case required', () => {
    assert.ok(data.includes('kebab-case'), 'Missing kebab-case naming rule');
  });

  it('[ARCH-02] Rule 1 -- naming: plural resource nouns', () => {
    assert.ok(data.includes('plural'), 'Missing plural resource noun requirement');
  });

  it('[ARCH-02] Rule 2 -- HTTP methods: GET no body or GET has no request body', () => {
    assert.ok(
      data.includes('GET no body') || data.includes('GET has no request body'),
      'Missing GET no body HTTP method rule'
    );
  });

  it('[ARCH-02] Rule 2 -- HTTP methods: No GET with side effects', () => {
    assert.ok(
      data.includes('No GET with side effects') || data.includes('side effect'),
      'Missing No GET with side effects rule'
    );
  });

  it('[ARCH-02] Rule 3 -- pagination: ?page=N&limit=N', () => {
    assert.ok(
      data.includes('?page=N&limit=N') || data.includes('page=N'),
      'Missing ?page=N&limit=N pagination parameter rule'
    );
  });

  it('[ARCH-02] Rule 3 -- pagination: default limit=20', () => {
    assert.ok(
      data.includes('default limit=20') || (data.includes('default') && data.includes('20')),
      'Missing default limit=20 pagination rule'
    );
  });

  it('[ARCH-02] Rule 3 -- pagination: max limit=100', () => {
    assert.ok(
      data.includes('max limit=100') || (data.includes('max') && data.includes('100')),
      'Missing max limit=100 pagination rule'
    );
  });

  it('[ARCH-02] Rule 4 -- error format: {code, message, details}', () => {
    assert.ok(data.includes('{code'), 'Missing {code in error format');
    assert.ok(data.includes('message'), 'Missing message in error format');
    assert.ok(data.includes('details'), 'Missing details in error format');
  });

  it('[ARCH-02] Rule 5 -- versioning: /api/v1/ prefix', () => {
    assert.ok(
      data.includes('/api/v1/') || data.includes('version in URL'),
      'Missing /api/v1/ versioning rule'
    );
  });
});

// ─── Group 4: N+1 detection (ARCH-03) ────────────────────────────────────────

describe('[ARCH-03] N+1 detection at design level', () => {
  const data = readAgent('gsd-architect.md');

  it('[ARCH-03] N+1 pattern mentioned', () => {
    assert.ok(data.includes('N+1'), 'Missing N+1 pattern reference');
  });

  it('[ARCH-03] design-level scope: "plan files" or "plan text" mentioned', () => {
    assert.ok(
      data.includes('plan files') || data.includes('plan text') || data.includes('proposed designs'),
      'Missing design-level scope reference (plan files, plan text, or proposed designs)'
    );
  });

  it('[ARCH-03] distinction from executor-data: gsd-executor-data SQL-level detection', () => {
    assert.ok(
      data.includes('gsd-executor-data'),
      'Missing reference to gsd-executor-data for SQL-level detection distinction'
    );
  });

  it('[ARCH-03] resolution suggestions: eager loading or batching or DataLoader', () => {
    assert.ok(
      data.includes('eager loading') || data.includes('batching') || data.includes('DataLoader'),
      'Missing N+1 resolution suggestions (eager loading, batching, or DataLoader)'
    );
  });

  it('[ARCH-03] "for each X, fetch Y" pattern description present', () => {
    assert.ok(
      data.includes('for each'),
      'Missing "for each" N+1 pattern description'
    );
  });
});

// ─── Group 5: Review output schema ───────────────────────────────────────────

describe('[ARCH-02][ARCH-03] Review output schema: required fields and values', () => {
  const data = readAgent('gsd-architect.md');

  it('[ARCH-02] review_type field present in schema', () => {
    assert.ok(data.includes('review_type'), 'Missing review_type field in output schema');
  });

  it('[ARCH-03] architecture categories: n_plus_one, coupling, scalability', () => {
    assert.ok(data.includes('n_plus_one'), 'Missing n_plus_one category');
    assert.ok(data.includes('coupling'), 'Missing coupling category');
    assert.ok(data.includes('scalability'), 'Missing scalability category');
  });

  it('[ARCH-02] naming category present', () => {
    assert.ok(data.includes('naming'), 'Missing naming as a category');
  });

  it('[ARCH-02] http_method category present', () => {
    assert.ok(data.includes('http_method'), 'Missing http_method category');
  });

  it('[ARCH-02] pagination category present', () => {
    assert.ok(data.includes('pagination'), 'Missing pagination as category');
  });

  it('[ARCH-02][ARCH-03] approval values: approve, request_changes, comment_only', () => {
    assert.ok(data.includes('approve'), 'Missing approve approval value');
    assert.ok(data.includes('request_changes'), 'Missing request_changes approval value');
    assert.ok(data.includes('comment_only'), 'Missing comment_only approval value');
  });

  it('[ARCH-02] deterministic approval logic stated', () => {
    assert.ok(
      data.includes('deterministic'),
      'Missing "deterministic" approval logic statement'
    );
  });
});

// ─── Group 6: Examples (ARCH-01, ARCH-02, ARCH-03) ───────────────────────────

describe('[ARCH-01][ARCH-02][ARCH-03] Examples: 3 examples covering all requirements', () => {
  const data = readAgent('gsd-architect.md');

  it('[ARCH-01] exactly 3 numbered examples (**Example N: pattern)', () => {
    const matches = data.match(/\*\*Example \d+:/g) || [];
    assert.strictEqual(matches.length, 3, `Expected 3 examples, found ${matches.length}`);
  });

  it('[ARCH-01] Example 1: ADR generation (contains "ADR" or "REST" or "GraphQL")', () => {
    const parts = data.split('**Example ');
    const ex1 = parts.find(p => p.startsWith('1:')) || '';
    assert.ok(
      ex1.includes('ADR') || ex1.includes('REST') || ex1.includes('GraphQL'),
      'Example 1 does not demonstrate ADR generation'
    );
  });

  it('[ARCH-02] Example 2: API review (contains "findings" or "request_changes")', () => {
    const parts = data.split('**Example ');
    const ex2 = parts.find(p => p.startsWith('2:')) || '';
    assert.ok(
      ex2.includes('findings') || ex2.includes('request_changes'),
      'Example 2 does not demonstrate API design review'
    );
  });

  it('[ARCH-03] Example 3: N+1 detection (contains "N+1" or "n_plus_one")', () => {
    const parts = data.split('**Example ');
    const ex3 = parts.find(p => p.startsWith('3:')) || '';
    assert.ok(
      ex3.includes('N+1') || ex3.includes('n_plus_one'),
      'Example 3 does not demonstrate N+1 detection'
    );
  });
});

// ─── Group 7: Security rules content-identity (shared source of truth) ────────

describe('[ARCH-01] Security rules: content-identity against shared source of truth', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));
  const data = readAgent('gsd-architect.md');

  it(`all ${bulletLines.length} security rule bullet lines appear verbatim in gsd-architect.md`, () => {
    const missing = bulletLines.filter(line => !data.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `Security rules missing from gsd-architect.md:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 8: Engineering standards content-identity ──────────────────────────

describe('[ARCH-01] Engineering standards: content-identity against shared source of truth', () => {
  const stdPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sharedStd = fs.readFileSync(stdPath, 'utf-8');
  const headings = sharedStd.split('\n').filter(l => l.startsWith('#### '));
  const data = readAgent('gsd-architect.md');

  it(`all ${headings.length} engineering standard #### headings appear verbatim in gsd-architect.md`, () => {
    const missing = headings.filter(h => !data.includes(h));
    assert.strictEqual(
      missing.length,
      0,
      `Engineering standard headings missing from gsd-architect.md:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 9: ADR file structure assertions (ARCH-01) ─────────────────────────

describe('[ARCH-01] ADR files: template and real ADR structural verification', () => {

  it('[ARCH-01] docs/adr/000-template.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(ADR_DIR, '000-template.md')),
      'docs/adr/000-template.md does not exist'
    );
  });

  it('[ARCH-01] docs/adr/000-template.md has all 5 required section headings', () => {
    const template = readADR('000-template.md');
    assert.ok(template.includes('## Status'), 'Missing ## Status in ADR template');
    assert.ok(template.includes('## Context'), 'Missing ## Context in ADR template');
    assert.ok(template.includes('## Decision'), 'Missing ## Decision in ADR template');
    assert.ok(template.includes('## Consequences'), 'Missing ## Consequences in ADR template');
    assert.ok(template.includes('Alternatives'), 'Missing Alternatives in ADR template');
  });

  it('[ARCH-01] docs/adr/001-postgresql-pgvector.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(ADR_DIR, '001-postgresql-pgvector.md')),
      'docs/adr/001-postgresql-pgvector.md does not exist'
    );
  });

  it('[ARCH-01] docs/adr/001-postgresql-pgvector.md has "accepted" status', () => {
    const adr = readADR('001-postgresql-pgvector.md');
    assert.ok(adr.includes('accepted'), 'Missing accepted status in ADR 001');
  });

  it('[ARCH-01] docs/adr/001-postgresql-pgvector.md mentions pgvector', () => {
    const adr = readADR('001-postgresql-pgvector.md');
    assert.ok(adr.includes('pgvector'), 'Missing pgvector mention in ADR 001');
  });

  it('[ARCH-01] docs/adr/001-postgresql-pgvector.md mentions PostgreSQL', () => {
    const adr = readADR('001-postgresql-pgvector.md');
    assert.ok(adr.includes('PostgreSQL'), 'Missing PostgreSQL mention in ADR 001');
  });

  it('[ARCH-01] docs/adr/001-postgresql-pgvector.md has at least 2 alternatives', () => {
    const adr = readADR('001-postgresql-pgvector.md');
    const altMatches = (adr.match(/Alternative \d+:/g) || []).length;
    assert.ok(
      altMatches >= 2,
      `ADR 001 has ${altMatches} alternatives, expected >= 2`
    );
  });
});

// ─── Group 10: Fixture file content assertions ────────────────────────────────

describe('[ARCH-02][ARCH-03] Fixture files: expected profiles for architect scenarios', () => {

  it('[ARCH-02] 37-api-spec-violations.json: exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '37-api-spec-violations.json')),
      '37-api-spec-violations.json does not exist'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: valid JSON', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.doesNotThrow(
      () => JSON.parse(content),
      '37-api-spec-violations.json is not valid JSON'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has _violation labels (>= 5)', () => {
    const content = readFixture('37-api-spec-violations.json');
    const violations = (content.match(/"_violation"/g) || []).length;
    assert.ok(
      violations >= 5,
      `37-api-spec-violations.json has ${violations} _violation labels, expected >= 5`
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has >= 5 endpoints', () => {
    const data = JSON.parse(readFixture('37-api-spec-violations.json'));
    assert.ok(
      Array.isArray(data.endpoints) && data.endpoints.length >= 5,
      `37-api-spec-violations.json has ${data.endpoints ? data.endpoints.length : 0} endpoints, expected >= 5`
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has camelCase naming violation (Rule 1)', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.ok(
      content.includes('userProfile') || content.includes('camelCase'),
      'Missing camelCase naming violation in fixture'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has GET with side effect violation (Rule 2)', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.ok(
      content.includes('deactivate') || content.includes('side effect'),
      'Missing GET with side effect violation in fixture'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has missing pagination violation (Rule 3)', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.ok(
      content.includes('pagination') || content.includes('no pagination') || content.includes('all tasks'),
      'Missing pagination violation in fixture'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has non-standard error format (Rule 4)', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.ok(
      content.includes('"err"') || content.includes('non-standard'),
      'Missing non-standard error format violation in fixture'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has missing versioning violation (Rule 5)', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.ok(
      content.includes('versioning') || content.includes('no /v1/'),
      'Missing versioning violation in fixture'
    );
  });

  it('[ARCH-02] 37-api-spec-violations.json: has @testing-only marker', () => {
    const content = readFixture('37-api-spec-violations.json');
    assert.ok(
      content.includes('@testing-only'),
      'Missing @testing-only marker in fixture'
    );
  });

  it('[ARCH-03] 37-plan-n-plus-one.md: exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '37-plan-n-plus-one.md')),
      '37-plan-n-plus-one.md does not exist'
    );
  });

  it('[ARCH-03] 37-plan-n-plus-one.md: has "for each category" N+1 trigger phrase', () => {
    const content = readFixture('37-plan-n-plus-one.md');
    assert.ok(
      content.includes('For each category') || content.includes('for each category'),
      'Missing "for each category" N+1 trigger phrase in plan fixture'
    );
  });

  it('[ARCH-03] 37-plan-n-plus-one.md: has "fetch" pattern (the Y in "for each X, fetch Y")', () => {
    const content = readFixture('37-plan-n-plus-one.md');
    assert.ok(
      content.includes('fetch all products') || content.includes('fetch'),
      'Missing fetch pattern in plan fixture'
    );
  });

  it('[ARCH-03] 37-plan-n-plus-one.md: has JOIN alternative (GOOD pattern)', () => {
    const content = readFixture('37-plan-n-plus-one.md');
    assert.ok(
      content.includes('JOIN') || content.includes('GROUP BY'),
      'Missing JOIN alternative (GOOD pattern) in plan fixture'
    );
  });

  it('[ARCH-03] 37-plan-n-plus-one.md: has @testing-only marker', () => {
    const content = readFixture('37-plan-n-plus-one.md');
    assert.ok(
      content.includes('@testing-only'),
      'Missing @testing-only marker in N+1 plan fixture'
    );
  });

  it('[ARCH-03] 37-plan-n-plus-one.md: between 15 and 50 lines', () => {
    const content = readFixture('37-plan-n-plus-one.md');
    const lines = content.split('\n').length;
    assert.ok(
      lines >= 15 && lines <= 50,
      `37-plan-n-plus-one.md has ${lines} lines, expected between 15 and 50`
    );
  });
});
