'use strict';

// Phase 61 PERS-02 evidence map (test # -> ROADMAP SC2/SC3):
//   1  persona parse            -> SC2/SC3 precondition: <persona> element parses into task.persona
//   2  SC2 positive (match)     -> SC2: persona over base_executor-member files = zero conflicts
//   3  SC2 negative (mismatch)  -> SC2: persona over non-member files = persona_base_executor_mismatch
//   4  unknown persona          -> fail-closed: unregistered persona id never silently passes
//   5  agent/persona coupling   -> fail-closed: <agent> must equal the declared persona id
//   6  multi-base persona       -> SC2: gsd-persona-systems-architect's 3-way base_executor list
//   7  SC3 fallback + audit     -> SC3: _buildAgentAssignment no-persona vs persona audit shape
//   8  legacy byte-identity     -> absent-<persona> conflict objects stay byte-identical (no persona/reason keys)
//   9  _resolvePersona normalize-> short/full id acceptance, empty-string and kind-guard rejection
//
// No-inference note (Deterministic Before Behavioral): every assertion below
// exercises a DECLARED persona id resolved against the REAL
// get-shit-done/agent-capabilities.json registry via getCapabilityIndex(). There
// is no NLP/ML classification anywhere in this suite or in the code under test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const toolsPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-tools.cjs');
const {
  _validatePlanShape,
  _checkAgentConflicts,
  _resolvePersona,
  _buildAgentAssignment,
  routeExecutor,
} = require(toolsPath);

// ─── Shared fixture helpers (mirrors tests/59-01-fidel02-agent-conflict.test.cjs style) ───

const T = 'task';
const S = 'story';
const A = 'agent';
const P = 'persona';
const FE = 'files_expected';
const AC = 'acceptance_criteria';

function tag(name, value) {
  return `<${name}>${value}</${name}>`;
}

// Builds a single-task PLAN.md body. `personaLine` is either a full <persona>
// tag string or '' (omitted entirely) to exercise the absent-persona path.
function buildPlan({ taskId, agentValue, personaLine, filePath }) {
  return [
    '---', 'plan_id: test-persona-routing', '---',
    `<${S}><title>T</title><success_criteria>G W T</success_criteria><doc_refs></doc_refs></${S}>`,
    `<${T} id="${taskId}">`,
    '<title>Persona Routing Task</title>',
    tag(A, agentValue),
    personaLine,
    '<depends_on>[]</depends_on>',
    '<read_first>- some/file.js</read_first>',
    '<action>Do something.</action>',
    tag(AC, '- echo ok'),
    `<${FE}>`,
    'modify:',
    `  - ${filePath}`,
    'create: []',
    'delete: []',
    `</${FE}>`,
    `</${T}>`,
  ].join('\n');
}

function makeConflictTask({ id, agentValue, persona, filePath }) {
  return {
    id,
    agent: agentValue,
    persona: persona === undefined ? null : persona,
    filesExpected: { modify: [filePath], create: [], delete: [] },
  };
}

// ─── 1. persona parse ──────────────────────────────────────────────────────

test('1. persona parse: <persona> element populates tasks[0].persona', () => {
  const plan = buildPlan({
    taskId: 'x-01',
    agentValue: 'persona-senior-backend',
    personaLine: tag(P, 'persona-senior-backend'),
    filePath: 'services/a.py',
  });
  const result = _validatePlanShape(plan);
  assert.equal(result.tasks[0].persona, 'persona-senior-backend');
});

test('1b. persona parse: absent <persona> element yields tasks[0].persona == null', () => {
  const plan = buildPlan({
    taskId: 'x-01',
    agentValue: 'executor-backend',
    personaLine: '', // omitted entirely
    filePath: 'services/a.py',
  });
  const result = _validatePlanShape(plan);
  assert.equal(result.tasks[0].persona, null);
});

// ─── 2/3. SC2 positive (match) + negative (base mismatch) ─────────────────

test('2. SC2 positive: persona-senior-backend over .py (member) yields zero conflicts', () => {
  const task = makeConflictTask({
    id: 'x', agentValue: 'persona-senior-backend', persona: 'persona-senior-backend', filePath: 'services/a.py',
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 0);
});

test('3. SC2 negative: persona-senior-backend over .tsx (non-member) yields persona_base_executor_mismatch', () => {
  const filePath = 'src/components/X.tsx';
  const task = makeConflictTask({
    id: 'x', agentValue: 'persona-senior-backend', persona: 'persona-senior-backend', filePath,
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.reason, 'persona_base_executor_mismatch');
  assert.equal(c.persona, 'persona-senior-backend');
  assert.equal(c.computedAgent, routeExecutor(filePath));
  assert.deepEqual(c.base_executor, ['gsd-executor-backend']);
});

// ─── 4. unknown persona ─────────────────────────────────────────────────────

test('4. unknown persona: unregistered persona id fails closed with unknown_persona', () => {
  const task = makeConflictTask({
    id: 'x', agentValue: 'persona-nonexistent', persona: 'persona-nonexistent', filePath: 'services/a.py',
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'unknown_persona');
});

// ─── 5. agent/persona coupling ──────────────────────────────────────────────

test('5. agent/persona coupling: <agent> not equal to declared persona id fails with agent_persona_mismatch', () => {
  const task = makeConflictTask({
    id: 'x', agentValue: 'executor-backend', persona: 'persona-senior-backend', filePath: 'services/a.py',
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'agent_persona_mismatch');
});

// ─── 6. multi-base persona (gsd-persona-systems-architect) ─────────────────

test('6. multi-base persona: systems-architect over .py and .tsx both zero conflicts', () => {
  const pyTask = makeConflictTask({
    id: 'x', agentValue: 'persona-systems-architect', persona: 'persona-systems-architect', filePath: 'services/a.py',
  });
  assert.equal(_checkAgentConflicts([pyTask]).conflicts.length, 0);

  const tsxTask = makeConflictTask({
    id: 'y', agentValue: 'persona-systems-architect', persona: 'persona-systems-architect', filePath: 'src/components/X.tsx',
  });
  assert.equal(_checkAgentConflicts([tsxTask]).conflicts.length, 0);
});

test('6b. multi-base persona: systems-architect over a file routed OUTSIDE its base_executor set yields persona_base_executor_mismatch', () => {
  const entry = _resolvePersona('persona-systems-architect');
  assert.ok(entry, 'persona-systems-architect must resolve against the live registry');
  const baseShort = (entry.base_executor || []).map((b) => String(b).replace(/^gsd-/, ''));

  // Iterate candidate paths and pick the first whose routed executor is
  // outside the persona's base_executor set (registry-evolution-safe, no
  // hardcoded expected executor).
  const candidates = [
    'app/src/main/java/A.kt',
    'ios/App/AppDelegate.swift',
    'lib/main.dart',
    'wear/src/Watch.kt',
    'prompts/system.md',
  ];
  let outsidePath = null;
  let outsideExecutor = null;
  for (const candidate of candidates) {
    const computed = routeExecutor(candidate);
    if (!baseShort.includes(computed)) {
      outsidePath = candidate;
      outsideExecutor = computed;
      break;
    }
  }

  if (!outsidePath) {
    // No candidate outside the base set was found (registry may have grown
    // the base_executor list to cover everything) — skip with a logged note
    // per the plan's fallback instruction, rather than asserting a false negative.
    console.log('6b. SKIPPED — no candidate path found outside persona-systems-architect base_executor set');
    return;
  }

  const task = makeConflictTask({
    id: 'z', agentValue: 'persona-systems-architect', persona: 'persona-systems-architect', filePath: outsidePath,
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'persona_base_executor_mismatch');
  assert.equal(conflicts[0].computedAgent, outsideExecutor);
});

// ─── 7. SC3 fallback + audit shape (_buildAgentAssignment) ─────────────────

test('7. SC3 fallback: _buildAgentAssignment with no persona records persona:null + no-role-signal reasoning', () => {
  const computed = routeExecutor('services/a.py');
  const a = _buildAgentAssignment({
    agent: 'executor-backend', persona: null, filesExpected: { modify: ['services/a.py'], create: [] },
  });
  assert.equal(a.persona, null);
  assert.equal(a.base_executor, computed);
  assert.ok(a.reasoning.includes('no role signal — file-extension routing'));
});

test('7b. SC2 audit shape: _buildAgentAssignment with a matching persona records persona id + cross-check-passed reasoning', () => {
  const computed = routeExecutor('services/a.py');
  const a = _buildAgentAssignment({
    agent: 'persona-senior-backend', persona: 'persona-senior-backend', filesExpected: { modify: ['services/a.py'], create: [] },
  });
  assert.equal(a.agent, 'persona-senior-backend');
  assert.equal(a.persona, 'persona-senior-backend');
  assert.equal(a.base_executor, computed);
  assert.ok(a.reasoning.includes('persona-senior-backend'));
  assert.ok(a.reasoning.includes('cross-check passed'));
});

// ─── 8. legacy byte-identity ────────────────────────────────────────────────

test('8. legacy byte-identity: no-persona conflict objects carry exactly the 4 legacy keys', () => {
  const task = makeConflictTask({
    id: 'x', agentValue: 'executor-backend', persona: null, filePath: 'src/components/X.tsx',
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.deepEqual(Object.keys(c).sort(), ['computedAgent', 'declaredAgent', 'files', 'taskId'].sort());
  assert.ok(!('persona' in c));
  assert.ok(!('reason' in c));
});

test('8b. legacy byte-identity: matching declared/computed agent (no persona) still yields zero conflicts', () => {
  const task = makeConflictTask({
    id: 'x', agentValue: 'executor-backend', persona: null, filePath: 'services/a.py',
  });
  const { conflicts } = _checkAgentConflicts([task]);
  assert.equal(conflicts.length, 0);
});

// ─── 9. _resolvePersona normalization ───────────────────────────────────────

test('9. _resolvePersona: accepts short form and full gsd-prefixed form for the same entry', () => {
  const short = _resolvePersona('persona-senior-backend');
  const full = _resolvePersona('gsd-persona-senior-backend');
  assert.ok(short);
  assert.ok(full);
  assert.equal(short.id, full.id);
});

test('9b. _resolvePersona: returns null for empty string and for a non-persona (executor) id', () => {
  assert.equal(_resolvePersona(''), null);
  assert.equal(_resolvePersona('executor-backend'), null);
});
