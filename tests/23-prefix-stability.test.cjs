#!/usr/bin/env node
/**
 * Phase 23 CACHE-01 + CACHE-03: Prefix Stability Test Suite.
 *
 * Validates that all 11 agent .md files have correct stable-prefix /
 * variable-suffix structure (CACHE-01) and that prefix content is
 * byte-identical across sequential reads (CACHE-03).
 *
 * Requirements:
 *   CACHE-01: Each agent file has exactly one CACHE_BREAKPOINT marker;
 *             stable structural tags (frontmatter, role, patterns) precede it;
 *             no volatile patterns appear before it.
 *   CACHE-03: Two sequential reads of the same agent file produce
 *             byte-identical content above the breakpoint.
 *
 * Run: node --test tests/23-prefix-stability.test.cjs
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');
const BREAKPOINT = '<!-- CACHE_BREAKPOINT -->';

// All 11 expected agent files
const EXPECTED_AGENT_NAMES = [
  'gsd-checker.md',
  'gsd-debugger.md',
  'gsd-executor-backend.md',
  'gsd-executor-frontend.md',
  'gsd-executor-general.md',
  'gsd-executor-infra.md',
  'gsd-operator.md',
  'gsd-planner.md',
  'gsd-researcher.md',
  'gsd-roadmapper.md',
  'gsd-validator.md',
];

// Volatile patterns that must NOT appear in the stable prefix
const VOLATILE_PATTERNS = [
  { re: /datetime\.now\(\)/i, label: 'datetime.now()' },
  { re: /time\.time\(\)/, label: 'time.time()' },
  { re: /Date\.now\b/, label: 'Date.now' },
  { re: /new Date\(/, label: 'new Date(' },
  { re: /Math\.random\(\)/, label: 'Math.random()' },
];

// ---------------------------------------------------------------------------
// Helper: read all 11 agent files
// ---------------------------------------------------------------------------
const AGENT_FILES = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.startsWith('gsd-') && f.endsWith('.md'))
  .sort()
  .map(f => ({ name: f, filePath: path.join(AGENTS_DIR, f) }));

// ---------------------------------------------------------------------------
// Test 1: All 11 agent files exist
// ---------------------------------------------------------------------------
describe('CACHE-01: Agent file presence', () => {
  it('all 11 agent files exist in agents/ directory', () => {
    assert.strictEqual(
      AGENT_FILES.length,
      11,
      `Expected 11 gsd-*.md files in agents/, found ${AGENT_FILES.length}: ${AGENT_FILES.map(f => f.name).join(', ')}`
    );
    for (const expectedName of EXPECTED_AGENT_NAMES) {
      const found = AGENT_FILES.some(f => f.name === expectedName);
      assert.ok(found, `Expected agent file missing: ${expectedName}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Each agent has exactly one CACHE_BREAKPOINT
// ---------------------------------------------------------------------------
describe('CACHE-01: Exactly one CACHE_BREAKPOINT per agent', () => {
  it('each agent file contains exactly one CACHE_BREAKPOINT marker', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const count = content.split(BREAKPOINT).length - 1;
      assert.strictEqual(
        count,
        1,
        `${name}: expected 1 CACHE_BREAKPOINT, found ${count}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: No volatile patterns before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: No volatile patterns in stable prefix', () => {
  it('no volatile timestamp/random patterns appear before CACHE_BREAKPOINT in any agent', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      for (const { re, label } of VOLATILE_PATTERNS) {
        assert.ok(
          !re.test(prefix),
          `${name}: volatile pattern "${label}" found in stable prefix (before CACHE_BREAKPOINT)`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: YAML frontmatter appears before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: YAML frontmatter in stable prefix', () => {
  it('YAML frontmatter (---) appears before CACHE_BREAKPOINT in each agent', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        /^---/.test(prefix.trimStart()),
        `${name}: YAML frontmatter (--- block) not found before CACHE_BREAKPOINT`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: <role> tag appears before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: role tag in stable prefix', () => {
  it('<role> tag appears before CACHE_BREAKPOINT in each agent', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        prefix.includes('<role>'),
        `${name}: <role> tag missing from stable prefix (before CACHE_BREAKPOINT)`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: <patterns> tag appears before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: patterns tag in stable prefix', () => {
  it('<patterns> tag appears before CACHE_BREAKPOINT in each agent', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        prefix.includes('<patterns>'),
        `${name}: <patterns> tag missing from stable prefix (before CACHE_BREAKPOINT)`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: <runtime_read> tag, if present, appears after breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: runtime_read tag in variable suffix', () => {
  it('any <runtime_read> tag appears after CACHE_BREAKPOINT (not before)', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes('<runtime_read>')) continue; // not all agents have it
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        !prefix.includes('<runtime_read>'),
        `${name}: <runtime_read> tag appears before CACHE_BREAKPOINT — should be in variable suffix`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: Two sequential reads produce byte-identical prefixes (CACHE-03)
// ---------------------------------------------------------------------------
describe('CACHE-03: Prefix determinism', () => {
  it('two sequential reads of each agent file produce identical stable prefixes', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content1 = fs.readFileSync(filePath, 'utf8');
      const content2 = fs.readFileSync(filePath, 'utf8');
      const idx1 = content1.indexOf(BREAKPOINT);
      const idx2 = content2.indexOf(BREAKPOINT);
      assert.ok(idx1 >= 0, `${name}: CACHE_BREAKPOINT not found (read 1)`);
      assert.ok(idx2 >= 0, `${name}: CACHE_BREAKPOINT not found (read 2)`);
      const prefix1 = content1.slice(0, idx1);
      const prefix2 = content2.slice(0, idx2);
      assert.strictEqual(
        prefix1,
        prefix2,
        `${name}: stable prefix differs between two sequential reads — non-deterministic content detected`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: audit script exits 0
// ---------------------------------------------------------------------------
describe('CACHE-01: Audit script passes', () => {
  it('audit-prefix-stability.cjs exits 0 with all agents passing', () => {
    const auditScript = path.join(PROJECT_ROOT, 'scripts', 'audit-prefix-stability.cjs');
    assert.ok(fs.existsSync(auditScript), `audit script not found: ${auditScript}`);
    let output = '';
    let exitCode = 0;
    try {
      output = execSync(`node "${auditScript}"`, { encoding: 'utf8' });
    } catch (err) {
      output = err.stdout || '';
      exitCode = err.status || 1;
    }
    assert.strictEqual(
      exitCode,
      0,
      `audit-prefix-stability.cjs exited with code ${exitCode}.\nOutput:\n${output}`
    );
    assert.ok(
      output.includes('11/11 PASSED'),
      `Expected "11/11 PASSED" in audit output.\nActual output:\n${output}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 10: Stable prefix is the majority of each file (>= 50%)
// ---------------------------------------------------------------------------
describe('CACHE-03: Prefix is majority of file content', () => {
  it('stable prefix content is >= 50% of each agent file size', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefixLen = breakpointIdx;
      const totalLen = content.length;
      const ratio = prefixLen / totalLen;
      assert.ok(
        ratio >= 0.5,
        `${name}: stable prefix is only ${(ratio * 100).toFixed(1)}% of file (< 50%) — breakpoint may be placed too early`
      );
    }
  });
});
