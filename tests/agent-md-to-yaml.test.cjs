'use strict';
/**
 * tests/agent-md-to-yaml.test.cjs — Phase 52 COMPILE-01
 *
 * Tests for scripts/agent-md-to-yaml.cjs:
 *   - HEADING_TO_KEY maps 9 headings + 1 synthetic metadata (10 total)
 *   - Single convert: gsd-planner.md frontmatter preserved
 *   - 10 section keys populated for gsd-planner
 *   - metadata section contains "version: 3.0.0"
 *   - Unknown heading rejects with descriptive error
 *   - Batch converts all 17 agents without error
 *   - Section body preserves code-fence leading whitespace
 *   - body_preamble: H1 for planner, null for executor-data
 *
 * Run: node --test tests/agent-md-to-yaml.test.cjs
 *
 * IMPORTANT: Tests write only to temp directories (fs.mkdtempSync).
 * NEVER writes to get-shit-done/agents/ — Wave 2 owns canonical conversion.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const CONVERTER = path.join(ROOT, 'scripts', 'agent-md-to-yaml.cjs');

const { convert, convertBatch, parseAgentFrontmatter, HEADING_TO_KEY } = require(CONVERTER);

// ─── SECTION_KEY_ORDER (mirrors services/agent_schema.py) ────────────────────
const SECTION_KEY_ORDER = [
  'role_and_identity',
  'domain_knowledge',
  'patterns_and_practices',
  'workflow_and_process',
  'tools_and_resources',
  'quality_gates',
  'output_format',
  'error_handling',
  'examples',
  'metadata',
];

// ─── Test 1: HEADING_TO_KEY maps 9 headings + 1 metadata synthetic ───────────

test('HEADING_TO_KEY maps 9 headings + 1 metadata synthetic — 10 keys total', () => {
  const headings = Object.keys(HEADING_TO_KEY);
  const values = Object.values(HEADING_TO_KEY);

  assert.equal(headings.length, 10, `Expected 10 headings, got ${headings.length}`);
  assert.equal(values.length, 10, `Expected 10 values, got ${values.length}`);

  // All 10 unique values
  const uniqueValues = new Set(values);
  assert.equal(uniqueValues.size, 10, `Expected 10 unique values, got ${uniqueValues.size}`);

  // All SECTION_KEY_ORDER keys are present in values
  for (const key of SECTION_KEY_ORDER) {
    assert.ok(
      values.includes(key),
      `HEADING_TO_KEY missing SECTION_KEY_ORDER key: ${key}`
    );
  }

  // Values are exactly a permutation of SECTION_KEY_ORDER
  const sortedValues = [...values].sort();
  const sortedExpected = [...SECTION_KEY_ORDER].sort();
  assert.deepEqual(sortedValues, sortedExpected, 'HEADING_TO_KEY values must be a permutation of SECTION_KEY_ORDER');
});

// ─── Test 2: converts agents/gsd-planner.md to YAML preserving frontmatter ──

describe("single convert: gsd-planner.md", (t) => {
  let tmpDir;
  let result;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-yaml-planner-'));
    result = convert(path.join(AGENTS_DIR, 'gsd-planner.md'), tmpDir);
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('converts agents/gsd-planner.md to YAML preserving frontmatter', () => {
    assert.equal(result.name, 'gsd-planner', 'name must be gsd-planner');
    assert.equal(result.frontmatter.name, 'gsd-planner');

    // tools must include all canonical tools from gsd-planner.md
    const tools = result.frontmatter.tools;
    assert.ok(Array.isArray(tools), 'tools must be an array');
    for (const expected of ['Read', 'Write', 'Edit', 'Bash', 'Task', 'Glob', 'Grep']) {
      assert.ok(tools.includes(expected), `tools missing: ${expected}`);
    }

    // AGENT.yaml must be written
    const yamlPath = path.join(tmpDir, 'gsd-planner', 'AGENT.yaml');
    assert.ok(fs.existsSync(yamlPath), `AGENT.yaml not found at ${yamlPath}`);
  });

  test('all 10 section keys populated for gsd-planner', () => {
    const sectionKeys = Object.keys(result.sections);
    assert.equal(sectionKeys.length, 10, `Expected 10 section keys, got ${sectionKeys.length}`);

    const sectionKeySet = new Set(sectionKeys);
    for (const key of SECTION_KEY_ORDER) {
      assert.ok(sectionKeySet.has(key), `Missing section key: ${key}`);
    }
  });

  test('metadata section contains version: 3.0.0', () => {
    const metadata = result.sections.metadata || '';
    assert.ok(
      metadata.trim().includes('version: 3.0.0'),
      `metadata section must contain 'version: 3.0.0', got: ${JSON.stringify(metadata)}`
    );
  });
});

// ─── Test 5: unknown heading rejects conversion ──────────────────────────────

test('unknown heading rejects conversion', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-yaml-unknown-'));
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  // Minimal .md with an unknown heading
  const syntheticMd = [
    '---',
    'name: test-agent',
    'description: "A test agent for unknown heading rejection"',
    'tools: Read, Write',
    'color: blue',
    'memory: user',
    'skills:',
    '  - test-skill',
    '---',
    '',
    '# Agent: test-agent',
    '',
    '## version: 3.0.0',
    '',
    '## Unknown Heading',
    '',
    'Some unknown content.',
    '',
  ].join('\n');

  const syntheticPath = path.join(tmpDir, 'test-agent.md');
  fs.writeFileSync(syntheticPath, syntheticMd, 'utf8');

  // Must throw (or fail with error) on unknown heading
  assert.throws(
    () => convert(syntheticPath, tmpDir),
    (err) => {
      // Error must name the unknown heading
      assert.ok(
        err.message.includes('Unknown Heading') || err.message.includes('unknown heading'),
        `Error message must name the unknown heading, got: ${err.message}`
      );
      return true;
    }
  );
});

// ─── Test 6: batch converts all 17 agents without error ─────────────────────

test('batch converts all 17 agents without error', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-yaml-batch-'));
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  const batchResult = convertBatch(AGENTS_DIR, tmpDir);

  assert.equal(
    batchResult.errors.length, 0,
    `Batch conversion had errors:\n${batchResult.errors.map(e => `  ${e.file}: ${e.error}`).join('\n')}`
  );
  assert.equal(
    batchResult.converted, 17,
    `Expected 17 agents converted, got ${batchResult.converted}`
  );

  // Verify all 17 AGENT.yaml files were written
  const yamlFiles = fs.readdirSync(tmpDir)
    .filter(d => fs.existsSync(path.join(tmpDir, d, 'AGENT.yaml')));
  assert.equal(yamlFiles.length, 17, `Expected 17 AGENT.yaml files, found ${yamlFiles.length}`);
});

// ─── Test 7: section body preserves code fence leading whitespace ────────────

test('section body preserves leading whitespace in code fences', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-yaml-fence-'));
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  const codeBlock = [
    '```bash',
    'if [ "$var" = "value" ]; then',
    '  echo "indented"',
    'fi',
    '```',
  ].join('\n');

  // Build a synthetic .md with all 10 sections where role_and_identity has a code block
  const otherSections = SECTION_KEY_ORDER
    .filter(k => k !== 'role_and_identity' && k !== 'metadata')
    .map(k => {
      const heading = Object.keys(HEADING_TO_KEY).find(h => HEADING_TO_KEY[h] === k);
      return `## ${heading}\n\nBody text for ${k}.\n`;
    })
    .join('\n');

  const syntheticMd = [
    '---',
    'name: fence-test-agent',
    'description: "A test agent to verify code fence whitespace preservation"',
    'tools: Read, Bash',
    'color: orange',
    'memory: none',
    'skills: []',
    '---',
    '',
    '# Agent: fence-test-agent',
    '',
    '## version: 3.0.0',
    '',
    '## Role & identity',
    '',
    codeBlock,
    '',
    otherSections,
  ].join('\n');

  const syntheticPath = path.join(tmpDir, 'fence-test-agent.md');
  fs.writeFileSync(syntheticPath, syntheticMd, 'utf8');

  const result = convert(syntheticPath, tmpDir);

  // The role_and_identity section body must contain the code fence verbatim
  const roleBody = result.sections.role_and_identity;
  assert.ok(
    roleBody.includes('```bash'),
    `role_and_identity body must contain \`\`\`bash, got: ${JSON.stringify(roleBody)}`
  );
  assert.ok(
    roleBody.includes('  echo "indented"'),
    `role_and_identity body must preserve indented echo line, got: ${JSON.stringify(roleBody)}`
  );

  // Verify by reading YAML output and checking it round-trips the code block
  const yamlPath = path.join(tmpDir, 'fence-test-agent', 'AGENT.yaml');
  const yamlContent = fs.readFileSync(yamlPath, 'utf8');
  assert.ok(
    yamlContent.includes('  echo "indented"'),
    `YAML output must contain indented echo line, got snippet: ${yamlContent.slice(0, 500)}`
  );
});

// ─── Test 8: body_preamble: planner H1 present, executor-data null ───────────

describe("body_preamble handling", (t) => {
  let plannerTmpDir;
  let dataTmpDir;
  let plannerResult;
  let dataResult;

  before(() => {
    plannerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-yaml-bp-planner-'));
    dataTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-yaml-bp-data-'));
    plannerResult = convert(path.join(AGENTS_DIR, 'gsd-planner.md'), plannerTmpDir);
    dataResult = convert(path.join(AGENTS_DIR, 'gsd-executor-data.md'), dataTmpDir);
  });

  after(() => {
    try { fs.rmSync(plannerTmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(dataTmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('body_preamble captures # Agent: H1 for gsd-planner, null for gsd-executor-data', () => {
    // gsd-planner.md has '# Agent: gsd-planner' H1
    assert.ok(
      plannerResult.bodyPreamble !== null && plannerResult.bodyPreamble !== undefined && plannerResult.bodyPreamble !== '',
      `gsd-planner body_preamble must be non-null, got: ${JSON.stringify(plannerResult.bodyPreamble)}`
    );
    assert.ok(
      /^# Agent: gsd-planner\b/.test(plannerResult.bodyPreamble),
      `gsd-planner body_preamble must start with '# Agent: gsd-planner', got: ${JSON.stringify(plannerResult.bodyPreamble)}`
    );

    // gsd-executor-data.md has NO H1 (body_preamble null, empty string, or undefined)
    const bp = dataResult.bodyPreamble;
    assert.ok(
      bp === null || bp === '' || bp === undefined,
      `gsd-executor-data body_preamble must be null/empty, got: ${JSON.stringify(bp)}`
    );
  });
});
