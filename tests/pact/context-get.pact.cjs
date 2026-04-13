#!/usr/bin/env node
'use strict';
/**
 * Pact contract: gsd-tools (consumer) → amauta-daemon (provider)
 * Endpoint: GET /api/context/:task_id/:phase
 * Pact broker: local file-based (pacts/ directory — no external service required)
 *
 * Consumer: gsd-tools.cjs / gsd-amauta.cjs (CLI that calls daemon HTTP API)
 * Provider: amauta-daemon.py
 *
 * Run: node --test tests/pact/context-get.pact.cjs
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

// Helper: GET request to mock server using Node built-in http (no axios/fetch — portable)
function getContext(baseUrl, taskId, phase) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/context/${taskId}/${phase}`, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
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
    req.end();
  });
}

describe('GET /api/context/:task_id/:phase — stored context retrieval contract', () => {
  // Interaction 1: valid GET for existing context
  it('returns context object for existing task and valid phase', async () => {
    await provider
      .given('daemon is running with stored context for TK-0001/R')
      .uponReceiving('a GET context request for existing task_id and phase')
      .withRequest({
        method: 'GET',
        path: '/api/context/TK-0001/R',
        headers: { 'Content-Type': 'application/json' },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          task_id: string('TK-0001'),
          phase: string('R'),
          content: like('Research phase content'),
          timestamp: like('2026-04-13T00:00:00.000Z'),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await getContext(mockServer.url, 'TK-0001', 'R');
        assert.strictEqual(result.status, 200);
        assert.ok(result.body.task_id, 'task_id should be present');
        assert.ok(result.body.phase, 'phase should be present');
      });
  });

  // Interaction 2: invalid phase letter → 400
  it('returns 400 when phase is not a valid RPETD letter', async () => {
    await provider
      .given('daemon is running')
      .uponReceiving('a GET context request with invalid phase letter X')
      .withRequest({
        method: 'GET',
        path: '/api/context/TK-0001/X',
        headers: { 'Content-Type': 'application/json' },
      })
      .willRespondWith({
        status: 400,
        body: { error: string('invalid phase: must be one of R, P, E, T, D') },
      })
      .executeTest(async (mockServer) => {
        const result = await getContext(mockServer.url, 'TK-0001', 'X');
        assert.strictEqual(result.status, 400);
      });
  });

  // Interaction 3: task not found → 404
  it('returns 404 when task_id does not exist', async () => {
    await provider
      .given('daemon is running with no context for TK-NOTEXIST')
      .uponReceiving('a GET context request for a non-existent task_id')
      .withRequest({
        method: 'GET',
        path: '/api/context/TK-NOTEXIST/R',
        headers: { 'Content-Type': 'application/json' },
      })
      .willRespondWith({
        status: 404,
        body: { error: string('context not found for task TK-NOTEXIST phase R') },
      })
      .executeTest(async (mockServer) => {
        const result = await getContext(mockServer.url, 'TK-NOTEXIST', 'R');
        assert.strictEqual(result.status, 404);
      });
  });
});
