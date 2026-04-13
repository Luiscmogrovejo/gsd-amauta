'use strict';
/**
 * Phase 33 — Pact Contract Structure Validation
 * File: tests/33-pact-contracts.integration.test.cjs
 *
 * Requirements covered:
 *   TEST-08: Pact consumer contracts for >= 3 daemon endpoints
 *
 * Note: This validates contract FILE structure, not live provider verification.
 * Provider verification (running daemon) is a deployment gate, not a unit test.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PACT_DIR = path.resolve(__dirname, 'pact');

// The 3 locked endpoints from 33-CONTEXT.md
const REQUIRED_PACT_FILES = [
  { file: 'context-compact.pact.cjs', endpoint: '/api/context/compact', method: 'POST' },
  { file: 'context-get.pact.cjs', endpoint: '/api/context/', method: 'GET' },
  { file: 'rlm-search.pact.cjs', endpoint: '/api/rlm/search', method: 'POST' },
];

describe('[TEST-08] Pact contract files exist for 3 daemon endpoints', () => {
  for (const { file } of REQUIRED_PACT_FILES) {
    it(`contract file exists: ${file}`, () => {
      assert.ok(
        fs.existsSync(path.join(PACT_DIR, file)),
        `Missing Pact contract: tests/pact/${file}`
      );
    });
  }
  it('exactly 3 pact contract files in tests/pact/', () => {
    const files = fs.readdirSync(PACT_DIR).filter(f => f.endsWith('.pact.cjs'));
    assert.strictEqual(files.length, 3, `Expected 3 pact files, found ${files.length}: ${files.join(', ')}`);
  });
});

describe('[TEST-08] Pact contracts: consumer = gsd-tools', () => {
  for (const { file } of REQUIRED_PACT_FILES) {
    it(`${file} declares consumer: gsd-tools`, () => {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      assert.ok(
        content.includes('gsd-tools'),
        `${file} missing consumer 'gsd-tools'`
      );
    });
  }
});

describe('[TEST-08] Pact contracts: provider = amauta-daemon', () => {
  for (const { file } of REQUIRED_PACT_FILES) {
    it(`${file} declares provider: amauta-daemon`, () => {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      assert.ok(
        content.includes('amauta-daemon'),
        `${file} missing provider 'amauta-daemon'`
      );
    });
  }
});

describe('[TEST-08] Pact contracts: each has exactly 3 interactions', () => {
  for (const { file } of REQUIRED_PACT_FILES) {
    it(`${file} defines 3 willRespondWith interactions`, () => {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      const matches = (content.match(/willRespondWith/g) || []).length;
      assert.strictEqual(matches, 3, `${file} has ${matches} interactions, expected 3`);
    });
  }
});

describe('[TEST-08] Pact contracts: endpoint paths match locked spec', () => {
  it('context-compact.pact.cjs targets POST /api/context/compact', () => {
    const content = fs.readFileSync(path.join(PACT_DIR, 'context-compact.pact.cjs'), 'utf-8');
    assert.ok(
      content.includes('/api/context/compact'),
      'context-compact.pact.cjs missing /api/context/compact path'
    );
  });
  it('context-get.pact.cjs targets GET /api/context/:task_id/:phase', () => {
    const content = fs.readFileSync(path.join(PACT_DIR, 'context-get.pact.cjs'), 'utf-8');
    assert.ok(
      content.includes('/api/context/'),
      'context-get.pact.cjs missing /api/context/ path'
    );
    assert.ok(
      content.toUpperCase().includes('GET'),
      'context-get.pact.cjs missing GET method'
    );
  });
  it('rlm-search.pact.cjs targets POST /api/rlm/search', () => {
    const content = fs.readFileSync(path.join(PACT_DIR, 'rlm-search.pact.cjs'), 'utf-8');
    assert.ok(
      content.includes('/api/rlm/search'),
      'rlm-search.pact.cjs missing /api/rlm/search path'
    );
  });
});

describe('[TEST-08] Pact contracts: error case interactions defined', () => {
  for (const { file } of REQUIRED_PACT_FILES) {
    it(`${file} has at least one 400 error interaction`, () => {
      const content = fs.readFileSync(path.join(PACT_DIR, file), 'utf-8');
      assert.ok(
        content.includes('400') || content.includes('status: 400'),
        `${file} missing 400 error interaction`
      );
    });
  }
});
