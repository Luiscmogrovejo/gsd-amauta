#!/usr/bin/env node
'use strict';
/**
 * Pact contract: gsd-tools (consumer) → amauta-daemon (provider)
 * Endpoint: POST /api/rlm/search
 * Pact broker: local file-based (pacts/ directory — no external service required)
 *
 * Consumer: gsd-tools.cjs / gsd-amauta.cjs (CLI that calls daemon HTTP API)
 * Provider: amauta-daemon.py
 *
 * NOTE: gsd-rlm.cjs currently calls /search on the RLM service (separate port).
 * This Pact contract is for the PLANNED daemon proxy endpoint POST /api/rlm/search
 * that will be created in Phase 38 or as a daemon wrapper. The contract defines
 * the expected interface so Phase 38 implementation matches. This is a forward
 * contract — the provider does not yet implement this endpoint.
 *
 * Run: node --test tests/pact/rlm-search.pact.cjs
 */

const { PactV3, MatchersV3 } = require('@pact-foundation/pact');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const path = require('path');
const http = require('http');

const { like, string, integer } = MatchersV3;

const provider = new PactV3({
  consumer: 'gsd-tools',
  provider: 'amauta-daemon',
  dir: path.join(__dirname, '..', '..', 'pacts'),
  logLevel: 'warn',
});

// Helper: POST request to mock server using Node built-in http (no axios/fetch — portable)
function postRlmSearch(baseUrl, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL('/api/rlm/search', baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /api/rlm/search — RLM search proxy contract', () => {
  // Interaction 1: valid search request with query and dir
  it('returns results array for a valid search request', async () => {
    await provider
      .given('daemon is running with RLM service available')
      .uponReceiving('a valid RLM search request with query and dir')
      .withRequest({
        method: 'POST',
        path: '/api/rlm/search',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: string('task store patterns'),
          dir: string('get-shit-done/bin/lib'),
          top_k: integer(5),
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          results: [
            {
              path: string('get-shit-done/bin/lib/task-store.cjs'),
              score: like(0.9),
              snippet: string('function storeTask(task) {'),
            },
          ],
          total: integer(1),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await postRlmSearch(mockServer.url, {
          query: 'task store patterns',
          dir: 'get-shit-done/bin/lib',
          top_k: 5,
        });
        assert.strictEqual(result.status, 200);
        assert.ok(Array.isArray(result.body.results), 'results should be an array');
      });
  });

  // Interaction 2: missing query → 400
  it('returns 400 when query is missing', async () => {
    await provider
      .given('daemon is running')
      .uponReceiving('an RLM search request missing the required query field')
      .withRequest({
        method: 'POST',
        path: '/api/rlm/search',
        headers: { 'Content-Type': 'application/json' },
        body: { dir: 'get-shit-done/bin/lib', top_k: integer(5) },
      })
      .willRespondWith({
        status: 400,
        body: { error: string('query is required') },
      })
      .executeTest(async (mockServer) => {
        const result = await postRlmSearch(mockServer.url, {
          dir: 'get-shit-done/bin/lib',
          top_k: 5,
        });
        assert.strictEqual(result.status, 400);
      });
  });

  // Interaction 3: empty results (valid query but no matches)
  it('returns empty results array when query matches nothing', async () => {
    await provider
      .given('daemon is running with RLM service available but no matching documents')
      .uponReceiving('an RLM search request that produces no results')
      .withRequest({
        method: 'POST',
        path: '/api/rlm/search',
        headers: { 'Content-Type': 'application/json' },
        body: {
          query: string('zzznonexistentqueryzzzz'),
          dir: string('get-shit-done/bin/lib'),
          top_k: integer(5),
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          results: [],
          total: integer(0),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await postRlmSearch(mockServer.url, {
          query: 'zzznonexistentqueryzzzz',
          dir: 'get-shit-done/bin/lib',
          top_k: 5,
        });
        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.body.results, []);
      });
  });
});
