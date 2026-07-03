'use strict';

// TK-1690: _parseFilesExpectedYaml only parsed the FIRST top-level key when
// the files_expected block content is indented (the style
// get-shit-done/references/plan-task-xml-schema.md's own <files_expected>
// example uses). This locks in that both the indented style and the
// column-0 style parse identically, and that downstream missing-key /
// glob-blocklist enforcement is unaffected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const toolsPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-tools.cjs');
const {
  _parseFilesExpectedYaml,
  manifestCheck,
  _validatePlanShape,
} = require(toolsPath);

const T = 'task';
const S = 'story';
const A = 'agent';
const FE = 'files_expected';
const AC = 'acceptance_criteria';

function buildPlan(filesExpectedYaml, agent = 'executor-backend', taskId = 'test-indent-01') {
  return [
    '---', 'plan_id: test-indent', '---',
    `<${S}><title>T</title><success_criteria>G W T</success_criteria><doc_refs></doc_refs></${S}>`,
    `<${T} id="${taskId}">`,
    '<title>Test Task</title>',
    `<${A}>${agent}</${A}>`,
    '<depends_on>[]</depends_on>',
    '<read_first>- some/file.js</read_first>',
    '<action>Do something.</action>',
    `<${AC}>- echo ok</${AC}>`,
    `<${FE}>`,
    filesExpectedYaml,
    `</${FE}>`,
    `</${T}>`,
  ].join('\n');
}

// --- Unit-level: _parseFilesExpectedYaml directly ---------------------------

test('FIDEL-manifest: indented files_expected (plan-task-xml-schema.md style) parses all 3 keys', () => {
  // Mirrors the 4-space indent used in plan-task-xml-schema.md's own
  // <files_expected> example, and mirrors what the caller passes after
  // `match[1].trim()` (only the first line's indent is stripped externally).
  const indented = [
    'modify:',
    '      - path/to/modified-file.md',
    '    create:',
    '      - path/to/new-file.md',
    '    delete: []',
  ].join('\n');

  const parsed = _parseFilesExpectedYaml(indented);
  assert.deepEqual(parsed.modify, ['path/to/modified-file.md']);
  assert.deepEqual(parsed.create, ['path/to/new-file.md']);
  assert.deepEqual(parsed.delete, []);
});

test('FIDEL-manifest: column-0 files_expected still parses identically (no regression)', () => {
  const columnZero = [
    'modify:',
    '  - path/to/modified-file.md',
    'create:',
    '  - path/to/new-file.md',
    'delete: []',
  ].join('\n');

  const parsed = _parseFilesExpectedYaml(columnZero);
  assert.deepEqual(parsed.modify, ['path/to/modified-file.md']);
  assert.deepEqual(parsed.create, ['path/to/new-file.md']);
  assert.deepEqual(parsed.delete, []);
});

test('FIDEL-manifest: indented and column-0 styles produce byte-identical parse results', () => {
  const indented = [
    '    modify:',
    '      - a/b.py',
    '    create:',
    '      - c/d.py',
    '    delete:',
    '      - e/f.py',
  ].join('\n');
  const columnZero = [
    'modify:',
    '  - a/b.py',
    'create:',
    '  - c/d.py',
    'delete:',
    '  - e/f.py',
  ].join('\n');

  assert.deepEqual(_parseFilesExpectedYaml(indented), _parseFilesExpectedYaml(columnZero));
});

// --- Pass-0-level: _validatePlanShape over an indented plan -----------------
// (Uses _validatePlanShape directly rather than the full planToTasks, since
// planToTasks Pass 1 shells out to the live `amauta add task` CLI and
// persists real story/task records — not appropriate for a parser-focused
// regression test.)

test('FIDEL-manifest: _validatePlanShape sees create/delete lists from an indented block', () => {
  const filesExpectedYaml = [
    'modify:',
    '      - services/existing_file.py',
    '    create:',
    '      - services/new_file.py',
    '    delete: []',
  ].join('\n');
  const plan = buildPlan(filesExpectedYaml);
  const shape = _validatePlanShape(plan);
  assert.equal(shape.valid, true);
  const task = shape.tasks.find(t => t.id === 'test-indent-01');
  assert.ok(task, 'expected task test-indent-01 to be present in shape.tasks');
  assert.deepEqual(task.filesExpected.modify, ['services/existing_file.py']);
  assert.deepEqual(task.filesExpected.create, ['services/new_file.py']);
  assert.deepEqual(task.filesExpected.delete, []);
});

// --- manifestCheck: missing-key behavior is unchanged -----------------------

test('FIDEL-manifest: manifestCheck still throws when create/delete are missing (indented, malformed)', async () => {
  // Deliberately malformed: only `modify` declared, no create/delete at all
  // (not even the indented key line) -- must still be rejected as missing.
  const malformed = _parseFilesExpectedYaml([
    '    modify:',
    '      - a/b.py',
  ].join('\n'));
  assert.equal(malformed.create, undefined);
  assert.equal(malformed.delete, undefined);

  await assert.rejects(
    () => manifestCheck({
      phase: 'test',
      wave: '1',
      taskId: 'test-missing-01',
      filesExpected: malformed,
      gitShaBefore: 'HEAD',
      gitShaAfter: 'HEAD',
      cwd: process.cwd(),
    }),
    /must declare all of modify, create, delete/
  );
});

// --- manifestCheck: glob-blocklist behavior is unchanged --------------------

test('FIDEL-manifest: manifestCheck still rejects blocklisted globs parsed from an indented block', async () => {
  const parsed = _parseFilesExpectedYaml([
    'modify: []',
    '    create:',
    '      - **/*',
    '    delete: []',
  ].join('\n'));
  assert.deepEqual(parsed.create, ['**/*']);

  await assert.rejects(
    () => manifestCheck({
      phase: 'test',
      wave: '1',
      taskId: 'test-glob-indent-01',
      filesExpected: parsed,
      gitShaBefore: 'HEAD',
      gitShaAfter: 'HEAD',
      cwd: process.cwd(),
    }),
    /overly broad glob/
  );
});
