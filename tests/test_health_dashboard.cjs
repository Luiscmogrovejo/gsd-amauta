'use strict';

/**
 * Health Dashboard Tests
 *
 * Verifies the enhanced health dashboard in gsd-memory.cjs cmdStatus()
 * and the embedding coverage endpoint in amauta-daemon.py.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Health Dashboard', () => {
  const memoryPath = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');

  test('cmdStatus includes embedding coverage query', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    assert.ok(content.includes('embedding-coverage'), 'Should query embedding-coverage endpoint');
    assert.ok(content.includes('with_embeddings'), 'Should reference with_embeddings field');
  });

  test('cmdStatus includes SKB stats query', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    assert.ok(content.includes('/api/skb/'), 'Should query SKB endpoint');
  });

  test('cmdStatus includes agent performance query', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    assert.ok(content.includes('agent-performance'), 'Should query agent-performance endpoint');
    assert.ok(content.includes('executor-backend'), 'Should query executor-backend performance');
    assert.ok(content.includes('pass_rate'), 'Should display pass rate');
  });

  test('cmdStatus JSON output includes new fields', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    assert.ok(content.includes('embedding_coverage'), 'JSON output should include embedding_coverage');
    assert.ok(content.includes('agent_performance'), 'JSON output should include agent_performance');
    assert.ok(content.includes('skb_stats'), 'JSON output should include skb_stats');
  });

  test('all new sections wrapped in try/catch', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    // Verify the new endpoints exist in the code
    const embeddingIdx = content.indexOf('embedding-coverage');
    const agentPerfIdx = content.indexOf('agent-performance');
    const skbIdx = content.indexOf('/api/skb/');
    assert.ok(embeddingIdx > 0, 'embedding-coverage should exist');
    assert.ok(agentPerfIdx > 0, 'agent-performance should exist');
    assert.ok(skbIdx > 0, 'skb query should exist');

    // Verify try/catch wrapping by checking that 'try' appears before each endpoint reference
    const beforeEmbedding = content.substring(Math.max(0, embeddingIdx - 200), embeddingIdx);
    assert.ok(beforeEmbedding.includes('try'), 'embedding-coverage should be wrapped in try block');
    const beforeSkb = content.substring(Math.max(0, skbIdx - 200), skbIdx);
    assert.ok(beforeSkb.includes('try'), 'SKB query should be wrapped in try block');
  });

  test('embedding coverage uses color coding', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    // Check for green (>=80%), yellow (>=50%), red (<50%) color thresholds
    assert.ok(content.includes('pct >= 80'), 'Should have green threshold at 80%');
    assert.ok(content.includes('pct >= 50'), 'Should have yellow threshold at 50%');
  });

  test('agent performance shortens executor- prefix in display', () => {
    const content = fs.readFileSync(memoryPath, 'utf8');
    assert.ok(
      content.includes("agent.replace('executor-', '')"),
      'Should shorten agent names by removing executor- prefix'
    );
  });
});

describe('Daemon Embedding Coverage Endpoint', () => {
  const daemonPath = path.resolve(__dirname, '..', 'services', 'amauta-daemon.py');

  test('daemon has embedding-coverage endpoint', () => {
    const content = fs.readFileSync(daemonPath, 'utf8');
    assert.ok(content.includes('embedding-coverage'), 'Daemon should have embedding-coverage route');
    assert.ok(content.includes('coverage_pct'), 'Should return coverage percentage');
  });

  test('endpoint reuses memory_embedding_stats method', () => {
    const content = fs.readFileSync(daemonPath, 'utf8');
    assert.ok(
      content.includes('memory_embedding_stats'),
      'Should reuse existing memory_embedding_stats method'
    );
  });

  test('endpoint returns with_embeddings field', () => {
    const content = fs.readFileSync(daemonPath, 'utf8');
    assert.ok(
      content.includes('"with_embeddings"'),
      'Should return with_embeddings in response'
    );
  });
});
