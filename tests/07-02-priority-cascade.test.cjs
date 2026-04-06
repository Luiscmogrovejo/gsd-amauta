#!/usr/bin/env node
/**
 * Plan 07-02: Priority Scoring + Research Chain Cascade Guard Tests
 *
 * Tests:
 *   SCORE-01: Priority scoring formula
 *     1. dep_pressure cache uses content hash (no id(all_items))
 *     2. Sort key includes created_at for tie-breaking
 *     3. _score clamps importance to [1,5]
 *     4. _score clamps urgency to [1,5]
 *     5. dep_pressure capped at 5
 *     6. Critical priority boosts importance
 *     7. Due date overdue sets urgency to 5
 *   CASCADE-01: Research chain cascade
 *     8. RESEARCH_MIN_RESULTS constant defined
 *     9. Cascade uses >= RESEARCH_MIN_RESULTS (not > 0)
 *    10. Perplexity is always terminal (special case in stop condition)
 *    11. Context7 is additive (never stops cascade)
 *   GUARD-01: Research chain guards
 *    12. _search_q guards research chain invocation
 *    13. _search_q filters words > 2 chars
 *    14. Stopword list includes common action verbs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
const RESEARCH = fs.readFileSync(path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs'), 'utf-8');

describe('SCORE-01: Priority scoring formula', () => {
  it('1. dep_pressure cache uses content hash (no id(all_items))', () => {
    assert.ok(!AMAUTA.includes('id(all_items)'), 'dep_pressure cache should not use id(all_items)');
    assert.ok(AMAUTA.includes('hash(tuple('), 'dep_pressure cache should use hash(tuple(...))');
  });

  it('2. Sort key includes created_at for tie-breaking', () => {
    // cmd_next sort should reference created_at -- search a 4000-char window to be safe
    const nextFnStart = AMAUTA.indexOf('def cmd_next(');
    assert.ok(nextFnStart > -1, 'cmd_next function not found');
    const nextBlock = AMAUTA.slice(nextFnStart, nextFnStart + 4000);
    assert.ok(nextBlock.includes('created_at'), 'cmd_next sort should tie-break by created_at');
  });

  it('3. _score clamps importance to [1,5]', () => {
    assert.ok(AMAUTA.includes('max(1, min(5,'), '_score must clamp importance to [1,5]');
  });

  it('4. _score clamps urgency to [1,5]', () => {
    // There should be TWO clamp patterns (one for imp, one for urg)
    const clampMatches = AMAUTA.match(/max\(1,\s*min\(5,/g);
    assert.ok(clampMatches && clampMatches.length >= 2, 'Expected at least 2 clamping patterns (imp + urg)');
  });

  it('5. dep_pressure capped at 5', () => {
    assert.ok(AMAUTA.includes('min(5, _dep_pressure_cache'), 'dep_pressure should be capped at 5');
  });

  it('6. Critical priority boosts importance', () => {
    assert.ok(AMAUTA.includes('"critical"'), '_score should boost critical priority');
    assert.ok(AMAUTA.includes('imp + 1'), '_score should add 1 to importance for critical');
  });

  it('7. Due date overdue sets urgency to 5', () => {
    assert.ok(AMAUTA.includes('urg = 5'), 'Overdue tasks should have urgency 5');
  });
});

describe('CASCADE-01: Research chain cascade', () => {
  it('8. RESEARCH_MIN_RESULTS constant defined', () => {
    assert.ok(RESEARCH.includes('RESEARCH_MIN_RESULTS'), 'RESEARCH_MIN_RESULTS not defined');
    assert.ok(RESEARCH.includes('GSD_RESEARCH_MIN_RESULTS'), 'GSD_RESEARCH_MIN_RESULTS env var not referenced');
  });

  it('9. Cascade uses >= RESEARCH_MIN_RESULTS (not > 0)', () => {
    assert.ok(RESEARCH.includes('result.count >= RESEARCH_MIN_RESULTS'), 'Cascade should use >= RESEARCH_MIN_RESULTS');
    // Verify old pattern is gone
    assert.ok(!RESEARCH.includes('result.count > 0'), 'Old cascade stop condition (count > 0) should be removed');
  });

  it('10. Perplexity is always terminal (special case)', () => {
    // The cascade stop condition should have a perplexity special case
    assert.ok(RESEARCH.includes("name === 'perplexity'"), 'Perplexity should be terminal in cascade');
  });

  it('11. Context7 is additive (never stops cascade)', () => {
    assert.ok(RESEARCH.includes('ADDITIVE_PROVIDERS'), 'ADDITIVE_PROVIDERS should exist');
    assert.ok(RESEARCH.includes("'context7'"), 'context7 should be in ADDITIVE_PROVIDERS');
  });
});

describe('GUARD-01: Research chain guards', () => {
  it('12. _search_q guards research chain invocation', () => {
    assert.ok(AMAUTA.includes('_search_q and mem_result_count'), '_search_q should guard research chain');
  });

  it('13. _search_q filters words > 2 chars', () => {
    assert.ok(AMAUTA.includes('len(w) > 2'), '_search_q should filter short words');
  });

  it('14. Stopword list includes common action verbs', () => {
    // Verify key stopwords that would make titles like "Add code" produce empty _search_q
    const stopMatch = AMAUTA.match(/_stop\s*=\s*\{[^}]+\}/s);
    assert.ok(stopMatch, '_stop set not found');
    for (const word of ['build', 'add', 'create', 'fix', 'update']) {
      assert.ok(stopMatch[0].includes(`"${word}"`), `Stopword "${word}" missing from _stop set`);
    }
  });
});
