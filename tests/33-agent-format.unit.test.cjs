'use strict';
/**
 * Phase 33 — Agent Format Regression Suite
 * File: tests/33-agent-format.unit.test.cjs
 *
 * Requirements covered:
 *   TEST-01: gsd-tester CoverUp pattern present in agent
 *   TEST-02: gsd-tester Playwright E2E + POM pattern present
 *   TEST-03: gsd-tester fast-check property test pattern present
 *   TEST-04: gsd-qa coverage ratchet enforcement present
 *   TEST-05: gsd-qa Stryker mutation testing present
 *   TEST-06: gsd-qa test pyramid enforcement present
 *   TEST-07: gsd-qa quality audit antipattern detection present
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const tester = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-tester.md'), 'utf-8');
const qa = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-qa.md'), 'utf-8');

// ─── gsd-tester structural tests ────────────────────────────────

describe('gsd-tester: v3.0.0 10-section format (Phase 31 FORMAT-01 gate)', () => {
  it('[FORMAT] exactly 10 ## sections', () => {
    const count = (tester.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-tester has ${count} ## sections, expected 10`);
  });
  it('[FORMAT] version: 3.0.0 header present', () => {
    assert.ok(tester.includes('version: 3.0.0'));
  });
  it('[FORMAT-04] anti-over-engineering mandate verbatim', () => {
    assert.ok(tester.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'));
  });
  it('[FORMAT-03] security rules: Parameterized SQL present', () => {
    assert.ok(tester.includes('Parameterized SQL'));
  });
  it('[FORMAT] CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = tester.split('\n').filter(l => l.trim());
    assert.ok(lines[lines.length - 1].includes('CACHE_BREAKPOINT'));
  });
  it('[FORMAT] frontmatter name: gsd-tester', () => {
    assert.ok(tester.includes('name: gsd-tester'));
  });
});

describe('gsd-tester: "no self-assessment" boundary (tester does not evaluate)', () => {
  it('[BOUNDARY] tester boundary string present', () => {
    assert.ok(
      tester.includes('You do not evaluate test quality or mutation scores.'),
      'Missing: "You do not evaluate test quality or mutation scores."'
    );
  });
  it('[BOUNDARY] no mention of running Stryker in tester agent', () => {
    // gsd-tester must NOT instruct running Stryker — that is gsd-qa only
    const strykerLines = tester.split('\n').filter(l =>
      l.includes('npx stryker') || l.includes('stryker run')
    );
    assert.strictEqual(strykerLines.length, 0, `gsd-tester should not instruct running Stryker. Found: ${strykerLines.join(', ')}`);
  });
});

describe('[TEST-01] gsd-tester: CoverUp pattern (coverage-guided iteration)', () => {
  it('references CoverUp by name', () => {
    assert.ok(
      tester.toLowerCase().includes('coverup'),
      'Missing CoverUp pattern reference in gsd-tester'
    );
  });
  it('specifies max 5 iterations', () => {
    assert.ok(
      tester.includes('max 5') || tester.includes('5 iteration') || tester.includes('5 rounds') || tester.includes('iteration 5'),
      'Missing max 5 iterations constraint'
    );
  });
  it('specifies 80% coverage target', () => {
    assert.ok(
      tester.includes('80%'),
      'Missing 80% coverage target in CoverUp description'
    );
  });
});

describe('[TEST-02] gsd-tester: Playwright E2E + Page Object Model', () => {
  it('references Playwright', () => {
    assert.ok(tester.toLowerCase().includes('playwright'), 'Missing Playwright reference');
  });
  it('references Page Object Model', () => {
    assert.ok(
      tester.includes('Page Object Model') || tester.includes('POM'),
      'Missing Page Object Model reference'
    );
  });
  it('specifies complete user journey (not single click)', () => {
    assert.ok(
      tester.toLowerCase().includes('complete user journey') || tester.toLowerCase().includes('complete journey') || tester.toLowerCase().includes('user journey'),
      'Missing "complete user journey" requirement'
    );
  });
  it('specifies .e2e.test.cjs file naming', () => {
    assert.ok(tester.includes('.e2e.test.cjs'), 'Missing .e2e.test.cjs naming convention');
  });
});

describe('[TEST-03] gsd-tester: fast-check property tests', () => {
  it('references fast-check', () => {
    assert.ok(tester.includes('fast-check'), 'Missing fast-check reference');
  });
  it('specifies 100 iterations', () => {
    assert.ok(
      tester.includes('100 iteration') || tester.includes('numRuns: 100') || tester.includes('100'),
      'Missing 100 iterations requirement'
    );
  });
});

// ─── gsd-qa structural tests ────────────────────────────────────

describe('gsd-qa: v3.0.0 10-section format (Phase 31 FORMAT-01 gate)', () => {
  it('[FORMAT] exactly 10 ## sections', () => {
    const count = (qa.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-qa has ${count} ## sections, expected 10`);
  });
  it('[FORMAT] version: 3.0.0 header present', () => {
    assert.ok(qa.includes('version: 3.0.0'));
  });
  it('[FORMAT-04] anti-over-engineering mandate verbatim', () => {
    assert.ok(qa.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'));
  });
  it('[FORMAT-03] security rules: Parameterized SQL present', () => {
    assert.ok(qa.includes('Parameterized SQL'));
  });
  it('[FORMAT] CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = qa.split('\n').filter(l => l.trim());
    assert.ok(lines[lines.length - 1].includes('CACHE_BREAKPOINT'));
  });
  it('[FORMAT] frontmatter name: gsd-qa', () => {
    assert.ok(qa.includes('name: gsd-qa'));
  });
});

describe('gsd-qa: "no self-assessment" boundary (qa does not generate)', () => {
  it('[BOUNDARY] qa boundary string present', () => {
    assert.ok(
      qa.includes('You do not generate tests.'),
      'Missing: "You do not generate tests."'
    );
  });
  it('[BOUNDARY] no instruction to RUN CoverUp in qa agent (prohibitions are allowed)', () => {
    // gsd-qa must NOT instruct the user to run CoverUp — that is gsd-tester only.
    // Lines like "Never run CoverUp iterations" are prohibitions (allowed).
    // We look for lines that affirmatively instruct running CoverUp (imperative or procedural).
    const instructionLines = qa.split('\n').filter(l => {
      const lower = l.toLowerCase();
      if (!lower.includes('coverup')) return false;
      if (l.startsWith('#') || l.startsWith('>')) return false;
      // Prohibition lines: contain "never", "not", "do not", "don't" near coverup
      const isProhibition = lower.includes('never') || lower.includes(' not ') ||
        lower.includes("don't") || lower.includes('do not') || lower.includes("doesn't");
      return !isProhibition;
    });
    assert.strictEqual(instructionLines.length, 0,
      `gsd-qa should not instruct running CoverUp iterations. Found: ${instructionLines.join(', ')}`);
  });
});

describe('[TEST-04] gsd-qa: coverage ratchet enforcement', () => {
  it('references .coverage_threshold.json', () => {
    assert.ok(
      qa.includes('.coverage_threshold.json') || qa.includes('coverage_threshold'),
      'Missing coverage ratchet file reference'
    );
  });
  it('references coverage-ratchet script', () => {
    assert.ok(
      qa.includes('coverage-ratchet') || qa.includes('scripts/coverage-ratchet'),
      'Missing coverage-ratchet script reference'
    );
  });
  it('specifies threshold never decreases', () => {
    assert.ok(
      qa.includes('never decrease') || qa.includes('NEVER decrease') || qa.includes('ratchet'),
      'Missing "never decreases" ratchet constraint'
    );
  });
});

describe('[TEST-05] gsd-qa: Stryker mutation testing', () => {
  it('references Stryker', () => {
    assert.ok(
      qa.toLowerCase().includes('stryker'),
      'Missing Stryker reference in gsd-qa'
    );
  });
  it('specifies incremental mode (changed files only)', () => {
    assert.ok(
      qa.includes('incremental') || qa.includes('changed files'),
      'Missing incremental/changed-files mutation constraint'
    );
  });
  it('specifies 70% mutation score threshold', () => {
    assert.ok(qa.includes('70%'), 'Missing 70% mutation score threshold');
  });
});

describe('[TEST-06] gsd-qa: test pyramid enforcement', () => {
  it('references test pyramid', () => {
    assert.ok(qa.toLowerCase().includes('pyramid'), 'Missing test pyramid reference');
  });
  it('specifies test-pyramid script', () => {
    assert.ok(
      qa.includes('test-pyramid') || qa.includes('scripts/test-pyramid'),
      'Missing test-pyramid script reference'
    );
  });
  it('specifies unit >= 60% constraint', () => {
    assert.ok(qa.includes('60%'), 'Missing 60% unit test floor');
  });
  it('specifies E2E <= ceiling', () => {
    assert.ok(
      qa.includes('E2E') && (qa.includes('25%') || qa.includes('20%') || qa.includes('ceiling')),
      'Missing E2E ceiling constraint'
    );
  });
});

describe('[TEST-07] gsd-qa: quality antipattern detection', () => {
  it('mentions no-assertion tests', () => {
    assert.ok(
      qa.includes('no-assertion') || qa.includes('no assertion'),
      'Missing no-assertion antipattern'
    );
  });
  it('mentions implementation-testing antipattern', () => {
    assert.ok(
      qa.toLowerCase().includes('implementation-testing') || qa.toLowerCase().includes('impl-testing') || qa.toLowerCase().includes('testing implementation'),
      'Missing implementation-testing antipattern'
    );
  });
  it('mentions flaky test markers', () => {
    assert.ok(
      qa.toLowerCase().includes('flaky'),
      'Missing flaky test detection'
    );
  });
});
