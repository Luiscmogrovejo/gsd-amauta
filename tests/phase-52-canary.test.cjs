'use strict';
/**
 * tests/phase-52-canary.test.cjs — Phase 52 cross-surface byte-preservation canary.
 *
 * Verifies that Phase 52 added ONLY the expected surfaces and did NOT silently
 * mutate v3.1 + Phase 48/49/50/51 protected paths.
 *
 * PHASE_52_BASE: 21438ae43fd368d814b5aa27732aeb8379d2f7c5
 *   = the commit immediately preceding Phase 52 execution start.
 *
 * PROTECTED PATHS (must be byte-identical to PHASE_52_BASE):
 *   a. scripts/skill-compiler.cjs           (Phase 43, mirror only)
 *   b. services/skill_schema.py             (Phase 43)
 *   c. services/module_schema.py            (Phase 48)
 *   d. services/agent_hydrator.py           (Phase 47)
 *   e. services/agent_hydrate_cli.py        (Phase 47)
 *   f. services/party_session.py            (Phase 50/51)
 *   g. services/party_session_cli.py        (Phase 50/51)
 *   h. services/amauta-mcp.py               (Phase 46)
 *   i. get-shit-done/references/platform-codes.yaml (Phase 44)
 *   j. agents/gsd-planner.md               (SC1 canonical claude-code output)
 *   k. agents/gsd-checker.md               (SC1 canonical claude-code output)
 *   l. agents/gsd-executor-backend.md      (SC1 canonical claude-code output)
 *
 * EXPECTED ADDITIONS (must EXIST at HEAD but DID NOT exist at PHASE_52_BASE):
 *   m. services/agent_schema.py             (Wave 1)
 *   n. scripts/agent-md-to-yaml.cjs         (Wave 1)
 *   o. scripts/agent-compiler.cjs           (Wave 3)
 *   p. get-shit-done/agents/gsd-planner/AGENT.yaml (Wave 2)
 *   q. tests/agents-compile-claude-target-byte-match.test.cjs (Wave 3)
 *   r. tests/phase-52-canary.test.cjs       (this file — Wave 5)
 *
 * EXPECTED MODIFICATIONS (must DIFFER from PHASE_52_BASE in a controlled way):
 *   s. get-shit-done/bin/gsd-tools.cjs — NEW case 'agents': block; adjacent
 *      case 'skills' / case 'agent-hydrate' / case 'module' / case 'party'
 *      blocks must be BYTE-IDENTICAL to PHASE_52_BASE.
 *   t. bin/cli.cjs — NEW command === 'agents' branch; existing module + party
 *      branches + status routing must be BYTE-IDENTICAL.
 *
 * NEVER SKIPS — no PG/Valkey/daemon dependency. All assertions are git/filesystem only.
 *
 * Failure to match PHASE_52_BASE for any protected path is a CANARY HIT.
 * If the PHASE_52_BASE SHA is wrong (git show fails), the test MUST throw and
 * the executor MUST surface a divergence report — NOT silently update the SHA.
 *
 * Run: node --test tests/phase-52-canary.test.cjs
 *
 * Mirrors tests/party-decisions-canary.test.cjs (Phase 51 precedent).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── PHASE_52_BASE constant (FROZEN — NEVER update without operator sign-off) ─
//
// This is the commit immediately preceding Phase 52 execution start.
// Confirmed by git log at planning time (2026-05-13):
//   21438ae43fd368d814b5aa27732aeb8379d2f7c5  docs(phase-51): complete party mode decisions + operator CLI
const PHASE_52_BASE = '21438ae43fd368d814b5aa27732aeb8379d2f7c5';

const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run `git diff <PHASE_52_BASE> -- <path>` and return stdout string.
 * Returns empty string if the path is unchanged. Throws on error.
 */
function gitDiff(targetPath) {
  return execSync(`git diff ${PHASE_52_BASE} -- ${targetPath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

/**
 * Retrieve file content at PHASE_52_BASE via `git show <SHA>:<path>`.
 * Throws if the path did not exist at PHASE_52_BASE.
 */
function gitShowBase(filePath) {
  return execSync(`git show ${PHASE_52_BASE}:${filePath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

/**
 * sha256 of a string (hex, first 16 chars). Used for concise equality assertion messages.
 */
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Extract a JS case block from source text starting with `startMarker` (e.g. "case 'skills':")
 * and ending at the matching closing brace.
 * Returns the extracted substring or throws if not found.
 */
function extractCaseBlock(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`extractCaseBlock: startMarker not found: ${JSON.stringify(startMarker)}`);
  }
  // Find the first '{' after startMarker
  const braceStart = src.indexOf('{', startIdx + startMarker.length);
  if (braceStart === -1) {
    throw new Error(`extractCaseBlock: no opening brace found after: ${JSON.stringify(startMarker)}`);
  }
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error(`extractCaseBlock: unbalanced braces starting at ${braceStart} for marker ${JSON.stringify(startMarker)}`);
}

/**
 * Extract an `if (command === '<cmd>')` block from bin/cli.cjs source.
 * Uses brace-counting to find the matching closing brace.
 * Returns the extracted substring or throws.
 */
function extractIfBlock(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`extractIfBlock: startMarker not found: ${JSON.stringify(startMarker)}`);
  }
  const braceStart = src.indexOf('{', startIdx + startMarker.length);
  if (braceStart === -1) {
    throw new Error(`extractIfBlock: no opening brace after: ${JSON.stringify(startMarker)}`);
  }
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error(`extractIfBlock: unbalanced braces for marker ${JSON.stringify(startMarker)}`);
}

// ─── Sanity: verify BASE SHA resolves at module load ─────────────────────────
//
// If this throws, executor MUST surface a divergence report — NOT update the SHA.
const _baseSubject = execSync(`git show --format="%s" -s ${PHASE_52_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim();

assert.ok(
  typeof _baseSubject === 'string' && _baseSubject.length > 0,
  `PHASE_52_BASE SHA ${PHASE_52_BASE} must resolve to a commit`
);

// ─── Canary tests — NEVER SKIP ────────────────────────────────────────────────

// ── Subtest 1: BASE SHA sanity precondition ────────────────────────────────

test('canary-phase-52-base-resolves', () => {
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_52_BASE ${PHASE_52_BASE} must resolve; subject: ${_baseSubject}`
  );
});

// ── Subtest 2: Protected paths — Phase 47 + Phase 43 services ─────────────

test('canary-phase-47-phase-43-services-untouched', () => {
  const targets = [
    'services/skill_schema.py',           // b. Phase 43
    'services/agent_hydrator.py',         // d. Phase 47
    'services/agent_hydrate_cli.py',      // e. Phase 47
    'services/amauta-mcp.py',             // h. Phase 46
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_52_BASE ${PHASE_52_BASE}; diff:\n${diff}`
    );
  }
});

// ── Subtest 3: scripts/skill-compiler.cjs (Phase 43 mirror only) ──────────

test('canary-scripts-skill-compiler-untouched', () => {
  const diff = gitDiff('scripts/skill-compiler.cjs');
  assert.strictEqual(
    diff,
    '',
    `scripts/skill-compiler.cjs must be UNMODIFIED since PHASE_52_BASE; diff:\n${diff}`
  );
});

// ── Subtest 4: Phase 48 outputs ────────────────────────────────────────────

test('canary-phase-48-outputs-untouched', () => {
  const targets = [
    'services/module_schema.py',          // c. Phase 48
    'services/module_resolver.py',
    'services/module_validator_cli.py',
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_52_BASE; diff:\n${diff}`
    );
  }
});

// ── Subtest 5: Phase 49 outputs ────────────────────────────────────────────

test('canary-phase-49-outputs-untouched', () => {
  const targets = [
    'services/module_lifecycle.py',
    'services/install_record_store.py',
    'services/module_lifecycle_cli.py',
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_52_BASE; diff:\n${diff}`
    );
  }
});

// ── Subtest 6: Phase 50/51 party services untouched ────────────────────────

test('canary-phase-5051-party-services-untouched', () => {
  const targets = [
    'services/party_session.py',          // f. Phase 50/51
    'services/party_session_cli.py',      // g. Phase 50/51
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_52_BASE; diff:\n${diff}`
    );
  }
});

// ── Subtest 7: get-shit-done/references/platform-codes.yaml untouched ─────

test('canary-platform-codes-yaml-untouched', () => {
  const diff = gitDiff('get-shit-done/references/platform-codes.yaml');
  assert.strictEqual(
    diff,
    '',
    `get-shit-done/references/platform-codes.yaml must be UNMODIFIED since PHASE_52_BASE; diff:\n${diff}`
  );
});

// ── Subtest 8: SC1 protected canonical agents/*.md untouched ──────────────
//
// agents/*.md files are the COMPILED OUTPUTS for claude-code target.
// Phase 52 compile writes byte-identical content; the files themselves must
// NOT drift from PHASE_52_BASE (SC1 lock: compile → byte-match → no diff).

test('canary-agents-md-sc1-lock-untouched', () => {
  const targets = [
    'agents/gsd-planner.md',             // j.
    'agents/gsd-checker.md',             // k.
    'agents/gsd-executor-backend.md',    // l.
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_52_BASE (SC1 canonical claude-code output);\n` +
      `diff:\n${diff}`
    );
  }
});

// ── Subtest 9: Expected additions exist at HEAD but NOT at PHASE_52_BASE ──

test('canary-expected-additions-exist-at-head', () => {
  const additions = [
    { path: 'services/agent_schema.py', label: 'Wave 1' },              // m.
    { path: 'scripts/agent-md-to-yaml.cjs', label: 'Wave 1' },         // n.
    { path: 'scripts/agent-compiler.cjs', label: 'Wave 3' },           // o.
    { path: 'get-shit-done/agents/gsd-planner/AGENT.yaml', label: 'Wave 2' }, // p.
    { path: 'tests/agents-compile-claude-target-byte-match.test.cjs', label: 'Wave 3' }, // q.
    { path: 'tests/phase-52-canary.test.cjs', label: 'Wave 5' },       // r.
  ];

  for (const { path: filePath, label } of additions) {
    // Must exist at HEAD
    const absPath = path.join(ROOT, filePath);
    assert.ok(
      fs.existsSync(absPath),
      `${filePath} (${label}) must exist at HEAD`
    );

    // Must NOT have existed at PHASE_52_BASE (git show must throw)
    let existed = false;
    try {
      gitShowBase(filePath);
      existed = true;
    } catch (_) {
      // Expected: git show exits non-zero when path doesn't exist at base
      existed = false;
    }

    assert.ok(
      !existed,
      `${filePath} (${label}) must NOT have existed at PHASE_52_BASE ${PHASE_52_BASE} (it is a Phase 52 addition)`
    );
  }
});

// ── Subtest 10: gsd-tools.cjs — case 'agents' NEW; adjacent cases byte-identical ─

test('canary-gsd-tools-case-agents-new-adjacent-cases-preserved', () => {
  const toolsRelPath = 'get-shit-done/bin/gsd-tools.cjs';
  const headSrc = fs.readFileSync(path.join(ROOT, toolsRelPath), 'utf8');
  const baseSrc = gitShowBase(toolsRelPath);

  // HEAD must contain case 'agents': (Phase 52 Wave 4 addition)
  assert.ok(
    headSrc.includes("case 'agents':"),
    `get-shit-done/bin/gsd-tools.cjs at HEAD must contain case 'agents': (Phase 52 Wave 4 addition)`
  );

  // BASE must NOT contain case 'agents':
  assert.ok(
    !baseSrc.includes("case 'agents':"),
    `get-shit-done/bin/gsd-tools.cjs at PHASE_52_BASE must NOT contain case 'agents':`
  );

  // Adjacent case blocks must be byte-identical between HEAD and BASE
  const adjacentCases = [
    "case 'skills':",
    "case 'agent-hydrate':",
    "case 'module':",
    "case 'party':",
  ];

  for (const marker of adjacentCases) {
    let headBlock, baseBlock;
    try {
      headBlock = extractCaseBlock(headSrc, marker);
    } catch (e) {
      assert.fail(`HEAD gsd-tools.cjs: could not extract ${JSON.stringify(marker)}: ${e.message}`);
    }
    try {
      baseBlock = extractCaseBlock(baseSrc, marker);
    } catch (e) {
      assert.fail(`BASE gsd-tools.cjs: could not extract ${JSON.stringify(marker)}: ${e.message}`);
    }

    assert.strictEqual(
      headBlock,
      baseBlock,
      `${marker} block in gsd-tools.cjs must be byte-identical to PHASE_52_BASE.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}\n` +
      `git diff:\n${gitDiff(toolsRelPath).slice(0, 2000)}`
    );
  }
});

// ── Subtest 11: bin/cli.cjs — command === 'agents' NEW; module + party + status routing preserved ─

test('canary-bin-cli-agents-new-module-party-status-preserved', () => {
  const cliRelPath = 'bin/cli.cjs';
  const headSrc = fs.readFileSync(path.join(ROOT, cliRelPath), 'utf8');
  const baseSrc = gitShowBase(cliRelPath);

  // HEAD must contain command === 'agents'
  assert.ok(
    headSrc.includes("command === 'agents'"),
    `bin/cli.cjs at HEAD must contain command === 'agents' (Phase 52 Wave 4 addition)`
  );

  // BASE must NOT contain command === 'agents'
  assert.ok(
    !baseSrc.includes("command === 'agents'"),
    `bin/cli.cjs at PHASE_52_BASE must NOT contain command === 'agents'`
  );

  // Preserved blocks: module and party branches must be byte-identical
  const preservedBlocks = [
    "if (command === 'module')",
    "if (command === 'party')",
  ];

  for (const marker of preservedBlocks) {
    let headBlock, baseBlock;
    try {
      headBlock = extractIfBlock(headSrc, marker);
    } catch (e) {
      assert.fail(`HEAD bin/cli.cjs: could not extract ${JSON.stringify(marker)}: ${e.message}`);
    }
    try {
      baseBlock = extractIfBlock(baseSrc, marker);
    } catch (e) {
      assert.fail(`BASE bin/cli.cjs: could not extract ${JSON.stringify(marker)}: ${e.message}`);
    }

    assert.strictEqual(
      headBlock,
      baseBlock,
      `${marker} block in bin/cli.cjs must be byte-identical to PHASE_52_BASE.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}\n` +
      `git diff:\n${gitDiff(cliRelPath).slice(0, 1000)}`
    );
  }

  // Status routing block: the status-check logic must be byte-identical
  // Anchor: "const isStatusSystemCheck = command === 'status'"
  const statusAnchor = "const isStatusSystemCheck = command === 'status'";
  const headStatusIdx = headSrc.indexOf(statusAnchor);
  const baseStatusIdx = baseSrc.indexOf(statusAnchor);
  assert.ok(
    headStatusIdx !== -1,
    `HEAD bin/cli.cjs must contain isStatusSystemCheck constant`
  );
  assert.ok(
    baseStatusIdx !== -1,
    `BASE bin/cli.cjs must contain isStatusSystemCheck constant`
  );

  // Extract from isStatusSystemCheck to end of file and compare
  const headStatus = headSrc.slice(headStatusIdx);
  const baseStatus = baseSrc.slice(baseStatusIdx);
  assert.strictEqual(
    headStatus,
    baseStatus,
    `Status routing block (from isStatusSystemCheck to EOF) in bin/cli.cjs must be byte-identical.\n` +
    `head sha=${sha256(headStatus)}, base sha=${sha256(baseStatus)}`
  );
});
