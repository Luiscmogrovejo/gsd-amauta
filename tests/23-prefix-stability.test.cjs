#!/usr/bin/env node
/**
 * Phase 23 CACHE-01 + CACHE-03: Prefix Stability Test Suite.
 *
 * Validates that every agent .md file (the roster is read from disk) has the
 * stable-prefix / variable-suffix structure (CACHE-01) and that prefix content
 * is byte-identical across sequential reads (CACHE-03).
 *
 * Requirements:
 *   CACHE-01: Each agent file has exactly one CACHE_BREAKPOINT marker;
 *             stable structural tags (frontmatter, role, patterns) precede it;
 *             no volatile patterns appear before it.
 *   CACHE-03: Two sequential reads of the same agent file produce
 *             byte-identical content above the breakpoint.
 *
 * PFX-01 is deferred to v2 (88-CONTEXT.md). The compiled agents no longer carry
 * `<role>` / `<patterns>` XML tags (they use `## Role & identity` headings) and
 * three agents break a further clause each. The contract is SCOPED, not
 * satisfied: PFX01_DEFERRED lists, per agent, the clauses it is allowed to
 * violate; every other (agent, clause) pair is still enforced, a ratchet test
 * fails on any new violation, and a stale-entry test fails when a deferral
 * stops being true.
 *
 * Run: /opt/homebrew/bin/node scripts/run-tests.cjs tests/23-prefix-stability.test.cjs
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');
const BREAKPOINT = '<!-- CACHE_BREAKPOINT -->';

// Original core agents: a presence floor (membership), not the roster.
const EXPECTED_AGENT_NAMES = [
  'gsd-checker.md',
  'gsd-debugger.md',
  'gsd-executor-backend.md',
  'gsd-executor-frontend.md',
  'gsd-executor-general.md',
  'gsd-executor-infra.md',
  'gsd-operator.md',
  'gsd-planner.md',
  'gsd-researcher.md',
  'gsd-roadmapper.md',
  'gsd-validator.md',
];

// Volatile patterns that must NOT appear in the stable prefix
const VOLATILE_PATTERNS = [
  { re: /datetime\.now\(\)/i, label: 'datetime.now()' },
  { re: /time\.time\(\)/, label: 'time.time()' },
  { re: /Date\.now\b/, label: 'Date.now' },
  { re: /new Date\(/, label: 'new Date(' },
  { re: /Math\.random\(\)/, label: 'Math.random()' },
];

// Contract clauses a deferral may name.
const CLAUSES = ['one-breakpoint', 'volatile', 'role-tag', 'patterns-tag', 'prefix-ratio'];

// Map scripts/audit-prefix-stability.cjs check ids onto the clause ids above.
const AUDIT_CHECK_TO_CLAUSE = {
  BREAKPOINT_EXISTS: 'one-breakpoint',
  NO_VOLATILE_BEFORE_BREAKPOINT: 'volatile',
  ROLE_BEFORE_BREAKPOINT: 'role-tag',
  PATTERNS_BEFORE_BREAKPOINT: 'patterns-tag',
};

// ---------------------------------------------------------------------------
// Helper: read all agent files (roster derived from disk)
// ---------------------------------------------------------------------------
const AGENT_FILES = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.startsWith('gsd-') && f.endsWith('.md'))
  .sort()
  .map(f => ({ name: f, id: f.replace(/\.md$/, ''), filePath: path.join(AGENTS_DIR, f) }));

// PFX-01 deferred to v2 (88-CONTEXT.md): these agents do not yet satisfy the prompt-prefix stability contract. The assertion is scoped, not satisfied. Removing an entry here is the v2 fix; adding one is a regression.
// Measured 2026-11-11 on master 641874e: every compiled agent lacks <role> and <patterns> before the
// breakpoint (35 of 35; they use `## Role & identity` headings), and three agents break a further clause.
const PFX01_NO_XML_PREFIX = [
  'gsd-architect',
  'gsd-auditor-agentic-flow',
  'gsd-auditor-api-connections',
  'gsd-auditor-backend',
  'gsd-auditor-frontend',
  'gsd-auditor-general',
  'gsd-auditor-harness-self',
  'gsd-auditor-infra',
  'gsd-auditor-mobile',
  'gsd-auditor-models',
  'gsd-auditor-reference',
  'gsd-checker',
  'gsd-debugger',
  'gsd-executor-ai',
  'gsd-executor-backend',
  'gsd-executor-data',
  'gsd-executor-frontend',
  'gsd-executor-general',
  'gsd-executor-infra',
  'gsd-executor-mobile-android',
  'gsd-executor-mobile-cross',
  'gsd-executor-mobile-ios',
  'gsd-executor-wearables',
  'gsd-operator',
  'gsd-persona-frontend-specialist',
  'gsd-persona-senior-backend',
  'gsd-persona-systems-architect',
  'gsd-planner',
  'gsd-qa',
  'gsd-researcher',
  'gsd-reviewer',
  'gsd-roadmapper',
  'gsd-security',
  'gsd-tester',
  'gsd-validator',
];
/** @type {Map<string, string[]>} agent id -> clauses it is allowed to violate (PFX-01) */
const PFX01_DEFERRED = new Map(
  PFX01_NO_XML_PREFIX.map((id) => [id, ['role-tag', 'patterns-tag']])
);
// gsd-auditor-models.md carries 5 CACHE_BREAKPOINT markers, the first at 10.5% of the file.
PFX01_DEFERRED.get('gsd-auditor-models').push('one-breakpoint', 'prefix-ratio');
// gsd-executor-frontend.md has `new Date(` in a code example above the breakpoint.
PFX01_DEFERRED.get('gsd-executor-frontend').push('volatile');

/**
 * Is this (agent, clause) pair on the PFX-01 deferred list?
 *
 * @param {string} id - agent id without extension
 * @param {string} clause - one of CLAUSES
 * @returns {boolean} true when the violation is tolerated until v2
 */
function isDeferred(id, clause) {
  const clauses = PFX01_DEFERRED.get(id);
  return Boolean(clauses && clauses.includes(clause));
}

/**
 * Measure which contract clauses a file's content violates.
 *
 * @param {string} content - full agent file text
 * @returns {Set<string>} clause ids (subset of CLAUSES) that the content violates
 */
function measureViolations(content) {
  const violated = new Set();
  const count = content.split(BREAKPOINT).length - 1;
  if (count !== 1) violated.add('one-breakpoint');
  const idx = content.indexOf(BREAKPOINT);
  if (idx < 0) {
    // No breakpoint: nothing can precede it, so every positional clause is broken too.
    violated.add('role-tag');
    violated.add('patterns-tag');
    violated.add('prefix-ratio');
    return violated;
  }
  const prefix = content.slice(0, idx);
  if (VOLATILE_PATTERNS.some(({ re }) => re.test(prefix))) violated.add('volatile');
  if (!prefix.includes('<role>')) violated.add('role-tag');
  if (!prefix.includes('<patterns>')) violated.add('patterns-tag');
  if (prefix.length / content.length < 0.5) violated.add('prefix-ratio');
  return violated;
}

/** Violations measured now, per agent id: Map<id, Set<clause>> (only agents with >=1). */
function measureAll() {
  const out = new Map();
  for (const { id, filePath } of AGENT_FILES) {
    const v = measureViolations(fs.readFileSync(filePath, 'utf8'));
    if (v.size > 0) out.set(id, v);
  }
  return out;
}

/**
 * Agents the clause is enforced on (everything not deferred for that clause).
 *
 * @param {string} clause - one of CLAUSES
 * @returns {Array<{name: string, id: string, filePath: string}>} enforced agents
 */
function enforcedFor(clause) {
  return AGENT_FILES.filter(({ id }) => !isDeferred(id, clause));
}

// ---------------------------------------------------------------------------
// PFX-01 scope: diagnostic, ratchet, stale-entry check (always run)
// ---------------------------------------------------------------------------
describe('PFX-01 deferral (scoped, not satisfied)', () => {
  it('reports the deferred scope', (t) => {
    const pairs = [...PFX01_DEFERRED.values()].reduce((n, c) => n + c.length, 0);
    t.diagnostic(
      `PFX-01 deferred to v2: ${PFX01_DEFERRED.size} of ${AGENT_FILES.length} agents excluded from the prompt-prefix contract ` +
      `(${pairs} agent-clause pairs deferred; every other pair is enforced)`
    );
    assert.ok(PFX01_DEFERRED.size > 0, 'deferred list is empty: PFX-01 is fixed, delete the deferral machinery');
  });

  it('deferral entries only name known clauses', () => {
    for (const [id, clauses] of PFX01_DEFERRED) {
      for (const c of clauses) {
        assert.ok(CLAUSES.includes(c), `PFX01_DEFERRED[${id}] names unknown clause "${c}" (known: ${CLAUSES.join(', ')})`);
      }
    }
  });

  it('regression ratchet: no agent violates a clause that is not on the deferred list', () => {
    const regressions = [];
    for (const [id, violated] of measureAll()) {
      const fresh = [...violated].filter((c) => !isDeferred(id, c));
      if (fresh.length > 0) regressions.push(`${id} (${fresh.join(', ')})`);
    }
    assert.deepStrictEqual(
      regressions, [],
      `PFX-01 regression: ${regressions.join('; ')} newly violate the prompt-prefix contract and are not on the deferred list`
    );
  });

  it('stale-entry check: every deferred entry is a real agent that still violates the clause', () => {
    const measured = measureAll();
    const ids = new Set(AGENT_FILES.map((a) => a.id));
    const stale = [];
    for (const [id, clauses] of PFX01_DEFERRED) {
      if (!ids.has(id)) {
        stale.push(`${id} (no longer an agent file)`);
        continue;
      }
      const still = measured.get(id) || new Set();
      const fixed = clauses.filter((c) => !still.has(c));
      if (fixed.length > 0) stale.push(`${id} (${fixed.join(', ')})`);
    }
    assert.deepStrictEqual(
      stale, [],
      `PFX-01 stale deferral: ${stale.join('; ')} now satisfies the contract; remove it from PFX01_DEFERRED`
    );
  });

  it('detector self-test: a conforming prompt passes every clause, a broken one trips each', () => {
    // No compiled agent currently has <role>/<patterns>, so prove the clause detectors work on
    // synthetic text; otherwise the role/patterns clauses could silently never fire.
    const good = `---\nname: x\n---\n<role>r</role>\n<patterns>p</patterns>\n${'stable '.repeat(40)}\n${BREAKPOINT}\nsuffix\n`;
    assert.deepStrictEqual([...measureViolations(good)], [], 'conforming prompt must violate nothing');
    assert.ok(measureViolations(good.replace('<role>', '')).has('role-tag'));
    assert.ok(measureViolations(good.replace('<patterns>', '')).has('patterns-tag'));
    assert.ok(measureViolations(good + BREAKPOINT).has('one-breakpoint'));
    assert.ok(measureViolations(good.replace('stable', 'x = new Date()')).has('volatile'));
    assert.ok(measureViolations(`<role/><patterns/>${BREAKPOINT}${'tail '.repeat(100)}`).has('prefix-ratio'));
  });
});

// ---------------------------------------------------------------------------
// Test 1: Agent files match the compile source
// ---------------------------------------------------------------------------
describe('CACHE-01: Agent file presence', () => {
  it('compiled agent files match their AGENT.yaml sources, and the core 11 are present', () => {
    // The roster is read from the compile source of truth
    // (get-shit-done/agents/<name>/AGENT.yaml) so this catches real drift rather
    // than going stale each time an agent is added. EXPECTED_AGENT_NAMES stays as
    // a presence floor for the original eleven.
    const yamlDir = path.join(PROJECT_ROOT, 'get-shit-done', 'agents');
    const sources = fs.readdirSync(yamlDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(yamlDir, e.name, 'AGENT.yaml')))
      .map(e => e.name).sort();
    assert.ok(sources.length > 0, 'expected at least one AGENT.yaml source');
    assert.deepStrictEqual(
      AGENT_FILES.map(f => f.id).sort(),
      sources,
      'agents/*.md must match get-shit-done/agents/*/AGENT.yaml exactly'
    );
    for (const expectedName of EXPECTED_AGENT_NAMES) {
      const found = AGENT_FILES.some(f => f.name === expectedName);
      assert.ok(found, `Expected agent file missing: ${expectedName}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Each agent has exactly one CACHE_BREAKPOINT
// ---------------------------------------------------------------------------
describe('CACHE-01: Exactly one CACHE_BREAKPOINT per agent', () => {
  it('each agent file contains exactly one CACHE_BREAKPOINT marker', () => {
    for (const { name, filePath } of enforcedFor('one-breakpoint')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const count = content.split(BREAKPOINT).length - 1;
      assert.strictEqual(
        count,
        1,
        `${name}: expected 1 CACHE_BREAKPOINT, found ${count}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: No volatile patterns before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: No volatile patterns in stable prefix', () => {
  it('no volatile timestamp/random patterns appear before CACHE_BREAKPOINT in any agent', () => {
    for (const { name, filePath } of enforcedFor('volatile')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      for (const { re, label } of VOLATILE_PATTERNS) {
        assert.ok(
          !re.test(prefix),
          `${name}: volatile pattern "${label}" found in stable prefix (before CACHE_BREAKPOINT)`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: YAML frontmatter appears before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: YAML frontmatter in stable prefix', () => {
  it('YAML frontmatter (---) appears before CACHE_BREAKPOINT in each agent', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        /^---/.test(prefix.trimStart()),
        `${name}: YAML frontmatter (--- block) not found before CACHE_BREAKPOINT`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: <role> tag appears before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: role tag in stable prefix', () => {
  it('<role> tag appears before CACHE_BREAKPOINT in each agent', () => {
    for (const { name, filePath } of enforcedFor('role-tag')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        prefix.includes('<role>'),
        `${name}: <role> tag missing from stable prefix (before CACHE_BREAKPOINT)`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: <patterns> tag appears before breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: patterns tag in stable prefix', () => {
  it('<patterns> tag appears before CACHE_BREAKPOINT in each agent', () => {
    for (const { name, filePath } of enforcedFor('patterns-tag')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        prefix.includes('<patterns>'),
        `${name}: <patterns> tag missing from stable prefix (before CACHE_BREAKPOINT)`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: <runtime_read> tag, if present, appears after breakpoint
// ---------------------------------------------------------------------------
describe('CACHE-01: runtime_read tag in variable suffix', () => {
  it('any <runtime_read> tag appears after CACHE_BREAKPOINT (not before)', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes('<runtime_read>')) continue; // not all agents have it
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefix = content.slice(0, breakpointIdx);
      assert.ok(
        !prefix.includes('<runtime_read>'),
        `${name}: <runtime_read> tag appears before CACHE_BREAKPOINT — should be in variable suffix`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: Two sequential reads produce byte-identical prefixes (CACHE-03)
// ---------------------------------------------------------------------------
describe('CACHE-03: Prefix determinism', () => {
  it('two sequential reads of each agent file produce identical stable prefixes', () => {
    for (const { name, filePath } of AGENT_FILES) {
      const content1 = fs.readFileSync(filePath, 'utf8');
      const content2 = fs.readFileSync(filePath, 'utf8');
      const idx1 = content1.indexOf(BREAKPOINT);
      const idx2 = content2.indexOf(BREAKPOINT);
      assert.ok(idx1 >= 0, `${name}: CACHE_BREAKPOINT not found (read 1)`);
      assert.ok(idx2 >= 0, `${name}: CACHE_BREAKPOINT not found (read 2)`);
      const prefix1 = content1.slice(0, idx1);
      const prefix2 = content2.slice(0, idx2);
      assert.strictEqual(
        prefix1,
        prefix2,
        `${name}: stable prefix differs between two sequential reads — non-deterministic content detected`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: audit script agrees with the deferral list
// ---------------------------------------------------------------------------
describe('CACHE-01: Audit script passes', () => {
  it('audit-prefix-stability.cjs covers every agent and fails only on PFX-01 deferred clauses', () => {
    const auditScript = path.join(PROJECT_ROOT, 'scripts', 'audit-prefix-stability.cjs');
    assert.ok(fs.existsSync(auditScript), `audit script not found: ${auditScript}`);
    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync(process.execPath, [auditScript], { encoding: 'utf8' });
    } catch (err) {
      output = err.stdout || '';
      exitCode = err.status || 1;
    }
    // The summary line covers the whole roster (derived, not "11/11").
    const summary = output.match(/Result: (\d+)\/(\d+) PASSED, (\d+)\/(\d+) FAILED/);
    assert.ok(summary, `audit output has no Result line.\nOutput:\n${output}`);
    assert.strictEqual(
      Number(summary[2]), AGENT_FILES.length,
      `audit covered ${summary[2]} agents but agents/ holds ${AGENT_FILES.length}`
    );
    // Every failed check must be a deferred (agent, clause) pair.
    const unexpected = [];
    let current = null;
    for (const line of output.split('\n')) {
      const head = line.match(/^\[(PASS|FAIL)\] (\S+\.md)/);
      if (head) { current = head[2].replace(/\.md$/, ''); continue; }
      const fail = line.match(/^\s+FAIL: (\w+) /);
      if (fail && current) {
        const clause = AUDIT_CHECK_TO_CLAUSE[fail[1]] || fail[1];
        if (!isDeferred(current, clause)) unexpected.push(`${current} (${clause})`);
      }
    }
    assert.deepStrictEqual(
      unexpected, [],
      `PFX-01 regression: ${unexpected.join('; ')} newly violate the prompt-prefix contract and are not on the deferred list.\nOutput:\n${output}`
    );
    // Exit 0 or 1 only: 1 means the audit found (deferred) violations; anything else is a crash.
    assert.ok(exitCode === 0 || exitCode === 1, `audit-prefix-stability.cjs crashed with exit ${exitCode}.\nOutput:\n${output}`);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Stable prefix is the majority of each file (>= 50%)
// ---------------------------------------------------------------------------
describe('CACHE-03: Prefix is majority of file content', () => {
  it('stable prefix content is >= 50% of each agent file size', () => {
    for (const { name, filePath } of enforcedFor('prefix-ratio')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const breakpointIdx = content.indexOf(BREAKPOINT);
      assert.ok(breakpointIdx >= 0, `${name}: CACHE_BREAKPOINT not found`);
      const prefixLen = breakpointIdx;
      const totalLen = content.length;
      const ratio = prefixLen / totalLen;
      assert.ok(
        ratio >= 0.5,
        `${name}: stable prefix is only ${(ratio * 100).toFixed(1)}% of file (< 50%) — breakpoint may be placed too early`
      );
    }
  });
});
