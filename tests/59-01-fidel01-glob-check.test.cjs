'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const toolsPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-tools.cjs');

const T = 'task';
const S = 'story';
const A = 'agent';
const FE = 'files_expected';
const AC = 'acceptance_criteria';

function buildPlan(filesExpectedYaml, agent = 'executor-backend') {
  return [
    '---', 'plan_id: test-glob', '---',
    `<${S}><title>T</title><success_criteria>G W T</success_criteria><doc_refs></doc_refs></${S}>`,
    `<${T} id="test-glob-01">`,
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

test('FIDEL-01: plan-to-tasks rejects **/* glob in files_expected', async () => {
  const { planToTasks } = require(toolsPath);
  const tmp = path.join(os.tmpdir(), `fidel01-test-${Date.now()}.md`);
  fs.writeFileSync(tmp, buildPlan('modify:\n  - **/*\ncreate: []\ndelete: []'), 'utf-8');
  try {
    const result = await planToTasks(tmp, { cwd: process.cwd() });
    assert.equal(result.error, 'validation_failed');
    const globError = (result.errors || []).find(e => e.code === 'over_broad_files_expected');
    assert.ok(globError);
    assert.equal(globError.taskId, 'test-glob-01');
    assert.equal(globError.offendingPath, '**/*');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('FIDEL-01: plan-to-tasks rejects ? glob in files_expected', async () => {
  const { planToTasks } = require(toolsPath);
  const tmp = path.join(os.tmpdir(), `fidel01-test-q-${Date.now()}.md`);
  fs.writeFileSync(tmp, buildPlan('modify:\n  - services/?.py\ncreate: []\ndelete: []'), 'utf-8');
  try {
    const result = await planToTasks(tmp, { cwd: process.cwd() });
    assert.equal(result.error, 'validation_failed');
    const globError = (result.errors || []).find(e => e.code === 'over_broad_files_expected');
    assert.ok(globError);
    assert.equal(globError.taskId, 'test-glob-01');
    assert.equal(globError.offendingPath, 'services/?.py');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('FIDEL-01: concrete file path does not trigger over_broad_files_expected', async () => {
  const { planToTasks } = require(toolsPath);
  const tmp = path.join(os.tmpdir(), `fidel01-test-ok-${Date.now()}.md`);
  fs.writeFileSync(tmp, buildPlan('modify:\n  - services/my_file.py\ncreate: []\ndelete: []', 'executor-frontend'), 'utf-8');
  try {
    const result = await planToTasks(tmp, { cwd: process.cwd() });
    const globErrors = (result.errors || []).filter(e => e.code === 'over_broad_files_expected');
    assert.equal(globErrors.length, 0);
    assert.equal(result.error, 'agent_assignment_conflict');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});
