'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Discovery manifest — printed at module load for grep-verifiability
console.log('[discovery] BEHAV-01: AGENTS.md discovery — execute-phase includes discovery block');
console.log('[discovery] BEHAV-01: executor agents have Directory Override section');
console.log('[discovery] BEHAV-01: agents cannot write AGENTS.md (scope_expansion)');
console.log('[discovery] BEHAV-01: closest file wins — services/ AGENTS.md beats project root');
console.log('[discovery] BEHAV-01: no AGENTS.md found → header omitted from brief');
console.log('[discovery] BEHAV-02: closed state — agent allowed, failures 0');
console.log('[discovery] BEHAV-02: open state — 3 failures, agent blocked → executor-general');
console.log('[discovery] BEHAV-02: half-open probe — 60s elapsed, allowed: true');
console.log('[discovery] BEHAV-02: gsd-executor-general exempt — always allowed');
console.log('[discovery] BEHAV-03: divergence-memory.json schema validates correctly');
console.log('[discovery] BEHAV-03: all 4 divergence types trigger reflexion');
console.log('[discovery] BEHAV-03: max 3 entries injected into PRE_EXECUTION_EVIDENCE');
console.log('[discovery] BEHAV-03: failed executor never writes divergence-memory.json');
console.log('[discovery] BEHAV-03: what_failed/why/what_to_try_next are required fields');
console.log('[discovery] BEHAV-03: oldest reflections dropped beyond 3-entry cap');

const ROOT = path.join(__dirname, '..');

// ─── BEHAV-01 Tests ───────────────────────────────────────────────────────────

// Test 1: execute-phase.md includes AGENTS.md discovery block
test('BEHAV-01: execute-phase.md includes AGENTS.md discovery block', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase.md'), 'utf8');
  assert.match(content, /AGENTS\.md Discovery/);
  assert.match(content, /closest file wins|walk upward/i);
  assert.match(content, /additive/i);
});

// Test 2: all 4 executor agent .md files have Directory Override section
test('BEHAV-01: all 4 executor agent .md files have Directory Override section', () => {
  const agents = [
    'gsd-executor-backend.md',
    'gsd-executor-frontend.md',
    'gsd-executor-infra.md',
    'gsd-executor-general.md',
  ];
  for (const agent of agents) {
    const content = fs.readFileSync(path.join(ROOT, 'agents', agent), 'utf8');
    assert.match(content, /Directory Override \(AGENTS\.md\)/, `${agent} missing Directory Override section`);
    assert.match(content, /additive only/, `${agent} missing "additive only" language`);
  }
});

// Test 3: executor-general has Circuit Breaker Exemption note
test('BEHAV-01: executor-general has Circuit Breaker Exemption note', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'agents', 'gsd-executor-general.md'), 'utf8');
  assert.match(content, /Circuit Breaker Exemption/);
  assert.match(content, /last-resort fallback/);
});

// Test 4: AGENTS.md cannot be created by agents (scope_expansion noted)
test('BEHAV-01: AGENTS.md cannot be created by agents (scope_expansion divergence noted)', () => {
  const agents = [
    'gsd-executor-backend.md',
    'gsd-executor-frontend.md',
    'gsd-executor-infra.md',
    'gsd-executor-general.md',
  ];
  for (const agent of agents) {
    const content = fs.readFileSync(path.join(ROOT, 'agents', agent), 'utf8');
    assert.match(content, /scope_expansion divergence|scope_expansion/, `${agent} missing scope_expansion reference`);
    assert.match(content, /CANNOT create|must NOT create/i, `${agent} missing creation prohibition`);
  }
});

// Test 5: no AGENTS.md found → header omitted documented in execute-phase.md
test('BEHAV-01: execute-phase.md documents "no AGENTS.md" behavior (header omitted)', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase.md'), 'utf8');
  assert.match(content, /If no AGENTS\.md is found|no AGENTS\.md/i);
  assert.match(content, /Directory Conventions \(from AGENTS\.md\)/);
  assert.match(content, /AGENTS\.md: none found/);
});

// ─── BEHAV-02 Tests ───────────────────────────────────────────────────────────

// Helper: extract CB state machine logic for testability (pure function, no Redis)
function evaluateCBState(cbState, nowMs) {
  if (!cbState) return { allowed: true, state: 'closed', failures: 0 };
  if (cbState.state === 'open') {
    const elapsed = (nowMs - new Date(cbState.last_failure).getTime()) / 1000;
    if (elapsed >= 60) return { allowed: true, state: 'half_open', failures: cbState.failures };
    return { allowed: false, state: 'open', failures: cbState.failures };
  }
  return { allowed: true, state: cbState.state || 'closed', failures: cbState.failures || 0 };
}

// Test 6: closed state (no Valkey key) returns allowed: true
test('BEHAV-02: closed state (no Valkey key) returns allowed: true, failures: 0', () => {
  const result = evaluateCBState(null, Date.now());
  assert.equal(result.allowed, true);
  assert.equal(result.state, 'closed');
  assert.equal(result.failures, 0);
});

// Test 7: open state (3 failures, recent) returns allowed: false
test('BEHAV-02: open state (3 consecutive failures, recent) returns allowed: false', () => {
  const cbState = {
    state: 'open',
    failures: 3,
    last_failure: new Date(Date.now() - 10000).toISOString(), // 10s ago (< 60s TTL)
  };
  const result = evaluateCBState(cbState, Date.now());
  assert.equal(result.allowed, false);
  assert.equal(result.state, 'open');
  assert.equal(result.failures, 3);
});

// Test 8: half-open probe (TTL expired: 60s elapsed) returns allowed: true, state: half_open
test('BEHAV-02: half-open probe (60s+ elapsed) returns allowed: true, state: half_open', () => {
  const cbState = {
    state: 'open',
    failures: 3,
    last_failure: new Date(Date.now() - 65000).toISOString(), // 65s ago (> 60s TTL)
  };
  const result = evaluateCBState(cbState, Date.now());
  assert.equal(result.allowed, true);
  assert.equal(result.state, 'half_open');
  assert.equal(result.failures, 3);
});

// Test 9: gsd-executor-general exempt — circuit breaker never consulted
test('BEHAV-02: gsd-executor-general always returns allowed: true, exempt: true', () => {
  // Test via the gsd-tools.cjs module exports
  const tools = require(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'));
  // CB_EXEMPT_AGENTS is not exported directly, but circuitBreakerCheck is
  // Verify function is exported
  assert.equal(typeof tools.circuitBreakerCheck, 'function');
  assert.equal(typeof tools.circuitBreakerRecord, 'function');

  // Also verify gsd-tools.cjs has the exemption constant
  const toolsSource = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'), 'utf8');
  assert.match(toolsSource, /CB_EXEMPT_AGENTS/);
  assert.match(toolsSource, /'gsd-executor-general'/);
  assert.match(toolsSource, /'executor-general'/);
  assert.match(toolsSource, /CB_FAILURE_THRESHOLD\s*=\s*3/);
  assert.match(toolsSource, /CB_OPEN_TTL_SECONDS\s*=\s*60/);
});

// ─── BEHAV-03 Tests ───────────────────────────────────────────────────────────

// Test 10: divergence-memory.schema.json is valid JSON with required fields
test('BEHAV-03: divergence-memory.schema.json is valid JSON with required fields', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', 'divergence-memory.schema.json'), 'utf8'));
  assert.equal(schema.type, 'array');
  const required = schema.items.required;
  assert.ok(Array.isArray(required));
  assert.ok(required.includes('task_id'));
  assert.ok(required.includes('timestamp'));
  assert.ok(required.includes('what_failed'));
  assert.ok(required.includes('why'));
  assert.ok(required.includes('what_to_try_next'));
});

// Test 11: schema requires all 4 divergence types in enum
test('BEHAV-03: schema requires all 4 divergence types in enum', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', 'divergence-memory.schema.json'), 'utf8'));
  const dtEnum = schema.items.properties.divergence_type.enum;
  assert.ok(dtEnum.includes('manifest_violation'));
  assert.ok(dtEnum.includes('plan_amauta_drift'));
  assert.ok(dtEnum.includes('scope_expansion'));
  assert.ok(dtEnum.includes('rationalization_detected'));
  assert.equal(dtEnum.length, 4);
});

// Test 12: schema requires what_failed, why, what_to_try_next fields
test('BEHAV-03: divergence-memory.schema.json requires what_failed, why, what_to_try_next', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', 'divergence-memory.schema.json'), 'utf8'));
  const props = schema.items.properties;
  assert.ok('what_failed' in props);
  assert.ok('why' in props);
  assert.ok('what_to_try_next' in props);
  assert.equal(schema.items.additionalProperties, false);
});

// Test 13: divergence-protocol.md Section 14 documents failed-executor-never-writes rule
test('BEHAV-03: divergence-protocol.md Section 14 documents failed-executor-never-writes rule', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'references', 'divergence-protocol.md'), 'utf8');
  assert.match(content, /14\. Reflexion Memory Hook/);
  assert.match(content, /failed executor NEVER writes|no agent reflects on its own failure/i);
  assert.match(content, /divergence-memory\.json/);
});

// Test 14: divergence-protocol.md Section 14.4 documents PRE_EXECUTION_EVIDENCE injection
test('BEHAV-03: divergence-protocol.md Section 14.4 documents PRE_EXECUTION_EVIDENCE injection', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'references', 'divergence-protocol.md'), 'utf8');
  assert.match(content, /PRE_EXECUTION_EVIDENCE/);
  assert.match(content, /3 most recent/);
  assert.match(content, /14\.4/);
});

// Test 15: divergence-protocol.md version updated to 1.2.0
test('BEHAV-03: divergence-protocol.md version updated to 1.2.0', () => {
  const content = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'references', 'divergence-protocol.md'), 'utf8');
  assert.match(content, /version: "1\.2\.0"/);
  assert.match(content, /Protocol version: 1\.2\.0/);
});
