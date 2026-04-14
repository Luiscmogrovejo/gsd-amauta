'use strict';
/**
 * Phase 38 -- Blackboard Communication Integration Test Suite
 * File: tests/38-blackboard-communication.integration.test.cjs
 *
 * Requirements covered:
 *   COMM-01: agent_findings round-trip (POST + GET)
 *   COMM-02: agent_messages round-trip + auto-approval (POST + GET + PATCH)
 *   COMM-03: conflict resolution in operator + checker
 *   COMM-04: handoff endpoint E2E (POST /api/handoff)
 *   COMM-05: 17-agent regression gate + Pact contract gate
 *
 * Architecture:
 *   - Non-E2E tests (file reads, section counts) always run — no daemon needed
 *   - E2E tests guarded by E2E_BASE_URL env var (conditional skip pattern)
 *   - NODE_TEST_CONTEXT deleted via cleanEnv() before spawning inner processes
 *   - spawnSync at describe-block level for run-once-reuse pattern
 *
 * Run E2E:  E2E_BASE_URL=http://127.0.0.1:18799 node --test tests/38-blackboard-communication.integration.test.cjs
 * Run fast: node --test tests/38-blackboard-communication.integration.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');

// ─── Helper: clean subprocess env (prevents NODE_TEST_CONTEXT recursive detection) ──

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ─── Helper: HTTP request (node built-in, no external deps) ──────────────────

function httpRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── All 17 agent files ───────────────────────────────────────────────────────

const AGENT_FILES = [
  'agents/gsd-operator.md',
  'agents/gsd-planner.md',
  'agents/gsd-researcher.md',
  'agents/gsd-roadmapper.md',
  'agents/gsd-checker.md',
  'agents/gsd-validator.md',
  'agents/gsd-debugger.md',
  'agents/gsd-executor-backend.md',
  'agents/gsd-executor-frontend.md',
  'agents/gsd-executor-infra.md',
  'agents/gsd-executor-general.md',
  'agents/gsd-tester.md',
  'agents/gsd-qa.md',
  'agents/gsd-security.md',
  'agents/gsd-reviewer.md',
  'agents/gsd-executor-data.md',
  'agents/gsd-architect.md',
];

// ─── Group 1: 17-agent regression gate (always runs, no E2E needed) ──────────

describe('[FORMAT-01][COMM-05] 17-agent regression gate: section count + inter-agent communication', () => {
  for (const agentFile of AGENT_FILES) {
    const filePath = path.join(PROJECT_ROOT, agentFile);
    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} ## sections, expected 10`);
    });
  }

  for (const agentFile of AGENT_FILES) {
    it(`${agentFile} has ### Inter-agent communication subsection`, () => {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      assert.ok(
        content.includes('### Inter-agent communication'),
        `${agentFile} missing ### Inter-agent communication`
      );
    });
  }
});

// ─── Group 2: Conflict resolution identity (always runs) ─────────────────────

describe('[COMM-03] Conflict resolution identity: operator + checker vs shared source', () => {
  const conflictPath = path.join(AGENTS_DIR, 'shared', 'conflict-resolution.md');
  const sharedConflict = fs.readFileSync(conflictPath, 'utf-8');
  const conflictBullets = sharedConflict.split('\n').filter(l => l.startsWith('- '));

  it('gsd-operator.md contains all conflict resolution bullets', () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'agents/gsd-operator.md'), 'utf-8');
    const missing = conflictBullets.filter(line => !content.includes(line));
    assert.strictEqual(missing.length, 0, `Operator missing bullets:\n${missing.join('\n')}`);
  });

  it('gsd-checker.md contains all conflict resolution bullets', () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'agents/gsd-checker.md'), 'utf-8');
    const missing = conflictBullets.filter(line => !content.includes(line));
    assert.strictEqual(missing.length, 0, `Checker missing bullets:\n${missing.join('\n')}`);
  });

  it('gsd-operator.md has Operator supervision rules for all 4 message types', () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'agents/gsd-operator.md'), 'utf-8');
    const messageTypes = ['SHARE_FINDING', 'REQUEST_REVIEW', 'ASK_QUESTION', 'DELEGATE_SUBTASK'];
    for (const msgType of messageTypes) {
      assert.ok(content.includes(msgType), `gsd-operator.md missing supervision rule for ${msgType}`);
    }
  });
});

// ─── Group 3: Security rules identity (always runs) ──────────────────────────

describe('[SEC-04][COMM-05] Security rules identity: all 17 agents match shared source', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));

  it(`shared security-rules.md has ${bulletLines.length} bullet rules`, () => {
    assert.strictEqual(bulletLines.length, 12, `Expected 12 security rules, got ${bulletLines.length}`);
  });

  for (const agentFile of AGENT_FILES) {
    it(`${agentFile}: security rules match shared source`, () => {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, agentFile), 'utf-8');
      const missing = bulletLines.filter(line => !content.includes(line));
      assert.strictEqual(
        missing.length,
        0,
        `${agentFile} missing security rule bullets:\n${missing.join('\n')}`
      );
    });
  }
});

// ─── Group 4: Pact contract gate (always runs) ───────────────────────────────
// spawnSync at describe level for run-once-reuse pattern

const findingsContractResult = spawnSync(
  'node',
  ['--test', 'tests/pact/findings-crud.pact.cjs'],
  { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv() }
);

const messagesContractResult = spawnSync(
  'node',
  ['--test', 'tests/pact/messages-crud.pact.cjs'],
  { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv() }
);

describe('[COMM-01][COMM-02] Pact contract gate: findings-crud + messages-crud pass', () => {
  it('pact/findings-crud.pact.cjs exits 0 (all interactions verified)', () => {
    assert.strictEqual(
      findingsContractResult.status,
      0,
      `findings-crud.pact.cjs exited ${findingsContractResult.status}:\n` +
      `stdout: ${findingsContractResult.stdout.slice(-2000)}\n` +
      `stderr: ${findingsContractResult.stderr.slice(-1000)}`
    );
  });

  it('pact/messages-crud.pact.cjs exits 0 (all interactions verified)', () => {
    assert.strictEqual(
      messagesContractResult.status,
      0,
      `messages-crud.pact.cjs exited ${messagesContractResult.status}:\n` +
      `stdout: ${messagesContractResult.stdout.slice(-2000)}\n` +
      `stderr: ${messagesContractResult.stderr.slice(-1000)}`
    );
  });

  it('findings-crud covers POST /api/findings and GET /api/findings/:task_id', () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'tests/pact/findings-crud.pact.cjs'), 'utf-8');
    assert.ok(content.includes('/api/findings'), 'findings-crud missing /api/findings path');
    assert.ok(content.includes("'POST'") || content.includes('"POST"'), 'findings-crud missing POST method');
    assert.ok(content.includes("'GET'") || content.includes('"GET"'), 'findings-crud missing GET method');
  });

  it('messages-crud covers SHARE_FINDING auto-approval + DELEGATE_SUBTASK pending', () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'tests/pact/messages-crud.pact.cjs'), 'utf-8');
    assert.ok(content.includes('SHARE_FINDING'), 'messages-crud missing SHARE_FINDING');
    assert.ok(content.includes('DELEGATE_SUBTASK'), 'messages-crud missing DELEGATE_SUBTASK');
    assert.ok(content.includes('auto_approved'), 'messages-crud missing auto_approved field');
  });
});

// ─── Group 5: E2E — findings round-trip flow (conditional on E2E_BASE_URL) ───

describe('[COMM-01] E2E: findings round-trip flow (POST + GET + 400 errors)', () => {
  const BASE_URL = process.env.E2E_BASE_URL;

  if (!BASE_URL) {
    it('[skip] E2E_BASE_URL not set — skipping live findings round-trip tests', () => {
      console.log('[skip] E2E_BASE_URL not set — set it to run live blackboard tests');
    });
  } else {
    it('POST /api/findings with valid body returns 200 + {id, created: true}', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/findings`, {
        agent_name: 'gsd-executor-backend',
        task_id: 'TK-38-INTEGRATION-TEST',
        finding_type: 'observation',
        content: 'Integration test finding — round-trip verification',
        confidence: 0.9,
      });
      assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}`);
      assert.ok(result.body.id, 'Response must include id');
      assert.strictEqual(result.body.created, true, 'created must be true');
    });

    it('GET /api/findings/:task_id returns array with the posted finding', async () => {
      const result = await httpRequest('GET', `${BASE_URL}/api/findings/TK-38-INTEGRATION-TEST`);
      assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}`);
      assert.ok(Array.isArray(result.body), 'Response must be an array');
      assert.ok(result.body.length >= 1, 'Must have at least 1 finding for TK-38-INTEGRATION-TEST');
      assert.ok(
        result.body.some(f => f.finding_type === 'observation'),
        'Must include the observation finding we posted'
      );
    });

    it('POST /api/findings with missing required field returns 400', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/findings`, {
        agent_name: 'gsd-executor-backend',
        task_id: 'TK-38-INTEGRATION-TEST',
        // finding_type and content intentionally missing
      });
      assert.strictEqual(result.status, 400, `Expected 400, got ${result.status}`);
      assert.ok(result.body.error, 'Response must include error field');
    });

    it('POST /api/findings with invalid finding_type returns 400', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/findings`, {
        agent_name: 'gsd-executor-backend',
        task_id: 'TK-38-INTEGRATION-TEST',
        finding_type: 'invalid_type',
        content: 'This should fail',
      });
      assert.strictEqual(result.status, 400, `Expected 400 for invalid finding_type, got ${result.status}`);
    });

    it('GET /api/findings for non-existent task_id returns empty array (not 404)', async () => {
      const result = await httpRequest('GET', `${BASE_URL}/api/findings/TK-NONEXISTENT-99999`);
      assert.strictEqual(result.status, 200, `Expected 200 for non-existent task, got ${result.status}`);
      assert.ok(Array.isArray(result.body), 'Response must be an array');
      assert.strictEqual(result.body.length, 0, 'Non-existent task_id must return empty array');
    });
  }
});

// ─── Group 6: E2E — messages round-trip flow + auto-approval ─────────────────

describe('[COMM-02] E2E: messages round-trip flow — SHARE_FINDING auto-approval + DELEGATE_SUBTASK pending', () => {
  const BASE_URL = process.env.E2E_BASE_URL;

  if (!BASE_URL) {
    it('[skip] E2E_BASE_URL not set — skipping live messages round-trip tests', () => {
      console.log('[skip] E2E_BASE_URL not set — set it to run live blackboard tests');
    });
  } else {
    it('POST /api/messages with SHARE_FINDING returns auto_approved: true', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/messages`, {
        from_agent: 'gsd-executor-backend',
        to_agent: 'gsd-operator',
        task_id: 'TK-38-INTEGRATION-TEST',
        message_type: 'SHARE_FINDING',
        content: 'Integration test: SHARE_FINDING auto-approval verification',
      });
      assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}`);
      assert.ok(result.body.id, 'id must be present');
      assert.strictEqual(result.body.created, true, 'created must be true');
      assert.strictEqual(result.body.auto_approved, true, 'SHARE_FINDING must be auto-approved');
    });

    it('POST /api/messages with DELEGATE_SUBTASK returns auto_approved: false', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/messages`, {
        from_agent: 'gsd-executor-backend',
        to_agent: 'gsd-executor-frontend',
        task_id: 'TK-38-INTEGRATION-TEST',
        message_type: 'DELEGATE_SUBTASK',
        content: 'Integration test: DELEGATE_SUBTASK requires operator approval',
      });
      assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}`);
      assert.ok(result.body.id, 'id must be present');
      assert.strictEqual(result.body.auto_approved, false, 'DELEGATE_SUBTASK must NOT be auto-approved');
    });

    let postedMessageId;

    it('POST /api/messages with ASK_QUESTION returns auto_approved: false', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/messages`, {
        from_agent: 'gsd-executor-backend',
        to_agent: 'gsd-operator',
        task_id: 'TK-38-INTEGRATION-TEST',
        message_type: 'ASK_QUESTION',
        content: 'Integration test: is migration 014 idempotent?',
      });
      assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}`);
      assert.ok(result.body.id, 'id must be present');
      assert.strictEqual(result.body.auto_approved, false, 'ASK_QUESTION must NOT be auto-approved');
      postedMessageId = result.body.id;
    });

    it('GET /api/messages/:agent_name returns pending messages for that agent', async () => {
      const result = await httpRequest('GET', `${BASE_URL}/api/messages/gsd-operator`);
      assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}`);
      assert.ok(Array.isArray(result.body), 'Response must be an array');
      // Must have at least the messages we sent to gsd-operator
      assert.ok(result.body.length >= 1, 'Must have at least 1 message for gsd-operator');
    });

    it('PATCH /api/messages/:id with approve updates status to approved', async () => {
      if (!postedMessageId) {
        console.log('[skip] No message id from prior test — skipping PATCH test');
        return;
      }
      const result = await httpRequest('PATCH', `${BASE_URL}/api/messages/${postedMessageId}`, {
        status: 'approved',
        operator_approved: true,
      });
      assert.strictEqual(result.status, 200, `Expected 200 for PATCH, got ${result.status}`);
      assert.strictEqual(result.body.updated, true, 'updated must be true');
    });

    it('PATCH /api/messages/:id with respond stores response text', async () => {
      if (!postedMessageId) {
        console.log('[skip] No message id from prior test — skipping respond PATCH test');
        return;
      }
      const result = await httpRequest('PATCH', `${BASE_URL}/api/messages/${postedMessageId}`, {
        response: 'Yes, migration 014 is idempotent — BEGIN/COMMIT with conditional CREATE.',
      });
      assert.strictEqual(result.status, 200, `Expected 200 for PATCH respond, got ${result.status}`);
      assert.strictEqual(result.body.updated, true, 'updated must be true');
    });
  }
});

// ─── Group 7: E2E — handoff endpoint round-trip ───────────────────────────────

describe('[COMM-04] E2E: POST /api/handoff — structured JSON returned', () => {
  const BASE_URL = process.env.E2E_BASE_URL;

  if (!BASE_URL) {
    it('[skip] E2E_BASE_URL not set — skipping live handoff endpoint test', () => {
      console.log('[skip] E2E_BASE_URL not set — set it to run live handoff test');
    });
  } else {
    it('POST /api/handoff with valid body returns structured JSON (handoff + truncated + estimated_tokens)', async () => {
      const result = await httpRequest('POST', `${BASE_URL}/api/handoff`, {
        task_id: 'TK-38-INTEGRATION-TEST',
        from_agent: 'gsd-executor-backend',
        handoff_type: 'phase_complete',
        summary: 'Phase 38 Wave 1 complete. Migrations 014+015 applied, handoff.cjs created.',
        key_findings: [
          { text: 'Migration 014 applied successfully.', confidence: 0.95 },
          { text: 'Migration 015 applied successfully.', confidence: 0.9 },
        ],
      });
      assert.strictEqual(result.status, 200, `Expected 200 for POST /api/handoff, got ${result.status}`);
      assert.ok(result.body.handoff, 'Response must include handoff object');
      assert.ok(typeof result.body.truncated === 'boolean', 'Response must include truncated boolean');
      assert.ok(typeof result.body.estimated_tokens === 'number', 'Response must include estimated_tokens');
      assert.strictEqual(result.body.handoff.task_id, 'TK-38-INTEGRATION-TEST');
      assert.strictEqual(result.body.handoff.handoff_type, 'phase_complete');
    });
  }
});

// ─── Group 8: Prior-phase regression gates ───────────────────────────────────
// spawnSync at describe-block level for run-once-reuse efficiency

const priorSuites = [
  { name: '40-engineering-standards.unit.test.cjs', label: 'ENG-01..05' },
  { name: '37-architect-agent.unit.test.cjs', label: 'ARCH-01..03' },
  { name: '36-data-engineering-agent.unit.test.cjs', label: 'DATA-01..04' },
  { name: '35-code-review-agent.unit.test.cjs', label: 'REVIEW-01..04' },
];

const priorResults = priorSuites.map(suite => ({
  ...suite,
  result: spawnSync(
    'node',
    ['--test', `tests/${suite.name}`],
    { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120000, env: cleanEnv() }
  ),
}));

describe('[COMM-05] Prior-phase regression gates: Phases 35, 36, 37, 40 unit suites still pass', () => {
  for (const { name, label, result } of priorResults) {
    it(`[${label}] ${name} exits 0 (no regressions)`, () => {
      assert.strictEqual(
        result.status,
        0,
        `${name} exited ${result.status}:\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-1000)}`
      );
    });
  }
});

// ─── Group 9: Phase 38 unit suites pass ──────────────────────────────────────

const phase38HandoffResult = spawnSync(
  'node',
  ['--test', 'tests/38-handoff-utility.unit.test.cjs'],
  { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv() }
);

const phase38UnitResult = spawnSync(
  'node',
  ['--test', 'tests/38-blackboard-communication.unit.test.cjs'],
  { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env: cleanEnv() }
);

describe('[COMM-01..05] Phase 38 unit suites: handoff utility + blackboard communication pass', () => {
  it('38-handoff-utility.unit.test.cjs exits 0 (0 failures)', () => {
    assert.strictEqual(
      phase38HandoffResult.status,
      0,
      `38-handoff-utility.unit.test.cjs exited ${phase38HandoffResult.status}:\n` +
      `stdout: ${phase38HandoffResult.stdout.slice(-2000)}\nstderr: ${phase38HandoffResult.stderr.slice(-1000)}`
    );
  });

  it('38-blackboard-communication.unit.test.cjs exits 0 (0 failures)', () => {
    assert.strictEqual(
      phase38UnitResult.status,
      0,
      `38-blackboard-communication.unit.test.cjs exited ${phase38UnitResult.status}:\n` +
      `stdout: ${phase38UnitResult.stdout.slice(-2000)}\nstderr: ${phase38UnitResult.stderr.slice(-1000)}`
    );
  });

  it('38-handoff-utility.unit.test.cjs pass count >= 20', () => {
    const passMatch = (phase38HandoffResult.stdout.match(/pass (\d+)/) || [])[1];
    const passCount = parseInt(passMatch || '0', 10);
    assert.ok(passCount >= 20, `Expected >= 20 passes in handoff utility test, got ${passCount}`);
  });

  it('38-blackboard-communication.unit.test.cjs pass count >= 50', () => {
    const passMatch = (phase38UnitResult.stdout.match(/pass (\d+)/) || [])[1];
    const passCount = parseInt(passMatch || '0', 10);
    assert.ok(passCount >= 50, `Expected >= 50 passes in blackboard communication unit test, got ${passCount}`);
  });
});
