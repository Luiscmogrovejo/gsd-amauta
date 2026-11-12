'use strict';
/**
 * tests/89-03-sharded-step-capabilities.test.cjs
 *
 * Phase 89 plan 89-03. Three capabilities existed only in
 * `get-shit-done/workflows/execute-phase-legacy.md` while the six sharded
 * `execute-phase` steps carried none of them:
 *
 *   AGENTS.md discovery          (BEHAV-01, legacy :82-99)   — promised by 35 of 35 agent definitions
 *   circuit-breaker record/check (BEHAV-02, legacy :443-460) — promised by 2 agent definitions
 *   lint-after-edit, advisory    (BEHAV-04, legacy :492-510) — promised by none
 *
 * The legacy file is reachable only when `workflow.use_legacy_workflows` is true
 * (`execute-phase/workflow.md:30`, which HALTs the sharded path at `:37`), so on the
 * default path all three were unreachable.
 *
 * WHY THE SUITE STAYED GREEN. `tests/28-behavioral-upgrade.test.cjs` does assert
 * BEHAV-01/02/04 — but its `readExecPhase()` helper (`:41-54`) CONCATENATES the six
 * sharded steps with the legacy file and matches the blob, so every assertion was
 * satisfied by the legacy half alone. **This file reads the six step files and nothing
 * else.** That is the whole point: a capability must not be able to go missing from the
 * default path while a test that globs everything stays green.
 *
 * Four assertions:
 *   1. forward  — each anchor is in the step this plan placed it in
 *   2. backward — no agent definition promises a capability the sharded steps lack,
 *                 over a DECLARED token list that fails on an undeclared token
 *   3. verbs    — every gsd-tools verb named in a step exists as `case '<verb>':`
 *   4. legacy   — the three legacy anchors still exist, so a cleanup cannot delete the
 *                 evidence while this file stays green
 *
 * Run: node scripts/run-tests.cjs tests/89-03-sharded-step-capabilities.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STEPS_DIR = path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase', 'steps');
const AGENTS_DIR = path.join(ROOT, 'agents');
const LEGACY = path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase-legacy.md');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * The six sharded step files, by basename, with their text.
 *
 * @returns {Map<string, string>} basename -> file contents
 */
function stepFiles() {
  const out = new Map();
  for (const name of fs.readdirSync(STEPS_DIR).sort()) {
    if (name.endsWith('.md')) out.set(name, fs.readFileSync(path.join(STEPS_DIR, name), 'utf-8'));
  }
  return out;
}

/**
 * Every agent definition, by basename, with its text.
 *
 * @returns {Map<string, string>} basename -> file contents
 */
function agentFiles() {
  const out = new Map();
  for (const name of fs.readdirSync(AGENTS_DIR).sort()) {
    if (name.endsWith('.md')) out.set(name, fs.readFileSync(path.join(AGENTS_DIR, name), 'utf-8'));
  }
  return out;
}

/** @returns {Set<string>} every `case '<verb>':` name in gsd-tools.cjs */
function toolVerbs() {
  const src = fs.readFileSync(TOOLS, 'utf-8');
  return new Set([...src.matchAll(/case '([a-z0-9][a-z0-9-]*)':/g)].map((m) => m[1]));
}

/** @returns {string[]} the step basenames whose text contains `needle` */
function stepsContaining(needle) {
  return [...stepFiles()].filter(([, text]) => text.includes(needle)).map(([name]) => name);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. FORWARD — the three anchors, each in the step 89-03 placed it in.
//
// The expected step is named in every failure message on purpose: if a later
// refactor MOVES a capability between steps, this test must say so out loud
// rather than passing because the string still exists somewhere.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each restored capability: the step that must carry it, the anchor that proves the
 * section exists, and the semantics that prove the section is complete rather than a
 * heading. Every `semantics` entry was a measured `grep -c` in the 89-03 record.
 */
const RESTORED = [
  {
    capability: 'AGENTS.md discovery (BEHAV-01)',
    step: 'step-01-prepare.md',
    anchor: 'AGENTS.md Discovery (BEHAV-01)',
    legacyAnchor: 'AGENTS.md Discovery (BEHAV-01)',
    semantics: [
      'closest file wins',                        // the walk-up rule
      'additive',                                 // overrides per-directory conventions only
      '## Directory Conventions (from AGENTS.md)', // the exact brief header
      'omit this header entirely',                // the omit-when-absent rule
      'AGENTS.md: none found',                    // the report line, absent case
      'AGENTS.md: {path} applied',                // the report line, present case
      'scope_expansion',                          // the create/modify prohibition's divergence type
    ],
  },
  {
    capability: 'circuit-breaker record/check (BEHAV-02)',
    step: 'step-03-execute.md',
    anchor: 'Circuit Breaker Check (BEHAV-02)',
    legacyAnchor: 'Circuit Breaker Check (BEHAV-02)',
    semantics: [
      'circuit-breaker-record',   // after each task
      'circuit-breaker-check',    // before the next task
      'gsd-executor-general',     // the reroute target, which is exempt
      'continue and report',      // the unavailable-verb behaviour — never HALT
    ],
  },
  {
    capability: 'lint-after-edit (BEHAV-04, advisory)',
    step: 'step-03-execute.md',
    anchor: 'Lint-After-Edit (BEHAV-04',
    legacyAnchor: 'Lint-After-Edit (BEHAV-04',
    semantics: [
      'lint-after-edit',
      '{"linter":"none","exit_code":0,"findings":[],"fallback_used":false}', // the fallback result
      'does not block',       // advisory
      'continue and report',  // the unavailable-verb behaviour — never HALT
    ],
  },
];

describe('89-03 forward: the sharded steps carry the three capabilities', () => {
  test('the step glob finds exactly the six sharded steps', () => {
    const names = [...stepFiles().keys()];
    assert.deepEqual(
      names,
      [
        'step-01-prepare.md',
        'step-02-route.md',
        'step-03-execute.md',
        'step-04-verify.md',
        'step-05-validate.md',
        'step-06-close.md',
      ],
      'a glob that matches the wrong set would make every assertion below vacuous'
    );
  });

  for (const r of RESTORED) {
    test(`${r.capability} is anchored in ${r.step}`, () => {
      const steps = stepFiles();
      const text = steps.get(r.step);
      assert.ok(text, `${r.step} does not exist — the capability has nowhere to live`);
      const where = stepsContaining(r.anchor);
      assert.ok(
        text.includes(r.anchor),
        `${r.step} must contain the anchor ${JSON.stringify(r.anchor)} for ${r.capability}.\n` +
          `Found instead in: ${where.length ? where.join(', ') : '(no sharded step at all)'}.\n` +
          'If the capability was deliberately MOVED, update RESTORED[].step in this file so the ' +
          'new home is declared rather than discovered.'
      );
    });

    test(`${r.capability} carries all of its semantics, not just a heading`, () => {
      const text = stepFiles().get(r.step);
      const missing = r.semantics.filter((s) => !text.includes(s));
      assert.deepEqual(
        missing,
        [],
        `${r.step} has the ${r.capability} heading but is missing:\n` +
          missing.map((s) => `  - ${JSON.stringify(s)}`).join('\n')
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BACKWARD — the defect class. No agent definition may promise a workflow
//    capability the sharded steps lack.
//
//    This needs a DECLARED list, not a free grep: `circuit-breaker` appears in
//    three agent files and one of them means the resilience pattern in code under
//    audit, not the workflow verb. Every entry below is classified, with the reason,
//    seeded from the measurements in task 89-03-01. A token discovered in agents/
//    that is NOT declared here FAILS — that is what makes this a ratchet instead of
//    a snapshot of today's agent definitions.
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY_TOKENS = [
  {
    token: 'AGENTS.md',
    workflowPromise: true,
    step: 'step-01-prepare.md',
    // 35 of 35 agent definitions carry a "Directory Override (AGENTS.md)" section telling the
    // agent to obey conventions it cannot find for itself: the walk-up and the brief header are
    // the ORCHESTRATOR's job. An agent-side promise with no orchestrator-side discovery is the
    // exact gap 89-03 closed.
    why: 'all 35 agent definitions promise AGENTS.md behaviour the orchestrator must supply',
  },
  {
    token: 'circuit-breaker',
    workflowPromise: true,
    step: 'step-03-execute.md',
    // 3 hits, and they are NOT all the same thing — plan 89-03 said all three were the
    // resilience pattern; measured, 2 of 3 name the workflow reroute:
    //   gsd-auditor-api-connections.md:35     "circuit-breaker wrappers (e.g. services/
    //                                          a2a_client.py A2A Valkey breaker)"
    //                                          -> resilience pattern in AUDITED CODE, not a promise
    //   gsd-persona-systems-architect.md:291  "`gsd-executor-general` remains the
    //                                          circuit-breaker fallback"       -> THE WORKFLOW VERB
    //   gsd-persona-senior-backend.md:318     "...the circuit-breaker fallback if the base
    //                                          executor's circuit breaker opens" -> THE WORKFLOW VERB
    // One promise is enough to oblige the steps, so this token is a promise. Classifying it as
    // one is the STRICTER reading: it requires the capability instead of exempting the token.
    why: '2 of its 3 agent hits name the orchestrator reroute, not the audited-code pattern',
  },
  {
    token: 'lint-after-edit',
    workflowPromise: false,
    step: 'step-03-execute.md',
    // 0 hits in agents/. No agent definition has ever mentioned it, so there is nothing for the
    // backward direction to check. It is still asserted FORWARD (RESTORED above) because plan
    // 89-03 restores it, and it is declared here so a future agent that DOES name it is a
    // classified token rather than an undeclared-token failure.
    why: 'no agent definition names it; restored by 89-03 and asserted forward only',
  },
  {
    token: 'execute-phase',
    workflowPromise: false,
    step: null,
    // The workflow's own NAME, referenced by all 35 definitions as the `/amauta:execute-phase`
    // command. Naming a workflow is not promising a behaviour its steps must carry.
    why: 'the name of the workflow, not a capability of its steps',
  },
  {
    token: 'plan-phase',
    workflowPromise: false,
    step: null,
    // gsd-roadmapper.md names the sibling workflow it hands off to. A different workflow's
    // steps, not execute-phase's.
    why: "a sibling workflow's name (gsd-roadmapper), outside execute-phase",
  },
  {
    token: 'new-project',
    workflowPromise: false,
    step: null,
    why: "a sibling workflow's name (gsd-roadmapper), outside execute-phase",
  },
  {
    token: 'plan-to-tasks',
    workflowPromise: false,
    step: null,
    // gsd-validator.md names the task-store verb. Not an execute-phase step capability.
    why: 'a task-store verb named by gsd-validator, outside execute-phase',
  },
];

/**
 * Candidate workflow-capability tokens actually present in `agents/`.
 *
 * The universe is derived, not hand-written, so a new agent-side promise shows up as an
 * undeclared token: it is every HYPHENATED `gsd-tools` verb (hyphenated, because bare verbs
 * like `commit`, `template` and `validate` are ordinary English and would make the universe
 * noise), plus the declared non-verb tokens — `AGENTS.md`, which is a file and not a verb, and
 * `circuit-breaker`, the prefix the agent definitions actually use instead of the full
 * `circuit-breaker-check` / `circuit-breaker-record` verb names.
 *
 * @returns {Map<string, string[]>} token -> agent basenames naming it
 */
function candidateTokensInAgents() {
  const NON_VERB_TOKENS = ['AGENTS.md', 'circuit-breaker'];
  const hyphenatedVerbs = [...toolVerbs()].filter((v) => v.includes('-'));
  const universe = [...new Set([...NON_VERB_TOKENS, ...hyphenatedVerbs])];
  const found = new Map();
  for (const [name, text] of agentFiles()) {
    for (const token of universe) {
      if (!text.includes(token)) continue;
      if (!found.has(token)) found.set(token, []);
      found.get(token).push(name);
    }
  }
  return found;
}

describe('89-03 backward: no agent promise the sharded steps lack', () => {
  test('the agent roster is found (an empty roster would make this vacuous)', () => {
    assert.ok(agentFiles().size >= 30, `found only ${agentFiles().size} agent definitions`);
  });

  test('every capability token found in agents/ is declared and classified', () => {
    const declared = new Set(CAPABILITY_TOKENS.map((t) => t.token));
    const undeclared = [...candidateTokensInAgents()]
      .filter(([token]) => !declared.has(token))
      .map(([token, files]) => `${token} (in ${files.length} agent file(s): ${files.slice(0, 3).join(', ')})`);
    assert.deepEqual(
      undeclared,
      [],
      'Undeclared workflow-capability token(s) found in agents/. CLASSIFY each one by adding an ' +
        'entry to CAPABILITY_TOKENS in this file, with workflowPromise, step and a why comment ' +
        'stating whether an agent definition is promising a behaviour the sharded execute-phase ' +
        'steps must carry:\n' +
        undeclared.map((u) => `  - ${u}`).join('\n')
    );
  });

  test('every declared promise is actually carried by its sharded step', () => {
    const steps = stepFiles();
    const broken = [];
    for (const entry of CAPABILITY_TOKENS) {
      if (!entry.workflowPromise) continue;
      const promisedBy = candidateTokensInAgents().get(entry.token) || [];
      if (promisedBy.length === 0) continue; // declared ahead of use — nothing to check yet
      const text = steps.get(entry.step);
      if (!text || !text.includes(entry.token)) {
        broken.push(
          `${entry.token}: promised by ${promisedBy.length} agent definition(s) ` +
            `(e.g. ${promisedBy.slice(0, 2).join(', ')}) but absent from ${entry.step} ` +
            `— ${entry.why}`
        );
      }
    }
    assert.deepEqual(
      broken,
      [],
      'Agent definitions promise capabilities the sharded steps do not carry. Restore the ' +
        'capability into the step (NOT into agents/, which is canary-pinned):\n' +
        broken.map((b) => `  - ${b}`).join('\n')
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE VERBS EXIST. A step that names a verb `gsd-tools.cjs` does not ship is a
//    runtime failure in a markdown file, which nothing else in this repo catches.
//    Hyphenated only, because `gsd-tools.cjs runs once per task` in prose would
//    otherwise make "runs" a verb.
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Map<string, string[]>} verb -> step basenames invoking it */
function verbsNamedInSteps() {
  const re = /gsd-tools(?:\.cjs)?["'`]?[ \t]+([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g;
  const found = new Map();
  for (const [name, text] of stepFiles()) {
    for (const m of text.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], []);
      if (!found.get(m[1]).includes(name)) found.get(m[1]).push(name);
    }
  }
  return found;
}

describe('89-03 the gsd-tools verbs named in the steps exist', () => {
  test('the extraction finds the three restored verbs (and is therefore not vacuous)', () => {
    const named = verbsNamedInSteps();
    for (const verb of ['circuit-breaker-record', 'circuit-breaker-check', 'lint-after-edit']) {
      assert.ok(named.has(verb), `${verb} is not detected as invoked by any sharded step`);
    }
    assert.ok(named.size >= 10, `only ${named.size} verbs extracted — the regex stopped matching`);
  });

  test("every verb a step invokes has a matching case in gsd-tools.cjs", () => {
    const cases = toolVerbs();
    const missing = [...verbsNamedInSteps()]
      .filter(([verb]) => !cases.has(verb))
      .map(([verb, files]) => `${verb} (named in ${files.join(', ')})`);
    assert.deepEqual(
      missing,
      [],
      "Step file(s) invoke a gsd-tools verb that has no `case '<verb>':` in " +
        'get-shit-done/bin/gsd-tools.cjs. Either the verb name is a typo or the step is ahead ' +
        'of the implementation:\n' +
        missing.map((m) => `  - ${m}`).join('\n')
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE LEGACY FILE IS THE EVIDENCE. It is the source these three sections were
//    copied from. A later cleanup that deletes it, or deletes a section from it,
//    must fail here rather than quietly removing the only record of the original
//    semantics.
// ─────────────────────────────────────────────────────────────────────────────

describe('89-03 the legacy source of truth still carries all three sections', () => {
  test('execute-phase-legacy.md exists and keeps its three anchors', () => {
    assert.ok(fs.existsSync(LEGACY), 'execute-phase-legacy.md is the evidence; it must not be deleted');
    const text = fs.readFileSync(LEGACY, 'utf-8');
    const missing = RESTORED.filter((r) => !text.includes(r.legacyAnchor)).map((r) => r.legacyAnchor);
    assert.deepEqual(
      missing,
      [],
      'execute-phase-legacy.md lost the anchor(s) the sharded steps were restored from:\n' +
        missing.map((m) => `  - ${JSON.stringify(m)}`).join('\n')
    );
  });

  test('the legacy fallback is still opt-in, so the sharded steps are the default path', () => {
    const wf = fs.readFileSync(
      path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase', 'workflow.md'),
      'utf-8'
    );
    assert.match(wf, /workflow\.use_legacy_workflows/, 'the legacy switch must stay a config read');
    assert.match(wf, /HALT — do not proceed to step 3 when legacy mode is active\./,
      'legacy mode must still HALT the sharded path, which is what makes the steps the default');
  });
});
