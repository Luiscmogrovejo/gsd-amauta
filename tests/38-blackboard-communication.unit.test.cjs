'use strict';
/**
 * Phase 38 -- Blackboard Communication Unit Test Suite
 * File: tests/38-blackboard-communication.unit.test.cjs
 *
 * Requirements covered:
 *   COMM-01: agent_findings blackboard table
 *   COMM-02: agent_messages table with operator supervision
 *   COMM-03: conflict resolution in operator + checker
 *   COMM-04: structured handoff JSON
 *   COMM-05: all 17 agents updated with inter-agent communication subsection
 *
 * Tests all agent file modifications from Phase 38 Waves 1 and 2:
 *   1. FORMAT-01 gate: all 17 agents have exactly 10 ## sections
 *   2. Inter-agent communication presence: all 17 have ### Inter-agent communication
 *   3. Inter-agent content identity: all 17 have the same communication text
 *   4. Conflict resolution presence: operator + checker have ### Conflict resolution
 *   5. Conflict resolution identity: matches agents/shared/conflict-resolution.md
 *   6. Operator supervision rules: all 4 message types present in operator
 *   7. Security rules identity: all agents match agents/shared/security-rules.md
 *   8. Operator supervision heading present
 *   9. Migration files exist
 *   10. Handoff utility exists and exports createHandoff
 *
 * Pure file-system reads only — no child processes, no network.
 * Uses node:test + node:assert/strict (no external test framework).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const SERVICES_DIR = path.join(ROOT, 'services');

// All 17 agent files (16 existing + gsd-architect.md from Phase 37)
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

// Helper: read agent file from project root
function readAgent(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

// Expected inter-agent communication text (verbatim from Phase 38 Wave 2)
const INTER_AGENT_TEXT = 'Write findings to the blackboard via `POST /api/findings` when you discover something other agents should know. Check for pending messages via `GET /api/messages/:your_name` before starting work. Respond to questions via `PATCH /api/messages/:id`.';

// ─── Group 1: FORMAT-01 gate — all 17 agents have exactly 10 ## sections ─────

describe('[FORMAT-01][COMM-05] All 17 agents have exactly 10 ## sections', () => {
  for (const agentFile of AGENT_FILES) {
    const filePath = path.join(ROOT, agentFile);
    it(`${agentFile} has exactly 10 ## sections`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const count = (content.match(/^## /gm) || []).length;
      assert.strictEqual(count, 10, `${agentFile} has ${count} ## sections, expected 10`);
    });
  }
});

// ─── Group 2: Inter-agent communication presence — all 17 agents ─────────────

describe('[COMM-05] Inter-agent communication: all 17 agents have ### Inter-agent communication', () => {
  for (const agentFile of AGENT_FILES) {
    it(`${agentFile} contains ### Inter-agent communication`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes('### Inter-agent communication'),
        `${agentFile} is missing ### Inter-agent communication subsection`
      );
    });
  }
});

// ─── Group 3: Inter-agent content identity — all 17 agents share same text ───

describe('[COMM-05] Inter-agent content identity: all 17 agents have identical communication text', () => {
  for (const agentFile of AGENT_FILES) {
    it(`${agentFile} inter-agent text matches canonical text`, () => {
      const content = readAgent(agentFile);
      assert.ok(
        content.includes(INTER_AGENT_TEXT),
        `${agentFile} inter-agent communication text does not match canonical:\n` +
        `Expected: "${INTER_AGENT_TEXT}"`
      );
    });
  }
});

// ─── Group 4: Conflict resolution presence — operator + checker only ──────────

describe('[COMM-03] Conflict resolution: gsd-operator and gsd-checker have ### Conflict resolution', () => {
  it('gsd-operator.md has ### Conflict resolution subsection', () => {
    const content = readAgent('agents/gsd-operator.md');
    assert.ok(
      content.includes('### Conflict resolution'),
      'gsd-operator.md missing ### Conflict resolution'
    );
  });

  it('gsd-checker.md has ### Conflict resolution subsection', () => {
    const content = readAgent('agents/gsd-checker.md');
    assert.ok(
      content.includes('### Conflict resolution'),
      'gsd-checker.md missing ### Conflict resolution'
    );
  });
});

// ─── Group 5: Conflict resolution identity — matches shared source of truth ───

describe('[COMM-03] Conflict resolution identity: operator + checker text matches agents/shared/conflict-resolution.md', () => {
  const conflictResolutionPath = path.join(AGENTS_DIR, 'shared', 'conflict-resolution.md');
  const sharedConflictResolution = fs.readFileSync(conflictResolutionPath, 'utf-8');
  // Extract bullet lines from the shared file (lines starting with "- ")
  const conflictBullets = sharedConflictResolution.split('\n').filter(l => l.startsWith('- '));

  it(`gsd-operator.md contains all ${conflictBullets.length} conflict resolution bullet lines`, () => {
    const content = readAgent('agents/gsd-operator.md');
    const missing = conflictBullets.filter(line => !content.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `gsd-operator.md missing conflict resolution bullets:\n${missing.join('\n')}`
    );
  });

  it(`gsd-checker.md contains all ${conflictBullets.length} conflict resolution bullet lines`, () => {
    const content = readAgent('agents/gsd-checker.md');
    const missing = conflictBullets.filter(line => !content.includes(line));
    assert.strictEqual(
      missing.length,
      0,
      `gsd-checker.md missing conflict resolution bullets:\n${missing.join('\n')}`
    );
  });

  it('shared conflict-resolution.md has exactly 4 bullet rules', () => {
    assert.strictEqual(conflictBullets.length, 4, `Expected 4 conflict resolution bullets, got ${conflictBullets.length}`);
  });

  it('conflict resolution has security/safety rule (checker wins)', () => {
    assert.ok(
      sharedConflictResolution.includes('checker ALWAYS wins'),
      'Missing "checker ALWAYS wins" in conflict resolution'
    );
  });

  it('conflict resolution has code correctness rule (test results authoritative)', () => {
    assert.ok(
      sharedConflictResolution.includes('test results are authoritative'),
      'Missing "test results are authoritative" in conflict resolution'
    );
  });

  it('conflict resolution has ambiguous conflict escalation rule', () => {
    assert.ok(
      sharedConflictResolution.includes('escalate to operator'),
      'Missing "escalate to operator" in conflict resolution'
    );
  });
});

// ─── Group 6: Operator supervision rules — all 4 message types ───────────────

describe('[COMM-02] Operator supervision: gsd-operator.md contains rules for all 4 message types', () => {
  const operatorContent = readAgent('agents/gsd-operator.md');

  it('gsd-operator.md contains ### Operator supervision rules heading', () => {
    assert.ok(
      operatorContent.includes('### Operator supervision rules'),
      'gsd-operator.md missing ### Operator supervision rules heading'
    );
  });

  it('gsd-operator.md has SHARE_FINDING auto-approval rule', () => {
    assert.ok(
      operatorContent.includes('SHARE_FINDING'),
      'gsd-operator.md missing SHARE_FINDING supervision rule'
    );
  });

  it('gsd-operator.md has REQUEST_REVIEW auto-approval rule', () => {
    assert.ok(
      operatorContent.includes('REQUEST_REVIEW'),
      'gsd-operator.md missing REQUEST_REVIEW supervision rule'
    );
  });

  it('gsd-operator.md has ASK_QUESTION operator-gate rule', () => {
    assert.ok(
      operatorContent.includes('ASK_QUESTION'),
      'gsd-operator.md missing ASK_QUESTION supervision rule'
    );
  });

  it('gsd-operator.md has DELEGATE_SUBTASK operator-gate rule', () => {
    assert.ok(
      operatorContent.includes('DELEGATE_SUBTASK'),
      'gsd-operator.md missing DELEGATE_SUBTASK supervision rule'
    );
  });

  it('SHARE_FINDING is auto-approved (no operator gate)', () => {
    assert.ok(
      operatorContent.includes('auto-approved') || operatorContent.includes('auto_approved'),
      'gsd-operator.md missing auto-approved designation for SHARE_FINDING'
    );
  });
});

// ─── Group 7: Security rules identity — all 17 agents match shared source ─────

describe('[SEC-04][COMM-05] Security rules identity: all 17 agents match agents/shared/security-rules.md', () => {
  const rulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
  const sharedRules = fs.readFileSync(rulesPath, 'utf-8');
  const bulletLines = sharedRules.split('\n').filter(l => l.startsWith('- '));

  it(`shared security-rules.md has 12 bullet rules (7 original + 5 supply chain)`, () => {
    assert.strictEqual(bulletLines.length, 12, `Expected 12 security rules, got ${bulletLines.length}`);
  });

  for (const agentFile of AGENT_FILES) {
    it(`${agentFile}: all 12 security rule bullets present verbatim`, () => {
      const content = readAgent(agentFile);
      const missing = bulletLines.filter(line => !content.includes(line));
      assert.strictEqual(
        missing.length,
        0,
        `${agentFile} missing security rule bullets:\n${missing.join('\n')}`
      );
    });
  }
});

// ─── Group 8: Infrastructure artifacts — migrations + handoff utility ─────────

describe('[COMM-01][COMM-02][COMM-04] Infrastructure: migration files + handoff utility present', () => {
  it('migrations/014-agent-findings.sql exists (COMM-01)', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS_DIR, '014-agent-findings.sql')),
      'migrations/014-agent-findings.sql does not exist'
    );
  });

  it('migrations/015-agent-messages.sql exists (COMM-02)', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS_DIR, '015-agent-messages.sql')),
      'migrations/015-agent-messages.sql does not exist'
    );
  });

  it('migrations/014 DOWN file exists', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS_DIR, '014-agent-findings-DOWN.sql')),
      'migrations/014-agent-findings-DOWN.sql does not exist'
    );
  });

  it('migrations/015 DOWN file exists', () => {
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS_DIR, '015-agent-messages-DOWN.sql')),
      'migrations/015-agent-messages-DOWN.sql does not exist'
    );
  });

  it('migrations/014 has agent_findings table definition', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '014-agent-findings.sql'), 'utf-8');
    assert.ok(sql.includes('agent_findings'), 'Missing agent_findings table in migration 014');
    assert.ok(sql.includes('finding_type'), 'Missing finding_type column in migration 014');
    assert.ok(sql.includes('confidence'), 'Missing confidence column in migration 014');
    assert.ok(sql.includes('idx_findings_task'), 'Missing idx_findings_task index in migration 014');
  });

  it('migrations/015 has agent_messages table definition', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '015-agent-messages.sql'), 'utf-8');
    assert.ok(sql.includes('agent_messages'), 'Missing agent_messages table in migration 015');
    assert.ok(sql.includes('message_type'), 'Missing message_type column in migration 015');
    assert.ok(sql.includes('operator_approved'), 'Missing operator_approved column in migration 015');
    assert.ok(sql.includes('idx_messages_task'), 'Missing idx_messages_task index in migration 015');
    assert.ok(sql.includes('idx_messages_to'), 'Missing idx_messages_to index in migration 015');
  });

  it('services/handoff.cjs exists (COMM-04)', () => {
    assert.ok(
      fs.existsSync(path.join(SERVICES_DIR, 'handoff.cjs')),
      'services/handoff.cjs does not exist'
    );
  });

  it('services/handoff.cjs exports createHandoff function', () => {
    const { createHandoff } = require(path.join(SERVICES_DIR, 'handoff.cjs'));
    assert.ok(typeof createHandoff === 'function', 'createHandoff must be a function');
  });

  it('services/handoff.cjs exports estimateTokens function', () => {
    const { estimateTokens } = require(path.join(SERVICES_DIR, 'handoff.cjs'));
    assert.ok(typeof estimateTokens === 'function', 'estimateTokens must be a function');
  });
});

// ─── Group 9: agents/shared/conflict-resolution.md source of truth ───────────

describe('[COMM-03] agents/shared/conflict-resolution.md: source of truth format', () => {
  const conflictResolutionPath = path.join(AGENTS_DIR, 'shared', 'conflict-resolution.md');
  const sharedConflict = fs.readFileSync(conflictResolutionPath, 'utf-8');

  it('conflict-resolution.md exists', () => {
    assert.ok(fs.existsSync(conflictResolutionPath), 'agents/shared/conflict-resolution.md does not exist');
  });

  it('conflict-resolution.md starts with ## Conflict resolution heading', () => {
    assert.ok(
      sharedConflict.trim().startsWith('## Conflict resolution'),
      'conflict-resolution.md must start with ## Conflict resolution heading'
    );
  });

  it('conflict-resolution.md has style/approach disagreement rule (executor deference)', () => {
    assert.ok(
      sharedConflict.includes('executor gets deference'),
      'Missing executor deference rule in conflict-resolution.md'
    );
  });
});

// ─── Group 10: Pact contract files exist (COMM-01, COMM-02) ──────────────────

describe('[COMM-01][COMM-02] Pact contract files: findings-crud + messages-crud exist', () => {
  const PACT_DIR = path.join(ROOT, 'tests', 'pact');

  it('tests/pact/findings-crud.pact.cjs exists', () => {
    assert.ok(
      fs.existsSync(path.join(PACT_DIR, 'findings-crud.pact.cjs')),
      'tests/pact/findings-crud.pact.cjs does not exist'
    );
  });

  it('tests/pact/messages-crud.pact.cjs exists', () => {
    assert.ok(
      fs.existsSync(path.join(PACT_DIR, 'messages-crud.pact.cjs')),
      'tests/pact/messages-crud.pact.cjs does not exist'
    );
  });

  it('findings-crud.pact.cjs covers POST /api/findings', () => {
    const content = fs.readFileSync(path.join(PACT_DIR, 'findings-crud.pact.cjs'), 'utf-8');
    assert.ok(content.includes('/api/findings'), 'findings-crud.pact.cjs missing /api/findings endpoint');
    assert.ok(content.includes('POST'), 'findings-crud.pact.cjs missing POST method');
  });

  it('messages-crud.pact.cjs covers SHARE_FINDING auto-approval', () => {
    const content = fs.readFileSync(path.join(PACT_DIR, 'messages-crud.pact.cjs'), 'utf-8');
    assert.ok(content.includes('SHARE_FINDING'), 'messages-crud.pact.cjs missing SHARE_FINDING interaction');
    assert.ok(content.includes('auto_approved'), 'messages-crud.pact.cjs missing auto_approved field');
  });

  it('messages-crud.pact.cjs covers DELEGATE_SUBTASK (not auto-approved)', () => {
    const content = fs.readFileSync(path.join(PACT_DIR, 'messages-crud.pact.cjs'), 'utf-8');
    assert.ok(content.includes('DELEGATE_SUBTASK'), 'messages-crud.pact.cjs missing DELEGATE_SUBTASK interaction');
  });
});
