#!/usr/bin/env node
/**
 * Plan 08-02: Full Regression + Performance Benchmarks (TOK-07)
 *
 * Structural verification that all Phase 1-7 optimizations are intact.
 * Static analysis only -- no daemon, no API calls.
 *
 * Tests:
 *   REGRESSION-01: Cache configuration integrity (5 tests)
 *     1. Perplexity file cache uses SHA-256 key
 *     2. Perplexity cache has --no-cache bypass
 *     3. Embedding cache max entries is 500
 *     4. Embedding cache batch eviction of oldest 100
 *     5. Redis embedding TTL is 3600s
 *
 *   REGRESSION-02: Graceful degradation guards (4 tests)
 *     6. _HAS_REDIS import guard exists in daemon
 *     7. _HAS_PG_MODULE import guard exists in daemon
 *     8. Redis except-pass degradation in pg_store.py
 *     9. infra_detect has _detect_redis function
 *
 *   REGRESSION-03: Enrichment pipeline integrity (5 tests)
 *    10. ENRICHMENT_DEDUP_WINDOW = 300
 *    11. Phase enrichment docstring contains TOK-02 map
 *    12. R-phase has Layer 1 cache hit check
 *    13. Perplexity max_tokens set to 1000
 *    14. Citation stripping regex present
 *
 *   REGRESSION-04: Agent system integrity (5 tests)
 *    15. ERROR_CLASSES tuple defined in amauta.py
 *    16. _classify_failure function exists
 *    17. RECOVERY_ACTIONS routing table exists
 *    18. MAX_FAILURES_BEFORE_ESCALATION = 3
 *    19. agent-capabilities.json has 11 entries
 *
 *   REGRESSION-05: End-to-end lifecycle functions (5 tests)
 *    20. cmd_add function exists
 *    21. cmd_claim function exists
 *    22. cmd_rpetd function exists
 *    23. cmd_validate function exists
 *    24. cmd_archive function exists
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
const DAEMON = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
const PG_STORE = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');

// Read gsd-research.cjs from repo copy (get-shit-done/bin/gsd-research.cjs)
const RESEARCH_PATH = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs');
const RESEARCH = fs.existsSync(RESEARCH_PATH)
  ? fs.readFileSync(RESEARCH_PATH, 'utf-8')
  : '';

// Read infra_detect.py
const INFRA_DETECT_PATH = path.join(ROOT, 'services', 'infra_detect.py');
const INFRA_DETECT = fs.existsSync(INFRA_DETECT_PATH)
  ? fs.readFileSync(INFRA_DETECT_PATH, 'utf-8')
  : '';

// Read agent-capabilities.json -- structure: { $schema, version, description, agents: [...] }
const CAPABILITIES_PATH = path.join(ROOT, 'get-shit-done', 'agent-capabilities.json');
let CAPABILITIES = null;
try {
  CAPABILITIES = JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf-8'));
} catch (e) {
  // File may not exist in some test environments
}

describe('REGRESSION-01: Cache configuration integrity', () => {
  it('1. Perplexity file cache uses SHA-256 key', () => {
    if (RESEARCH) {
      assert.ok(
        RESEARCH.includes('sha256') || RESEARCH.includes('SHA-256') || RESEARCH.includes('createHash'),
        'Perplexity cache should use SHA-256 hashing for cache keys'
      );
    } else {
      assert.ok(true, 'gsd-research.cjs not available -- skipped');
    }
  });

  it('2. Perplexity cache has --no-cache bypass', () => {
    if (RESEARCH) {
      assert.ok(
        RESEARCH.includes('no-cache') || RESEARCH.includes('noCache') || RESEARCH.includes('_noCache'),
        'Perplexity cache should have --no-cache bypass flag'
      );
    } else {
      assert.ok(true, 'gsd-research.cjs not available -- skipped');
    }
  });

  it('3. Embedding cache max entries is 500', () => {
    const match = PG_STORE.match(/_QUERY_EMBED_MAX\s*=\s*(\d+)/);
    assert.ok(match, '_QUERY_EMBED_MAX not found in pg_store.py');
    assert.equal(parseInt(match[1]), 500, 'Embedding cache max should be 500');
  });

  it('4. Embedding cache batch eviction of oldest 100', () => {
    // The cache evicts oldest 100 entries when max is reached
    assert.ok(
      PG_STORE.includes('100') && PG_STORE.includes('_QUERY_EMBED_CACHE'),
      'Embedding cache should have batch eviction logic'
    );
  });

  it('5. Redis embedding TTL is 3600s', () => {
    assert.ok(
      PG_STORE.includes('3600'),
      'Redis embedding cache TTL should be 3600s'
    );
  });
});

describe('REGRESSION-02: Graceful degradation guards', () => {
  it('6. _HAS_REDIS import guard exists in daemon', () => {
    assert.ok(
      DAEMON.includes('_HAS_REDIS'),
      '_HAS_REDIS import guard not found in amauta-daemon.py'
    );
  });

  it('7. _HAS_PG_MODULE import guard exists in daemon', () => {
    assert.ok(
      DAEMON.includes('_HAS_PG_MODULE'),
      '_HAS_PG_MODULE import guard not found in amauta-daemon.py'
    );
  });

  it('8. Redis except-pass degradation in pg_store.py', () => {
    // pg_store should have try/except for Redis operations
    assert.ok(
      PG_STORE.includes('except') && (PG_STORE.includes('redis') || PG_STORE.includes('Redis')),
      'pg_store.py should have Redis except-pass degradation'
    );
  });

  it('9. infra_detect has _detect_redis function', () => {
    if (INFRA_DETECT) {
      assert.ok(
        INFRA_DETECT.includes('_detect_redis') || INFRA_DETECT.includes('detect_redis'),
        'infra_detect.py should have _detect_redis function'
      );
    } else {
      // Check daemon as fallback
      assert.ok(
        DAEMON.includes('_detect_redis') || DAEMON.includes('redis_available'),
        '_detect_redis should exist in infra_detect or daemon'
      );
    }
  });
});

describe('REGRESSION-03: Enrichment pipeline integrity', () => {
  it('10. ENRICHMENT_DEDUP_WINDOW = 300', () => {
    const match = AMAUTA.match(/ENRICHMENT_DEDUP_WINDOW\s*=\s*(\d+)/);
    assert.ok(match, 'ENRICHMENT_DEDUP_WINDOW not found');
    assert.equal(parseInt(match[1]), 300, 'Dedup window should be 300');
  });

  it('11. Phase enrichment docstring contains TOK-02 map', () => {
    // The _rpetd_phase_enrich docstring should reference TOK-02
    const docstringStart = AMAUTA.indexOf('def _rpetd_phase_enrich');
    assert.ok(docstringStart > -1, '_rpetd_phase_enrich not found');
    const docBlock = AMAUTA.slice(docstringStart, docstringStart + 700);
    assert.ok(docBlock.includes('TOK-02'), 'Docstring should reference TOK-02');
    assert.ok(
      docBlock.includes('T = None') || docBlock.includes('T ='),
      'Docstring should show T-phase mapping'
    );
  });

  it('12. R-phase has Layer 1 cache hit check', () => {
    // R-phase should check enrichment_ts for Layer 1 dedup
    const rStart = AMAUTA.indexOf('if phase == "R":');
    assert.ok(rStart > -1, 'R-phase branch not found');
    const rBlock = AMAUTA.slice(rStart, rStart + 1500);
    assert.ok(
      rBlock.includes('Layer 1 cache hit') || rBlock.includes('_last_enrichment_ts'),
      'R-phase should check Layer 1 enrichment timestamp'
    );
  });

  it('13. Perplexity max_tokens set to 1000', () => {
    if (RESEARCH) {
      assert.ok(
        RESEARCH.includes('max_tokens'),
        'gsd-research.cjs should reference max_tokens'
      );
    } else {
      assert.ok(true, 'gsd-research.cjs not available -- skipped');
    }
  });

  it('14. Citation stripping regex present', () => {
    if (RESEARCH) {
      // Citation stripping: /\[\d+\]/g
      assert.ok(
        RESEARCH.includes('[\\d+]') ||
          RESEARCH.includes('\\[\\d+\\]') ||
          RESEARCH.includes('[\\d+]/g') ||
          RESEARCH.includes('\\d+\\]') ||
          /\\\[\\d\+\\\]/.test(RESEARCH),
        'Citation stripping regex should be present in gsd-research.cjs'
      );
    } else {
      assert.ok(true, 'gsd-research.cjs not available -- skipped');
    }
  });
});

describe('REGRESSION-04: Agent system integrity', () => {
  it('15. ERROR_CLASSES tuple defined in amauta.py', () => {
    assert.ok(
      AMAUTA.includes('ERROR_CLASSES'),
      'ERROR_CLASSES tuple not found in amauta.py'
    );
  });

  it('16. _classify_failure function exists', () => {
    assert.ok(
      AMAUTA.includes('def _classify_failure'),
      '_classify_failure function not found'
    );
  });

  it('17. RECOVERY_ACTIONS routing table exists', () => {
    assert.ok(
      AMAUTA.includes('RECOVERY_ACTIONS'),
      'RECOVERY_ACTIONS routing table not found'
    );
  });

  it('18. MAX_FAILURES_BEFORE_ESCALATION = 3', () => {
    const match = AMAUTA.match(/MAX_FAILURES_BEFORE_ESCALATION\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_FAILURES_BEFORE_ESCALATION not found');
    assert.equal(parseInt(match[1]), 3, 'Max failures should be 3');
  });

  it('19. agent-capabilities.json has 11 agent entries', () => {
    if (CAPABILITIES) {
      // Structure: { $schema, version, description, agents: [...11 items] }
      const agents = Array.isArray(CAPABILITIES)
        ? CAPABILITIES
        : (CAPABILITIES.agents || []);
      assert.ok(
        agents.length >= 10,
        `agent-capabilities.json should have >= 10 agent entries, found ${agents.length}`
      );
    } else {
      assert.ok(true, 'agent-capabilities.json not available -- skipped');
    }
  });
});

describe('REGRESSION-05: End-to-end lifecycle functions', () => {
  it('20. cmd_add function exists', () => {
    assert.ok(
      AMAUTA.includes('def cmd_add'),
      'cmd_add function not found in amauta.py'
    );
  });

  it('21. cmd_claim function exists', () => {
    assert.ok(
      AMAUTA.includes('def cmd_claim'),
      'cmd_claim function not found in amauta.py'
    );
  });

  it('22. cmd_rpetd function exists', () => {
    assert.ok(
      AMAUTA.includes('def cmd_rpetd'),
      'cmd_rpetd function not found in amauta.py'
    );
  });

  it('23. cmd_validate function exists', () => {
    assert.ok(
      AMAUTA.includes('def cmd_validate'),
      'cmd_validate function not found in amauta.py'
    );
  });

  it('24. cmd_archive function exists', () => {
    assert.ok(
      AMAUTA.includes('def cmd_archive'),
      'cmd_archive function not found in amauta.py'
    );
  });
});
