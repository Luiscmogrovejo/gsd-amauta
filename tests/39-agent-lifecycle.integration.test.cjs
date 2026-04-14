'use strict';
/**
 * Plan 39-03: Agent Lifecycle Integration Test Suite
 * File: tests/39-agent-lifecycle.integration.test.cjs
 *
 * Requirements covered:
 *   LIFE-01..05: Cross-cutting lifecycle correctness + prior phase regression gates
 *
 * Architecture:
 *   - Cross-cutting file checks always run (no daemon needed)
 *   - spawnSync at describe-block level (run-once-reuse pattern from Phase 38/40)
 *   - NODE_TEST_CONTEXT deleted via cleanEnv() before spawning inner node --test
 *   - eval-runner and canary-suite spawned as separate node processes (not --test)
 *   - Regression gates run prior phase unit suites individually
 *
 * Run: node --test tests/39-agent-lifecycle.integration.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');
const EVALS_DIR = path.join(__dirname, 'evals');

// ─── Helper: clean subprocess env (prevents NODE_TEST_CONTEXT recursive detection) ──

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ─── All 17 agent files (relative to project root) ────────────────────────────

const AGENT_FILES = [
  'agents/gsd-operator.md',
  'agents/gsd-planner.md',
  'agents/gsd-researcher.md',
  'agents/gsd-roadmapper.md',
  'agents/gsd-checker.md',
  'agents/gsd-validator.md',
  'agents/gsd-debugger.md',
  'agents/gsd-executor-backend.md',
  'agents/gsd-executor-frontend.md',
  'agents/gsd-executor-infra.md',
  'agents/gsd-executor-general.md',
  'agents/gsd-tester.md',
  'agents/gsd-qa.md',
  'agents/gsd-security.md',
  'agents/gsd-reviewer.md',
  'agents/gsd-executor-data.md',
  'agents/gsd-architect.md',
];

// ─── Group 1: 17-agent FORMAT-01 gate — all have exactly 10 ## sections ──────

describe('[FORMAT-01][LIFE-01] All 17 agents pass the 10-section format gate', () => {
  for (const agentFile of AGENT_FILES) {
    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} ## sections, expected 10`);
    });
  }
});

// ─── Group 2: Changelog cross-cutting — all 17 agents have matching changelog ──

describe('[LIFE-01] All 17 agents have a matching changelog file', () => {
  const CHANGELOG_DIR = path.join(AGENTS_DIR, 'changelog');

  for (const agentFile of AGENT_FILES) {
    const agentBase = path.basename(agentFile, '.md');
    it(`${agentBase} has changelog file at agents/changelog/${agentBase}.md`, () => {
      const changelogPath = path.join(CHANGELOG_DIR, `${agentBase}.md`);
      assert.ok(
        fs.existsSync(changelogPath),
        `agents/changelog/${agentBase}.md does not exist`
      );
    });
  }
});

// ─── Group 3: Eval runner — all 15 code-based scenarios pass ──────────────────

describe('[LIFE-04] Eval runner: all 15 code-based scenarios pass', () => {
  // Run eval-runner.cjs once and reuse result
  const evalResult = spawnSync('node', [
    path.join(EVALS_DIR, 'eval-runner.cjs'),
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: cleanEnv(),
  });

  it('eval-runner.cjs exits 0 (all scenarios pass)', () => {
    assert.strictEqual(
      evalResult.status,
      0,
      `eval-runner.cjs exited ${evalResult.status}.\nstdout: ${evalResult.stdout}\nstderr: ${evalResult.stderr}`
    );
  });

  it('eval-runner output reports "15/15" scenarios passed', () => {
    assert.ok(
      evalResult.stdout.includes('15/15'),
      `eval-runner output missing "15/15".\nstdout: ${evalResult.stdout}`
    );
  });

  it('eval-runner output reports "Failed: 0"', () => {
    assert.ok(
      evalResult.stdout.includes('Failed: 0'),
      `eval-runner output missing "Failed: 0".\nstdout: ${evalResult.stdout}`
    );
  });
});

// ─── Group 4: Canary suite — exits 0 ──────────────────────────────────────────

describe('[LIFE-03] Canary suite: 50 tests pass, exits 0', () => {
  // Run canary suite once and reuse result
  const canaryResult = spawnSync('node', [
    '--test',
    path.join(PROJECT_ROOT, 'tests', '39-canary-suite.test.cjs'),
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 120000,
    env: cleanEnv(),
  });

  it('39-canary-suite.test.cjs exits 0', () => {
    assert.strictEqual(
      canaryResult.status,
      0,
      `Canary suite exited ${canaryResult.status}.\nstdout: ${canaryResult.stdout}\nstderr: ${canaryResult.stderr}`
    );
  });

  it('Canary suite reports "fail 0"', () => {
    const combined = canaryResult.stdout + canaryResult.stderr;
    assert.ok(
      combined.includes('fail 0'),
      `Canary suite did not report "fail 0".\ncombined: ${combined.slice(0, 500)}`
    );
  });

  it('Canary suite reports "pass 50"', () => {
    const combined = canaryResult.stdout + canaryResult.stderr;
    assert.ok(
      combined.includes('pass 50'),
      `Canary suite did not report "pass 50".\ncombined: ${combined.slice(0, 500)}`
    );
  });
});

// ─── Group 5: Security rules identity — all 17 agents have the same security rules ──

describe('[SEC-04][LIFE-01] Security rules identity: all 17 agents share the same security rules section', () => {
  const SHARED_SECURITY_RULES = path.join(AGENTS_DIR, 'shared', 'security-rules.md');

  it('agents/shared/security-rules.md exists', () => {
    assert.ok(fs.existsSync(SHARED_SECURITY_RULES), 'agents/shared/security-rules.md does not exist');
  });

  it('all 17 agents have ## Security rules section', () => {
    for (const agentFile of AGENT_FILES) {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      assert.ok(
        content.includes('## Security rules'),
        `${agentFile} missing ## Security rules section`
      );
    }
  });

  it('all 17 agents have the parameterized SQL rule', () => {
    for (const agentFile of AGENT_FILES) {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      assert.ok(
        content.includes('Parameterized SQL'),
        `${agentFile} missing Parameterized SQL rule`
      );
    }
  });

  it('all 17 agents have the 7-day supply chain rule', () => {
    for (const agentFile of AGENT_FILES) {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      assert.ok(
        content.includes('7 days ago'),
        `${agentFile} missing "7 days ago" supply chain rule`
      );
    }
  });
});

// ─── Group 6: Inter-agent communication identity — all 17 agents ──────────────

describe('[COMM-05][LIFE-01] Inter-agent communication: all 17 agents have blackboard section', () => {
  const INTER_AGENT_TEXT = '### Inter-agent communication';

  for (const agentFile of AGENT_FILES) {
    it(`${agentFile} has ${INTER_AGENT_TEXT}`, () => {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      assert.ok(
        content.includes(INTER_AGENT_TEXT),
        `${agentFile} missing "${INTER_AGENT_TEXT}"`
      );
    });
  }
});

// ─── Group 7: Prior-phase regression gates ────────────────────────────────────
//
// Each suite is spawned once at describe-block level and reused across assertions.
// NODE_TEST_CONTEXT is deleted via cleanEnv() to prevent recursive detection.

describe('[LIFE-03] Regression gate: tests/31-format-regression.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/31-format-regression.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('31-format-regression exits 0', () => {
    assert.strictEqual(result.status, 0,
      `31-format-regression failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('31-format-regression reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `31-format-regression missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/40-engineering-standards.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/40-engineering-standards.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('40-engineering-standards.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `40-engineering-standards.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('40-engineering-standards.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `40-engineering-standards.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/37-architect-agent.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/37-architect-agent.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('37-architect-agent.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `37-architect-agent.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('37-architect-agent.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `37-architect-agent.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/36-data-engineering-agent.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/36-data-engineering-agent.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('36-data-engineering-agent.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `36-data-engineering-agent.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('36-data-engineering-agent.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `36-data-engineering-agent.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/35-code-review-agent.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/35-code-review-agent.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('35-code-review-agent.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `35-code-review-agent.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('35-code-review-agent.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `35-code-review-agent.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/38-blackboard-communication.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/38-blackboard-communication.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('38-blackboard-communication.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `38-blackboard-communication.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('38-blackboard-communication.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `38-blackboard-communication.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/34-agent-format.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/34-agent-format.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('34-agent-format.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `34-agent-format.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('34-agent-format.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `34-agent-format.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/33-agent-format.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/33-agent-format.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('33-agent-format.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `33-agent-format.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('33-agent-format.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `33-agent-format.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});

describe('[LIFE-03] Regression gate: tests/32-frontend-rebuild.unit.test.cjs passes', () => {
  const result = spawnSync('node', ['--test', 'tests/32-frontend-rebuild.unit.test.cjs'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv(),
  });
  it('32-frontend-rebuild.unit exits 0', () => {
    assert.strictEqual(result.status, 0,
      `32-frontend-rebuild.unit failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr.slice(0, 400)}`);
  });
  it('32-frontend-rebuild.unit reports fail 0', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes('fail 0'),
      `32-frontend-rebuild.unit missing "fail 0".\ncombined: ${combined.slice(0, 400)}`);
  });
});
