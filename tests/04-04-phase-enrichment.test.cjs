#!/usr/bin/env node
/**
 * Plan 04-04: Phase-Specific Enrichment Reduction Tests
 *
 * Tests:
 *   PHASE-01: T-phase disabled
 *     1. T-phase contains TOK-02 comment
 *     2. T-phase does NOT contain _rlm_query
 *     3. T-phase does NOT contain _mem_semantic_search
 *   PHASE-02: D-phase writes preserved, RLM removed
 *     4. D-phase contains TOK-02 comment
 *     5. D-phase does NOT contain _rlm_query
 *     6. D-phase STILL contains _mem_log_event (delivery write)
 *     7. D-phase STILL contains _skb_promote (SKB promotion)
 *     8. D-phase STILL contains WEB_SEARCH FINDING (web search write)
 *   PHASE-03: E-phase RLM kept, semantic search removed
 *     9. E-phase contains TOK-02 comment about patterns removed
 *    10. E-phase does NOT contain 'implementation approach pattern'
 *    11. E-phase STILL contains _rlm_query (execution analysis)
 *    12. E-phase STILL contains 'Past execution failures' (failure search kept)
 *   PHASE-04: R and P unchanged
 *    13. R-phase still calls _rlm_query
 *    14. R-phase still calls _mem_semantic_search
 *    15. P-phase still calls _rlm_query
 *   PHASE-05: Docstring and TOK-04
 *    16. Docstring contains phase enrichment map
 *    17. selectPerplexityModel function still exists (TOK-04)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');
const RESEARCH_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');

const amautaContent = fs.readFileSync(AMAUTA_PY, 'utf-8');
const researchContent = fs.readFileSync(RESEARCH_CJS, 'utf-8');

// Helper: extract a phase block from _rpetd_phase_enrich
function extractPhaseBlock(content, phase) {
  // Find `elif phase == "X":` or `if phase == "X":`
  const pattern = phase === 'R'
    ? /if phase == "R":([\s\S]*?)(?=elif phase ==|$)/
    : new RegExp(`elif phase == "${phase}":[\\s\\S]*?(?=elif phase ==|if supplement_parts:|$)`);
  const match = content.match(pattern);
  return match ? match[0] : '';
}

const tBlock = extractPhaseBlock(amautaContent, 'T');
const dBlock = extractPhaseBlock(amautaContent, 'D');
const eBlock = extractPhaseBlock(amautaContent, 'E');
const rBlock = extractPhaseBlock(amautaContent, 'R');
const pBlock = extractPhaseBlock(amautaContent, 'P');

describe('PHASE-01: T-phase disabled', () => {
  it('1. T-phase contains TOK-02 comment', () => {
    assert.ok(tBlock.includes('TOK-02'), 'T-phase should have TOK-02 comment');
  });

  it('2. T-phase does NOT contain _rlm_query', () => {
    assert.ok(!tBlock.includes('_rlm_query'), 'T-phase should not call _rlm_query');
  });

  it('3. T-phase does NOT contain _mem_semantic_search', () => {
    assert.ok(!tBlock.includes('_mem_semantic_search'), 'T-phase should not call _mem_semantic_search');
  });
});

describe('PHASE-02: D-phase writes preserved, RLM removed', () => {
  it('4. D-phase contains TOK-02 comment', () => {
    assert.ok(dBlock.includes('TOK-02'), 'D-phase should have TOK-02 comment');
  });

  it('5. D-phase does NOT contain _rlm_query', () => {
    assert.ok(!dBlock.includes('_rlm_query'), 'D-phase should not call _rlm_query');
  });

  it('6. D-phase STILL contains _mem_log_event', () => {
    assert.ok(dBlock.includes('_mem_log_event'), 'D-phase must preserve delivery write');
  });

  it('7. D-phase STILL contains _skb_promote', () => {
    assert.ok(dBlock.includes('_skb_promote'), 'D-phase must preserve SKB promotion');
  });

  it('8. D-phase STILL contains WEB_SEARCH FINDING', () => {
    assert.ok(dBlock.includes('WEB_SEARCH FINDING'), 'D-phase must preserve web search write');
  });
});

describe('PHASE-03: E-phase RLM kept, semantic search removed', () => {
  it('9. E-phase contains TOK-02 comment about patterns removed', () => {
    assert.ok(eBlock.includes('TOK-02'), 'E-phase should have TOK-02 comment');
  });

  it('10. E-phase does NOT contain implementation approach pattern', () => {
    assert.ok(!eBlock.includes('implementation approach pattern'),
      'E-phase semantic search for patterns should be removed');
  });

  it('11. E-phase STILL contains _rlm_query', () => {
    assert.ok(eBlock.includes('_rlm_query'), 'E-phase must keep RLM execution analysis');
  });

  it('12. E-phase STILL contains Past execution failures', () => {
    assert.ok(eBlock.includes('Past execution failures'),
      'E-phase must keep failure-pattern search');
  });
});

describe('PHASE-04: R and P unchanged', () => {
  it('13. R-phase still calls _rlm_query', () => {
    assert.ok(rBlock.includes('_rlm_query'), 'R-phase must keep _rlm_query');
  });

  it('14. R-phase still calls _mem_semantic_search', () => {
    assert.ok(rBlock.includes('_mem_semantic_search'), 'R-phase must keep _mem_semantic_search');
  });

  it('15. P-phase still calls _rlm_query', () => {
    assert.ok(pBlock.includes('_rlm_query'), 'P-phase must keep _rlm_query');
  });
});

describe('PHASE-05: Docstring and TOK-04', () => {
  it('16. Docstring contains phase enrichment map', () => {
    assert.ok(amautaContent.includes('Phase enrichment map (TOK-02'),
      'Docstring should contain the TOK-02 phase map');
  });

  it('17. selectPerplexityModel function still exists (TOK-04 regression)', () => {
    assert.ok(researchContent.includes('function selectPerplexityModel(query)'),
      'selectPerplexityModel must still exist for TOK-04');
  });
});
