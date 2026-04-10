#!/usr/bin/env node
/**
 * Plan 11-02-03: E-Phase Evidence Advisory unit tests.
 *
 * Tests the `_checkEvidenceBlock(eContent, taskType)` pure logic function
 * exported from gsd-amauta.cjs. No daemon access required.
 *
 * Categories:
 *   (1) Block detection (4 tests)
 *   (2) Skip markers (3 tests)
 *   (3) Kill switch via GSD_E_MANDATE env var (2 tests)
 *   (4) Non-code task skip (2 tests)
 *   (5) Subfield detection (2 tests)
 *   (6) Cargo-cult detection (3 tests)
 *   (7) Backward compat / graceful degradation (2 tests)
 *
 * Run: node --test tests/11-evidence-advisory.test.cjs
 *      npm test tests/11-evidence-advisory.test.cjs
 */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AMAUTA_CJS = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');

// Load the test-only exports. _checkEvidenceBlock is a pure function — no daemon needed.
let _checkEvidenceBlock;
try {
  const mod = require(AMAUTA_CJS);
  _checkEvidenceBlock = mod._checkEvidenceBlock;
} catch (e) {
  // If module fails to load, tests will fail with a clear message
  _checkEvidenceBlock = null;
}

// Helper: build a complete E-phase content string with evidence block
function makeCompleteEContent() {
  return `E: Implemented feature.
PRE_EXECUTION_EVIDENCE:
  failure_patterns: checked -- no existing pattern for this path, safe to add new route
  best_practices: applied -- followed Express middleware pattern from routes/index.cjs
  existing_style: applied -- used same JSDoc style as surrounding functions
  security_checklist:
    input_validation: applied -- validates task_id matches /^TK-\\d{4}$/ before DB query
    sql_injection: applied -- uses parameterized pg queries throughout
    xss: n/a -- no HTML output from this endpoint
    path_traversal: n/a -- no file system operations
    auth_check: applied -- Bearer token checked by middleware before handler runs
    secret_leak: applied -- no secrets in logs or responses
    rate_limiting: deferred -- rate limiting handled at nginx layer
    error_info_leak: applied -- error messages reference code, not stack trace`;
}

// Helper: build E-phase content with evidence block but missing some subfields
function makeMissingSubfieldsContent() {
  return `E: Implemented docs update.
PRE_EXECUTION_EVIDENCE:
  failure_patterns: checked -- no code changes, docs only
  best_practices: applied -- followed existing markdown style`;
  // missing: existing_style, security_checklist
}

// Helper: skip marker content
function makeSkipContent(reason) {
  return `E: Updated README only.\nPRE_EXECUTION_EVIDENCE: skipped -- ${reason}`;
}

// ─── Guard: skip all tests if module failed to load ───────────────────────────

describe('Module load', () => {
  it('gsd-amauta.cjs exports _checkEvidenceBlock', () => {
    assert.ok(
      typeof _checkEvidenceBlock === 'function',
      `Expected _checkEvidenceBlock to be a function — got ${typeof _checkEvidenceBlock}. ` +
      'Ensure gsd-amauta.cjs exports { _checkEvidenceBlock } when require.main !== module.'
    );
  });
});

// ─── (1) Block detection ─────────────────────────────────────────────────────

describe('Block detection', () => {
  it('1. fires advisory when E-phase is empty', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock('', 'task');
    assert.strictEqual(result.advisory, true);
    assert.match(result.reason, /empty/i);
  });

  it('2. fires advisory when PRE_EXECUTION_EVIDENCE block is absent', () => {
    if (!_checkEvidenceBlock) return;
    const eContent = 'E: Built the feature. Tests pass. No evidence block here.';
    const result = _checkEvidenceBlock(eContent, 'task');
    assert.strictEqual(result.advisory, true);
    assert.match(result.reason, /missing/i);
  });

  it('3. does NOT fire when PRE_EXECUTION_EVIDENCE block is present at top of E-phase', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock(makeCompleteEContent(), 'task');
    assert.strictEqual(result.advisory, false);
    assert.match(result.reason, /present and complete/i);
  });

  it('4. does NOT fire when PRE_EXECUTION_EVIDENCE block appears after other content', () => {
    // Block position is guidance, not enforcement in v2.6
    if (!_checkEvidenceBlock) return;
    const eContent = `E: Built the feature.\n\nSome notes about the work.\n\n${makeCompleteEContent()}`;
    const result = _checkEvidenceBlock(eContent, 'task');
    assert.strictEqual(result.advisory, false);
  });
});

// ─── (2) Skip markers ────────────────────────────────────────────────────────

describe('Skip markers', () => {
  it('5. accepts non-code task skip marker (no advisory)', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock(makeSkipContent('non-code task'), 'task');
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'intentional skip');
  });

  it('6. accepts mandate-disabled skip marker (no advisory)', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock(
      makeSkipContent('mandate disabled (GSD_E_MANDATE=off)'),
      'task'
    );
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'intentional skip');
  });

  it('7. fires advisory on bare skip without reason (no -- separator)', () => {
    // "PRE_EXECUTION_EVIDENCE: skipped" without "-- reason" does NOT match skip pattern
    if (!_checkEvidenceBlock) return;
    const eContent = 'E: Did work.\nPRE_EXECUTION_EVIDENCE: skipped';
    const result = _checkEvidenceBlock(eContent, 'task');
    // Block IS present, skip pattern does NOT match (no --), so falls through to subfield check
    // Missing subfields -> advisory: true, partial: true
    assert.strictEqual(result.advisory, true);
    assert.strictEqual(result.partial, true);
  });
});

// ─── (3) Kill switch (GSD_E_MANDATE env var) ─────────────────────────────────
// _checkEvidenceBlock is the pure logic function — it does NOT read env vars.
// Kill switch is checked in checkEvidenceAdvisory() (the async wrapper).
// We verify the kill switch wiring by reading the source code.

describe('Kill switch wiring', () => {
  it('8. gsd-amauta.cjs source contains GSD_E_MANDATE env var check', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(AMAUTA_CJS, 'utf-8');
    assert.ok(
      src.includes('GSD_E_MANDATE'),
      'Missing GSD_E_MANDATE kill switch check in gsd-amauta.cjs'
    );
  });

  it("9. kill switch 'off' returns advisory:false in source (mandate disabled path)", () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(AMAUTA_CJS, 'utf-8');
    assert.ok(
      src.includes("'off'") || src.includes('"off"'),
      "Missing 'off' literal in GSD_E_MANDATE kill switch check"
    );
    assert.ok(
      src.includes('mandate disabled'),
      "Missing 'mandate disabled' reason string in kill switch return"
    );
  });
});

// ─── (4) Non-code task skip ───────────────────────────────────────────────────

describe('Non-code task skip', () => {
  it('10. skips advisory for epic task type (no E-phase enforcement)', () => {
    if (!_checkEvidenceBlock) return;
    // Epic is in NON_CODE_TYPES — advisory should never fire regardless of content
    const result = _checkEvidenceBlock('', 'epic');
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'non-code task');
  });

  it('11. skips advisory for research task type', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock('No evidence block needed for research', 'research');
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'non-code task');
  });
});

// ─── (5) Subfield detection ───────────────────────────────────────────────────

describe('Subfield detection', () => {
  it('12. warns on missing subfields (partial block)', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock(makeMissingSubfieldsContent(), 'task');
    assert.strictEqual(result.advisory, true);
    assert.strictEqual(result.partial, true);
    assert.match(result.reason, /missing subfields/i);
    // Should mention the two missing ones
    assert.match(result.reason, /existing_style/);
    assert.match(result.reason, /security_checklist/);
  });

  it('13. passes with all 4 subfields present (no advisory)', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock(makeCompleteEContent(), 'task');
    assert.strictEqual(result.advisory, false);
    assert.strictEqual(result.reason, 'evidence block present and complete');
  });
});

// ─── (6) Cargo-cult detection ─────────────────────────────────────────────────

describe('Cargo-cult detection', () => {
  it('14. warns on bare "applied" without explanation note', () => {
    if (!_checkEvidenceBlock) return;
    const eContent = `E: Built feature.
PRE_EXECUTION_EVIDENCE:
  failure_patterns: checked -- no existing pattern
  best_practices: applied -- followed Express pattern
  existing_style: applied -- same JSDoc style
  security_checklist:
    input_validation: applied
    sql_injection: applied -- uses parameterized queries
    xss: n/a -- no HTML output
    path_traversal: n/a -- no file system ops
    auth_check: applied -- middleware
    secret_leak: applied -- no secrets
    rate_limiting: deferred -- nginx handles it
    error_info_leak: applied -- codes not traces`;
    const result = _checkEvidenceBlock(eContent, 'task');
    assert.strictEqual(result.advisory, true);
    assert.match(result.reason, /cargo-cult/i);
    assert.match(result.reason, /applied/i);
  });

  it('15. passes when applied item has explanation (no cargo-cult warning)', () => {
    if (!_checkEvidenceBlock) return;
    const result = _checkEvidenceBlock(makeCompleteEContent(), 'task');
    assert.strictEqual(result.advisory, false);
    // Confirm no cargo-cult in reason
    assert.ok(
      !result.reason.includes('cargo-cult'),
      `Expected no cargo-cult warning but got: ${result.reason}`
    );
  });

  it('16. warns on single-word "done", "checked", "yes", or "ok" responses', () => {
    if (!_checkEvidenceBlock) return;
    const eContent = `E: Fixed bug.
PRE_EXECUTION_EVIDENCE:
  failure_patterns: checked -- reviewed existing patterns
  best_practices: applied -- followed conventions
  existing_style: applied -- matched surrounding code
  security_checklist:
    input_validation: done
    sql_injection: applied -- parameterized queries
    xss: ok
    path_traversal: n/a -- no file I/O
    auth_check: checked
    secret_leak: applied -- audited
    rate_limiting: deferred -- nginx
    error_info_leak: yes`;
    const result = _checkEvidenceBlock(eContent, 'task');
    assert.strictEqual(result.advisory, true);
    assert.match(result.reason, /cargo-cult/i);
  });
});

// ─── (7) Backward compat / graceful degradation ────────────────────────────────

describe('Backward compatibility', () => {
  it('17. advisory result is independent -- does not affect other gate failures', () => {
    // _checkEvidenceBlock is a pure function — it returns its own result object.
    // It cannot affect checkValidationGates() return value (they are separate functions).
    if (!_checkEvidenceBlock) return;
    // Verify the function returns a standalone object with only advisory/reason/partial keys
    const result = _checkEvidenceBlock('', 'task');
    assert.ok('advisory' in result, 'result must have advisory key');
    assert.ok('reason' in result, 'result must have reason key');
    // Should NOT contain gate-specific keys that would interfere with gate checking
    assert.ok(!('gateNumber' in result), 'advisory result should not have gateNumber');
    assert.ok(!('gates' in result), 'advisory result should not have gates array');
  });

  it('18. handles null/undefined E-phase content gracefully (no throw)', () => {
    if (!_checkEvidenceBlock) return;
    // null content — should treat as empty
    const r1 = _checkEvidenceBlock(null, 'task');
    assert.strictEqual(r1.advisory, true);
    assert.match(r1.reason, /empty/i);

    // undefined content
    const r2 = _checkEvidenceBlock(undefined, 'task');
    assert.strictEqual(r2.advisory, true);
    assert.match(r2.reason, /empty/i);
  });
});

// ─── (8) Source-level verification (checkEvidenceAdvisory wiring) ─────────────

describe('Source wiring verification', () => {
  it('19. cmdValidate contains [ADVISORY] PRE_EXECUTION_EVIDENCE output line', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(AMAUTA_CJS, 'utf-8');
    assert.ok(
      src.includes('[ADVISORY] PRE_EXECUTION_EVIDENCE'),
      'Missing [ADVISORY] PRE_EXECUTION_EVIDENCE log in cmdValidate'
    );
  });

  it('20. advisory call in cmdValidate is wrapped in try/catch (never blocks validation)', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(AMAUTA_CJS, 'utf-8');
    // Find the advisory block and verify it is inside a try/catch
    const advisoryIdx = src.indexOf('[ADVISORY] PRE_EXECUTION_EVIDENCE');
    assert.ok(advisoryIdx >= 0, 'Missing [ADVISORY] string in source');
    // Look backwards for 'try {' within 300 chars
    const before = src.substring(Math.max(0, advisoryIdx - 300), advisoryIdx);
    assert.ok(
      before.includes('try {'),
      'Advisory block must be inside a try/catch to never block validation'
    );
  });

  it('21. module exports _checkEvidenceBlock for test access', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(AMAUTA_CJS, 'utf-8');
    assert.ok(
      src.includes('_checkEvidenceBlock'),
      'Missing _checkEvidenceBlock export in gsd-amauta.cjs'
    );
    assert.ok(
      src.includes('module.exports'),
      'Missing module.exports in gsd-amauta.cjs test export block'
    );
  });
});
