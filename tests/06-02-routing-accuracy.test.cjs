#!/usr/bin/env node
/**
 * Plan 06-02: Routing Accuracy + Performance Routing Tests
 *
 * Tests:
 *   ROUTE-01: Frontend routing
 *     1. .tsx routes to frontend
 *     2. .jsx routes to frontend
 *     3. .css routes to frontend
 *     4. .vue routes to frontend
 *     5. .svelte routes to frontend
 *   ROUTE-02: Backend routing
 *     6. .py routes to backend
 *     7. .ts routes to backend
 *     8. .js routes to backend
 *     9. .sql routes to backend
 *    10. .go routes to backend
 *   ROUTE-03: Infra routing (tightened)
 *    11. Dockerfile routes to infra
 *    12. docker-compose.yml routes to infra
 *    13. .github/workflows/ci.yml routes to infra
 *    14. terraform/main.tf routes to infra
 *    15. k8s/deployment.yaml routes to infra
 *   ROUTE-04: General routing
 *    16. README.md routes to general
 *    17. .env routes to general
 *    18. package.json routes to general
 *   ROUTE-05: False positive fixes (infra regex tightened)
 *    19. src/config.ts does NOT route to infra (should be backend)
 *    20. src/deploy-utils.ts does NOT route to infra (should be backend)
 *    21. .github/ISSUE_TEMPLATE.md does NOT route to infra (should be general)
 *   ROUTE-06: Mixed file routing (priority order)
 *    22. .tsx + .py mix routes to frontend (frontend priority)
 *    23. Dockerfile + .ts mix routes to infra (infra > backend)
 *   DEDUP-01: Routing is single source of truth
 *    24. execute-phase.md references gsd-tools route-executor
 *    25. execute-plan.md references gsd-tools route-executor
 *   PERF-01: Performance routing format fix
 *    26. execute-phase.md has pass_rate normalization (pr > 1 else)
 *    27. execute-phase.md has PERF_ROUTING_OVERRIDE note
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
// Phase 41: execute-phase.md is now a redirect — read sharded step files + legacy for full content
const EXEC_PHASE_DIR = path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase');
const EXEC_PHASE = fs.existsSync(path.join(EXEC_PHASE_DIR, 'steps'))
  ? fs.readdirSync(path.join(EXEC_PHASE_DIR, 'steps')).sort().map(f => fs.readFileSync(path.join(EXEC_PHASE_DIR, 'steps', f), 'utf-8')).join('\n') + '\n' + fs.readFileSync(path.join(EXEC_PHASE_DIR, 'workflow.md'), 'utf-8')
  : fs.readFileSync(path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase.md'), 'utf-8');
const EXEC_PLAN = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'workflows', 'execute-plan.md'), 'utf-8');

function route(files) {
  const out = execSync(`node "${TOOLS}" route-executor "${files}"`, { encoding: 'utf-8', timeout: 5000 });
  return JSON.parse(out.trim()).executor;
}

describe('ROUTE-01: Frontend routing', () => {
  it('1. .tsx routes to frontend', () => assert.equal(route('src/App.tsx'), 'executor-frontend'));
  it('2. .jsx routes to frontend', () => assert.equal(route('src/App.jsx'), 'executor-frontend'));
  it('3. .css routes to frontend', () => assert.equal(route('src/styles.css'), 'executor-frontend'));
  it('4. .vue routes to frontend', () => assert.equal(route('src/App.vue'), 'executor-frontend'));
  it('5. .svelte routes to frontend', () => assert.equal(route('src/App.svelte'), 'executor-frontend'));
});

describe('ROUTE-02: Backend routing', () => {
  it('6. .py routes to backend', () => assert.equal(route('src/api.py'), 'executor-backend'));
  it('7. .ts routes to backend', () => assert.equal(route('src/utils.ts'), 'executor-backend'));
  it('8. .js routes to backend', () => assert.equal(route('src/server.js'), 'executor-backend'));
  it('9. .sql routes to backend', () => assert.equal(route('migrations/001.sql'), 'executor-backend'));
  it('10. .go routes to backend', () => assert.equal(route('cmd/main.go'), 'executor-backend'));
});

describe('ROUTE-03: Infra routing (tightened)', () => {
  it('11. Dockerfile routes to infra', () => assert.equal(route('Dockerfile'), 'executor-infra'));
  it('12. docker-compose.yml routes to infra', () => assert.equal(route('docker-compose.yml'), 'executor-infra'));
  it('13. .github/workflows/ci.yml routes to infra', () => assert.equal(route('.github/workflows/ci.yml'), 'executor-infra'));
  it('14. terraform/main.tf routes to infra', () => assert.equal(route('terraform/main.tf'), 'executor-infra'));
  it('15. k8s/deployment.yaml routes to infra', () => assert.equal(route('k8s/deployment.yaml'), 'executor-infra'));
});

describe('ROUTE-04: General routing', () => {
  it('16. README.md routes to general', () => assert.equal(route('README.md'), 'executor-general'));
  it('17. .env routes to general', () => assert.equal(route('.env'), 'executor-general'));
  it('18. package.json routes to general', () => assert.equal(route('package.json'), 'executor-general'));
});

describe('ROUTE-05: False positive fixes', () => {
  it('19. src/config.ts routes to backend, NOT infra', () => assert.equal(route('src/config.ts'), 'executor-backend'));
  it('20. src/deploy-utils.ts routes to backend, NOT infra', () => assert.equal(route('src/deploy-utils.ts'), 'executor-backend'));
  it('21. .github/ISSUE_TEMPLATE.md routes to general, NOT infra', () => assert.equal(route('.github/ISSUE_TEMPLATE.md'), 'executor-general'));
});

describe('ROUTE-06: Mixed file routing (priority order)', () => {
  it('22. .tsx + .py mix routes to frontend', () => assert.equal(route('src/App.tsx,src/api.py'), 'executor-frontend'));
  it('23. Dockerfile + .ts mix routes to infra', () => assert.equal(route('Dockerfile,src/server.ts'), 'executor-infra'));
});

describe('DEDUP-01: Routing is single source of truth', () => {
  it('24. execute-phase.md references route-executor', () => {
    assert.ok(EXEC_PHASE.includes('route-executor'), 'execute-phase.md missing route-executor reference');
  });
  it('25. execute-plan.md references route-executor', () => {
    assert.ok(EXEC_PLAN.includes('route-executor'), 'execute-plan.md missing route-executor reference');
  });
});

describe('PERF-01: Performance routing format fix', () => {
  it('26. pass_rate normalization present', () => {
    assert.ok(EXEC_PHASE.includes('pr > 1 else'), 'Missing pass_rate normalization (pr > 1 else int(pr*100))');
  });
  it('27. PERF_ROUTING_OVERRIDE note present', () => {
    assert.ok(EXEC_PHASE.includes('PERF_ROUTING_OVERRIDE'), 'Missing PERF_ROUTING_OVERRIDE audit trail');
  });
});
