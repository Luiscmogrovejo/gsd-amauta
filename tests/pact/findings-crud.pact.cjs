#!/usr/bin/env node
'use strict';
/**
 * Pact contract: gsd-tools (consumer) → amauta-daemon (provider)
 * Endpoints: POST /api/findings, GET /api/findings/:task_id
 * Pact broker: local file-based (pacts/ directory — no external service required)
 *
 * Consumer: gsd-tools.cjs / agents (write and read blackboard findings)
 * Provider: amauta-daemon.py
 *
 * Run: node --test tests/pact/findings-crud.pact.cjs
 */

const { PactV3, MatchersV3 } = require('@pact-foundation/pact');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const path = require('path');
const http = require('http');

const { like, string } = MatchersV3;

const provider = new PactV3({
  consumer: 'gsd-tools',
  provider: 'amauta-daemon',
  dir: path.join(__dirname, '..', '..', 'pacts'),
  logLevel: 'warn',
});

// Helper: POST JSON body to mock server using Node built-in http
function postJson(baseUrl, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
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
    req.write(bodyStr);
    req.end();
  });
}

// Helper: GET request to mock server using Node built-in http
function getJson(baseUrl, urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
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

describe('findings CRUD endpoints — blackboard write/read contract', () => {
  // Interaction 1: POST /api/findings with valid body → 200 + {id, created: true}
  it('writes a finding to the blackboard with valid body', async () => {
    await provider
      .given('daemon is running and agent_findings table exists')
      .uponReceiving('a POST findings request with valid agent_name, task_id, finding_type, content')
      .withRequest({
        method: 'POST',
        path: '/api/findings',
        headers: { 'Content-Type': 'application/json' },
        body: {
          agent_name: 'executor-backend',
          task_id: 'TK-0001',
          finding_type: 'observation',
          content: 'Found N+1 query in users endpoint',
          confidence: 0.9,
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: like('550e8400-e29b-41d4-a716-446655440000'),
          created: like(true),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await postJson(mockServer.url, '/api/findings', {
          agent_name: 'executor-backend',
          task_id: 'TK-0001',
          finding_type: 'observation',
          content: 'Found N+1 query in users endpoint',
          confidence: 0.9,
        });
        assert.strictEqual(result.status, 200);
        assert.ok(result.body.id, 'id should be present');
        assert.strictEqual(result.body.created, true, 'created should be true');
      });
  });

  // Interaction 2: GET /api/findings/:task_id with existing findings → 200 + array
  it('retrieves findings for an existing task_id', async () => {
    await provider
      .given('daemon is running with findings for TK-0001')
      .uponReceiving('a GET findings request for existing task_id TK-0001')
      .withRequest({
        method: 'GET',
        path: '/api/findings/TK-0001',
        headers: { 'Content-Type': 'application/json' },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: like([
          {
            id: like('550e8400-e29b-41d4-a716-446655440000'),
            agent_name: string('executor-backend'),
            task_id: string('TK-0001'),
            finding_type: string('observation'),
            content: like('Found N+1 query in users endpoint'),
            confidence: like(0.9),
            created_at: like('2026-04-14T00:00:00.000Z'),
          },
        ]),
      })
      .executeTest(async (mockServer) => {
        const result = await getJson(mockServer.url, '/api/findings/TK-0001');
        assert.strictEqual(result.status, 200);
        assert.ok(Array.isArray(result.body), 'response body should be an array');
        assert.ok(result.body.length >= 1, 'should return at least one finding');
        assert.ok(result.body[0].agent_name, 'finding should have agent_name');
        assert.ok(result.body[0].finding_type, 'finding should have finding_type');
      });
  });

  // Interaction 3: POST /api/findings with missing required field → 400 + error
  it('returns 400 when a required field is missing', async () => {
    await provider
      .given('daemon is running')
      .uponReceiving('a POST findings request missing the required content field')
      .withRequest({
        method: 'POST',
        path: '/api/findings',
        headers: { 'Content-Type': 'application/json' },
        body: {
          agent_name: 'executor-backend',
          task_id: 'TK-0001',
          finding_type: 'observation',
          // content intentionally missing
        },
      })
      .willRespondWith({
        status: 400,
        body: { error: string('missing required field: content') },
      })
      .executeTest(async (mockServer) => {
        const result = await postJson(mockServer.url, '/api/findings', {
          agent_name: 'executor-backend',
          task_id: 'TK-0001',
          finding_type: 'observation',
        });
        assert.strictEqual(result.status, 400);
        assert.ok(result.body.error, 'error message should be present');
      });
  });
});
