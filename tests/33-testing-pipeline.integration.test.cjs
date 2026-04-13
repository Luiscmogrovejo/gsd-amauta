'use strict';
/**
 * Phase 33 — Testing Pipeline Integration Tests
 * File: tests/33-testing-pipeline.integration.test.cjs
 *
 * Full requirements coverage: TEST-01..08
 * This is the capstone suite — passes when all Phase 33 deliverables are in place.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const TESTS_DIR = path.join(ROOT, 'tests');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const PACT_DIR = path.join(TESTS_DIR, 'pact');

const tester = () => fs.readFileSync(path.join(AGENTS_DIR, 'gsd-tester.md'), 'utf-8');
const qa = () => fs.readFileSync(path.join(AGENTS_DIR, 'gsd-qa.md'), 'utf-8');

// [TEST-01] CoverUp — agent + script infrastructure
describe('[TEST-01] CoverUp infrastructure in place', () => {
  it('gsd-tester has CoverUp pattern with 5-iteration limit', () => {
    const t = tester();
    assert.ok(t.toLowerCase().includes('coverup'), 'Missing CoverUp');
    assert.ok(t.includes('5') && (t.includes('iteration') || t.includes('round')), 'Missing iteration limit');
    assert.ok(t.includes('80%'), 'Missing 80% target');
  });
  it('gsd-tester specifies c8 as coverage tool', () => {
    const t = tester();
    assert.ok(t.includes('c8') || t.includes('coverage-summary.json'), 'Missing c8 reference');
  });
  it('coverage-ratchet.cjs exists and reads coverage-summary.json', () => {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'coverage-ratchet.cjs'), 'utf-8');
    assert.ok(src.includes('coverage-summary.json'));
  });
});

// [TEST-02] Playwright E2E
describe('[TEST-02] Playwright E2E infrastructure in place', () => {
  it('gsd-tester specifies .e2e.test.cjs naming', () => {
    assert.ok(tester().includes('.e2e.test.cjs'));
  });
  it('tests/pages/ directory exists (POM location)', () => {
    assert.ok(
      fs.existsSync(path.join(TESTS_DIR, 'pages')),
      'tests/pages/ directory missing'
    );
  });
  it('TaskBoardPage.js POM exists', () => {
    assert.ok(
      fs.existsSync(path.join(TESTS_DIR, 'pages', 'TaskBoardPage.js')),
      'tests/pages/TaskBoardPage.js missing'
    );
  });
  it('board.e2e.test.cjs uses E2E_BASE_URL guard', () => {
    const content = fs.readFileSync(path.join(TESTS_DIR, 'board.e2e.test.cjs'), 'utf-8');
    assert.ok(content.includes('E2E_BASE_URL'));
  });
  it('@playwright/test in package.json devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.ok(
      pkg.devDependencies && pkg.devDependencies['@playwright/test'],
      'Missing @playwright/test in devDependencies'
    );
  });
});

// [TEST-03] fast-check property tests
describe('[TEST-03] fast-check property test infrastructure', () => {
  it('gsd-tester references fast-check', () => {
    assert.ok(tester().includes('fast-check'));
  });
  it('parse-learning.unit.test.cjs exists', () => {
    assert.ok(fs.existsSync(path.join(TESTS_DIR, 'parse-learning.unit.test.cjs')));
  });
  it('parse-learning.unit.test.cjs has 3 property tests with numRuns: 100', () => {
    const content = fs.readFileSync(path.join(TESTS_DIR, 'parse-learning.unit.test.cjs'), 'utf-8');
    const propertyCount = (content.match(/fc\.property/g) || []).length;
    assert.ok(propertyCount >= 3, `Expected >= 3 fc.property calls, found ${propertyCount}`);
    assert.ok(content.includes('numRuns: 100'));
  });
  it('fast-check in package.json devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.ok(
      pkg.devDependencies && pkg.devDependencies['fast-check'],
      'Missing fast-check in devDependencies'
    );
  });
  it('parse-learning.unit.test.cjs passes', () => {
    const result = spawnSync(process.execPath, ['--test', 'tests/parse-learning.unit.test.cjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000
    });
    assert.strictEqual(result.status, 0, `Property tests failed: ${result.stderr}`);
  });
});

// [TEST-04] Coverage ratchet
describe('[TEST-04] Coverage ratchet enforcement', () => {
  it('gsd-qa references coverage-ratchet.cjs', () => {
    assert.ok(qa().includes('coverage-ratchet'));
  });
  it('.coverage_threshold.json schema valid', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.coverage_threshold.json'), 'utf-8'));
    assert.ok(typeof data.lines === 'number');
    assert.ok(typeof data.branches === 'number');
    assert.ok(typeof data.timestamp === 'string');
  });
  it('gsd-qa specifies threshold never decreases', () => {
    const q = qa();
    assert.ok(q.includes('never decrease') || q.includes('NEVER decrease') || q.includes('ratchet'));
  });
});

// [TEST-05] Stryker mutation testing
describe('[TEST-05] Stryker mutation testing infrastructure', () => {
  it('stryker.config.json exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'stryker.config.json')));
  });
  it('stryker.config.json has incremental: true', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.config.json'), 'utf-8'));
    assert.strictEqual(config.incremental, true);
  });
  it('stryker.config.json has break threshold at 60', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.config.json'), 'utf-8'));
    assert.strictEqual(config.thresholds.break, 60);
  });
  it('gsd-qa specifies 70% mutation score threshold', () => {
    assert.ok(qa().includes('70%'));
  });
  it('gsd-qa specifies incremental mode (changed files only)', () => {
    const q = qa();
    assert.ok(q.includes('incremental') || q.includes('changed files'));
  });
});

// [TEST-06] Test pyramid
describe('[TEST-06] Test pyramid enforcement', () => {
  it('test-pyramid.cjs exists and passes', () => {
    const result = spawnSync(process.execPath, ['scripts/test-pyramid.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    assert.strictEqual(result.status, 0, `Pyramid check failed: ${result.stderr}`);
  });
  it('test-pyramid output has pyramid_valid: true', () => {
    const result = spawnSync(process.execPath, ['scripts/test-pyramid.cjs'], {
      cwd: ROOT, encoding: 'utf-8'
    });
    const data = JSON.parse(result.stdout);
    assert.strictEqual(data.pyramid_valid, true);
  });
  it('gsd-qa specifies unit >= 60%, E2E ceiling', () => {
    const q = qa();
    assert.ok(q.includes('60%'));
    assert.ok(q.includes('E2E') && (q.includes('25%') || q.includes('20%') || q.includes('ceiling')));
  });
});

// [TEST-07] Quality audit antipatterns
describe('[TEST-07] Quality audit antipattern detection', () => {
  it('quality-audit.cjs exits 0 on clean codebase', () => {
    const result = spawnSync(process.execPath, ['scripts/quality-audit.cjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000
    });
    assert.strictEqual(result.status, 0, `Quality audit failed: ${result.stdout}`);
  });
  it('quality-audit output pass=true', () => {
    const result = spawnSync(process.execPath, ['scripts/quality-audit.cjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000
    });
    const data = JSON.parse(result.stdout);
    assert.strictEqual(data.pass, true, `Gaps found: ${JSON.stringify(data.gaps)}`);
  });
  it('gsd-qa detects no-assertion, flaky, implementation-testing', () => {
    const q = qa();
    assert.ok(q.includes('no-assertion') || q.includes('no assertion'));
    assert.ok(q.toLowerCase().includes('flaky'));
  });
});

// [TEST-08] Pact contracts
describe('[TEST-08] Pact contracts for >= 3 daemon endpoints', () => {
  it('all 3 Pact contract files exist', () => {
    for (const file of ['context-compact.pact.cjs', 'context-get.pact.cjs', 'rlm-search.pact.cjs']) {
      assert.ok(fs.existsSync(path.join(PACT_DIR, file)), `Missing: tests/pact/${file}`);
    }
  });
  it('all contracts use gsd-tools as consumer', () => {
    for (const file of ['context-compact.pact.cjs', 'context-get.pact.cjs', 'rlm-search.pact.cjs']) {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      assert.ok(content.includes('gsd-tools'), `${file} missing gsd-tools consumer`);
    }
  });
  it('all contracts use amauta-daemon as provider', () => {
    for (const file of ['context-compact.pact.cjs', 'context-get.pact.cjs', 'rlm-search.pact.cjs']) {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      assert.ok(content.includes('amauta-daemon'), `${file} missing amauta-daemon provider`);
    }
  });
  it('local file-based Pact broker (pacts/ dir path in config)', () => {
    for (const file of ['context-compact.pact.cjs', 'context-get.pact.cjs', 'rlm-search.pact.cjs']) {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      assert.ok(content.includes('pacts'), `${file} missing local pacts/ directory reference`);
    }
  });
});
