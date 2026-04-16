'use strict';
/**
 * Plan 41-03-06: Legacy Fallback Tests
 * File: tests/sharded-workflow-legacy.test.cjs
 *
 * Requirements covered:
 *   SHARD-01, SHARD-02, SHARD-03: Legacy fallback mechanism
 *
 * Tests that the legacy fallback mechanism works:
 *   - Legacy files exist and contain original content
 *   - Redirect files are thin (< 20 lines) and point to correct targets
 *   - Router files contain use_legacy_workflows config check
 *   - Router files reference legacy files
 *
 * All tests are pure filesystem reads — no daemon or subprocess needed.
 *
 * Run: node --test tests/sharded-workflow-legacy.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'get-shit-done', 'workflows');

// Paths to legacy backup files
const LEGACY = {
  'plan-phase': path.join(WORKFLOWS_DIR, 'plan-phase-legacy.md'),
  'execute-phase': path.join(WORKFLOWS_DIR, 'execute-phase-legacy.md'),
  'discuss-phase': path.join(WORKFLOWS_DIR, 'discuss-phase-legacy.md'),
};

// Paths to redirect (thin) files
const REDIRECTS = {
  'plan-phase': path.join(WORKFLOWS_DIR, 'plan-phase.md'),
  'execute-phase': path.join(WORKFLOWS_DIR, 'execute-phase.md'),
  'discuss-phase': path.join(WORKFLOWS_DIR, 'discuss-phase.md'),
};

// Paths to router files
const ROUTERS = {
  'plan-phase': path.join(WORKFLOWS_DIR, 'plan-phase', 'workflow.md'),
  'execute-phase': path.join(WORKFLOWS_DIR, 'execute-phase', 'workflow.md'),
  'discuss-phase': path.join(WORKFLOWS_DIR, 'discuss-phase', 'workflow.md'),
};

// ─── Group 1: Legacy files exist and have substantial content ─────────────────

describe('[SHARD-01-03] Legacy backup files exist with substantial content', () => {

  it('plan-phase-legacy.md exists', () => {
    assert.ok(fs.existsSync(LEGACY['plan-phase']), 'plan-phase-legacy.md does not exist');
  });

  it('execute-phase-legacy.md exists', () => {
    assert.ok(fs.existsSync(LEGACY['execute-phase']), 'execute-phase-legacy.md does not exist');
  });

  it('discuss-phase-legacy.md exists', () => {
    assert.ok(fs.existsSync(LEGACY['discuss-phase']), 'discuss-phase-legacy.md does not exist');
  });

  it('plan-phase-legacy.md has >= 600 lines (original monolith preserved)', () => {
    const content = fs.readFileSync(LEGACY['plan-phase'], 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(
      lines >= 600,
      `plan-phase-legacy.md has only ${lines} lines, expected >= 600`
    );
  });

  it('execute-phase-legacy.md has >= 800 lines (original monolith preserved)', () => {
    const content = fs.readFileSync(LEGACY['execute-phase'], 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(
      lines >= 800,
      `execute-phase-legacy.md has only ${lines} lines, expected >= 800`
    );
  });

  it('discuss-phase-legacy.md has >= 700 lines (original monolith preserved)', () => {
    const content = fs.readFileSync(LEGACY['discuss-phase'], 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(
      lines >= 700,
      `discuss-phase-legacy.md has only ${lines} lines, expected >= 700`
    );
  });

});

// ─── Group 2: Legacy files contain original content ───────────────────────────

describe('[SHARD-01-03] Legacy files contain original workflow content', () => {

  it('plan-phase-legacy.md contains gsd-planner references (original content)', () => {
    const content = fs.readFileSync(LEGACY['plan-phase'], 'utf-8');
    assert.ok(
      content.includes('gsd-planner') || content.includes('planner'),
      'plan-phase-legacy.md missing gsd-planner reference (original content may be missing)'
    );
  });

  it('plan-phase-legacy.md starts with LEGACY header comment', () => {
    const content = fs.readFileSync(LEGACY['plan-phase'], 'utf-8');
    assert.ok(
      content.startsWith('<!-- LEGACY'),
      'plan-phase-legacy.md missing LEGACY header comment at start'
    );
  });

  it('execute-phase-legacy.md contains gsd-executor references (original content)', () => {
    const content = fs.readFileSync(LEGACY['execute-phase'], 'utf-8');
    assert.ok(
      content.includes('gsd-executor') || content.includes('executor'),
      'execute-phase-legacy.md missing executor reference (original content may be missing)'
    );
  });

  it('execute-phase-legacy.md starts with LEGACY header comment', () => {
    const content = fs.readFileSync(LEGACY['execute-phase'], 'utf-8');
    assert.ok(
      content.startsWith('<!-- LEGACY'),
      'execute-phase-legacy.md missing LEGACY header comment at start'
    );
  });

  it('discuss-phase-legacy.md contains discussion-related content (original content)', () => {
    const content = fs.readFileSync(LEGACY['discuss-phase'], 'utf-8');
    assert.ok(
      content.includes('discuss') || content.includes('gray area') || content.includes('gsd-qa'),
      'discuss-phase-legacy.md missing discussion content (original content may be missing)'
    );
  });

  it('discuss-phase-legacy.md starts with LEGACY header comment', () => {
    const content = fs.readFileSync(LEGACY['discuss-phase'], 'utf-8');
    assert.ok(
      content.startsWith('<!-- LEGACY'),
      'discuss-phase-legacy.md missing LEGACY header comment at start'
    );
  });

});

// ─── Group 3: Redirect files are thin ────────────────────────────────────────

describe('[SHARD-01-03] Redirect files are thin (< 20 lines)', () => {

  it('plan-phase.md redirect has < 20 lines', () => {
    const content = fs.readFileSync(REDIRECTS['plan-phase'], 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(
      lines < 20,
      `plan-phase.md redirect has ${lines} lines, expected < 20`
    );
  });

  it('execute-phase.md redirect has < 20 lines', () => {
    const content = fs.readFileSync(REDIRECTS['execute-phase'], 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(
      lines < 20,
      `execute-phase.md redirect has ${lines} lines, expected < 20`
    );
  });

  it('discuss-phase.md redirect has < 20 lines', () => {
    const content = fs.readFileSync(REDIRECTS['discuss-phase'], 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(
      lines < 20,
      `discuss-phase.md redirect has ${lines} lines, expected < 20`
    );
  });

});

// ─── Group 4: Redirect files point to correct targets ────────────────────────

describe('[SHARD-01-03] Redirect files point to correct sharded router targets', () => {

  it('plan-phase.md contains reference to plan-phase/workflow.md', () => {
    const content = fs.readFileSync(REDIRECTS['plan-phase'], 'utf-8');
    assert.ok(
      content.includes('plan-phase/workflow.md'),
      'plan-phase.md redirect missing reference to plan-phase/workflow.md'
    );
  });

  it('execute-phase.md contains reference to execute-phase/workflow.md', () => {
    const content = fs.readFileSync(REDIRECTS['execute-phase'], 'utf-8');
    assert.ok(
      content.includes('execute-phase/workflow.md'),
      'execute-phase.md redirect missing reference to execute-phase/workflow.md'
    );
  });

  it('discuss-phase.md contains reference to discuss-phase/workflow.md', () => {
    const content = fs.readFileSync(REDIRECTS['discuss-phase'], 'utf-8');
    assert.ok(
      content.includes('discuss-phase/workflow.md'),
      'discuss-phase.md redirect missing reference to discuss-phase/workflow.md'
    );
  });

});

// ─── Group 5: Router files contain legacy fallback check ─────────────────────

describe('[SHARD-01-03] Router files contain use_legacy_workflows config check', () => {

  it('plan-phase/workflow.md contains use_legacy_workflows check', () => {
    const content = fs.readFileSync(ROUTERS['plan-phase'], 'utf-8');
    assert.ok(
      content.includes('use_legacy_workflows'),
      'plan-phase/workflow.md missing use_legacy_workflows config check'
    );
  });

  it('execute-phase/workflow.md contains use_legacy_workflows check', () => {
    const content = fs.readFileSync(ROUTERS['execute-phase'], 'utf-8');
    assert.ok(
      content.includes('use_legacy_workflows'),
      'execute-phase/workflow.md missing use_legacy_workflows config check'
    );
  });

  it('discuss-phase/workflow.md contains use_legacy_workflows check', () => {
    const content = fs.readFileSync(ROUTERS['discuss-phase'], 'utf-8');
    assert.ok(
      content.includes('use_legacy_workflows'),
      'discuss-phase/workflow.md missing use_legacy_workflows config check'
    );
  });

});

// ─── Group 6: Router files reference their legacy files ──────────────────────

describe('[SHARD-01-03] Router files reference their corresponding legacy files', () => {

  it('plan-phase/workflow.md contains plan-phase-legacy.md reference', () => {
    const content = fs.readFileSync(ROUTERS['plan-phase'], 'utf-8');
    assert.ok(
      content.includes('plan-phase-legacy.md'),
      'plan-phase/workflow.md missing plan-phase-legacy.md reference'
    );
  });

  it('execute-phase/workflow.md contains execute-phase-legacy.md reference', () => {
    const content = fs.readFileSync(ROUTERS['execute-phase'], 'utf-8');
    assert.ok(
      content.includes('execute-phase-legacy.md'),
      'execute-phase/workflow.md missing execute-phase-legacy.md reference'
    );
  });

  it('discuss-phase/workflow.md contains discuss-phase-legacy.md reference', () => {
    const content = fs.readFileSync(ROUTERS['discuss-phase'], 'utf-8');
    assert.ok(
      content.includes('discuss-phase-legacy.md'),
      'discuss-phase/workflow.md missing discuss-phase-legacy.md reference'
    );
  });

  it('all 3 legacy files contain Will be removed in v3.2 notice', () => {
    for (const [wf, legacyPath] of Object.entries(LEGACY)) {
      const content = fs.readFileSync(legacyPath, 'utf-8');
      assert.ok(
        content.includes('v3.2') || content.includes('Will be removed'),
        `${wf}-legacy.md missing v3.2 removal notice`
      );
    }
  });

});
