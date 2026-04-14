'use strict';
/**
 * Phase 38 -- Handoff Utility Unit Test Suite
 * File: tests/38-handoff-utility.unit.test.cjs
 *
 * Requirements covered:
 *   COMM-04: Structured handoff JSON with 800-token budget enforcement
 *
 * Tests the services/handoff.cjs module:
 *   - Schema completeness (all 10 required fields present)
 *   - Token budget enforcement (output <= 800 tokens)
 *   - Truncation behavior (10 findings → top-5 by confidence)
 *   - Confidence sorting (descending order)
 *   - Edge cases (0, 1, 5 findings)
 *   - handoff_type validation (valid types succeed, invalid throws)
 *
 * Pure module tests only — no child processes, no network.
 * Uses node:test + node:assert/strict (no external test framework).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const { createHandoff, estimateTokens } = require(path.join(ROOT, 'services', 'handoff.cjs'));
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');

// Load fixture
const FINDINGS_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, '38-blackboard-findings.json'), 'utf-8')
);

// Helper: make a minimal valid handoff options object
function validOptions(overrides = {}) {
  return {
    task_id: 'TK-TEST-001',
    from_agent: 'gsd-executor-backend',
    handoff_type: 'phase_complete',
    summary: 'Migration 014 created and committed.',
    key_findings: [{ text: 'Index idx_findings_task present.', confidence: 0.95 }],
    ...overrides,
  };
}

// ─── Group 1: Schema completeness ────────────────────────────────────────────

describe('[COMM-04] Schema completeness: all 10 required fields present', () => {
  const result = createHandoff(validOptions());
  const h = result.handoff;

  it('createHandoff returns object with "handoff" key', () => {
    assert.ok(result && typeof result === 'object', 'result must be an object');
    assert.ok(result.handoff && typeof result.handoff === 'object', '"handoff" key must be an object');
  });

  it('handoff has task_id field', () => {
    assert.ok('task_id' in h, 'Missing task_id field');
    assert.strictEqual(h.task_id, 'TK-TEST-001');
  });

  it('handoff has from_agent field', () => {
    assert.ok('from_agent' in h, 'Missing from_agent field');
    assert.strictEqual(h.from_agent, 'gsd-executor-backend');
  });

  it('handoff has handoff_type field', () => {
    assert.ok('handoff_type' in h, 'Missing handoff_type field');
    assert.strictEqual(h.handoff_type, 'phase_complete');
  });

  it('handoff has summary field', () => {
    assert.ok('summary' in h, 'Missing summary field');
    assert.ok(typeof h.summary === 'string', 'summary must be a string');
  });

  it('handoff has key_findings field (array)', () => {
    assert.ok('key_findings' in h, 'Missing key_findings field');
    assert.ok(Array.isArray(h.key_findings), 'key_findings must be an array');
  });

  it('handoff has decisions_made field (array)', () => {
    assert.ok('decisions_made' in h, 'Missing decisions_made field');
    assert.ok(Array.isArray(h.decisions_made), 'decisions_made must be an array');
  });

  it('handoff has open_questions field (array)', () => {
    assert.ok('open_questions' in h, 'Missing open_questions field');
    assert.ok(Array.isArray(h.open_questions), 'open_questions must be an array');
  });

  it('handoff has artifacts field (array)', () => {
    assert.ok('artifacts' in h, 'Missing artifacts field');
    assert.ok(Array.isArray(h.artifacts), 'artifacts must be an array');
  });

  it('handoff has confidence field (number 0.0-1.0)', () => {
    assert.ok('confidence' in h, 'Missing confidence field');
    assert.ok(typeof h.confidence === 'number', 'confidence must be a number');
    assert.ok(h.confidence >= 0.0 && h.confidence <= 1.0, 'confidence must be between 0.0 and 1.0');
  });

  it('handoff has full_context_ref field (string)', () => {
    assert.ok('full_context_ref' in h, 'Missing full_context_ref field');
    assert.ok(typeof h.full_context_ref === 'string', 'full_context_ref must be a string');
  });

  it('result has estimated_tokens field (number)', () => {
    assert.ok('estimated_tokens' in result, 'Missing estimated_tokens in result');
    assert.ok(typeof result.estimated_tokens === 'number', 'estimated_tokens must be a number');
    assert.ok(result.estimated_tokens > 0, 'estimated_tokens must be > 0');
  });

  it('result has truncated field (boolean)', () => {
    assert.ok('truncated' in result, 'Missing truncated in result');
    assert.ok(typeof result.truncated === 'boolean', 'truncated must be a boolean');
  });
});

// ─── Group 2: Token budget enforcement (800 tokens) ──────────────────────────

describe('[COMM-04] Token budget: output <= 800 estimated tokens after truncation', () => {
  it('minimal handoff stays well under 800 tokens', () => {
    const result = createHandoff(validOptions());
    // 800-token soft limit
    assert.ok(result.estimated_tokens <= 800, `estimated_tokens=${result.estimated_tokens} exceeds 800`);
    assert.strictEqual(result.truncated, false, 'minimal handoff should not be truncated');
  });

  it('handoff with very long summary truncates to 200 chars', () => {
    const longSummary = 'A'.repeat(500);
    const result = createHandoff(validOptions({ summary: longSummary }));
    assert.ok(result.handoff.summary.length <= 200, `summary.length=${result.handoff.summary.length} exceeds 200`);
  });

  it('estimated_tokens is always a positive integer', () => {
    const result = createHandoff(validOptions());
    assert.ok(Number.isInteger(result.estimated_tokens), 'estimated_tokens must be integer');
    assert.ok(result.estimated_tokens > 0, 'estimated_tokens must be > 0');
  });

  it('estimateTokens returns 0 for empty string', () => {
    const tokens = estimateTokens('');
    assert.strictEqual(tokens, 0);
  });

  it('estimateTokens scales with word count (5-word string has >= 5 tokens)', () => {
    const tokens = estimateTokens('one two three four five');
    assert.ok(tokens >= 5, `estimateTokens returned ${tokens} for 5-word string, expected >= 5`);
  });

  it('handoff with 10 long findings trims to <= 5 key_findings', () => {
    const manyFindings = Array.from({ length: 10 }, (_, i) => ({
      text: 'A'.repeat(100),
      confidence: (10 - i) * 0.05 + 0.5, // 1.0 down to 0.55
    }));
    const result = createHandoff(validOptions({ key_findings: manyFindings }));
    assert.ok(result.handoff.key_findings.length <= 5, `key_findings has ${result.handoff.key_findings.length} items, expected <= 5`);
  });
});

// ─── Group 3: Truncation behavior ────────────────────────────────────────────

describe('[COMM-04] Truncation: 10 findings → top-5 highest confidence kept', () => {
  const tenFindings = [
    { text: 'f-conf-0.3', confidence: 0.3 },
    { text: 'f-conf-0.7', confidence: 0.7 },
    { text: 'f-conf-0.1', confidence: 0.1 },
    { text: 'f-conf-0.9', confidence: 0.9 },
    { text: 'f-conf-0.5', confidence: 0.5 },
    { text: 'f-conf-0.8', confidence: 0.8 },
    { text: 'f-conf-0.2', confidence: 0.2 },
    { text: 'f-conf-0.6', confidence: 0.6 },
    { text: 'f-conf-0.4', confidence: 0.4 },
    { text: 'f-conf-1.0', confidence: 1.0 },
  ];
  const result = createHandoff(validOptions({ key_findings: tenFindings }));

  it('output has exactly 5 key_findings (truncated from 10)', () => {
    assert.strictEqual(result.handoff.key_findings.length, 5, `Expected 5 findings, got ${result.handoff.key_findings.length}`);
  });

  it('top-5 by confidence are kept: 1.0, 0.9, 0.8, 0.7, 0.6', () => {
    // Verify the top-5 confidence text values are present
    const kept = result.handoff.key_findings;
    assert.ok(kept.includes('f-conf-1.0'), 'Missing f-conf-1.0 (highest confidence)');
    assert.ok(kept.includes('f-conf-0.9'), 'Missing f-conf-0.9');
    assert.ok(kept.includes('f-conf-0.8'), 'Missing f-conf-0.8');
    assert.ok(kept.includes('f-conf-0.7'), 'Missing f-conf-0.7');
    assert.ok(kept.includes('f-conf-0.6'), 'Missing f-conf-0.6');
  });

  it('lowest 5 are dropped: 0.5, 0.4, 0.3, 0.2, 0.1', () => {
    const kept = result.handoff.key_findings;
    assert.ok(!kept.includes('f-conf-0.5'), 'f-conf-0.5 should have been dropped');
    assert.ok(!kept.includes('f-conf-0.1'), 'f-conf-0.1 (lowest) should have been dropped');
  });

  it('fixture findings: 5 items result in <= 5 output findings', () => {
    const fixtureFindings = FINDINGS_FIXTURE.map(f => ({ text: f.content, confidence: f.confidence }));
    const result2 = createHandoff(validOptions({ key_findings: fixtureFindings }));
    assert.ok(result2.handoff.key_findings.length <= 5, `Expected <= 5, got ${result2.handoff.key_findings.length}`);
  });
});

// ─── Group 4: Confidence sorting ─────────────────────────────────────────────

describe('[COMM-04] Confidence sorting: findings sorted descending by confidence', () => {
  it('3 findings sorted descending (no truncation)', () => {
    const findings = [
      { text: 'low', confidence: 0.3 },
      { text: 'high', confidence: 0.9 },
      { text: 'mid', confidence: 0.6 },
    ];
    const result = createHandoff(validOptions({ key_findings: findings }));
    // With 3 findings (< 5 limit), no truncation; but key_findings are plain text strings
    const output = result.handoff.key_findings;
    assert.strictEqual(output.length, 3, 'Expected 3 findings');
    // The first item should be 'high' (confidence 0.9)
    assert.strictEqual(output[0], 'high', `Expected first item 'high', got '${output[0]}'`);
    assert.strictEqual(output[1], 'mid', `Expected second item 'mid', got '${output[1]}'`);
    assert.strictEqual(output[2], 'low', `Expected third item 'low', got '${output[2]}'`);
  });

  it('fixture findings sorted by confidence descending', () => {
    const fixtureFindings = FINDINGS_FIXTURE.map(f => ({ text: f.content, confidence: f.confidence }));
    const result = createHandoff(validOptions({ key_findings: fixtureFindings }));
    // Fixture confidences: 0.9, 0.85, 0.7, 0.95, 0.6 → sorted: 0.95, 0.9, 0.85, 0.7, 0.6
    // The highest-confidence item is the blocker at 0.95
    assert.ok(result.handoff.key_findings.length <= 5, 'Fixture 5 findings should stay <= 5');
    // First finding should be the blocker (confidence 0.95)
    const blockerContent = FINDINGS_FIXTURE.find(f => f.confidence === 0.95).content.slice(0, 100);
    assert.strictEqual(result.handoff.key_findings[0], blockerContent, 'First finding should be highest-confidence (blocker at 0.95)');
  });
});

// ─── Group 5: Edge cases ─────────────────────────────────────────────────────

describe('[COMM-04] Edge cases: 0, 1, and 5 findings', () => {
  it('0 findings: key_findings is empty array, no truncation', () => {
    const result = createHandoff(validOptions({ key_findings: [] }));
    assert.deepStrictEqual(result.handoff.key_findings, [], 'key_findings should be []');
    assert.strictEqual(result.truncated, false, 'Should not be truncated with 0 findings');
  });

  it('1 finding: passes through without truncation', () => {
    const result = createHandoff(validOptions({ key_findings: [{ text: 'single finding', confidence: 0.8 }] }));
    assert.strictEqual(result.handoff.key_findings.length, 1, 'Expected 1 finding');
    assert.strictEqual(result.handoff.key_findings[0], 'single finding');
  });

  it('5 findings: all kept (exactly at max, no truncation needed)', () => {
    const fiveFindings = Array.from({ length: 5 }, (_, i) => ({
      text: `finding-${i}`,
      confidence: 0.5 + i * 0.1,
    }));
    const result = createHandoff(validOptions({ key_findings: fiveFindings }));
    assert.strictEqual(result.handoff.key_findings.length, 5, 'Expected all 5 findings kept');
  });

  it('string-only findings (not objects) normalize correctly', () => {
    const result = createHandoff(validOptions({ key_findings: ['plain text finding'] }));
    assert.strictEqual(result.handoff.key_findings.length, 1);
    assert.ok(typeof result.handoff.key_findings[0] === 'string', 'finding must be a string in output');
  });

  it('decisions_made capped at 3 items', () => {
    const result = createHandoff(validOptions({
      decisions_made: ['d1', 'd2', 'd3', 'd4', 'd5'],
    }));
    assert.ok(result.handoff.decisions_made.length <= 3, `decisions_made has ${result.handoff.decisions_made.length} items, expected <= 3`);
  });

  it('open_questions capped at 3 items', () => {
    const result = createHandoff(validOptions({
      open_questions: ['q1', 'q2', 'q3', 'q4'],
    }));
    assert.ok(result.handoff.open_questions.length <= 3, `open_questions has ${result.handoff.open_questions.length} items, expected <= 3`);
  });

  it('confidence clamped to 0.0-1.0 range', () => {
    const result1 = createHandoff(validOptions({ confidence: -0.5 }));
    assert.ok(result1.handoff.confidence >= 0.0, 'confidence below 0.0 should be clamped');

    const result2 = createHandoff(validOptions({ confidence: 1.5 }));
    assert.ok(result2.handoff.confidence <= 1.0, 'confidence above 1.0 should be clamped');
  });
});

// ─── Group 6: handoff_type validation ────────────────────────────────────────

describe('[COMM-04] handoff_type validation: valid types succeed, invalid throws', () => {
  it('phase_complete is a valid handoff_type', () => {
    assert.doesNotThrow(() => createHandoff(validOptions({ handoff_type: 'phase_complete' })));
  });

  it('subtask_complete is a valid handoff_type', () => {
    assert.doesNotThrow(() => createHandoff(validOptions({ handoff_type: 'subtask_complete' })));
  });

  it('escalation is a valid handoff_type', () => {
    assert.doesNotThrow(() => createHandoff(validOptions({ handoff_type: 'escalation' })));
  });

  it('invalid handoff_type throws an Error', () => {
    assert.throws(
      () => createHandoff(validOptions({ handoff_type: 'invalid_type' })),
      (err) => {
        assert.ok(err instanceof Error, 'Expected Error to be thrown');
        return true;
      }
    );
  });

  it('missing task_id throws an Error', () => {
    assert.throws(
      () => createHandoff({ from_agent: 'gsd-executor-backend', handoff_type: 'phase_complete' }),
      /task_id/
    );
  });

  it('missing from_agent throws an Error', () => {
    assert.throws(
      () => createHandoff({ task_id: 'TK-TEST-001', handoff_type: 'phase_complete' }),
      /from_agent/
    );
  });

  it('missing handoff_type throws an Error', () => {
    assert.throws(
      () => createHandoff({ task_id: 'TK-TEST-001', from_agent: 'gsd-executor-backend' }),
      /handoff_type/
    );
  });
});
