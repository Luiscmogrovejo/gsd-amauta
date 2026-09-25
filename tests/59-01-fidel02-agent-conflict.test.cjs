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

function buildConflictPlan() {
  return [
    '---', 'plan_id: test-conflict', '---',
    `<${S}><title>T</title><success_criteria>G W T</success_criteria><doc_refs></doc_refs></${S}>`,
    `<${T} id="test-conflict-01">`,
    '<title>Conflict Task</title>',
    `<${A}>executor-backend</${A}>`,
    '<depends_on>[]</depends_on>',
    '<read_first>- some/file.js</read_first>',
    '<action>Do something.</action>',
    `<${AC}>- echo ok</${AC}>`,
    `<${FE}>`,
    'modify:',
    '  - src/components/MyComponent.tsx',
    'create: []',
    'delete: []',
    `</${FE}>`,
    `</${T}>`,
  ].join('\n');
}

test('FIDEL-02: conflict payload includes declaredAgent, computedAgent, files', async () => {
  const { planToTasks } = require(toolsPath);
  const tmp = path.join(os.tmpdir(), `fidel02-test-${Date.now()}.md`);
  fs.writeFileSync(tmp, buildConflictPlan(), 'utf-8');
  try {
    const result = await planToTasks(tmp, { cwd: process.cwd() });
    assert.equal(result.error, 'agent_assignment_conflict');
    assert.ok(Array.isArray(result.conflicts));
    assert.ok(result.conflicts.length >= 1);
    const conflict = result.conflicts[0];
    assert.equal(conflict.taskId, 'test-conflict-01');
    assert.equal(conflict.declaredAgent, 'executor-backend');
    assert.equal(conflict.computedAgent, 'executor-frontend');
    assert.ok(Array.isArray(conflict.files));
    assert.ok(conflict.files.includes('src/components/MyComponent.tsx'));
    assert.ok(result.message.includes(conflict.taskId));
    assert.ok(result.message.includes(conflict.declaredAgent));
    assert.ok(result.message.includes(conflict.computedAgent));
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('FIDEL-02: divergence_type remains agent_assignment_conflict', async () => {
  const { planToTasks } = require(toolsPath);
  const tmp = path.join(os.tmpdir(), `fidel02-type-${Date.now()}.md`);
  fs.writeFileSync(tmp, buildConflictPlan(), 'utf-8');
  try {
    const result = await planToTasks(tmp, { cwd: process.cwd() });
    assert.equal(result.divergence_type, 'agent_assignment_conflict');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});
