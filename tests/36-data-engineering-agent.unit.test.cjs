'use strict';
/**
 * Phase 36 — Data Engineering Agent Unit Test Suite
 * File: tests/36-data-engineering-agent.unit.test.cjs
 *
 * Requirements covered:
 *   DATA-01: Expand-and-contract migration pattern + safety rules
 *   DATA-02: Static query analysis (N+1, sequential scan, cartesian join)
 *   DATA-03: Data quality checks (NOT NULL, FK, enum, uniqueness, test generation)
 *   DATA-04: Schema summary (migrations 001-013, all 8 core tables)
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

function readFixture(filename) {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
}

// ─── Group 1: gsd-executor-data.md format (DATA-01, DATA-02, DATA-03, DATA-04) ──

describe('[DATA-01][DATA-02][DATA-03][DATA-04] gsd-executor-data.md: v3.0.0 10-section format', () => {
  const data = readAgent('gsd-executor-data.md');

  it('[DATA-01] file exists', () => {
    assert.ok(fs.existsSync(path.join(AGENTS_DIR, 'gsd-executor-data.md')));
  });

  it('[DATA-01] exactly 10 ## sections', () => {
    const count = (data.match(/^## /gm) || []).length;
    assert.strictEqual(count, 10, `gsd-executor-data.md has ${count} ## sections, expected 10`);
  });

  it('[DATA-01] version header: ## version: 3.0.0', () => {
    assert.ok(data.includes('## version: 3.0.0'), 'Missing ## version: 3.0.0');
  });

  it('[DATA-01] frontmatter name: gsd-executor-data', () => {
    assert.ok(data.includes('name: gsd-executor-data'), 'Missing frontmatter name: gsd-executor-data');
  });

  it('[DATA-01] boundary verbatim: "You own the data layer"', () => {
    assert.ok(
      data.includes('You own the data layer'),
      'Missing "You own the data layer" boundary statement'
    );
  });

  it('[DATA-01] no-app-logic boundary: "You do not write application logic"', () => {
    assert.ok(
      data.includes('You do not write application logic'),
      'Missing "You do not write application logic" boundary'
    );
  });

  it('[DATA-01] anti-over-engineering mandate verbatim', () => {
    assert.ok(
      data.includes('Do not add features, refactor code, or make improvements beyond what was explicitly requested.'),
      'Missing anti-over-engineering mandate'
    );
  });

  it('[DATA-01] read-before-edit mandate verbatim', () => {
    assert.ok(
      data.includes('Always read a file completely before modifying it. Never edit a file based on assumptions about its contents.'),
      'Missing read-before-edit mandate'
    );
  });

  it('[DATA-01] AGENTS.md constraint present', () => {
    assert.ok(
      data.includes('You CANNOT create or modify AGENTS.md'),
      'Missing AGENTS.md constraint'
    );
  });

  it('[DATA-01] CACHE_BREAKPOINT as last non-empty line', () => {
    const lines = data.split('\n').filter(l => l.trim());
    assert.ok(
      lines[lines.length - 1].includes('CACHE_BREAKPOINT'),
      `Last non-empty line is not CACHE_BREAKPOINT: "${lines[lines.length - 1]}"`
    );
  });

  it('[DATA-01] executor type: "executor-data" in frontmatter name field', () => {
    assert.ok(
      data.includes('executor-data'),
      'Missing "executor-data" in agent (frontmatter name field)'
    );
  });

  it('[DATA-01] line count: between 320 and 450 lines', () => {
    const lines = data.split('\n').length;
    assert.ok(
      lines >= 320 && lines <= 450,
      `gsd-executor-data.md has ${lines} lines, expected between 320 and 450`
    );
  });
});

// ─── Group 2: Expand-and-contract rules (DATA-01) ────────────────────────────

describe('[DATA-01] Expand-and-contract migration pattern rules', () => {
  const data = readAgent('gsd-executor-data.md');

  it('[DATA-01] pattern name: contains "expand-and-contract" or "Expand-and-Contract"', () => {
    assert.ok(
      data.toLowerCase().includes('expand-and-contract'),
      'Missing expand-and-contract pattern name'
    );
  });

  it('[DATA-01] destructive trigger 1: contains "DROP COLUMN"', () => {
    assert.ok(data.includes('DROP COLUMN'), 'Missing DROP COLUMN destructive trigger');
  });

  it('[DATA-01] destructive trigger 2: contains "DROP TABLE"', () => {
    assert.ok(data.includes('DROP TABLE'), 'Missing DROP TABLE destructive trigger');
  });

  it('[DATA-01] destructive trigger 3: contains "ALTER TYPE"', () => {
    assert.ok(data.includes('ALTER TYPE'), 'Missing ALTER TYPE destructive trigger');
  });

  it('[DATA-01] destructive trigger 4: contains "RENAME COLUMN"', () => {
    assert.ok(data.includes('RENAME COLUMN'), 'Missing RENAME COLUMN destructive trigger');
  });

  it('[DATA-01] 3-step names: contains Expand, Migrate, and Contract', () => {
    assert.ok(data.includes('Expand'), 'Missing "Expand" step name');
    assert.ok(data.includes('Migrate'), 'Missing "Migrate" step name');
    assert.ok(data.includes('Contract'), 'Missing "Contract" step name');
  });

  it('[DATA-01] user override: contains "DESTRUCTIVE: confirmed by user"', () => {
    assert.ok(
      data.includes('DESTRUCTIVE: confirmed by user'),
      'Missing user override comment "DESTRUCTIVE: confirmed by user"'
    );
  });

  it('[DATA-01] adaptive warning: contains "adaptive warning"', () => {
    assert.ok(
      data.includes('adaptive warning'),
      'Missing "adaptive warning" — must not be a hard block'
    );
  });

  it('[DATA-01] safe cast exception: contains "INT" and "BIGINT"', () => {
    assert.ok(data.includes('INT'), 'Missing INT safe widening example');
    assert.ok(data.includes('BIGINT'), 'Missing BIGINT safe widening example');
  });
});

// ─── Group 3: Static query analysis rules (DATA-02) ──────────────────────────

describe('[DATA-02] Static query analysis rules', () => {
  const data = readAgent('gsd-executor-data.md');

  it('[DATA-02] EXPLAIN ANALYZE recommendation: contains "EXPLAIN ANALYZE"', () => {
    assert.ok(data.includes('EXPLAIN ANALYZE'), 'Missing EXPLAIN ANALYZE recommendation');
  });

  it('[DATA-02] N+1 detection: contains "N+1"', () => {
    assert.ok(data.includes('N+1'), 'Missing N+1 detection pattern');
  });

  it('[DATA-02] sequential scan pattern: contains "SELECT *"', () => {
    assert.ok(data.includes('SELECT *'), 'Missing SELECT * sequential scan pattern');
  });

  it('[DATA-02] missing JOIN detection: contains "JOIN" and "cartesian"', () => {
    assert.ok(data.includes('JOIN'), 'Missing JOIN keyword in query analysis');
    assert.ok(
      data.toLowerCase().includes('cartesian'),
      'Missing "cartesian" product risk detection'
    );
  });

  it('[DATA-02] missing index detection: contains "WHERE"', () => {
    assert.ok(data.includes('WHERE'), 'Missing WHERE clause reference for index suggestion');
  });

  it('[DATA-02] static analysis only: contains "does NOT connect to a live database" or "static analysis only"', () => {
    assert.ok(
      data.includes('does NOT connect to a live database') || data.includes('static analysis only'),
      'Missing static analysis constraint (no DB connection)'
    );
  });

  it('[DATA-02] output metadata key: contains "query_analysis"', () => {
    assert.ok(data.includes('query_analysis'), 'Missing query_analysis metadata key in output schema');
  });
});

// ─── Group 4: Data quality checks (DATA-03) ──────────────────────────────────

describe('[DATA-03] Data quality check rules', () => {
  const data = readAgent('gsd-executor-data.md');

  it('[DATA-03] NOT NULL constraint check: contains "NOT NULL"', () => {
    assert.ok(data.includes('NOT NULL'), 'Missing NOT NULL constraint check');
  });

  it('[DATA-03] FK integrity: contains "FK integrity" or "foreign key"', () => {
    assert.ok(
      data.includes('FK integrity') || data.toLowerCase().includes('foreign key'),
      'Missing FK integrity check'
    );
  });

  it('[DATA-03] enum validation: contains "enum"', () => {
    assert.ok(data.toLowerCase().includes('enum'), 'Missing enum validation check');
  });

  it('[DATA-03] uniqueness: contains "unique"', () => {
    assert.ok(data.toLowerCase().includes('unique'), 'Missing uniqueness check');
  });

  it('[DATA-03] test location: contains "tests/migrations/"', () => {
    assert.ok(data.includes('tests/migrations/'), 'Missing tests/migrations/ path reference');
  });
});

// ─── Group 5: Schema summary (DATA-04) ───────────────────────────────────────

describe('[DATA-04] Schema summary: all 8 core tables and migration sequence', () => {
  const data = readAgent('gsd-executor-data.md');

  it('[DATA-04] table gsd_memory: present in schema summary', () => {
    assert.ok(data.includes('gsd_memory'), 'Missing gsd_memory table in schema summary');
  });

  it('[DATA-04] table gsd_tasks: present in schema summary', () => {
    assert.ok(data.includes('gsd_tasks'), 'Missing gsd_tasks table in schema summary');
  });

  it('[DATA-04] table gsd_shared_kb: present in schema summary', () => {
    assert.ok(data.includes('gsd_shared_kb'), 'Missing gsd_shared_kb table in schema summary');
  });

  it('[DATA-04] table rlm_chunks: present in schema summary', () => {
    assert.ok(data.includes('rlm_chunks'), 'Missing rlm_chunks table in schema summary');
  });

  it('[DATA-04] table semantic_cache: present in schema summary', () => {
    assert.ok(data.includes('semantic_cache'), 'Missing semantic_cache table in schema summary');
  });

  it('[DATA-04] table rpetd_context: present in schema summary', () => {
    assert.ok(data.includes('rpetd_context'), 'Missing rpetd_context table in schema summary');
  });

  it('[DATA-04] table gsd_audit_log: present in schema summary', () => {
    assert.ok(
      data.includes('gsd_audit_log') || data.includes('audit_log'),
      'Missing gsd_audit_log table in schema summary'
    );
  });

  it('[DATA-04] table gsd_agent_performance: present in schema summary', () => {
    assert.ok(
      data.includes('gsd_agent_performance') || data.includes('agent_performance'),
      'Missing gsd_agent_performance table in schema summary'
    );
  });

  it('[DATA-04] migration range: contains "001" and "013"', () => {
    assert.ok(data.includes('001'), 'Missing migration 001 boundary in schema summary');
    assert.ok(data.includes('013'), 'Missing migration 013 boundary in schema summary');
  });

  it('[DATA-04] dynamic numbering: contains "highest" or "discover dynamically"', () => {
    assert.ok(
      data.includes('highest') || data.includes('discover dynamically'),
      'Missing dynamic migration numbering rule (never hardcode)'
    );
  });
});

// ─── Group 6: Examples (DATA-01, DATA-02, DATA-03, DATA-04) ──────────────────

describe('[DATA-01][DATA-02][DATA-03][DATA-04] Examples: 4 examples covering all requirements', () => {
  const data = readAgent('gsd-executor-data.md');

  it('[DATA-01] exactly 4 numbered examples (**Example N: pattern)', () => {
    const matches = data.match(/\*\*Example \d+:/g) || [];
    assert.strictEqual(matches.length, 4, `Expected 4 examples, found ${matches.length}`);
  });

  it('[DATA-01] Example 1: safe additive migration (contains "additive" or "nullable")', () => {
    const parts = data.split('**Example ');
    const ex1 = parts.find(p => p.startsWith('1:')) || '';
    assert.ok(ex1.includes('additive') || ex1.includes('nullable'), 'Example 1 does not demonstrate safe additive migration');
  });

  it('[DATA-01] Example 2: column rename with expand-and-contract', () => {
    const parts = data.split('**Example ');
    const ex2 = parts.find(p => p.startsWith('2:')) || '';
    assert.ok(
      ex2.toLowerCase().includes('rename') &&
      (ex2.toLowerCase().includes('expand-and-contract') || ex2.includes('3-step')),
      'Example 2 does not demonstrate rename with expand-and-contract'
    );
  });

  it('[DATA-02] Example 3: N+1 detection with query analysis', () => {
    const parts = data.split('**Example ');
    const ex3 = parts.find(p => p.startsWith('3:')) || '';
    assert.ok(ex3.includes('N+1'), 'Example 3 does not demonstrate N+1 detection');
  });

  it('[DATA-04] Example 4: new table creation (contains "agent_findings" or "new table")', () => {
    const parts = data.split('**Example ');
    const ex4 = parts.find(p => p.startsWith('4:')) || '';
    assert.ok(
      ex4.includes('agent_findings') || ex4.toLowerCase().includes('new table'),
      'Example 4 does not demonstrate new table creation'
    );
  });
});

// ─── Group 7: Security rules content-identity (shared source of truth) ────────

describe('[DATA-01] Security rules: content-identity against shared source of truth', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));
  const data = readAgent('gsd-executor-data.md');

  it(`all ${bulletLines.length} security rule bullet lines appear verbatim in gsd-executor-data.md`, () => {
    const missing = bulletLines.filter(line => !data.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `Security rules missing from gsd-executor-data.md:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 8: Engineering standards content-identity ──────────────────────────

describe('[DATA-01] Engineering standards: content-identity against shared source of truth', () => {
  const stdPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
  const sharedStd = fs.readFileSync(stdPath, 'utf-8');
  const headings = sharedStd.split('\n').filter(l => l.startsWith('#### '));
  const data = readAgent('gsd-executor-data.md');

  it(`all ${headings.length} engineering standard #### headings appear verbatim in gsd-executor-data.md`, () => {
    const missing = headings.filter(h => !data.includes(h));
    assert.strictEqual(
      missing.length,
      0,
      `Engineering standard headings missing from gsd-executor-data.md:\n${missing.join('\n')}`
    );
  });
});

// ─── Group 9: Fixture file content assertions ─────────────────────────────────

describe('[DATA-01][DATA-02] Fixture files: expected profiles for data engineering scenarios', () => {

  it('[DATA-01] 36-safe-migration.sql: exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '36-safe-migration.sql')),
      '36-safe-migration.sql does not exist'
    );
  });

  it('[DATA-01] 36-safe-migration.sql: has ADD COLUMN IF NOT EXISTS', () => {
    const content = readFixture('36-safe-migration.sql');
    assert.ok(content.includes('ADD COLUMN IF NOT EXISTS'), 'Missing ADD COLUMN IF NOT EXISTS in safe migration fixture');
  });

  it('[DATA-01] 36-safe-migration.sql: no DROP COLUMN outside DOWN comment section', () => {
    const content = readFixture('36-safe-migration.sql');
    // Any DROP COLUMN must be inside a comment (prefixed with --)
    const dropColumnLines = content.split('\n').filter(l => l.includes('DROP COLUMN'));
    const uncommentedDrops = dropColumnLines.filter(l => !l.trim().startsWith('--'));
    assert.strictEqual(
      uncommentedDrops.length,
      0,
      `Found uncommented DROP COLUMN in safe migration fixture:\n${uncommentedDrops.join('\n')}`
    );
  });

  it('[DATA-01] 36-safe-migration.sql: labeled as safe/SAFE/additive', () => {
    const content = readFixture('36-safe-migration.sql');
    assert.ok(
      content.includes('SAFE') || content.includes('safe') || content.includes('additive'),
      'Safe migration fixture not labeled as safe/additive'
    );
  });

  it('[DATA-01] 36-destructive-migration.sql: exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '36-destructive-migration.sql')),
      '36-destructive-migration.sql does not exist'
    );
  });

  it('[DATA-01] 36-destructive-migration.sql: has DROP COLUMN', () => {
    const content = readFixture('36-destructive-migration.sql');
    assert.ok(content.includes('DROP COLUMN'), 'Missing DROP COLUMN in destructive migration fixture');
  });

  it('[DATA-01] 36-destructive-migration.sql: has RENAME COLUMN', () => {
    const content = readFixture('36-destructive-migration.sql');
    assert.ok(content.includes('RENAME'), 'Missing RENAME in destructive migration fixture');
  });

  it('[DATA-01] 36-destructive-migration.sql: has ALTER TYPE (narrowing)', () => {
    const content = readFixture('36-destructive-migration.sql');
    assert.ok(
      content.includes('ALTER TYPE') || content.includes('ALTER COLUMN') && content.includes('TYPE'),
      'Missing ALTER TYPE in destructive migration fixture'
    );
  });

  it('[DATA-01] 36-destructive-migration.sql: has DROP TABLE', () => {
    const content = readFixture('36-destructive-migration.sql');
    assert.ok(content.includes('DROP TABLE'), 'Missing DROP TABLE in destructive migration fixture');
  });

  it('[DATA-02] 36-n-plus-one.js: exists', () => {
    assert.ok(
      fs.existsSync(path.join(FIXTURES_DIR, '36-n-plus-one.js')),
      '36-n-plus-one.js does not exist'
    );
  });

  it('[DATA-02] 36-n-plus-one.js: has for loop pattern', () => {
    const content = readFixture('36-n-plus-one.js');
    assert.ok(
      content.includes('for (const') || content.includes('for(const'),
      'Missing for loop pattern in N+1 fixture'
    );
  });

  it('[DATA-02] 36-n-plus-one.js: has db.query inside loop (N+1 pattern)', () => {
    const content = readFixture('36-n-plus-one.js');
    // The for loop and db.query must appear in the same function scope
    assert.ok(content.includes('db.query'), 'Missing db.query call in N+1 fixture');
    const loopIdx = content.indexOf('for (const');
    const queryIdx = content.indexOf('db.query');
    assert.ok(
      loopIdx !== -1 && queryIdx !== -1,
      'N+1 fixture missing for loop and/or db.query'
    );
    // Verify query appears after loop start (inside the loop body)
    const afterLoop = content.slice(loopIdx);
    assert.ok(
      afterLoop.includes('db.query'),
      'db.query does not appear after for loop start (N+1 pattern not present)'
    );
  });

  it('[DATA-02] 36-n-plus-one.js: has SELECT * FROM gsd_memory without WHERE (unbounded scan)', () => {
    const content = readFixture('36-n-plus-one.js');
    assert.ok(
      content.includes("SELECT * FROM gsd_memory'") || content.includes('SELECT * FROM gsd_memory\u0027'),
      'Missing unbounded SELECT * FROM gsd_memory without WHERE in N+1 fixture'
    );
  });

  it('[DATA-02] 36-n-plus-one.js: has cartesian product (multi-table FROM without JOIN)', () => {
    const content = readFixture('36-n-plus-one.js');
    assert.ok(
      content.includes('gsd_tasks, gsd_task_validations') || content.includes('FROM gsd_tasks,'),
      'Missing cartesian product pattern (multi-table FROM without ON) in N+1 fixture'
    );
  });

  it('[DATA-02] 36-n-plus-one.js: has batch query GOOD example', () => {
    const content = readFixture('36-n-plus-one.js');
    assert.ok(
      content.includes('searchByTagsBatch') || (content.includes('GOOD') && content.includes('batch')),
      'Missing GOOD batch query example in N+1 fixture'
    );
  });

  it('[DATA-02] 36-n-plus-one.js: between 40 and 100 lines', () => {
    const content = readFixture('36-n-plus-one.js');
    const lines = content.split('\n').length;
    assert.ok(lines >= 40 && lines <= 100, `36-n-plus-one.js has ${lines} lines, expected 40-100`);
  });
});
