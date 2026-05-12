'use strict';
/**
 * Plan 43-01-06: Skill Schema + Compiler Tests
 * File: tests/skill-schema.test.cjs
 *
 * Requirements covered:
 *   SKILL-01: SkillFrontmatter schema validation (via compiler's JS validator)
 *   SKILL-03: compile/validate/listSkills functions
 *
 * Tests scripts/skill-compiler.cjs exported functions.
 * No live DB or daemon dependency — hermetic.
 *
 * Run: node --test tests/skill-schema.test.cjs
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const compiler = require(path.join(ROOT, 'scripts', 'skill-compiler.cjs'));
const { compile, validate, listSkills } = compiler;

// ── Test 1: validate() accepts a valid frontmatter ────────────────────────────

test('validate() accepts a valid plan-phase skill', () => {
  const result = validate(path.join(ROOT, 'get-shit-done/skills/plan-phase'));
  assert.strictEqual(result.ok, true, `Expected ok:true, errors: ${JSON.stringify(result.errors)}`);
  assert.deepStrictEqual(result.errors, []);
});

// ── Test 2: validate() rejects missing required field ────────────────────────

test('validate() rejects SKILL.md missing version field', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-missing-'));
  const skillFile = path.join(tmpDir, 'SKILL.md');
  fs.writeFileSync(skillFile, `---
name: test-skill
description: "A test skill with enough characters to pass description length"
category: workflow
security_class: read-only
allowed-tools:
  - Read
depends_on: []
---

body
`);
  try {
    const result = validate(tmpDir);
    assert.strictEqual(result.ok, false, 'Expected validation to fail for missing version');
    assert.ok(
      result.errors.some(e => e.toLowerCase().includes('version')),
      `Expected error mentioning 'version', got: ${JSON.stringify(result.errors)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 3: validate() rejects invalid security_class enum ───────────────────

test('validate() rejects invalid security_class value', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-sc-'));
  const skillFile = path.join(tmpDir, 'SKILL.md');
  fs.writeFileSync(skillFile, `---
name: test-skill
description: "A test skill with enough characters to pass description validation"
category: workflow
version: 1.0.0
security_class: super-admin
allowed-tools:
  - Read
depends_on: []
---

body
`);
  try {
    const result = validate(tmpDir);
    assert.strictEqual(result.ok, false, 'Expected validation to fail for invalid security_class');
    assert.ok(
      result.errors.some(e => e.toLowerCase().includes('security_class')),
      `Expected error mentioning 'security_class', got: ${JSON.stringify(result.errors)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 4: validate() rejects bad name pattern (uppercase) ──────────────────

test('validate() rejects name with uppercase characters', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-name-'));
  const skillFile = path.join(tmpDir, 'SKILL.md');
  fs.writeFileSync(skillFile, `---
name: BadName
description: "A test skill with enough characters to pass description validation"
category: workflow
version: 1.0.0
security_class: read-only
allowed-tools:
  - Read
depends_on: []
---

body
`);
  try {
    const result = validate(tmpDir);
    assert.strictEqual(result.ok, false, 'Expected validation to fail for uppercase name');
    assert.ok(
      result.errors.some(e => e.toLowerCase().includes('name')),
      `Expected error mentioning 'name', got: ${JSON.stringify(result.errors)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 5: listSkills() finds all 3 canonical skills ────────────────────────

test('listSkills() finds all 3 canonical skills', () => {
  const skills = listSkills(path.join(ROOT, 'get-shit-done/skills'));
  assert.ok(Array.isArray(skills), 'Expected array from listSkills');
  assert.ok(skills.length >= 3, `Expected >= 3 skills, got ${skills.length}`);
  const names = skills.map(s => s.name);
  assert.ok(names.includes('plan-phase'), `Expected plan-phase in ${names}`);
  assert.ok(names.includes('execute-phase'), `Expected execute-phase in ${names}`);
  assert.ok(names.includes('discuss-phase'), `Expected discuss-phase in ${names}`);
  for (const skill of skills) {
    assert.ok(skill.name, 'Each skill must have name');
    assert.ok(skill.version, 'Each skill must have version');
    assert.ok(skill.category, 'Each skill must have category');
    assert.ok(skill.security_class, 'Each skill must have security_class');
    assert.ok(skill.path, 'Each skill must have path');
  }
});

// ── Test 6: compile() dry-run succeeds for all 3 targets ─────────────────────

test('compile() dry-run succeeds for all 3 targets (claude, opencode, cursor)', () => {
  const srcDir = path.join(ROOT, 'get-shit-done/skills');
  for (const target of ['claude', 'opencode', 'cursor']) {
    const result = compile(target, { source: srcDir, dryRun: true });
    assert.deepStrictEqual(result.errors, [],
      `Target '${target}' should have no errors, got: ${JSON.stringify(result.errors)}`
    );
    assert.ok(result.compiled.length >= 3,
      `Target '${target}' should compile >= 3 skills, got ${result.compiled.length}`
    );
  }
});

// ── Test 7: compile() applies tool aliases for cursor target ─────────────────

test('compile() applies cursor tool aliases (Read -> read_file)', () => {
  const srcDir = path.join(ROOT, 'get-shit-done/skills');
  const result = compile('cursor', { source: srcDir, dryRun: true });
  assert.deepStrictEqual(result.errors, []);
  assert.ok(result.compiled.length >= 3);

  // Find at least one skill where the intended_frontmatter has 'read_file'
  let foundRemapped = false;
  for (const entry of result.compiled) {
    const tools = entry.intended_frontmatter &&
      (entry.intended_frontmatter['allowedTools'] || entry.intended_frontmatter['allowed-tools'] || []);
    if (Array.isArray(tools) && tools.includes('read_file')) {
      foundRemapped = true;
      break;
    }
  }
  assert.ok(foundRemapped,
    `Expected at least one skill to have 'Read' remapped to 'read_file' for cursor target`
  );
});

// ── Test 8: compile() detects depends_on cycle ───────────────────────────────

const _cycleTmpDir = path.join(os.tmpdir(), 'cycle-skills-' + Date.now());

test('compile() detects depends_on cycle and returns errors', () => {
  fs.mkdirSync(path.join(_cycleTmpDir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(_cycleTmpDir, 'b'), { recursive: true });

  fs.writeFileSync(path.join(_cycleTmpDir, 'a', 'SKILL.md'), `---
name: a
description: "Skill a with enough chars for validation to pass requirement"
category: workflow
version: 1.0.0
security_class: read-only
allowed-tools:
  - Read
depends_on:
  - b
---
body
`);
  fs.writeFileSync(path.join(_cycleTmpDir, 'b', 'SKILL.md'), `---
name: b
description: "Skill b with enough chars for validation to pass requirement"
category: workflow
version: 1.0.0
security_class: read-only
allowed-tools:
  - Read
depends_on:
  - a
---
body
`);

  const result = compile('opencode', { source: _cycleTmpDir, dryRun: true });
  // Should return errors containing cycle info
  const hasCycleError = result.errors && result.errors.length > 0 &&
    result.errors.some(e => {
      const s = typeof e === 'string' ? e : JSON.stringify(e);
      return s.toLowerCase().includes('cycle') || s.toLowerCase().includes('a -> b') || s.toLowerCase().includes('b -> a');
    });
  assert.ok(hasCycleError,
    `Expected cycle error in result.errors, got: ${JSON.stringify(result.errors)}`
  );
});

after(() => {
  // Cleanup cycle test temp dir
  try { fs.rmSync(_cycleTmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ── Test 9: depends_on version pin round-trips correctly ─────────────────────

test('compile() preserves depends_on version pin (plan-phase@1.0.0)', () => {
  const skills = listSkills(path.join(ROOT, 'get-shit-done/skills'));
  const executePhaseMeta = skills.find(s => s.name === 'execute-phase');
  assert.ok(executePhaseMeta, 'execute-phase skill should exist in listSkills');

  // Read the actual SKILL.md and verify depends_on is preserved
  const content = fs.readFileSync(executePhaseMeta.path, 'utf8');
  assert.ok(
    content.includes('plan-phase@1.0.0'),
    'execute-phase SKILL.md should contain plan-phase@1.0.0 in depends_on'
  );

  // Compile and check intended frontmatter
  const result = compile('opencode', {
    source: path.join(ROOT, 'get-shit-done/skills'),
    dryRun: true,
  });
  const entry = result.compiled.find(c => c.name === 'execute-phase');
  assert.ok(entry, 'execute-phase should be in compiled output');
  const deps = entry.intended_frontmatter['depends_on'] || entry.intended_frontmatter['dependsOn'] || [];
  assert.ok(
    deps.includes('plan-phase@1.0.0'),
    `Expected plan-phase@1.0.0 in depends_on, got: ${JSON.stringify(deps)}`
  );
});
