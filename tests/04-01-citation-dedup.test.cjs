#!/usr/bin/env node
/**
 * Plan 04-01: Citation Stripping + Dedup Window Audit Tests
 *
 * Tests:
 *   CIT-01: Citation stripping regex
 *     1. cleanAnswer line exists with /\[\d+\]/g regex
 *     2. Double-space collapse regex present (/\s{2,}/g -> ' ')
 *     3. Regex correctness: matches [1], [12], [999] but not [abc] or []
 *   CIT-02: cleanAnswer usage sites
 *     4. cappedAnswer uses cleanAnswer (not raw answer)
 *     5. stripPreamble uses cleanAnswer (not raw answer)
 *     6. Null check uses cleanAnswer
 *   CIT-03: Citations metadata preserved
 *     7. res.data.citations still captured in const citations
 *     8. citations passed to metadata in store call
 *   DUP-01: Dedup window constant
 *     9. ENRICHMENT_DEDUP_WINDOW = 300 in amauta.py
 *    10. TOK-03 AUDIT comment block exists in amauta.py
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESEARCH_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');

const researchContent = fs.readFileSync(RESEARCH_CJS, 'utf-8');
const amautaContent = fs.readFileSync(AMAUTA_PY, 'utf-8');

describe('CIT-01: Citation stripping regex', () => {
  it('1. cleanAnswer line exists with citation removal regex', () => {
    assert.ok(researchContent.includes("answer.replace(/\\[\\d+\\]/g, '')"),
      'Missing citation stripping regex /\\[\\d+\\]/g');
  });

  it('2. Double-space collapse regex is present', () => {
    assert.ok(researchContent.includes(".replace(/\\s{2,}/g, ' ')"),
      'Missing double-space collapse regex');
  });

  it('3. Regex correctness: matches [1], [12], [999] patterns', () => {
    const regex = /\[\d+\]/g;
    assert.ok(regex.test('[1]'), 'Should match [1]');
    regex.lastIndex = 0;
    assert.ok(regex.test('[12]'), 'Should match [12]');
    regex.lastIndex = 0;
    assert.ok(regex.test('[999]'), 'Should match [999]');
    regex.lastIndex = 0;
    assert.ok(!regex.test('[abc]'), 'Should NOT match [abc]');
    regex.lastIndex = 0;
    assert.ok(!regex.test('[]'), 'Should NOT match []');
  });
});

describe('CIT-02: cleanAnswer usage sites', () => {
  it('4. cappedAnswer uses cleanAnswer, not raw answer', () => {
    assert.ok(researchContent.includes('cleanAnswer.slice(0, 2000)'),
      'cappedAnswer should use cleanAnswer');
  });

  it('5. stripPreamble uses cleanAnswer, not raw answer', () => {
    assert.ok(researchContent.includes('stripPreamble(cleanAnswer)'),
      'stripPreamble should use cleanAnswer');
    assert.ok(!researchContent.includes('stripPreamble(answer)'),
      'stripPreamble should NOT use raw answer');
  });

  it('6. Null check uses cleanAnswer', () => {
    assert.ok(researchContent.includes('if (!cleanAnswer)'),
      'Null check should use cleanAnswer');
  });
});

describe('CIT-03: Citations metadata preserved', () => {
  it('7. res.data.citations captured in const citations', () => {
    assert.ok(researchContent.includes('const citations = res.data.citations'),
      'Citations metadata must still be captured');
  });

  it('8. citations passed to metadata in store call', () => {
    assert.ok(researchContent.includes('citations,') || researchContent.includes('citations:'),
      'Citations should be passed to store metadata');
  });
});

describe('DUP-01: Dedup window constant', () => {
  it('9. ENRICHMENT_DEDUP_WINDOW = 300 in amauta.py', () => {
    assert.ok(amautaContent.includes('ENRICHMENT_DEDUP_WINDOW = 300'),
      'Dedup window should be 300 seconds');
  });

  it('10. TOK-03 AUDIT comment exists in amauta.py', () => {
    assert.ok(amautaContent.includes('TOK-03 AUDIT'),
      'TOK-03 audit comment block should exist');
  });
});
