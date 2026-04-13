#!/usr/bin/env node
'use strict';
/**
 * Pact contract: gsd-tools (consumer) → amauta-daemon (provider)
 * Endpoint: POST /api/context/compact
 * Pact broker: local file-based (pacts/ directory — no external service required)
 *
 * Consumer: gsd-tools.cjs / gsd-amauta.cjs (CLI that calls daemon HTTP API)
 * Provider: amauta-daemon.py
 *
 * Run: node --test tests/pact/context-compact.pact.cjs
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
function postCompact(baseUrl, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL('/api/context/compact', baseUrl);
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

describe('POST /api/context/compact — context compaction contract', () => {
  // Interaction 1: valid compact request
  it('returns compiled_view for a valid messages array', async () => {
    await provider
      .given('daemon is running with PG connection')
      .uponReceiving('a context compact request with valid messages')
      .withRequest({
        method: 'POST',
        path: '/api/context/compact',
        headers: { 'Content-Type': 'application/json' },
        body: {
          task_id: string('TK-0001'),
          phase: string('R'),
          messages: [
            { role: string('user'), content: string('What does task-store.cjs do?') },
          ],
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          compiled_view: string(''),
          context_version: integer(1),
          stored: like(false),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await postCompact(mockServer.url, {
          task_id: 'TK-0001',
          phase: 'R',
          messages: [{ role: 'user', content: 'What does task-store.cjs do?' }],
        });
        assert.strictEqual(result.status, 200);
      });
  });

  // Interaction 2: missing task_id → 400
  it('returns 400 when task_id is missing', async () => {
    await provider
      .given('daemon is running')
      .uponReceiving('a compact request missing task_id')
      .withRequest({
        method: 'POST',
        path: '/api/context/compact',
        headers: { 'Content-Type': 'application/json' },
        body: { messages: [{ role: 'user', content: 'test' }] },
      })
      .willRespondWith({
        status: 400,
        body: { error: string('task_id is required') },
      })
      .executeTest(async (mockServer) => {
        const result = await postCompact(mockServer.url, {
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.strictEqual(result.status, 400);
      });
  });

  // Interaction 3: missing messages → 400
  it('returns 400 when messages (list) is required', async () => {
    await provider
      .given('daemon is running')
      .uponReceiving('a compact request missing messages')
      .withRequest({
        method: 'POST',
        path: '/api/context/compact',
        headers: { 'Content-Type': 'application/json' },
        body: { task_id: 'TK-0001', phase: 'R' },
      })
      .willRespondWith({
        status: 400,
        body: { error: string('messages (list) is required') },
      })
      .executeTest(async (mockServer) => {
        const result = await postCompact(mockServer.url, {
          task_id: 'TK-0001',
          phase: 'R',
        });
        assert.strictEqual(result.status, 400);
      });
  });
});
