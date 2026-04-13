#!/usr/bin/env node
/**
 * Phase 22 CAVE-03: BM25 Retrieval Benchmark.
 *
 * Verifies that caveman-compressed pipe-delimited descriptions do not degrade
 * BM25 retrieval quality versus naive first-500-char "original" descriptions.
 *
 * Requirements:
 *   - Compressed MRR >= 0.95 * Original MRR (across 20 ground-truth queries)
 *   - No single query drops > 2 rank positions in the compressed corpus
 *   - All 20 corpus files produce non-empty BM25 token lists
 *   - Exactly 20 ground-truth queries are defined
 *   - All expected_top3 files exist on disk
 *
 * Run: node --test tests/22-caveman-bm25.test.cjs
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Corpus files
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');

const CORPUS_FILES = [
  'services/context_validator.py',
  'services/rpetd_context.py',
  'services/caveman_descriptions.py',
  'services/grammar_strip.py',
  'services/amauta-daemon.py',
  'services/pg_store.py',
  'services/rlm-service.py',
  'services/sqlite_store.py',
  'get-shit-done/bin/gsd-amauta.cjs',
  'get-shit-done/bin/gsd-rlm.cjs',
  'get-shit-done/bin/gsd-memory.cjs',
  'get-shit-done/bin/lib/core.cjs',
  'agents/gsd-executor-backend.md',
  'agents/gsd-operator.md',
  'agents/gsd-planner.md',
  'tests/test_context_validator.py',
  'tests/test_context_validator_integration.py',
  'tests/test_caveman_descriptions.py',
  'tests/test_grammar_strip.py',
  'tests/20-context-handoff.test.cjs',
];

// ---------------------------------------------------------------------------
// Ground-truth queries — 20 queries covering domain concepts
// ---------------------------------------------------------------------------

const GROUND_TRUTH = [
  {
    query: 'SHA-256 file hashing staleness detection',
    expected_top3: [
      'services/context_validator.py',
      'tests/test_context_validator.py',
      'tests/test_context_validator_integration.py',
    ],
  },
  {
    query: 'RPETD context compaction conversation handoff',
    expected_top3: [
      'services/rpetd_context.py',
      'services/amauta-daemon.py',
      'get-shit-done/bin/gsd-amauta.cjs',
    ],
  },
  {
    query: 'pipe delimited file description generator caveman',
    expected_top3: [
      'services/caveman_descriptions.py',
      'tests/test_caveman_descriptions.py',
      'services/context_validator.py',
    ],
  },
  {
    query: 'grammar stripping markdown agent definitions filler',
    expected_top3: [
      'services/grammar_strip.py',
      'tests/test_grammar_strip.py',
      'agents/gsd-executor-backend.md',
    ],
  },
  {
    query: 'PostgreSQL memory storage task persistence SKB',
    expected_top3: [
      'services/pg_store.py',
      'get-shit-done/bin/gsd-memory.cjs',
      'services/amauta-daemon.py',
    ],
  },
  {
    query: 'retrieval augmented context engine search query',
    expected_top3: [
      'services/rlm-service.py',
      'get-shit-done/bin/gsd-rlm.cjs',
      'get-shit-done/bin/lib/core.cjs',
    ],
  },
  {
    query: 'SQLite fallback store database unavailable',
    expected_top3: [
      'services/sqlite_store.py',
      'services/pg_store.py',
      'services/amauta-daemon.py',
    ],
  },
  {
    query: 'daemon HTTP API task manager background service',
    expected_top3: [
      'services/amauta-daemon.py',
      'get-shit-done/bin/gsd-amauta.cjs',
      'services/pg_store.py',
    ],
  },
  {
    query: 'CLI node wrapper amauta commands board stats',
    expected_top3: [
      'get-shit-done/bin/gsd-amauta.cjs',
      'services/amauta-daemon.py',
      'get-shit-done/bin/lib/core.cjs',
    ],
  },
  {
    query: 'memory CLI search learn PostgreSQL knowledge base',
    expected_top3: [
      'get-shit-done/bin/gsd-memory.cjs',
      'services/pg_store.py',
      'services/amauta-daemon.py',
    ],
  },
  {
    query: 'core shared utilities constants helpers config',
    expected_top3: [
      'get-shit-done/bin/lib/core.cjs',
      'get-shit-done/bin/gsd-amauta.cjs',
      'get-shit-done/bin/gsd-rlm.cjs',
    ],
  },
  {
    query: 'backend executor APIs services authentication migrations',
    expected_top3: [
      'agents/gsd-executor-backend.md',
      'agents/gsd-operator.md',
      'services/amauta-daemon.py',
    ],
  },
  {
    query: 'operator orchestrator agent routing workflow planning',
    expected_top3: [
      'agents/gsd-operator.md',
      'agents/gsd-planner.md',
      'agents/gsd-executor-backend.md',
    ],
  },
  {
    query: 'planner phase roadmap planning protocol milestone',
    expected_top3: [
      'agents/gsd-planner.md',
      'agents/gsd-operator.md',
      'agents/gsd-executor-backend.md',
    ],
  },
  {
    query: 'changed since git diff stale files selective refresh',
    expected_top3: [
      'services/context_validator.py',
      'tests/test_context_validator.py',
      'tests/test_context_validator_integration.py',
    ],
  },
  {
    query: 'integration test validation context pipeline staleness',
    expected_top3: [
      'tests/test_context_validator_integration.py',
      'tests/test_context_validator.py',
      'services/context_validator.py',
    ],
  },
  {
    query: 'test caveman description pipe regex format exports loc',
    expected_top3: [
      'tests/test_caveman_descriptions.py',
      'services/caveman_descriptions.py',
      'tests/test_grammar_strip.py',
    ],
  },
  {
    query: 'test grammar strip article filler hedging removal ratio',
    expected_top3: [
      'tests/test_grammar_strip.py',
      'services/grammar_strip.py',
      'tests/test_caveman_descriptions.py',
    ],
  },
  {
    query: 'context handoff compact RPETD phase integration test',
    expected_top3: [
      'tests/20-context-handoff.test.cjs',
      'get-shit-done/bin/gsd-amauta.cjs',
      'services/rpetd_context.py',
    ],
  },
  {
    query: 'RPETDContext structured phase boundary token budget',
    expected_top3: [
      'services/rpetd_context.py',
      'services/amauta-daemon.py',
      'tests/test_context_validator.py',
    ],
  },
];

// ---------------------------------------------------------------------------
// Inline BM25 implementation
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'it', 'its', 'this', 'that', 'these', 'those',
  'as', 'up', 'if', 'not', 'no', 'so', 'than', 'then', 'when', 'where',
  'which', 'who', 'how', 'all', 'each', 'any', 'more', 'also', 'into',
]);

/**
 * Tokenize text: lowercase, split on non-alphanumeric runs, filter stopwords
 * and tokens shorter than 2 chars.
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Compute IDF for each term across the document corpus.
 * idf(t) = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 */
function computeIDF(tokenizedDocs) {
  const N = tokenizedDocs.length;
  const df = new Map();
  for (const tokens of tokenizedDocs) {
    const seen = new Set(tokens);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [term, freq] of df.entries()) {
    idf.set(term, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
  }
  return idf;
}

/**
 * BM25 score for a single query against a single document.
 */
function scoreBM25(queryTokens, docTokens, idf, avgDL, k1 = 1.5, b = 0.75) {
  const docLen = docTokens.length;
  const tf = new Map();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }

  let score = 0;
  for (const qt of queryTokens) {
    const termIDF = idf.get(qt) || 0;
    const termFreq = tf.get(qt) || 0;
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLen / avgDL));
    score += termIDF * (numerator / denominator);
  }
  return score;
}

/**
 * Rank all documents by BM25 score for a given query.
 * Returns sorted array of {index, score} descending by score.
 */
function rankDocuments(queryText, tokenizedDocs, idf, avgDL) {
  const queryTokens = tokenize(queryText);
  const scores = tokenizedDocs.map((docTokens, idx) => ({
    index: idx,
    score: scoreBM25(queryTokens, docTokens, idf, avgDL),
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * Compute MRR (Mean Reciprocal Rank) across all ground-truth queries.
 * For each query, find the rank of the first file in expected_top3.
 */
function computeMRR(queries, docFiles, tokenizedDocs, idf, avgDL) {
  let reciprocalSum = 0;
  for (const q of queries) {
    const ranked = rankDocuments(q.query, tokenizedDocs, idf, avgDL);
    for (let rank = 0; rank < ranked.length; rank++) {
      if (q.expected_top3.includes(docFiles[ranked[rank].index])) {
        reciprocalSum += 1 / (rank + 1);
        break;
      }
    }
  }
  return reciprocalSum / queries.length;
}

// ---------------------------------------------------------------------------
// Description generators
// ---------------------------------------------------------------------------

/**
 * Original description: first 500 chars of the file (naive approach).
 */
function getOriginalDescription(relPath) {
  try {
    const absPath = path.join(PROJECT_ROOT, relPath);
    const content = fs.readFileSync(absPath, 'utf8');
    return content.slice(0, 500);
  } catch (e) {
    return '';
  }
}

/**
 * Compressed description: output of generate_caveman_description(path).
 * Calls Python via child_process.execSync — inline caveman output.
 */
function getCavemanDescription(relPath) {
  try {
    const absPath = path.join(PROJECT_ROOT, relPath);
    const safeAbsPath = absPath.replace(/'/g, "\\'");
    const cmd = `python3 -c "import sys; sys.path.insert(0, '${PROJECT_ROOT}'); from services.caveman_descriptions import generate_caveman_description; print(generate_caveman_description('${safeAbsPath}'))"`;
    return execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Precompute corpus descriptions (runs once at module load)
// ---------------------------------------------------------------------------

const originalDescriptions = CORPUS_FILES.map(f => getOriginalDescription(f));
const compressedDescriptions = CORPUS_FILES.map(f => getCavemanDescription(f));

const origTokenized = originalDescriptions.map(d => tokenize(d));
const compTokenized = compressedDescriptions.map(d => tokenize(d));

const origAvgDL = origTokenized.reduce((s, t) => s + t.length, 0) / origTokenized.length;
const compAvgDL = compTokenized.reduce((s, t) => s + t.length, 0) / compTokenized.length;

const origIDF = computeIDF(origTokenized);
const compIDF = computeIDF(compTokenized);

// ---------------------------------------------------------------------------
// Per-query rank helper (for the rank-drop test)
// ---------------------------------------------------------------------------

function getFirstExpectedRank(query, docFiles, tokenizedDocs, idf, avgDL) {
  const ranked = rankDocuments(query.query, tokenizedDocs, idf, avgDL);
  for (let rank = 0; rank < ranked.length; rank++) {
    if (query.expected_top3.includes(docFiles[ranked[rank].index])) {
      return rank; // 0-indexed
    }
  }
  return ranked.length - 1; // worst case if not found
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 22 CAVE-03: BM25 Retrieval Benchmark', () => {

  test('ground truth has exactly 20 queries', () => {
    assert.strictEqual(GROUND_TRUTH.length, 20, `Expected 20 queries, got ${GROUND_TRUTH.length}`);
  });

  test('all expected_top3 files exist on disk', () => {
    const missing = [];
    for (const q of GROUND_TRUTH) {
      for (const f of q.expected_top3) {
        const absPath = path.join(PROJECT_ROOT, f);
        if (!fs.existsSync(absPath)) {
          missing.push(f);
        }
      }
    }
    assert.deepEqual(missing, [], `Missing files: ${missing.join(', ')}`);
  });

  test('BM25 tokenizer produces non-empty tokens for all corpus files', () => {
    const emptyOrig = CORPUS_FILES.filter((_, i) => origTokenized[i].length === 0);
    const emptyComp = CORPUS_FILES.filter((_, i) => compTokenized[i].length === 0);
    assert.deepEqual(
      emptyOrig, [],
      `Original descriptions with 0 tokens: ${emptyOrig.join(', ')}`
    );
    assert.deepEqual(
      emptyComp, [],
      `Compressed descriptions with 0 tokens: ${emptyComp.join(', ')}`
    );
  });

  test('compressed MRR >= 0.95 * original MRR', () => {
    const origMRR = computeMRR(GROUND_TRUTH, CORPUS_FILES, origTokenized, origIDF, origAvgDL);
    const compMRR = computeMRR(GROUND_TRUTH, CORPUS_FILES, compTokenized, compIDF, compAvgDL);
    const threshold = 0.95 * origMRR;

    assert.ok(
      compMRR >= threshold,
      `Compressed MRR ${compMRR.toFixed(4)} < 0.95 * original MRR ${origMRR.toFixed(4)} = ${threshold.toFixed(4)}`
    );
  });

  test('no single query drops > 2 rank positions', () => {
    const violations = [];
    for (const q of GROUND_TRUTH) {
      const origRank = getFirstExpectedRank(q, CORPUS_FILES, origTokenized, origIDF, origAvgDL);
      const compRank = getFirstExpectedRank(q, CORPUS_FILES, compTokenized, compIDF, compAvgDL);
      const drop = compRank - origRank;
      if (drop > 2) {
        violations.push({
          query: q.query,
          origRank: origRank + 1,
          compRank: compRank + 1,
          drop,
        });
      }
    }
    assert.deepEqual(
      violations, [],
      `Rank drop violations (> 2 positions):\n${violations.map(v =>
        `  "${v.query}": orig=${v.origRank} comp=${v.compRank} drop=${v.drop}`
      ).join('\n')}`
    );
  });

});
