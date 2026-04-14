#!/usr/bin/env node
'use strict';
/**
 * Pact contract: gsd-tools (consumer) → amauta-daemon (provider)
 * Endpoints: POST /api/messages, GET /api/messages/:agent_name, PATCH /api/messages/:id
 * Pact broker: local file-based (pacts/ directory — no external service required)
 *
 * Consumer: gsd-tools.cjs / agents (send and receive inter-agent messages)
 * Provider: amauta-daemon.py
 *
 * Run: node --test tests/pact/messages-crud.pact.cjs
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

// Helper: POST JSON body to mock server
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

// Helper: GET request to mock server
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

// Helper: PATCH JSON body to mock server
function patchJson(baseUrl, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'PATCH',
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

describe('messages CRUD endpoints — inter-agent communication contract', () => {
  // Interaction 1: POST /api/messages with SHARE_FINDING type → auto_approved: true
  it('sends a SHARE_FINDING message and receives auto-approval', async () => {
    await provider
      .given('daemon is running and agent_messages table exists')
      .uponReceiving('a POST messages request with SHARE_FINDING type')
      .withRequest({
        method: 'POST',
        path: '/api/messages',
        headers: { 'Content-Type': 'application/json' },
        body: {
          from_agent: 'executor-backend',
          to_agent: 'operator',
          task_id: 'TK-0001',
          message_type: 'SHARE_FINDING',
          content: 'Identified N+1 query in the users endpoint',
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: like('550e8400-e29b-41d4-a716-446655440000'),
          created: like(true),
          auto_approved: like(true),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await postJson(mockServer.url, '/api/messages', {
          from_agent: 'executor-backend',
          to_agent: 'operator',
          task_id: 'TK-0001',
          message_type: 'SHARE_FINDING',
          content: 'Identified N+1 query in the users endpoint',
        });
        assert.strictEqual(result.status, 200);
        assert.ok(result.body.id, 'id should be present');
        assert.strictEqual(result.body.created, true, 'created should be true');
        assert.strictEqual(result.body.auto_approved, true, 'SHARE_FINDING should be auto-approved');
      });
  });

  // Interaction 2: GET /api/messages/:agent_name → 200 + array of pending messages
  it('retrieves pending messages for a given agent', async () => {
    await provider
      .given('daemon is running with pending messages for executor-backend')
      .uponReceiving('a GET messages request for agent executor-backend')
      .withRequest({
        method: 'GET',
        path: '/api/messages/executor-backend',
        headers: { 'Content-Type': 'application/json' },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: like([
          {
            id: like('550e8400-e29b-41d4-a716-446655440000'),
            from_agent: string('operator'),
            to_agent: string('executor-backend'),
            task_id: string('TK-0001'),
            message_type: string('ASK_QUESTION'),
            content: like('Is the migration reversible?'),
            status: string('approved'),
            operator_approved: like(true),
            created_at: like('2026-04-14T00:00:00.000Z'),
          },
        ]),
      })
      .executeTest(async (mockServer) => {
        const result = await getJson(mockServer.url, '/api/messages/executor-backend');
        assert.strictEqual(result.status, 200);
        assert.ok(Array.isArray(result.body), 'response should be an array');
        assert.ok(result.body.length >= 1, 'should have at least one message');
        assert.ok(result.body[0].from_agent, 'message should have from_agent');
        assert.ok(result.body[0].message_type, 'message should have message_type');
      });
  });

  // Interaction 3: PATCH /api/messages/:id with approve action → 200 + {updated: true}
  it('approves a pending message by id', async () => {
    await provider
      .given('daemon is running with a pending message id msg-0001')
      .uponReceiving('a PATCH messages request to approve message msg-0001')
      .withRequest({
        method: 'PATCH',
        path: '/api/messages/msg-0001',
        headers: { 'Content-Type': 'application/json' },
        body: {
          status: 'approved',
          operator_approved: true,
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          updated: like(true),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await patchJson(mockServer.url, '/api/messages/msg-0001', {
          status: 'approved',
          operator_approved: true,
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.updated, true, 'updated should be true');
      });
  });

  // Interaction 4: POST /api/messages with DELEGATE_SUBTASK → auto_approved: false (operator review required)
  it('sends a DELEGATE_SUBTASK message and receives pending status (not auto-approved)', async () => {
    await provider
      .given('daemon is running and agent_messages table exists')
      .uponReceiving('a POST messages request with DELEGATE_SUBTASK type')
      .withRequest({
        method: 'POST',
        path: '/api/messages',
        headers: { 'Content-Type': 'application/json' },
        body: {
          from_agent: 'executor-backend',
          to_agent: 'executor-frontend',
          task_id: 'TK-0001',
          message_type: 'DELEGATE_SUBTASK',
          content: 'Please update the UI to display the new endpoint response',
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: like('550e8400-e29b-41d4-a716-446655440001'),
          created: like(true),
          auto_approved: like(false),
        },
      })
      .executeTest(async (mockServer) => {
        const result = await postJson(mockServer.url, '/api/messages', {
          from_agent: 'executor-backend',
          to_agent: 'executor-frontend',
          task_id: 'TK-0001',
          message_type: 'DELEGATE_SUBTASK',
          content: 'Please update the UI to display the new endpoint response',
        });
        assert.strictEqual(result.status, 200);
        assert.ok(result.body.id, 'id should be present');
        assert.strictEqual(result.body.created, true, 'created should be true');
        assert.strictEqual(result.body.auto_approved, false, 'DELEGATE_SUBTASK should NOT be auto-approved');
      });
  });
});
