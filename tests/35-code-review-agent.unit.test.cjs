'use strict';
/**
 * Phase 35 — Code Review Agent Unit Test Suite
 * File: tests/35-code-review-agent.unit.test.cjs
 *
 * Requirements covered:
 *   REVIEW-01: gsd-reviewer agent exists in correct v3.0.0 10-section format
 *   REVIEW-02: 10 detection rules with locked thresholds present
 *   REVIEW-03: Reviewer scope is distinct from validator (QUALITY vs CORRECTNESS)
 *   REVIEW-04: Deterministic approval logic + output schema keys + examples
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
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');

// ─── Helper ────────────────────────────────────────────────────────────────

function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

function readFixture(filename) {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
}

// ─── Group 1: gsd-reviewer.md format (REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04) ──

describe('[REVIEW-01][REVIEW-02][REVIEW-03][REVIEW-04] gsd-reviewer.md: v3.0.0 10-section format', () => {
  const reviewer = readAgent('gsd-reviewer.md');

  it('[REVIEW-01] file exists', () => {
    assert.ok(fs.existsSync(path.join(AGENTS_DIR, 'gsd-reviewer.md')));
  });

  it('[REVIEW-01] exactly 10 ## sections', () => {
    const count = (reviewer.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-reviewer.md has ${count} ## sections, expected 10`);
  });

  it('[REVIEW-01] version header: ## version: 3.0.0', () => {
    assert.ok(reviewer.includes('## version: 3.0.0'), 'Missing ## version: 3.0.0');
  });

  it('[REVIEW-01] frontmatter name: gsd-reviewer', () => {
    assert.ok(reviewer.includes('name: gsd-reviewer'), 'Missing frontmatter name: gsd-reviewer');
  });

  it('[REVIEW-03] boundary verbatim: "You review code and produce findings. You do not fix code"', () => {
    assert.ok(
      reviewer.includes('You review code and produce findings. You do not fix code'),
      'Missing boundary verbatim string'
    );
  });

  it('[REVIEW-03] no-tests boundary: "You do not run tests"', () => {
    assert.ok(
      reviewer.includes('You do not run tests'),
      'Missing "You do not run tests" boundary'
    );
  });

  it('[REVIEW-01] anti-over-engineering mandate verbatim', () => {
    assert.ok(
      reviewer.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
      'Missing anti-over-engineering mandate'
    );
  });

  it('[REVIEW-01] read-before-edit mandate verbatim', () => {
    assert.ok(
      reviewer.includes('Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.'),
      'Missing read-before-edit mandate'
    );
  });

  it('[REVIEW-01] AGENTS.md constraint present', () => {
    assert.ok(
      reviewer.includes('You CANNOT create or modify AGENTS.md'),
      'Missing AGENTS.md constraint'
    );
  });

  it('[REVIEW-01] CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = reviewer.split('\n').filter(l => l.trim());
    assert.ok(
      lines[lines.length - 1].includes('CACHE_BREAKPOINT'),
      `Last non-empty line is not CACHE_BREAKPOINT: "${lines[lines.length - 1]}"`
    );
  });

  it('[REVIEW-03] advisory nature: file contains "advisory"', () => {
    assert.ok(
      reviewer.toLowerCase().includes('advisory'),
      'Missing "advisory" in agent (reviewer output must be advisory)'
    );
  });
});

// ─── Group 2: Detection rules present (REVIEW-01, REVIEW-02) ─────────────────

describe('[REVIEW-01][REVIEW-02] Detection rules: all 10 rules with locked thresholds', () => {
  const reviewer = readAgent('gsd-reviewer.md');

  it('[REVIEW-02] god class rule: file contains "500 lines"', () => {
    assert.ok(reviewer.includes('500 lines'), 'Missing god class threshold (500 lines)');
  });

  it('[REVIEW-02] long function rule: file contains "50 lines"', () => {
    assert.ok(reviewer.includes('50 lines'), 'Missing long function threshold (50 lines)');
  });

  it('[REVIEW-02] too many params rule: mentions "> 5 param" or "5 params"', () => {
    assert.ok(
      reviewer.includes('> 5 param') || reviewer.includes('5 params') || reviewer.includes('5 param'),
      'Missing parameter threshold (> 5 params)'
    );
  });

  it('[REVIEW-02] duplication rule: mentions "10 identical lines" or "> 10 identical"', () => {
    assert.ok(
      reviewer.includes('10 identical lines') || reviewer.includes('> 10 identical') || reviewer.includes('10 identical'),
      'Missing duplication threshold (10 identical lines)'
    );
  });

  it('[REVIEW-02] missing docs rule: mentions "JSDoc" or "docstring"', () => {
    assert.ok(
      reviewer.includes('JSDoc') || reviewer.includes('docstring'),
      'Missing documentation check (JSDoc/docstring)'
    );
  });

  it('[REVIEW-02] dead code rule: mentions "unused imports"', () => {
    assert.ok(reviewer.includes('unused imports'), 'Missing dead code detection (unused imports)');
  });

  it('[REVIEW-02] circular deps rule: mentions "circular"', () => {
    assert.ok(reviewer.includes('circular'), 'Missing circular dependency detection');
  });

  it('[REVIEW-02] naming rule: mentions "camelCase" and "snake_case"', () => {
    assert.ok(reviewer.includes('camelCase'), 'Missing camelCase naming reference');
    assert.ok(reviewer.includes('snake_case'), 'Missing snake_case naming reference');
  });

  it('[REVIEW-02] import ordering rule: mentions "grouped" or "import ordering"', () => {
    assert.ok(
      reviewer.includes('import ordering') || reviewer.includes('grouped'),
      'Missing import ordering rule'
    );
  });

  it('[REVIEW-02] SOLID rule: mentions "3+ unrelated concerns" or "SOLID"', () => {
    assert.ok(
      reviewer.includes('3+ unrelated concerns') || reviewer.includes('SOLID'),
      'Missing SOLID violation detection'
    );
  });
});

// ─── Group 3: Severity model and approval logic (REVIEW-04) ──────────────────

describe('[REVIEW-04] Severity model and deterministic approval logic', () => {
  const reviewer = readAgent('gsd-reviewer.md');

  it('[REVIEW-04] error severity level present', () => {
    assert.ok(reviewer.includes('error'), 'Missing "error" severity level');
  });

  it('[REVIEW-04] warning severity level present', () => {
    assert.ok(reviewer.includes('warning'), 'Missing "warning" severity level');
  });

  it('[REVIEW-04] info severity level present', () => {
    assert.ok(reviewer.includes('info'), 'Missing "info" severity level');
  });

  it('[REVIEW-04] approval value: request_changes', () => {
    assert.ok(reviewer.includes('request_changes'), 'Missing "request_changes" approval value');
  });

  it('[REVIEW-04] approval value: comment_only', () => {
    assert.ok(reviewer.includes('comment_only'), 'Missing "comment_only" approval value');
  });

  it('[REVIEW-04] approval value: "approve"', () => {
    assert.ok(reviewer.includes('"approve"') || reviewer.includes('→ approve') || reviewer.includes('approve'),
      'Missing "approve" approval value');
  });

  it('[REVIEW-04] deterministic logic stated', () => {
    assert.ok(
      reviewer.includes('deterministic') || reviewer.includes('DETERMINISTIC'),
      'Missing deterministic approval logic declaration'
    );
  });
});

// ─── Group 4: Output schema keys (REVIEW-04) ─────────────────────────────────

describe('[REVIEW-04] Output schema: all required keys present', () => {
  const reviewer = readAgent('gsd-reviewer.md');

  it('[REVIEW-04] schema key: task_id', () => {
    assert.ok(reviewer.includes('task_id'), 'Missing "task_id" in output schema');
  });

  it('[REVIEW-04] schema key: files_reviewed', () => {
    assert.ok(reviewer.includes('files_reviewed'), 'Missing "files_reviewed" in output schema');
  });

  it('[REVIEW-04] schema key: findings', () => {
    assert.ok(reviewer.includes('findings'), 'Missing "findings" in output schema');
  });

  it('[REVIEW-04] schema subkey: file (in findings)', () => {
    assert.ok(reviewer.includes('"file"'), 'Missing "file" subkey in findings schema');
  });

  it('[REVIEW-04] schema subkey: line (in findings)', () => {
    assert.ok(reviewer.includes('"line"'), 'Missing "line" subkey in findings schema');
  });

  it('[REVIEW-04] schema subkey: category', () => {
    assert.ok(reviewer.includes('"category"'), 'Missing "category" subkey in findings schema');
  });

  it('[REVIEW-04] schema subkey: severity', () => {
    assert.ok(reviewer.includes('"severity"'), 'Missing "severity" subkey in findings schema');
  });

  it('[REVIEW-04] schema subkey: message', () => {
    assert.ok(reviewer.includes('"message"'), 'Missing "message" subkey in findings schema');
  });

  it('[REVIEW-04] schema subkey: suggestion', () => {
    assert.ok(reviewer.includes('"suggestion"'), 'Missing "suggestion" subkey in findings schema');
  });

  it('[REVIEW-04] schema key: summary', () => {
    assert.ok(reviewer.includes('"summary"'), 'Missing "summary" in output schema');
  });

  it('[REVIEW-04] schema key: approval', () => {
    assert.ok(reviewer.includes('"approval"'), 'Missing "approval" in output schema');
  });

  it('[REVIEW-04] schema key: metrics', () => {
    assert.ok(reviewer.includes('"metrics"'), 'Missing "metrics" in output schema');
  });

  it('[REVIEW-04] schema key: findings_by_severity', () => {
    assert.ok(reviewer.includes('findings_by_severity'), 'Missing "findings_by_severity" in output schema');
  });
});

// ─── Group 5: Examples (REVIEW-04) ───────────────────────────────────────────

describe('[REVIEW-04] Examples: 4 examples covering all approval outcomes', () => {
  const reviewer = readAgent('gsd-reviewer.md');

  it('[REVIEW-04] exactly 4 examples (** Example N: pattern)', () => {
    const matches = reviewer.match(/\*\*Example \d+:/g) || [];
    assert.strictEqual(matches.length, 4, `Expected 4 examples, found ${matches.length}`);
  });

  it('[REVIEW-04] Example 1 contains "approve" (clean code → approve)', () => {
    const ex1 = reviewer.split('**Example 2:')[0];
    assert.ok(ex1.includes('**Example 1:'), 'Example 1 not found');
    assert.ok(
      ex1.includes('"approve"') || ex1.includes('approval": "approve') || ex1.includes('→ approve'),
      'Example 1 does not demonstrate "approve" outcome'
    );
  });

  it('[REVIEW-04] Example 2 contains "comment_only" (minor style → comment_only)', () => {
    const parts = reviewer.split('**Example ');
    const ex2 = parts.find(p => p.startsWith('2:')) || '';
    assert.ok(ex2.includes('comment_only'), 'Example 2 does not demonstrate "comment_only" outcome');
  });

  it('[REVIEW-04] Example 3 contains "request_changes" (serious violations → request_changes)', () => {
    const parts = reviewer.split('**Example ');
    const ex3 = parts.find(p => p.startsWith('3:')) || '';
    assert.ok(ex3.includes('request_changes'), 'Example 3 does not demonstrate "request_changes" outcome');
  });

  it('[REVIEW-04] Example 4 contains "request_changes" and security finding (hardcoded credential)', () => {
    const parts = reviewer.split('**Example ');
    const ex4 = parts.find(p => p.startsWith('4:')) || '';
    assert.ok(ex4.includes('request_changes'), 'Example 4 does not have "request_changes"');
    assert.ok(
      ex4.includes('hardcoded') || ex4.includes('credential') || ex4.includes('password'),
      'Example 4 does not demonstrate a security/hardcoded-credential finding'
    );
  });
});

// ─── Group 6: REVIEW-03 boundary (distinct from validator) ───────────────────

describe('[REVIEW-03] Boundary: reviewer checks QUALITY, validator checks CORRECTNESS', () => {
  const reviewer = readAgent('gsd-reviewer.md');

  it('[REVIEW-03] quality focus: file contains "QUALITY"', () => {
    assert.ok(reviewer.includes('QUALITY'), 'Missing "QUALITY" — reviewer checks code quality');
  });

  it('[REVIEW-03] correctness distinction: validator checks CORRECTNESS', () => {
    assert.ok(
      reviewer.includes('CORRECTNESS') || reviewer.includes('gsd-validator checks CORRECTNESS') || reviewer.includes('validator checks CORRECTNESS'),
      'Missing CORRECTNESS distinction from validator'
    );
  });

  it('[REVIEW-03] boundary list: Test coverage → gsd-qa', () => {
    assert.ok(
      reviewer.includes('Test coverage') && (reviewer.includes('gsd-qa') || reviewer.includes('gsd-tester')),
      'Missing "Test coverage → gsd-qa" boundary delegation'
    );
  });

  it('[REVIEW-03] boundary list: Requirements compliance → gsd-validator', () => {
    assert.ok(
      reviewer.includes('Requirements compliance') && reviewer.includes('gsd-validator'),
      'Missing "Requirements compliance → gsd-validator" boundary delegation'
    );
  });
});

// ─── Group 7: Security rules content-identity (REVIEW-01, SEC-04) ────────────

describe('[REVIEW-01] Security rules: content-identity against shared source of truth', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));
  const reviewer = readAgent('gsd-reviewer.md');

  it(`all ${bulletLines.length} security rule bullet lines appear verbatim in gsd-reviewer.md`, () => {
    const missing = bulletLines.filter(line => !reviewer.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `Security rules missing from gsd-reviewer.md:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 8: Engineering standards content-identity (REVIEW-01, ENG-01..05) ──

describe('[REVIEW-01] Engineering standards: content-identity against shared source of truth', () => {
  const stdPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sharedStd = fs.readFileSync(stdPath, 'utf-8');
  const headings = sharedStd.split('\n').filter(l => l.startsWith('#### '));
  const reviewer = readAgent('gsd-reviewer.md');

  it(`all ${headings.length} engineering standard headings (####) appear verbatim in gsd-reviewer.md`, () => {
    const missing = headings.filter(h => !reviewer.includes(h));
    assert.strictEqual(
      missing.length,
      0,
      `Engineering standard headings missing from gsd-reviewer.md:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 9: Fixture file content assertions ─────────────────────────────────

describe('[REVIEW-01][REVIEW-02] Fixture files: expected violation profiles', () => {

  it('[REVIEW-02] 35-review-clean.js: exists and < 100 lines', () => {
    const cleanPath = path.join(FIXTURES_DIR, '35-review-clean.js');
    assert.ok(fs.existsSync(cleanPath), '35-review-clean.js does not exist');
    const lines = fs.readFileSync(cleanPath, 'utf-8').split('\n').length;
    assert.ok(lines < 100, `35-review-clean.js has ${lines} lines, expected < 100`);
  });

  it('[REVIEW-02] 35-review-clean.js: has JSDoc on public functions (@param present)', () => {
    const content = readFixture('35-review-clean.js');
    const paramCount = (content.match(/@param/g) || []).length;
    assert.ok(paramCount >= 3, `Expected >= 3 @param tags, found ${paramCount}`);
  });

  it('[REVIEW-02] 35-review-clean.js: has validateEmail function', () => {
    assert.ok(readFixture('35-review-clean.js').includes('validateEmail'), 'Missing validateEmail in clean fixture');
  });

  it('[REVIEW-02] 35-review-clean.js: has @returns tags (JSDoc complete)', () => {
    const content = readFixture('35-review-clean.js');
    const returnsCount = (content.match(/@returns/g) || []).length;
    assert.ok(returnsCount >= 3, `Expected >= 3 @returns tags, found ${returnsCount}`);
  });

  it('[REVIEW-02] 35-review-messy.js: exists and between 100-250 lines', () => {
    const messyPath = path.join(FIXTURES_DIR, '35-review-messy.js');
    assert.ok(fs.existsSync(messyPath), '35-review-messy.js does not exist');
    const lines = fs.readFileSync(messyPath, 'utf-8').split('\n').length;
    assert.ok(lines >= 100 && lines <= 250, `35-review-messy.js has ${lines} lines, expected 100-250`);
  });

  it('[REVIEW-02] 35-review-messy.js: has process_all_records (snake_case — naming inconsistency)', () => {
    assert.ok(
      readFixture('35-review-messy.js').includes('process_all_records'),
      'Missing process_all_records (snake_case function) in messy fixture'
    );
  });

  it('[REVIEW-02] 35-review-messy.js: has formatOutput without JSDoc (missing docs violation)', () => {
    const content = readFixture('35-review-messy.js');
    // formatOutput should be present
    assert.ok(content.includes('formatOutput'), 'Missing formatOutput in messy fixture');
    // The fixture has a comment noting no JSDoc
    assert.ok(
      content.includes('NO JSDoc') || content.includes('no JSDoc') || content.includes('NO @param') ||
      content.includes('no @param') || content.includes('missing documentation'),
      'Missing explicit no-JSDoc comment on formatOutput in messy fixture'
    );
  });

  it('[REVIEW-02] 35-review-messy.js: file is large enough to contain a 50+ line function', () => {
    const content = readFixture('35-review-messy.js');
    // process_all_records is documented as 57 lines. File must have at least 50+ body lines for the function.
    const lines = content.split('\n').length;
    // If file is > 100 lines and has a single long function annotation, we verify by content
    assert.ok(lines >= 100, `File should be >= 100 lines to contain a 50+ line function, got ${lines}`);
    assert.ok(
      content.includes('57 lines') || content.includes('55 lines') || content.includes('long function') ||
      content.includes('VIOLATION: function body'),
      'Missing documentation of the long function violation in messy fixture'
    );
  });

  it('[REVIEW-02] 35-review-messy.js: must NOT trigger god class error (< 500 lines)', () => {
    const lines = readFixture('35-review-messy.js').split('\n').length;
    assert.ok(lines < 500, `35-review-messy.js has ${lines} lines — must be < 500 to avoid god class error`);
  });

  it('[REVIEW-02] 35-review-god-class.js: exists and > 500 lines', () => {
    const godPath = path.join(FIXTURES_DIR, '35-review-god-class.js');
    assert.ok(fs.existsSync(godPath), '35-review-god-class.js does not exist');
    const lines = fs.readFileSync(godPath, 'utf-8').split('\n').length;
    assert.ok(lines > 500, `35-review-god-class.js has ${lines} lines, MUST exceed 500`);
  });

  it('[REVIEW-02] 35-review-god-class.js: has class keyword', () => {
    assert.ok(
      readFixture('35-review-god-class.js').includes('class '),
      'Missing class keyword in god-class fixture'
    );
  });

  it('[REVIEW-02] 35-review-god-class.js: has 3+ concern keywords (auth, email, log/warn, process)', () => {
    const content = readFixture('35-review-god-class.js');
    const hasAuth = content.includes('login') || content.includes('authenticate') || content.includes('auth');
    const hasEmail = content.includes('email') || content.includes('sendEmail');
    const hasLog = content.includes('log') || content.includes('warn');
    const hasProcess = content.includes('process') || content.includes('transform');
    const concernCount = [hasAuth, hasEmail, hasLog, hasProcess].filter(Boolean).length;
    assert.ok(concernCount >= 3, `Expected >= 3 concern domains in god-class fixture, found ${concernCount}`);
  });

  it('[REVIEW-02] 35-review-god-class.js: documented as Phase 35 testing fixture', () => {
    const content = readFixture('35-review-god-class.js');
    assert.ok(
      content.includes('Phase 35') || content.includes('testing-only'),
      'Missing Phase 35 / testing-only header in god-class fixture'
    );
  });
});
