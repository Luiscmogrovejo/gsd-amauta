#!/usr/bin/env node
/**
 * Plan 06-05: Agent Capability Index Tests
 *
 * Tests:
 *   INDEX-01: File existence and validity
 *     1. agent-capabilities.json exists
 *     2. Valid JSON
 *     3. Has version field
 *     4. Has agents array
 *   INDEX-02: Completeness (all 11 agents)
 *     5. Exactly 11 agent entries
 *     6. All 11 agent IDs present
 *     7. No duplicate IDs
 *   INDEX-03: Structure per agent
 *     8. Every agent has id field
 *     9. Every agent has lane field (code or non-code)
 *    10. Every agent has file_patterns array
 *    11. Every agent has task_types array
 *    12. Every agent has tools array
 *    13. Every agent has patterns array
 *   INDEX-04: Routing data correctness
 *    14. executor-frontend has .tsx pattern
 *    15. executor-backend has .py pattern
 *    16. executor-infra has Dockerfile pattern
 *    17. executor-general has empty file_patterns
 *   INDEX-05: Lane assignments
 *    18. operator, planner, researcher, roadmapper, checker, validator are non-code
 *    19. executor-frontend, executor-backend, executor-infra, executor-general, debugger are code
 *   WIRE-01: Routing reads from index
 *    20. gsd-tools.cjs contains agent-capabilities.json reference
 *    21. gsd-tools.cjs route-executor still works (backward compat)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'get-shit-done', 'agent-capabilities.json');
const TOOLS_SRC = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'), 'utf-8');
const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));

const ALL_IDS = [
  'gsd-operator', 'gsd-planner', 'gsd-researcher', 'gsd-roadmapper',
  'gsd-executor-frontend', 'gsd-executor-backend', 'gsd-executor-infra',
  'gsd-executor-general', 'gsd-checker', 'gsd-validator', 'gsd-debugger'
];

const NON_CODE = ['gsd-operator', 'gsd-planner', 'gsd-researcher', 'gsd-roadmapper', 'gsd-checker', 'gsd-validator'];
const CODE = ['gsd-executor-frontend', 'gsd-executor-backend', 'gsd-executor-infra', 'gsd-executor-general', 'gsd-debugger'];

describe('INDEX-01: File existence and validity', () => {
  it('1. agent-capabilities.json exists', () => {
    assert.ok(fs.existsSync(INDEX_PATH), 'Missing agent-capabilities.json');
  });
  it('2. Valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')));
  });
  it('3. Has version field', () => {
    assert.ok(index.version, 'Missing version field');
  });
  it('4. Has agents array', () => {
    assert.ok(Array.isArray(index.agents), 'agents should be an array');
  });
});

describe('INDEX-02: Completeness', () => {
  it('5. Exactly 11 agent entries', () => {
    assert.equal(index.agents.length, 11, `Expected 11 agents, got ${index.agents.length}`);
  });
  it('6. All 11 agent IDs present', () => {
    const ids = index.agents.map(a => a.id);
    for (const id of ALL_IDS) {
      assert.ok(ids.includes(id), `Missing agent: ${id}`);
    }
  });
  it('7. No duplicate IDs', () => {
    const ids = index.agents.map(a => a.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'Duplicate agent IDs found');
  });
});

describe('INDEX-03: Structure per agent', () => {
  it('8. Every agent has id', () => {
    for (const a of index.agents) assert.ok(a.id, 'Missing id');
  });
  it('9. Every agent has lane', () => {
    for (const a of index.agents) {
      assert.ok(['code', 'non-code'].includes(a.lane), `${a.id}: invalid lane "${a.lane}"`);
    }
  });
  it('10. Every agent has file_patterns array', () => {
    for (const a of index.agents) assert.ok(Array.isArray(a.file_patterns), `${a.id}: file_patterns not array`);
  });
  it('11. Every agent has task_types array', () => {
    for (const a of index.agents) assert.ok(Array.isArray(a.task_types), `${a.id}: task_types not array`);
  });
  it('12. Every agent has tools array', () => {
    for (const a of index.agents) assert.ok(Array.isArray(a.tools), `${a.id}: tools not array`);
  });
  it('13. Every agent has patterns array', () => {
    for (const a of index.agents) assert.ok(Array.isArray(a.patterns), `${a.id}: patterns not array`);
  });
});

describe('INDEX-04: Routing data correctness', () => {
  it('14. executor-frontend has .tsx pattern', () => {
    const fe = index.agents.find(a => a.id === 'gsd-executor-frontend');
    assert.ok(fe.file_patterns.some(p => p.includes('tsx')), 'Missing .tsx pattern');
  });
  it('15. executor-backend has .py pattern', () => {
    const be = index.agents.find(a => a.id === 'gsd-executor-backend');
    assert.ok(be.file_patterns.some(p => p.includes('py')), 'Missing .py pattern');
  });
  it('16. executor-infra has Dockerfile pattern', () => {
    const infra = index.agents.find(a => a.id === 'gsd-executor-infra');
    assert.ok(infra.file_patterns.some(p => p.includes('Dockerfile')), 'Missing Dockerfile pattern');
  });
  it('17. executor-general has empty file_patterns', () => {
    const gen = index.agents.find(a => a.id === 'gsd-executor-general');
    assert.equal(gen.file_patterns.length, 0, 'executor-general should have empty file_patterns');
  });
});

describe('INDEX-05: Lane assignments', () => {
  it('18. Non-code agents', () => {
    for (const id of NON_CODE) {
      const a = index.agents.find(ag => ag.id === id);
      assert.equal(a.lane, 'non-code', `${id} should be non-code`);
    }
  });
  it('19. Code agents', () => {
    for (const id of CODE) {
      const a = index.agents.find(ag => ag.id === id);
      assert.equal(a.lane, 'code', `${id} should be code`);
    }
  });
});

describe('WIRE-01: Routing reads from index', () => {
  it('20. gsd-tools.cjs references agent-capabilities.json', () => {
    assert.ok(TOOLS_SRC.includes('agent-capabilities.json'), 'gsd-tools.cjs missing index reference');
  });
  it('21. route-executor backward compat', () => {
    const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
    const result = JSON.parse(execSync(`node "${TOOLS}" route-executor "src/App.tsx"`, { encoding: 'utf-8', timeout: 5000 }));
    assert.equal(result.executor, 'executor-frontend', 'Backward compat broken: .tsx should route frontend');
  });
});
