'use strict';
/**
 * Plan 39-03: Agent Lifecycle Unit Test Suite
 * File: tests/39-agent-lifecycle.unit.test.cjs
 *
 * Requirements covered:
 *   LIFE-01: SemVer versioning + per-agent changelogs
 *   LIFE-02: Agent metrics PG table + daemon endpoints + gsd-tools agent-stats
 *   LIFE-03: Canary suite (50 tests, McNemar's comparison, baseline vector)
 *   LIFE-04: Eval framework (15 scenarios, 3 grader type schemas)
 *   LIFE-05: Tool integrity checking (SHA-256 + Valkey, graceful degradation)
 *
 * All assertions are pure file-system reads (grep equivalent).
 * Uses node:test + node:assert/strict — no child processes, no network.
 * Total: >= 60 assertions organized by LIFE-XX requirement group.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const CHANGELOG_DIR = path.join(AGENTS_DIR, 'changelog');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const TESTS_DIR = path.join(ROOT, 'tests');
const EVALS_DIR = path.join(TESTS_DIR, 'evals');
const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures');

// Helper: read a file by absolute path
function readFile(absPath) {
  return fs.readFileSync(absPath, 'utf-8');
}

// Helper: read an agent file by base name (no extension)
function agentContent(name) {
  return readFile(path.join(AGENTS_DIR, `${name}.md`));
}

// Helper: read changelog file for agent
function changelogContent(name) {
  return readFile(path.join(CHANGELOG_DIR, `${name}.md`));
}

// All 17 agent base names
const ALL_17_AGENTS = [
  'gsd-operator',
  'gsd-planner',
  'gsd-researcher',
  'gsd-roadmapper',
  'gsd-checker',
  'gsd-validator',
  'gsd-debugger',
  'gsd-executor-backend',
  'gsd-executor-frontend',
  'gsd-executor-infra',
  'gsd-executor-general',
  'gsd-tester',
  'gsd-qa',
  'gsd-security',
  'gsd-reviewer',
  'gsd-executor-data',
  'gsd-architect',
];

// ─── LIFE-01: SemVer + Changelog (~15 assertions) ────────────────────────────

describe('[LIFE-01] SemVer versioning and per-agent changelogs', () => {

  it('LIFE-01: all 17 agents have ## version: 3.0.0 header', () => {
    for (const agent of ALL_17_AGENTS) {
      const content = agentContent(agent);
      assert.ok(
        content.includes('## version: 3.0.0'),
        `${agent}.md missing ## version: 3.0.0 header`
      );
    }
  });

  it('LIFE-01: agents/changelog/ directory exists', () => {
    assert.ok(
      fs.existsSync(CHANGELOG_DIR),
      'agents/changelog/ directory does not exist'
    );
  });

  it('LIFE-01: agents/changelog/ has exactly 17 files', () => {
    const files = fs.readdirSync(CHANGELOG_DIR).filter(f => f.endsWith('.md'));
    assert.strictEqual(
      files.length,
      17,
      `agents/changelog/ has ${files.length} .md files, expected 17`
    );
  });

  it('LIFE-01: gsd-executor-backend changelog contains 3.0.0 entry', () => {
    const content = changelogContent('gsd-executor-backend');
    assert.ok(content.includes('3.0.0'), 'gsd-executor-backend changelog missing 3.0.0 entry');
  });

  it('LIFE-01: gsd-tester changelog contains 3.0.0 entry', () => {
    const content = changelogContent('gsd-tester');
    assert.ok(content.includes('3.0.0'), 'gsd-tester changelog missing 3.0.0 entry');
  });

  it('LIFE-01: gsd-security changelog contains 3.0.0 entry', () => {
    const content = changelogContent('gsd-security');
    assert.ok(content.includes('3.0.0'), 'gsd-security changelog missing 3.0.0 entry');
  });

  it('LIFE-01: gsd-operator has ### Version management subsection', () => {
    const content = agentContent('gsd-operator');
    assert.ok(
      content.includes('### Version management'),
      'gsd-operator.md missing ### Version management subsection'
    );
  });

  it('LIFE-01: gsd-operator has "bumps the version" rule', () => {
    const content = agentContent('gsd-operator');
    assert.ok(
      content.includes('bumps the version'),
      'gsd-operator.md missing "bumps the version" rule'
    );
  });

  it('LIFE-01: gsd-operator has Major/Minor/Patch version criteria', () => {
    const content = agentContent('gsd-operator');
    assert.ok(content.includes('Major'), 'gsd-operator.md missing Major version criteria');
    assert.ok(content.includes('Minor'), 'gsd-operator.md missing Minor version criteria');
    assert.ok(content.includes('Patch'), 'gsd-operator.md missing Patch version criteria');
  });

  it('LIFE-01: FORMAT-01 — gsd-operator still has exactly 10 ## sections', () => {
    const content = agentContent('gsd-operator');
    const count = (content.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-operator.md has ${count} ## sections, expected 10`);
  });

  it('LIFE-01: gsd-operator Version management says atomic commit rule', () => {
    const content = agentContent('gsd-operator');
    assert.ok(
      content.includes('atomic commit'),
      'gsd-operator.md missing atomic commit requirement in Version management'
    );
  });

  it('LIFE-01: all 17 changelog files are non-empty', () => {
    for (const agent of ALL_17_AGENTS) {
      const filePath = path.join(CHANGELOG_DIR, `${agent}.md`);
      const content = readFile(filePath);
      assert.ok(content.trim().length > 0, `changelog/${agent}.md is empty`);
    }
  });

  it('LIFE-01: gsd-operator changelog contains 3.0.0 entry', () => {
    const content = changelogContent('gsd-operator');
    assert.ok(content.includes('3.0.0'), 'gsd-operator changelog missing 3.0.0 entry');
  });

  it('LIFE-01: gsd-architect changelog exists', () => {
    const filePath = path.join(CHANGELOG_DIR, 'gsd-architect.md');
    assert.ok(fs.existsSync(filePath), 'agents/changelog/gsd-architect.md does not exist');
  });

  it('LIFE-01: gsd-planner changelog exists', () => {
    const filePath = path.join(CHANGELOG_DIR, 'gsd-planner.md');
    assert.ok(fs.existsSync(filePath), 'agents/changelog/gsd-planner.md does not exist');
  });

});

// ─── LIFE-02: Agent Metrics (~12 assertions) ──────────────────────────────────

describe('[LIFE-02] Agent metrics PG table + daemon endpoints + gsd-tools', () => {

  it('LIFE-02: migrations/016-agent-metrics.sql exists', () => {
    const p = path.join(MIGRATIONS_DIR, '016-agent-metrics.sql');
    assert.ok(fs.existsSync(p), 'migrations/016-agent-metrics.sql does not exist');
  });

  it('LIFE-02: migration has CREATE TABLE agent_metrics', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('CREATE TABLE agent_metrics'), 'migration missing CREATE TABLE agent_metrics');
  });

  it('LIFE-02: migration has agent_name column', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('agent_name'), 'migration missing agent_name column');
  });

  it('LIFE-02: migration has task_id column', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('task_id'), 'migration missing task_id column');
  });

  it('LIFE-02: migration has completion_time_ms column', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('completion_time_ms'), 'migration missing completion_time_ms column');
  });

  it('LIFE-02: migration has token_usage column', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('token_usage'), 'migration missing token_usage column');
  });

  it('LIFE-02: migration has error_count column', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('error_count'), 'migration missing error_count column');
  });

  it('LIFE-02: migration has outcome column', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('outcome'), 'migration missing outcome column');
  });

  it('LIFE-02: migration has idx_metrics_agent index', () => {
    const content = readFile(path.join(MIGRATIONS_DIR, '016-agent-metrics.sql'));
    assert.ok(content.includes('idx_metrics_agent'), 'migration missing idx_metrics_agent index');
  });

  it('LIFE-02: DOWN migration exists with DROP TABLE', () => {
    const downPath = path.join(MIGRATIONS_DIR, '016-agent-metrics-DOWN.sql');
    assert.ok(fs.existsSync(downPath), '016-agent-metrics-DOWN.sql does not exist');
    const content = readFile(downPath);
    assert.ok(content.includes('DROP TABLE'), 'DOWN migration missing DROP TABLE');
  });

  it('LIFE-02: daemon has /api/metrics endpoint reference', () => {
    const daemonPath = path.join(ROOT, 'services', 'amauta-daemon.py');
    const content = readFile(daemonPath);
    assert.ok(content.includes('/api/metrics'), 'daemon missing /api/metrics endpoint reference');
  });

  it('LIFE-02: daemon has /api/metrics/stats endpoint reference', () => {
    const daemonPath = path.join(ROOT, 'services', 'amauta-daemon.py');
    const content = readFile(daemonPath);
    assert.ok(content.includes('/api/metrics/stats'), 'daemon missing /api/metrics/stats endpoint reference');
  });

  it('LIFE-02: gsd-tools has agent-stats command', () => {
    const toolsPath = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
    const content = readFile(toolsPath);
    assert.ok(content.includes('agent-stats'), 'gsd-tools.cjs missing agent-stats command');
  });

});

// ─── LIFE-03: Canary Suite (~10 assertions) ───────────────────────────────────

describe('[LIFE-03] Canary suite — 50 tests, McNemar\'s comparison, baseline vector', () => {

  it('LIFE-03: tests/39-canary-suite.test.cjs exists', () => {
    const p = path.join(TESTS_DIR, '39-canary-suite.test.cjs');
    assert.ok(fs.existsSync(p), 'tests/39-canary-suite.test.cjs does not exist');
  });

  it('LIFE-03: canary suite has >= 50 it() blocks', () => {
    const content = readFile(path.join(TESTS_DIR, '39-canary-suite.test.cjs'));
    const count = (content.match(/\bit\(/g) || []).length;
    assert.ok(count >= 50, `canary suite has only ${count} it() blocks, expected >= 50`);
  });

  it('LIFE-03: canary suite has >= 10 describe() blocks', () => {
    const content = readFile(path.join(TESTS_DIR, '39-canary-suite.test.cjs'));
    const count = (content.match(/\bdescribe\(/g) || []).length;
    assert.ok(count >= 10, `canary suite has only ${count} describe() blocks, expected >= 10`);
  });

  it('LIFE-03: canary suite covers FORMAT category', () => {
    const content = readFile(path.join(TESTS_DIR, '39-canary-suite.test.cjs'));
    assert.ok(content.includes('FORMAT'), 'canary suite missing FORMAT category');
  });

  it('LIFE-03: canary suite covers LIFE category', () => {
    const content = readFile(path.join(TESTS_DIR, '39-canary-suite.test.cjs'));
    assert.ok(content.includes('LIFE'), 'canary suite missing LIFE category');
  });

  it('LIFE-03: canary suite covers ENG category', () => {
    const content = readFile(path.join(TESTS_DIR, '39-canary-suite.test.cjs'));
    assert.ok(content.includes('ENG'), 'canary suite missing ENG category');
  });

  it('LIFE-03: scripts/canary-compare.cjs exists', () => {
    const p = path.join(SCRIPTS_DIR, 'canary-compare.cjs');
    assert.ok(fs.existsSync(p), 'scripts/canary-compare.cjs does not exist');
  });

  it('LIFE-03: canary-compare.cjs has McNemar\'s computation', () => {
    const content = readFile(path.join(SCRIPTS_DIR, 'canary-compare.cjs'));
    assert.ok(content.includes('McNemar') || content.includes('mcnemar'), 'canary-compare.cjs missing McNemar reference');
  });

  it('LIFE-03: baseline vector exists at tests/fixtures/39-canary-baseline.json', () => {
    const p = path.join(FIXTURES_DIR, '39-canary-baseline.json');
    assert.ok(fs.existsSync(p), 'tests/fixtures/39-canary-baseline.json does not exist');
  });

  it('LIFE-03: baseline vector has >= 50 entries', () => {
    const content = JSON.parse(readFile(path.join(FIXTURES_DIR, '39-canary-baseline.json')));
    const count = Object.keys(content).length;
    assert.ok(count >= 50, `baseline vector has only ${count} entries, expected >= 50`);
  });

});

// ─── LIFE-04: Eval Framework (~13 assertions) ─────────────────────────────────

describe('[LIFE-04] Eval framework — 15 scenarios, 3 grader type schemas', () => {

  it('LIFE-04: tests/evals/ directory exists', () => {
    assert.ok(fs.existsSync(EVALS_DIR), 'tests/evals/ directory does not exist');
  });

  it('LIFE-04: tests/evals/gsd-executor-backend.json exists', () => {
    assert.ok(
      fs.existsSync(path.join(EVALS_DIR, 'gsd-executor-backend.json')),
      'tests/evals/gsd-executor-backend.json does not exist'
    );
  });

  it('LIFE-04: tests/evals/gsd-tester.json exists', () => {
    assert.ok(
      fs.existsSync(path.join(EVALS_DIR, 'gsd-tester.json')),
      'tests/evals/gsd-tester.json does not exist'
    );
  });

  it('LIFE-04: tests/evals/gsd-security.json exists', () => {
    assert.ok(
      fs.existsSync(path.join(EVALS_DIR, 'gsd-security.json')),
      'tests/evals/gsd-security.json does not exist'
    );
  });

  it('LIFE-04: gsd-executor-backend.json has exactly 5 scenarios', () => {
    const data = JSON.parse(readFile(path.join(EVALS_DIR, 'gsd-executor-backend.json')));
    assert.strictEqual(data.scenarios.length, 5, 'gsd-executor-backend.json should have 5 scenarios');
  });

  it('LIFE-04: gsd-tester.json has exactly 5 scenarios', () => {
    const data = JSON.parse(readFile(path.join(EVALS_DIR, 'gsd-tester.json')));
    assert.strictEqual(data.scenarios.length, 5, 'gsd-tester.json should have 5 scenarios');
  });

  it('LIFE-04: gsd-security.json has exactly 5 scenarios', () => {
    const data = JSON.parse(readFile(path.join(EVALS_DIR, 'gsd-security.json')));
    assert.strictEqual(data.scenarios.length, 5, 'gsd-security.json should have 5 scenarios');
  });

  it('LIFE-04: all 15 scenarios have grader_type "code-based"', () => {
    const files = ['gsd-executor-backend.json', 'gsd-tester.json', 'gsd-security.json'];
    for (const f of files) {
      const data = JSON.parse(readFile(path.join(EVALS_DIR, f)));
      for (const s of data.scenarios) {
        assert.strictEqual(
          s.grader_type,
          'code-based',
          `${f} scenario ${s.id} has grader_type "${s.grader_type}", expected "code-based"`
        );
      }
    }
  });

  it('LIFE-04: tests/evals/eval-runner.cjs exists', () => {
    assert.ok(
      fs.existsSync(path.join(EVALS_DIR, 'eval-runner.cjs')),
      'tests/evals/eval-runner.cjs does not exist'
    );
  });

  it('LIFE-04: tests/evals/grader-schemas.json exists', () => {
    assert.ok(
      fs.existsSync(path.join(EVALS_DIR, 'grader-schemas.json')),
      'tests/evals/grader-schemas.json does not exist'
    );
  });

  it('LIFE-04: grader-schemas.json documents 3 grader types', () => {
    const data = JSON.parse(readFile(path.join(EVALS_DIR, 'grader-schemas.json')));
    assert.strictEqual(
      data.grader_types.length,
      3,
      `grader-schemas.json has ${data.grader_types.length} grader types, expected 3`
    );
  });

  it('LIFE-04: grader-schemas.json references v3.1 for model-based and human graders', () => {
    const content = readFile(path.join(EVALS_DIR, 'grader-schemas.json'));
    assert.ok(content.includes('v3.1'), 'grader-schemas.json missing v3.1 reference for deferred grader types');
    assert.ok(content.includes('model-based'), 'grader-schemas.json missing model-based schema');
    assert.ok(content.includes('human'), 'grader-schemas.json missing human schema');
  });

  it('LIFE-04: each scenario has required fields: id, agent, input_description, expected_behavior, grader_type, grading_criteria', () => {
    const files = ['gsd-executor-backend.json', 'gsd-tester.json', 'gsd-security.json'];
    const required = ['id', 'agent', 'input_description', 'expected_behavior', 'grader_type', 'grading_criteria'];
    for (const f of files) {
      const data = JSON.parse(readFile(path.join(EVALS_DIR, f)));
      for (const s of data.scenarios) {
        for (const field of required) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(s, field),
            `${f} scenario ${s.id || '?'} missing required field: ${field}`
          );
        }
      }
    }
  });

});

// ─── LIFE-05: Tool Integrity (~10 assertions) ─────────────────────────────────

describe('[LIFE-05] Tool integrity checking — SHA-256 + Valkey, graceful degradation', () => {

  const INTEGRITY_PATH = path.join(SCRIPTS_DIR, 'tool-integrity.cjs');

  it('LIFE-05: scripts/tool-integrity.cjs exists', () => {
    assert.ok(fs.existsSync(INTEGRITY_PATH), 'scripts/tool-integrity.cjs does not exist');
  });

  it('LIFE-05: tool-integrity.cjs references SHA-256 / createHash', () => {
    const content = readFile(INTEGRITY_PATH);
    assert.ok(
      content.includes('createHash') || content.includes('sha256'),
      'tool-integrity.cjs missing SHA-256 / createHash reference'
    );
  });

  it('LIFE-05: tool-integrity.cjs references TOOL_INTEGRITY_VIOLATION', () => {
    const content = readFile(INTEGRITY_PATH);
    assert.ok(content.includes('TOOL_INTEGRITY_VIOLATION'), 'tool-integrity.cjs missing TOOL_INTEGRITY_VIOLATION reference');
  });

  it('LIFE-05: tool-integrity.cjs references tool_integrity: Valkey key prefix', () => {
    const content = readFile(INTEGRITY_PATH);
    assert.ok(content.includes('tool_integrity'), 'tool-integrity.cjs missing tool_integrity key prefix reference');
  });

  it('LIFE-05: tool-integrity.cjs has --store mode', () => {
    const content = readFile(INTEGRITY_PATH);
    assert.ok(content.includes('--store'), 'tool-integrity.cjs missing --store mode');
  });

  it('LIFE-05: tool-integrity.cjs has --check mode', () => {
    const content = readFile(INTEGRITY_PATH);
    assert.ok(content.includes('--check'), 'tool-integrity.cjs missing --check mode');
  });

  it('LIFE-05: tool-integrity.cjs references all 5 CJS tool files', () => {
    const content = readFile(INTEGRITY_PATH);
    const cjsTools = ['gsd-amauta.cjs', 'gsd-tools.cjs', 'gsd-rlm.cjs', 'gsd-research.cjs', 'gsd-memory.cjs'];
    for (const tool of cjsTools) {
      assert.ok(content.includes(tool), `tool-integrity.cjs missing reference to ${tool}`);
    }
  });

  it('LIFE-05: tool-integrity.cjs references all 3 Python service files', () => {
    const content = readFile(INTEGRITY_PATH);
    const pyServices = ['amauta-daemon.py', 'rlm-service.py', 'amauta-mcp.py'];
    for (const svc of pyServices) {
      assert.ok(content.includes(svc), `tool-integrity.cjs missing reference to ${svc}`);
    }
  });

  it('LIFE-05: tool-integrity.cjs has graceful degradation (Valkey unavailable handling)', () => {
    const content = readFile(INTEGRITY_PATH);
    // Must log a warning and exit 0 when Valkey is unavailable
    assert.ok(
      content.includes('unavailable') || content.includes('degradat') || content.includes('exit(0)'),
      'tool-integrity.cjs missing graceful degradation for Valkey unavailability'
    );
  });

  it('LIFE-05: tool-integrity.cjs exit-1 on integrity violation (security event)', () => {
    const content = readFile(INTEGRITY_PATH);
    assert.ok(content.includes('exit(1)') || content.includes('process.exit(1)'), 'tool-integrity.cjs missing exit(1) for integrity violation');
  });

});
