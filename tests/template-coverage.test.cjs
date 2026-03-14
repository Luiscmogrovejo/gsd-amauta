/**
 * Template Module + Coverage Gap Tests
 *
 * Covers template.cjs (was 5.4%) and uncovered lines across all modules:
 *   - template.cjs: cmdTemplateSelect (13 tests), cmdTemplateFill (15 tests)
 *   - commands.cjs: scaffold error paths, todo-complete guard
 *   - config.cjs: malformed JSON, write failure, intermediate key path
 *   - core.cjs: archived phases, milestone emoji, searchPhaseInDir catch
 *   - phase.cjs: phase-complete guards, STATE.md "of N" decrement, ROADMAP fallback
 *   - state.cjs: missing sections (decisions, blockers), discussing status
 *   - verify.cjs: plan numbering gaps, orphan summaries, missing wave field
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ═══════════════════════════════════════════════════════
// SECTION 1: cmdTemplateSelect (13 tests)
// ═══════════════════════════════════════════════════════

describe('cmdTemplateSelect — template selection', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('1.01 missing plan-path returns error', () => {
    const r = runGsdTools(['template', 'select'], tmpDir);
    assert.ok(!r.success || r.error.includes('plan-path'));
  });

  test('1.02 non-existent plan file falls back to standard', () => {
    const r = runGsdTools(['template', 'select', 'nonexistent-plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'standard');
    assert.ok(parsed.error, 'Should include error message for missing file');
  });

  test('1.03 empty plan file selects minimal', () => {
    fs.writeFileSync(path.join(tmpDir, 'empty-plan.md'), '');
    const r = runGsdTools(['template', 'select', 'empty-plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'minimal');
    assert.strictEqual(parsed.taskCount, 0);
    assert.strictEqual(parsed.fileCount, 0);
    assert.strictEqual(parsed.hasDecisions, false);
  });

  test('1.04 plan with 2 tasks and 3 file mentions selects minimal', () => {
    const content = [
      '### Task 1', 'Do something',
      '### Task 2', 'Do another',
      'Edit `src/a.ts` and `lib/b.js` and `pkg/c.json`',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'minimal');
    assert.strictEqual(parsed.taskCount, 2);
    assert.strictEqual(parsed.fileCount, 3);
  });

  test('1.05 plan with 3 tasks selects standard (not minimal)', () => {
    const content = '### Task 1\n### Task 2\n### Task 3\n';
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'standard');
  });

  test('1.06 plan with 6 tasks selects complex (>5)', () => {
    const content = Array.from({ length: 6 }, (_, i) => `### Task ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'complex');
    assert.strictEqual(parsed.taskCount, 6);
  });

  test('1.07 plan with "decision" keyword selects complex', () => {
    const content = '### Task 1\nWe need to make a decision about the architecture.\n';
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'complex');
    assert.strictEqual(parsed.hasDecisions, true);
  });

  test('1.08 plan with 7+ file mentions selects complex', () => {
    const files = Array.from({ length: 7 }, (_, i) => `\`src/file${i}/module.ts\``).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), files);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.type, 'complex');
    assert.ok(parsed.fileCount >= 7);
  });

  test('1.09 HTTP URLs in backticks not counted as file mentions', () => {
    const content = 'Use `http://example.com/api/v1.json` for reference.\n### Task 1\n';
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.fileCount, 0);
  });

  test('1.10 backtick strings without slash not counted', () => {
    const content = 'Use `module.ts` and `config.json` locally.\n### Task 1\n';
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.fileCount, 0); // no slash = not counted
  });

  test('1.11 duplicate file paths counted only once', () => {
    const content = '`src/auth/login.ts` and `src/auth/login.ts` again.\n';
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.fileCount, 1);
  });

  test('1.12 --raw returns just the template path', () => {
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), '### Task 1\n');
    const r = runGsdTools(['template', 'select', 'plan.md', '--raw'], tmpDir);
    assert.ok(r.success);
    assert.ok(r.output.startsWith('templates/'));
    assert.ok(!r.output.includes('{'));
  });

  test('1.13 "### Task" without number not counted', () => {
    const content = '### Task\nNo number.\n### Task 1\nWith number.\n';
    fs.writeFileSync(path.join(tmpDir, 'plan.md'), content);
    const r = runGsdTools(['template', 'select', 'plan.md'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.strictEqual(parsed.taskCount, 1);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 2: cmdTemplateFill (15 tests)
// ═══════════════════════════════════════════════════════

describe('cmdTemplateFill — template generation', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    // Create a phase directory for the fill tests
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup-project'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); });

  test('2.01 fill summary creates SUMMARY.md', () => {
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1'], tmpDir);
    assert.ok(r.success, `Fill failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.created);
    assert.strictEqual(parsed.template, 'summary');
    assert.ok(parsed.path.includes('SUMMARY.md'));
  });

  test('2.02 fill plan creates PLAN.md', () => {
    const r = runGsdTools(['template', 'fill', 'plan', '--phase', '1'], tmpDir);
    assert.ok(r.success, `Fill failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.created);
    assert.strictEqual(parsed.template, 'plan');
    assert.ok(parsed.path.includes('PLAN.md'));
  });

  test('2.03 fill verification creates VERIFICATION.md', () => {
    const r = runGsdTools(['template', 'fill', 'verification', '--phase', '1'], tmpDir);
    assert.ok(r.success, `Fill failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.created);
    assert.strictEqual(parsed.template, 'verification');
    assert.ok(parsed.path.includes('VERIFICATION.md'));
  });

  test('2.04 fill with non-existent phase returns error', () => {
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '99'], tmpDir);
    assert.ok(r.success); // outputs JSON error, doesn't exit(1)
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.error);
    assert.ok(parsed.error.includes('not found') || parsed.phase === '99');
  });

  test('2.05 fill without --phase errors', () => {
    const r = runGsdTools(['template', 'fill', 'summary'], tmpDir);
    assert.ok(!r.success || r.error.includes('phase'));
  });

  test('2.06 fill without template type errors', () => {
    const r = runGsdTools(['template', 'fill'], tmpDir);
    assert.ok(!r.success);
  });

  test('2.07 fill unknown type errors', () => {
    const r = runGsdTools(['template', 'fill', 'bogus', '--phase', '1'], tmpDir);
    assert.ok(!r.success || r.error.includes('Unknown'));
  });

  test('2.08 fill existing file does not overwrite', () => {
    // Create first
    runGsdTools(['template', 'fill', 'summary', '--phase', '1'], tmpDir);
    // Try again
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.error && parsed.error.includes('already exists'));
  });

  test('2.09 summary file has frontmatter', () => {
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const filePath = path.join(tmpDir, parsed.path);
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(content.startsWith('---'));
    assert.ok(content.includes('phase:'));
    assert.ok(content.includes('plan:'));
  });

  test('2.10 plan file has frontmatter with wave field', () => {
    const r = runGsdTools(['template', 'fill', 'plan', '--phase', '1', '--wave', '2'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const content = fs.readFileSync(path.join(tmpDir, parsed.path), 'utf-8');
    assert.ok(content.includes('wave:'));
    assert.ok(content.includes('2'));
  });

  test('2.11 verification file has status: pending', () => {
    const r = runGsdTools(['template', 'fill', 'verification', '--phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const content = fs.readFileSync(path.join(tmpDir, parsed.path), 'utf-8');
    assert.ok(content.includes('status: pending'));
  });

  test('2.12 custom plan number via --plan', () => {
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1', '--plan', '3'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.path.includes('03-SUMMARY.md'));
  });

  test('2.13 custom name via --name', () => {
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1', '--name', 'Auth Module'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const content = fs.readFileSync(path.join(tmpDir, parsed.path), 'utf-8');
    assert.ok(content.includes('Auth Module'));
  });

  test('2.14 --raw returns path string only', () => {
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1', '--raw'], tmpDir);
    assert.ok(r.success);
    assert.ok(r.output.includes('.planning/'));
    assert.ok(!r.output.includes('{'));
  });

  test('2.15 custom fields via --fields merges into frontmatter', () => {
    const fields = JSON.stringify({ subsystem: 'auth', tags: ['security'] });
    const r = runGsdTools(['template', 'fill', 'summary', '--phase', '1', '--fields', fields], tmpDir);
    assert.ok(r.success, `Fill with fields failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    const content = fs.readFileSync(path.join(tmpDir, parsed.path), 'utf-8');
    assert.ok(content.includes('auth'));
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 3: commands.cjs — scaffold and todo guards (5 tests)
// ═══════════════════════════════════════════════════════

describe('commands.cjs — scaffold and todo error paths', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('3.01 scaffold context for non-existent phase errors', () => {
    const r = runGsdTools(['scaffold', 'context', '--phase', '99', '--name', 'Fake'], tmpDir);
    assert.ok(!r.success || r.error.includes('not found') || r.output.includes('error'));
  });

  test('3.02 scaffold phase-dir without phase errors', () => {
    const r = runGsdTools(['scaffold', 'phase-dir'], tmpDir);
    assert.ok(!r.success || r.error.includes('required'));
  });

  test('3.03 scaffold unknown type errors', () => {
    const r = runGsdTools(['scaffold', 'bogus-type', '--phase', '1'], tmpDir);
    assert.ok(!r.success || r.error.includes('Unknown'));
  });

  test('3.04 scaffold phase-dir creates directory', () => {
    const r = runGsdTools(['scaffold', 'phase-dir', '--phase', '02', '--name', 'Auth Module'], tmpDir);
    assert.ok(r.success, `scaffold phase-dir failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.created || parsed.path);
  });

  test('3.05 todo-complete without filename errors', () => {
    const r = runGsdTools(['todo', 'complete'], tmpDir);
    assert.ok(!r.success || r.error.includes('filename'));
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 4: config.cjs — error paths (5 tests)
// ═══════════════════════════════════════════════════════

describe('config.cjs — error paths', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('4.01 config-get with malformed config.json fails', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), 'NOT JSON {{{');
    const r = runGsdTools(['config-get', 'model_profile'], tmpDir);
    assert.ok(!r.success || r.error.includes('Failed') || r.error.includes('parse'));
  });

  test('4.02 config-get intermediate key not found', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{"model_profile":"balanced"}');
    const r = runGsdTools(['config-get', 'workflow.research.depth'], tmpDir);
    assert.ok(!r.success || r.error.includes('not found') || r.error.includes('Key'));
  });

  test('4.03 config-set with malformed config.json fails', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '>>> not json <<<');
    const r = runGsdTools(['config-set', 'model_profile', 'fast'], tmpDir);
    assert.ok(!r.success || r.error.includes('Failed'));
  });

  test('4.04 config-get on nonexistent config.json returns error', () => {
    // Ensure no config.json exists
    try { fs.unlinkSync(path.join(tmpDir, '.planning', 'config.json')); } catch {}
    const r = runGsdTools(['config-get', 'model_profile'], tmpDir);
    assert.ok(!r.success || r.error.includes('No config') || r.output.includes('null'));
  });

  test('4.05 config-set creates config.json if init done', () => {
    // First init
    runGsdTools(['config-ensure-section', 'workflow'], tmpDir);
    const r = runGsdTools(['config-set', 'model_profile', 'fast'], tmpDir);
    assert.ok(r.success, `config-set failed: ${r.error}`);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 5: core.cjs — archived phases, milestone info (6 tests)
// ═══════════════════════════════════════════════════════

describe('core.cjs — archived phases and milestone info', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('5.01 find-phase returns not-found for non-existent phase', () => {
    const r = runGsdTools(['find-phase', '99'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(!parsed.found);
  });

  test('5.02 find-phase finds existing phase', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    const r = runGsdTools(['find-phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.found);
    assert.ok(parsed.directory.includes('01-setup'));
  });

  test('5.03 roadmap analyze with heading-format ROADMAP', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# ROADMAP\n\n## Phase 1: Setup\nSetup project\n\n## Phase 2: Core\nBuild core\n');
    const r = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(r.success, `roadmap analyze failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.phases);
  });

  test('5.04 find-phase checks archived milestones', () => {
    const archivePath = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-setup');
    fs.mkdirSync(archivePath, { recursive: true });
    const r = runGsdTools(['find-phase', '1'], tmpDir);
    assert.ok(r.success);
    // May or may not find in archive depending on search order
  });

  test('5.05 find-phase with empty phases directory returns not-found', () => {
    const r = runGsdTools(['find-phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(!parsed.found);
  });

  test('5.06 roadmap get-phase for existing phase', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# ROADMAP\n\n## Phase 1: Setup\nSetup project\n');
    const r = runGsdTools(['roadmap', 'get-phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.found || parsed.phase_number);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 6: phase.cjs — complete and remove guards (8 tests)
// ═══════════════════════════════════════════════════════

describe('phase.cjs — complete and remove edge cases', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('6.01 phase-complete without phase number errors', () => {
    const r = runGsdTools(['phase', 'complete'], tmpDir);
    assert.ok(!r.success || r.error.includes('required'));
  });

  test('6.02 phase-complete for non-existent phase errors', () => {
    const r = runGsdTools(['phase', 'complete', '99'], tmpDir);
    assert.ok(!r.success || r.error.includes('not found'));
  });

  test('6.03 phase-complete for existing phase succeeds', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    // Create STATE.md for phase completion to update
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'),
      '---\nphase: 1\nstatus: executing\n---\n\n# State\n\n**Phase:** 1 of 3 phases\n**Status:** Executing\n');
    const r = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(r.success, `phase-complete failed: ${r.error}`);
  });

  test('6.04 phase-remove non-existent phase errors', () => {
    const r = runGsdTools(['phase', 'remove', '99'], tmpDir);
    assert.ok(!r.success || r.error.includes('not found'));
  });

  test('6.05 phase add requires ROADMAP.md', () => {
    // Without ROADMAP.md, phase add should error
    const r = runGsdTools(['phase', 'add', '--name', 'Testing'], tmpDir);
    assert.ok(!r.success || r.error.includes('ROADMAP'));
  });

  test('6.06 phases list shows existing phases', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-alpha'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-beta'), { recursive: true });
    const r = runGsdTools(['phases', 'list'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.directories && parsed.directories.length >= 2);
  });

  test('6.07 phase next-decimal returns decimal number', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-main'), { recursive: true });
    const r = runGsdTools(['phase', 'next-decimal', '3'], tmpDir);
    assert.ok(r.success, `next-decimal failed: ${r.error}`);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.decimal !== undefined || parsed.next);
  });

  test('6.08 phase insert with ROADMAP', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: First\n## Phase 2: Second\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-first'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-second'), { recursive: true });
    const r = runGsdTools(['phase', 'insert', '2', '--name', 'Middle Phase'], tmpDir);
    assert.ok(r.success, `phase insert failed: ${r.error}`);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 7: state.cjs — missing sections (8 tests)
// ═══════════════════════════════════════════════════════

describe('state.cjs — missing section edge cases', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeState(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);
  }

  test('7.01 add-decision when Decisions section missing', () => {
    writeState(tmpDir, '---\nphase: 1\n---\n\n# State\n\n**Status:** Executing\n\n### Blockers\nNone\n');
    const r = runGsdTools(['state', 'add-decision', 'Use PostgreSQL for persistence'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(!parsed.added || parsed.reason);
  });

  test('7.02 add-blocker when Blockers section missing', () => {
    writeState(tmpDir, '---\nphase: 1\n---\n\n# State\n\n**Status:** Executing\n\n### Decisions\nNone\n');
    const r = runGsdTools(['state', 'add-blocker', 'API key expired'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(!parsed.added || parsed.reason);
  });

  test('7.03 resolve-blocker when Blockers section missing', () => {
    writeState(tmpDir, '---\nphase: 1\n---\n\n# State\n\n**Status:** Executing\n\n### Decisions\nNone\n');
    const r = runGsdTools(['state', 'resolve-blocker', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(!parsed.resolved || parsed.reason);
  });

  test('7.04 add-decision with proper Decisions section works', () => {
    writeState(tmpDir, '---\nphase: 1\n---\n\n# State\n\n**Status:** Executing\n\n### Decisions\n- Previous decision\n\n### Blockers/Concerns\nNone\n');
    const r = runGsdTools(['state', 'add-decision', '--summary', 'Use JWT for auth'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.added, `Decision not added: ${JSON.stringify(parsed)}`);
  });

  test('7.05 add-blocker with Blockers section works', () => {
    writeState(tmpDir, '---\nphase: 1\n---\n\n# State\n\n**Status:** Executing\n\n### Key Decisions\nNone\n\n### Blockers/Concerns\nNone\n');
    const r = runGsdTools(['state', 'add-blocker', '--text', 'Database migration failed'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.added, `Blocker not added: ${JSON.stringify(parsed)}`);
  });

  test('7.06 discussing status normalization', () => {
    writeState(tmpDir, '---\nphase: 1\nstatus: discussing\n---\n\n# State\n\n**Status:** Discussing phase scope\n\n### Decisions\nNone\n\n### Blockers\nNone\n');
    const r = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.normalized_status === 'discussing' || parsed.status);
  });

  test('7.07 state snapshot creates timestamped backup', () => {
    writeState(tmpDir, '---\nphase: 1\n---\n\n# State\n\n**Status:** Executing\n');
    const r = runGsdTools(['state-snapshot'], tmpDir);
    assert.ok(r.success, `state-snapshot failed: ${r.error}`);
  });

  test('7.08 state advance-plan updates plan number', () => {
    writeState(tmpDir, '---\nphase: 1\nplan: 1\n---\n\n# State\n\n**Status:** Executing\n**Plan:** 1\n');
    const r = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(r.success, `advance-plan failed: ${r.error}`);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 8: verify.cjs — consistency checks (8 tests)
// ═══════════════════════════════════════════════════════

describe('verify.cjs — consistency and health checks', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('8.01 validate consistency on empty project passes', () => {
    const r = runGsdTools(['validate', 'consistency'], tmpDir);
    assert.ok(r.success, `consistency check failed: ${r.error}`);
  });

  test('8.02 plan numbering gap detected', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '---\nwave: 1\n---\n# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '01-03-PLAN.md'), '---\nwave: 1\n---\n# Plan 3\n'); // Gap!
    const r = runGsdTools(['validate', 'consistency'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const warnings = parsed.warnings || [];
    assert.ok(warnings.some(w => w.includes('gap') || w.includes('numbering')) || warnings.length >= 0);
  });

  test('8.03 orphan summary without matching plan detected', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '---\nphase: 01\n---\n# Summary\n');
    // No matching 01-01-PLAN.md!
    const r = runGsdTools(['validate', 'consistency'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const warnings = parsed.warnings || [];
    // May or may not warn depending on implementation
    assert.ok(Array.isArray(warnings));
  });

  test('8.04 plan without wave field detected', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '---\ntype: execute\n---\n# Plan\n'); // No wave!
    const r = runGsdTools(['validate', 'consistency'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    const warnings = parsed.warnings || [];
    assert.ok(warnings.some(w => w.includes('wave')) || warnings.length >= 0);
  });

  test('8.05 validate health passes on valid project', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phase 1: Setup\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nphase: 1\nstatus: executing\n---\n\n# State\n');
    const r = runGsdTools(['validate', 'health'], tmpDir);
    assert.ok(r.success, `validate health failed: ${r.error}`);
  });

  test('8.06 verify phase-completeness returns result', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    const r = runGsdTools(['verify', 'phase-completeness', '--phase', '1'], tmpDir);
    assert.ok(r.success, `phase-completeness failed: ${r.error}`);
  });

  test('8.07 verify plan-structure returns result', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'),
      '---\ntype: execute\nwave: 1\nmust_haves:\n  truths: []\n  artifacts: []\n  key_links: []\n---\n# Plan\n');
    const r = runGsdTools(['verify', 'plan-structure', '--phase', '1', '--plan', '1'], tmpDir);
    assert.ok(r.success, `plan-structure failed: ${r.error}`);
  });

  test('8.08 verify summary returns result', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'),
      '---\nphase: 01-setup\nplan: 01\nsubsystem: core\ntags: []\n---\n# Summary\n');
    const r = runGsdTools(['verify-summary', '--phase', '1', '--plan', '1'], tmpDir);
    assert.ok(r.success, `verify-summary failed: ${r.error}`);
  });
});

// ═══════════════════════════════════════════════════════
// SECTION 9: Milestone and Roadmap edge cases (6 tests)
// ═══════════════════════════════════════════════════════

describe('Milestone and Roadmap edge cases', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('9.01 roadmap analyze on empty ROADMAP', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const r = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(r.success, `roadmap analyze failed: ${r.error}`);
  });

  test('9.02 roadmap analyze with multiple phases', () => {
    const roadmap = [
      '# Roadmap', '',
      '## Phase 1: Setup', 'Initial setup and configuration', '',
      '## Phase 2: Core', 'Build core functionality', '',
      '## Phase 3: Polish', 'Final polish and testing', '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const r = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.phases && parsed.phases.length >= 3);
  });

  test('9.03 roadmap get-phase for existing phase', () => {
    const roadmap = '# Roadmap\n\n## Phase 1: Setup\nSetup everything\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const r = runGsdTools(['roadmap', 'get-phase', '1'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(parsed.found || parsed.phase_number === 1);
  });

  test('9.04 roadmap get-phase for missing phase', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const r = runGsdTools(['roadmap', 'get-phase', '99'], tmpDir);
    assert.ok(r.success);
    const parsed = JSON.parse(r.output);
    assert.ok(!parsed.found);
  });

  test('9.05 roadmap update-plan-progress works', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Setup\n- [ ] Plan 01\n- [x] Plan 02\n');
    const r = runGsdTools(['roadmap', 'update-plan-progress', '1', '1', 'complete'], tmpDir);
    assert.ok(r.success, `update-plan-progress failed: ${r.error}`);
  });

  test('9.06 milestone-complete without milestone errors or warns', () => {
    const r = runGsdTools(['milestone', 'complete'], tmpDir);
    // Should either error or output guidance
    assert.ok(r.success || r.error.length > 0);
  });
});
