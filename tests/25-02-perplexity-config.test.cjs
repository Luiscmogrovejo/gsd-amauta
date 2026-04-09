#!/usr/bin/env node
/**
 * Plan 25-02: Perplexity Config Tests
 * Tests for max_tokens reduction (01-02-T1) and model auto-selection (01-02-T2).
 *
 * Tests:
 *   PERP-01: max_tokens value
 *     1. max_tokens is 1000 (not 4096)
 *     2. Comment references PERPLEXITY_OUTPUT_CAP on the max_tokens line
 *   PERP-02: selectPerplexityModel heuristic
 *     3. Short simple query (<80 chars, no complex keywords) -> 'sonar' (via pattern check)
 *     4. Long query (>= 80 chars) -> 'sonar-pro' (length threshold)
 *     5. Query with "best practice" keyword -> 'sonar-pro'
 *     6. Query with "compare" keyword -> 'sonar-pro'
 *     7. Query with "architecture" keyword -> 'sonar-pro'
 *   PERP-03: PERPLEXITY_MODEL=auto wiring
 *     8. Code contains `PERPLEXITY_MODEL === 'auto'` conditional
 *     9. Code contains `const selectedModel =` local variable
 *    10. selectPerplexityModel appears at least 3 times (JSDoc + definition + call)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESEARCH_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');

// Read file once
const content = fs.readFileSync(RESEARCH_CJS, 'utf-8');

// ═══════════════════════════════════════════════════════
// PERP-01: max_tokens value
// ═══════════════════════════════════════════════════════

describe('PERP-01: max_tokens value', () => {

  it('max_tokens is 1000 (not 4096)', () => {
    assert.ok(
      content.includes('max_tokens: 1000,'),
      'gsd-research.cjs should contain max_tokens: 1000,'
    );
    assert.ok(
      !content.includes('max_tokens: 4096'),
      'gsd-research.cjs should NOT contain max_tokens: 4096'
    );
  });

  it('max_tokens line references PERPLEXITY_OUTPUT_CAP in comment', () => {
    // Find the max_tokens line and check it references PERPLEXITY_OUTPUT_CAP
    const tokenLine = content
      .split('\n')
      .find(line => line.includes('max_tokens: 1000'));
    assert.ok(tokenLine, 'max_tokens: 1000 line must exist');
    assert.ok(
      tokenLine.includes('PERPLEXITY_OUTPUT_CAP'),
      `Expected PERPLEXITY_OUTPUT_CAP in comment on max_tokens line, got: ${tokenLine.trim()}`
    );
  });

});

// ═══════════════════════════════════════════════════════
// PERP-02: selectPerplexityModel heuristic (via pattern extraction)
// ═══════════════════════════════════════════════════════

describe('PERP-02: selectPerplexityModel heuristic patterns', () => {

  // Extract the complexPatterns array from the source to verify its contents
  it('complexPatterns includes at least 8 required patterns', () => {
    const requiredPatterns = [
      'best.?practice',
      'compar',
      'architect',
      'how (to|do|does|should)',
      'pattern',
      'trade.?off',
      'design',
      'implement',
    ];
    for (const p of requiredPatterns) {
      assert.ok(
        content.includes(p),
        `gsd-research.cjs should contain complexPattern: ${p}`
      );
    }
  });

  it('length threshold is >= 80 (not 79 or 81)', () => {
    // The condition should be `query.length >= 80`
    assert.ok(
      content.includes('query.length >= 80'),
      'gsd-research.cjs should contain `query.length >= 80` threshold'
    );
  });

  it('function returns sonar for the short-circuit (length < 80, no complex keywords)', () => {
    // Verify the function body contains `return \'sonar\'` as the default branch
    const fnStart = content.indexOf('function selectPerplexityModel(query)');
    assert.ok(fnStart !== -1, 'selectPerplexityModel function must exist');
    // Extract function body (find matching closing brace)
    const fnBody = content.slice(fnStart, fnStart + 600);
    assert.ok(
      fnBody.includes("return 'sonar';"),
      "selectPerplexityModel should contain `return 'sonar';` for simple queries"
    );
  });

  it('function returns sonar-pro for complex queries (length >= 80 or keyword match)', () => {
    const fnStart = content.indexOf('function selectPerplexityModel(query)');
    const fnBody = content.slice(fnStart, fnStart + 600);
    assert.ok(
      fnBody.includes("return 'sonar-pro';"),
      "selectPerplexityModel should contain `return 'sonar-pro';` for complex queries"
    );
  });

  it('sonar-pro branch comes before sonar default (complex check first)', () => {
    const fnStart = content.indexOf('function selectPerplexityModel(query)');
    const fnBody = content.slice(fnStart, fnStart + 600);
    const proIdx = fnBody.indexOf("return 'sonar-pro';");
    const sonarIdx = fnBody.indexOf("return 'sonar';");
    assert.ok(proIdx !== -1, "sonar-pro return must exist");
    assert.ok(sonarIdx !== -1, "sonar return must exist");
    assert.ok(
      proIdx < sonarIdx,
      'sonar-pro should be returned before sonar (complex check is the early return)'
    );
  });

});

// ═══════════════════════════════════════════════════════
// PERP-03: PERPLEXITY_MODEL=auto wiring in providerPerplexity
// ═══════════════════════════════════════════════════════

describe("PERP-03: PERPLEXITY_MODEL === 'auto' wiring", () => {

  it("code contains PERPLEXITY_MODEL === 'auto' conditional", () => {
    assert.ok(
      content.includes("PERPLEXITY_MODEL === 'auto'"),
      "gsd-research.cjs should contain `PERPLEXITY_MODEL === 'auto'`"
    );
  });

  it('code contains const selectedModel = ... to hold the resolved model', () => {
    assert.ok(
      content.includes('const selectedModel ='),
      "gsd-research.cjs should contain `const selectedModel =`"
    );
  });

  it('selectPerplexityModel appears at least 3 times (JSDoc + definition + call site)', () => {
    const matches = (content.match(/selectPerplexityModel/g) || []).length;
    assert.ok(
      matches >= 3,
      `Expected at least 3 occurrences of selectPerplexityModel, found ${matches}`
    );
  });

  it('selectedModel is used in model field of API request (not raw PERPLEXITY_MODEL)', () => {
    // After the selectedModel declaration, model: should use selectedModel not PERPLEXITY_MODEL
    // Find providerPerplexity body
    const fnStart = content.indexOf('async function providerPerplexity');
    assert.ok(fnStart !== -1, 'providerPerplexity must exist');
    const fnBody = content.slice(fnStart, fnStart + 1500);  // window expanded: caching logic added before API call
    assert.ok(
      fnBody.includes('model: selectedModel,'),
      'providerPerplexity API request should use `model: selectedModel,`'
    );
  });

});
