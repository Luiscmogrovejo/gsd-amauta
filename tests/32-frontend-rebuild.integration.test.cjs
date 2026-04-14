'use strict';
/**
 * Phase 32 — Frontend Rebuild Integration Tests
 * File: tests/32-frontend-rebuild.integration.test.cjs
 *
 * Requirements covered:
 *   FRONT-01..07 (via Phase 32 unit test suite execution)
 *   FORMAT-01..07 regression (via Phase 31 suite execution)
 *   SEC-04 regression (via Phase 34 suite execution)
 *   ENG-01..05 regression (via Phase 40 suite execution)
 *
 * Runs child processes — requires Node.js only, no external services.
 * Uses node:test + node:assert/strict + child_process.spawnSync.
 *
 * Pattern: run-once-reuse — spawnSync at describe-block level, reuse across it().
 * NODE_TEST_CONTEXT is stripped from subprocess env (Plan 40-02 learning:
 * node:test recursive invocation detection fires on nested `node --test` calls).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read an agent file from the agents directory.
 * @param {string} filename
 * @returns {string}
 */
function readAgent(filename) {
  return fs.readFileSync(path.join(AGENTS_DIR, filename), 'utf-8');
}

/**
 * Extract the engineering standards block from agent file content.
 * Finds text from `### Engineering standards` to the next `### ` or `## ` heading.
 * @param {string} content - full agent file content
 * @returns {string} trimmed engineering standards block
 */
function extractEngStandards(content) {
  const startMarker = '### Engineering standards';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return '';

  const afterStart = content.indexOf('\n', startIdx);
  const rest = content.slice(afterStart);
  const nextSection = rest.search(/\n###? /);

  let block;
  if (nextSection === -1) {
    block = content.slice(startIdx);
  } else {
    block = content.slice(startIdx, afterStart + nextSection);
  }
  return block.trim();
}

/**
 * Create a clean env without NODE_TEST_CONTEXT.
 * Required to prevent node:test recursive invocation detection when
 * this test file is itself run with `node --test` and then spawns
 * inner `node --test` child processes.
 * @returns {object} env without NODE_TEST_CONTEXT
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ─── Group 1: Phase 31 regression — format standard still passes (3 assertions)

describe('[FORMAT-01..07] Phase 31 regression: format-regression suite still passes', () => {
  const result = spawnSync('node', ['--test', 'tests/31-format-regression.test.cjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 60000,
  });

  it('[P31] node --test tests/31-format-regression.test.cjs exits 0', () => {
    assert.strictEqual(
      result.status,
      0,
      `Phase 31 regression suite failed with exit ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('[P31] stdout does not contain "not ok" (no TAP failures)', () => {
    assert.ok(
      !result.stdout.includes('not ok'),
      `Phase 31 suite has failures (found "not ok").\nstdout: ${result.stdout}`
    );
  });

  it('[P31] output contains "pass" (at least some tests ran)', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('pass'),
      `Phase 31 suite output missing "pass".\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });
});

// ─── Group 2: Phase 34 regression — security format still passes (3 assertions)

describe('[SEC-04] Phase 34 regression: 34-agent-format unit suite still passes', () => {
  const result = spawnSync('node', ['--test', 'tests/34-agent-format.unit.test.cjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 60000,
  });

  it('[P34] node --test tests/34-agent-format.unit.test.cjs exits 0', () => {
    assert.strictEqual(
      result.status,
      0,
      `Phase 34 regression suite failed with exit ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('[P34] stdout does not contain "not ok"', () => {
    assert.ok(
      !result.stdout.includes('not ok'),
      `Phase 34 suite has failures (found "not ok").\nstdout: ${result.stdout}`
    );
  });

  it('[P34] output contains "pass"', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('pass'),
      `Phase 34 suite output missing "pass".\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });
});

// ─── Group 3: Phase 40 regression — engineering standards still pass (3 assertions)

describe('[ENG-01..05] Phase 40 regression: 40-engineering-standards unit suite still passes', () => {
  const result = spawnSync('node', ['--test', 'tests/40-engineering-standards.unit.test.cjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 60000,
  });

  it('[P40-unit] node --test tests/40-engineering-standards.unit.test.cjs exits 0', () => {
    assert.strictEqual(
      result.status,
      0,
      `Phase 40 unit suite failed with exit ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('[P40-unit] stdout does not contain "not ok"', () => {
    assert.ok(
      !result.stdout.includes('not ok'),
      `Phase 40 unit suite has failures (found "not ok").\nstdout: ${result.stdout}`
    );
  });

  it('[P40-unit] output contains "pass"', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('pass'),
      `Phase 40 unit suite output missing "pass".\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });
});

// ─── Group 4: Phase 40 integration regression (3 assertions) ──────────────────

describe('[ENG-01..05] Phase 40 regression: 40-engineering-standards integration suite still passes', () => {
  const result = spawnSync('node', ['--test', 'tests/40-engineering-standards.integration.test.cjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 120000,
  });

  it('[P40-int] node --test tests/40-engineering-standards.integration.test.cjs exits 0', () => {
    assert.strictEqual(
      result.status,
      0,
      `Phase 40 integration suite failed with exit ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('[P40-int] stdout does not contain "not ok"', () => {
    assert.ok(
      !result.stdout.includes('not ok'),
      `Phase 40 integration suite has failures (found "not ok").\nstdout: ${result.stdout}`
    );
  });

  it('[P40-int] output contains "pass"', () => {
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('pass'),
      `Phase 40 integration suite output missing "pass".\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });
});

// ─── Group 5: Phase 32 unit tests pass (2 assertions) ─────────────────────────

describe('[FRONT-01..07] Phase 32 unit suite passes (self-verification)', () => {
  const result = spawnSync('node', ['--test', 'tests/32-frontend-rebuild.unit.test.cjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 60000,
  });

  it('[P32-unit] node --test tests/32-frontend-rebuild.unit.test.cjs exits 0', () => {
    assert.strictEqual(
      result.status,
      0,
      `Phase 32 unit suite failed with exit ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('[P32-unit] stdout does not contain "not ok"', () => {
    assert.ok(
      !result.stdout.includes('not ok'),
      `Phase 32 unit suite has failures (found "not ok").\nstdout: ${result.stdout}`
    );
  });
});

// ─── Group 6: Cross-file consistency checks (5 assertions) ────────────────────
//
// Pure fs.readFileSync assertions — no child processes.
// Verifies gsd-executor-frontend.md is consistent with shared source-of-truth files.

describe('[FRONT-01..07][SEC-04][ENG-01..05] Cross-file consistency: frontend vs shared source-of-truth', () => {

  // --- 15. Security rules match shared/security-rules.md ---
  it('[SEC-04] security rules in gsd-executor-frontend.md contain all 12 bullets from shared/security-rules.md', () => {
    const sharedRulesPath = path.join(AGENTS_DIR, 'shared', 'security-rules.md');
    const sharedRules = fs.readFileSync(sharedRulesPath, 'utf-8');
    const frontendContent = readAgent('gsd-executor-frontend.md');

    // Extract individual bullet lines from shared rules (lines starting with "- ")
    const sharedBullets = sharedRules
      .split('\n')
      .filter(line => line.startsWith('- '))
      .map(line => line.trim());

    assert.ok(sharedBullets.length >= 12, `Expected >= 12 shared rules, found ${sharedBullets.length}`);

    const missingRules = sharedBullets.filter(bullet => {
      // Strip the "- " prefix for substring match
      const ruleText = bullet.slice(2);
      return !frontendContent.includes(ruleText);
    });

    assert.strictEqual(
      missingRules.length,
      0,
      `gsd-executor-frontend.md is missing ${missingRules.length} security rule(s):\n  ${missingRules.join('\n  ')}`
    );
  });

  // --- 16. Engineering standards match shared/engineering-standards.md ---
  it('[ENG-01..05] engineering standards block in gsd-executor-frontend.md is content-identical to shared/engineering-standards.md', () => {
    const srcPath = path.join(AGENTS_DIR, 'shared', 'engineering-standards.md');
    const sourceOfTruth = fs.readFileSync(srcPath, 'utf-8').trim();
    const frontendContent = readAgent('gsd-executor-frontend.md');
    const extracted = extractEngStandards(frontendContent);

    if (extracted !== sourceOfTruth) {
      const srcLines = sourceOfTruth.split('\n');
      const agentLines = extracted.split('\n');
      let firstDiff = -1;
      for (let i = 0; i < Math.max(srcLines.length, agentLines.length); i++) {
        if (srcLines[i] !== agentLines[i]) {
          firstDiff = i;
          break;
        }
      }
      assert.fail(
        `gsd-executor-frontend.md engineering standards block differs from source.\n` +
        `First differing line ${firstDiff}: ` +
        `source="${srcLines[firstDiff]}" agent="${agentLines[firstDiff]}"`
      );
    }
    assert.ok(true); // explicit pass
  });

  // --- 17. AGENTS.md constraint text identical between frontend and backend ---
  it('[FORMAT-06] gsd-executor-frontend.md has same AGENTS.md constraint text as gsd-executor-backend.md', () => {
    const frontendContent = readAgent('gsd-executor-frontend.md');
    const backendContent = readAgent('gsd-executor-backend.md');

    const AGENTS_MD_CONSTRAINT = 'You CANNOT create or modify AGENTS.md files during execution.';
    assert.ok(
      frontendContent.includes(AGENTS_MD_CONSTRAINT),
      `gsd-executor-frontend.md missing AGENTS.md constraint: "${AGENTS_MD_CONSTRAINT}"`
    );
    assert.ok(
      backendContent.includes(AGENTS_MD_CONSTRAINT),
      `gsd-executor-backend.md missing AGENTS.md constraint (reference agent has drifted)`
    );
  });

  // --- 18. Divergence protocol paragraph identical between frontend and backend ---
  it('[FORMAT-06] gsd-executor-frontend.md has divergence_report protocol paragraph present (same as gsd-executor-backend.md)', () => {
    const frontendContent = readAgent('gsd-executor-frontend.md');
    const backendContent = readAgent('gsd-executor-backend.md');

    const DIVERGENCE_KEY = 'divergence_report per `get-shit-done/references/divergence-protocol.md`';
    assert.ok(
      frontendContent.includes(DIVERGENCE_KEY),
      `gsd-executor-frontend.md missing divergence protocol reference: "${DIVERGENCE_KEY}"`
    );
    assert.ok(
      backendContent.includes(DIVERGENCE_KEY),
      `gsd-executor-backend.md missing divergence protocol reference (reference agent has drifted)`
    );
  });

  // --- 19. Preconditions count similar between frontend and backend (within 1) ---
  it('[FORMAT] gsd-executor-frontend.md preconditions count is within 1 of gsd-executor-backend.md', () => {
    const frontendContent = readAgent('gsd-executor-frontend.md');
    const backendContent = readAgent('gsd-executor-backend.md');

    // Extract "- Never" lines from Preconditions section of each file
    function extractPreconditionNeverCount(content) {
      const marker = '## Preconditions & constraints';
      const idx = content.indexOf(marker);
      if (idx === -1) return 0;
      const afterSection = content.slice(idx);
      const neverLines = (afterSection.match(/^- Never/gm) || []);
      return neverLines.length;
    }

    const frontendCount = extractPreconditionNeverCount(frontendContent);
    const backendCount = extractPreconditionNeverCount(backendContent);

    assert.ok(
      frontendCount > 0,
      `gsd-executor-frontend.md has 0 "- Never" lines in Preconditions section`
    );
    assert.ok(
      Math.abs(frontendCount - backendCount) <= 1,
      `Preconditions "- Never" count diverged: frontend=${frontendCount}, backend=${backendCount} (difference > 1)`
    );
  });
});
