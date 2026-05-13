'use strict';
/**
 * Plan 51-04-02: Phase 51 cross-surface canary.
 *
 * Verifies Phase 50 byte-preservation + v3.1 + Phase 48 + Phase 49 untouched
 * at PHASE_51_BASE (dd404b7ee48ad2c4a9fc46d55b14f1cf3eac2671).
 *
 * Protected surfaces verified:
 *   a. Phase 50 byte-preservation — services/party_session.py: 8 Phase 50
 *      functions (create/start/pause/resume/terminate/get/post_finding/
 *      list_findings), PartySession class body, Phase 50 constants
 *      (SCHEMA_VERSION/ALLOWED_STATUSES/VALID_TRANSITIONS) are byte-identical
 *      to PHASE_51_BASE. NEW additions (DECISION_TYPES, post_decision,
 *      list_decisions, summarize_decisions) must EXIST at HEAD.
 *   b. Phase 50 byte-preservation — services/party_session_cli.py: existing
 *      6 subparser blocks + 6 action handlers are byte-identical to PHASE_51_BASE.
 *      NEW 3 subparsers (status/inspect/kill) must EXIST at HEAD.
 *   c. Phase 50 byte-preservation — gsd-tools.cjs case 'party': dispatch-contract
 *      lines (args[1], args.slice(2), spawnSync, partyCli path, exit-code
 *      passthrough) are byte-identical. KNOWN_ACTIONS Set EXTENDED to 9 actions.
 *   d. bin/cli.cjs party branch byte-identical (Phase 51 adds ZERO edits).
 *   e. 13 Phase 50 protected paths (v3.1 + Phase 48 + Phase 49) untouched.
 *
 * NEVER SKIPS — no PG dependency. All assertions are git/filesystem only.
 *
 * Run:
 *   node --test tests/party-decisions-canary.test.cjs
 *
 * Phase 51 canary. Mirrors tests/party-canary.test.cjs structure.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Phase 51 base SHA (FROZEN — NEVER update without operator sign-off) ─────
//
// This is the commit immediately preceding Phase 51 execution start.
// From .planning/ROADMAP.md §Phase 51 + git log confirmation:
//   dd404b7ee48ad2c4a9fc46d55b14f1cf3eac2671  docs(51): capture Phase 51 context
//
// If this SHA is wrong (i.e., git show fails), the test will throw and the
// executor MUST surface a divergence report — NOT silently update the SHA.
const PHASE_51_BASE = 'dd404b7ee48ad2c4a9fc46d55b14f1cf3eac2671';

const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run `git diff <PHASE_51_BASE> -- <path>` and return stdout string.
 * Returns empty string if the path is unchanged. Throws on error.
 */
function gitDiff(targetPath) {
  return execSync(`git diff ${PHASE_51_BASE} -- ${targetPath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

/**
 * Retrieve file content at PHASE_51_BASE via `git show <SHA>:<path>`.
 */
function gitShowBase(filePath) {
  return execSync(`git show ${PHASE_51_BASE}:${filePath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

/**
 * Extract a JS/CSS/JSON block from source text starting with `startMarker` and
 * ending at the closing `}` that balances the first `{` encountered after the marker.
 * Returns the extracted substring (inclusive of start marker) or throws if not found.
 * Mirrors party-canary.test.cjs extractBlock.
 */
function extractBlock(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`startMarker not found: ${JSON.stringify(startMarker)}`);
  }
  const braceStart = src.indexOf('{', startIdx + startMarker.length);
  if (braceStart === -1) {
    throw new Error(`Opening brace not found after: ${JSON.stringify(startMarker)}`);
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
  throw new Error(`Unbalanced braces starting at ${braceStart}`);
}

/**
 * Extract a Python function or class body using indent-level scanning (WARN-04
 * compliance — NOT hardcoded line numbers).
 *
 * Algorithm:
 *   1. Find the line starting with `startMarker` (e.g. 'def create(')
 *   2. Record anchor line indentation (typically 0 for top-level defs)
 *   3. Collect all subsequent lines until a non-blank, non-comment line is found
 *      at the SAME or LESSER indent level as the anchor line (i.e., the block ends)
 *   4. Return the full text from anchor through the last included line
 *
 * Handles nested functions, decorators, blank lines inside body, and comments.
 * Returns the extracted block string or throws if the anchor is not found.
 */
function extractPythonBlock(src, startMarker) {
  const lines = src.split('\n');
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startMarker)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error(`extractPythonBlock: startMarker not found: ${JSON.stringify(startMarker)}`);
  }

  // Determine anchor indentation (number of leading spaces/tabs on the def/class line)
  const anchorLine = lines[startLine];
  const anchorIndent = anchorLine.length - anchorLine.trimStart().length;

  // Scan forward: the block ends when we hit a non-blank, non-indented-comment
  // line at the SAME or LESSER indent level as the anchor.
  // Track the last SUBSTANTIVE (non-blank, non-comment) indented line seen.
  let lastSubstantiveLine = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      // Blank lines tentatively included; don't update lastSubstantiveLine
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= anchorIndent) {
      // Hit a line at the same or lesser indent: block has ended
      break;
    }
    // Indented line (substantive or comment) — update lastSubstantiveLine
    lastSubstantiveLine = i;
  }

  // Return from start through the last substantive line (trim trailing blank lines)
  return lines.slice(startLine, lastSubstantiveLine + 1).join('\n');
}

/**
 * sha256 of a string (hex). Used for concise equality assertion messages.
 */
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// ─── Sanity: verify the BASE SHA resolves at module load ──────────────────────
//
// If this throws, executor MUST surface a divergence report — NOT update the SHA.
const _baseSubject = execSync(`git show --format="%s" -s ${PHASE_51_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim();

assert.ok(
  typeof _baseSubject === 'string' && _baseSubject.length > 0,
  `PHASE_51_BASE SHA ${PHASE_51_BASE} must resolve to a commit`
);

// ─── Canary tests (9 subtests — NEVER SKIPS) ─────────────────────────────────

// Subtest 1: BASE SHA sanity precondition
test('canary-phase-51-base-resolves', () => {
  // _baseSubject was asserted at module load. Re-assert inside the test.
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_51_BASE ${PHASE_51_BASE} must resolve; subject: ${_baseSubject}`
  );
});

// Subtest 2: agents/ directory glob
test('canary-agents-untouched', () => {
  const diff = gitDiff('agents/');
  assert.strictEqual(
    diff,
    '',
    `agents/ must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
  );
});

// Subtest 3: v3.1 carry-forward services + scripts + bin/init.cjs
test('canary-v31-services-untouched', () => {
  const targets = [
    'services/amauta-mcp.py',
    'services/skill_schema.py',
    'services/agent_hydrator.py',
    'services/agent_hydrate_cli.py',
    'scripts/skill-compiler.cjs',
    'bin/init.cjs',
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
    );
  }
});

// Subtest 4: Phase 48 outputs (3 module_*.py files)
test('canary-phase-48-outputs-untouched', () => {
  const targets = [
    'services/module_schema.py',
    'services/module_resolver.py',
    'services/module_validator_cli.py',
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
    );
  }
});

// Subtest 5: Phase 49 outputs
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
      `${t} must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
    );
  }
});

// Subtest 6: bin/cli.cjs party branch — Phase 51 contract: zero edits
test('canary-bin-cli-party-branch-byte-preserved', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'bin', 'cli.cjs'), 'utf8');
  const baseSrc = gitShowBase('bin/cli.cjs');

  const headBlock = extractBlock(headSrc, "if (command === 'party')");
  const baseBlock = extractBlock(baseSrc, "if (command === 'party')");

  assert.strictEqual(
    headBlock,
    baseBlock,
    `if (command === 'party') block in bin/cli.cjs must be byte-identical to Phase 51 base.\n` +
    `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
  );
});

// Subtest 7: gsd-tools.cjs case 'party': dispatch-contract + KNOWN_ACTIONS extended to 9
test('canary-gsd-tools-party-dispatch-lines-preserved', () => {
  const headSrc = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'),
    'utf8'
  );

  // Extract the case 'party': block from HEAD
  const headBlock = extractBlock(headSrc, "case 'party':");

  // Dispatch-contract substrings that must be byte-identical (Phase 51 adds 0 logic changes)
  const requiredSubstrings = [
    "const action = args[1];",
    "const rest = args.slice(2);",
    "const partyCli = path.join(repoRoot, 'services', 'party_session_cli.py');",
    "spawnSync('python3', subprocArgs, { encoding: 'utf8', cwd: repoRoot });",
    "process.exit(result.status === null ? 1 : result.status);",
  ];

  for (const sub of requiredSubstrings) {
    assert.ok(
      headBlock.includes(sub),
      `case 'party': block must contain dispatch-contract substring:\n  ${sub}\n` +
      `Block length: ${headBlock.length}`
    );
  }

  // KNOWN_ACTIONS Set must be EXTENDED to 9 actions (frozen order)
  const expectedKnownActions = "'create', 'start', 'pause', 'resume', 'terminate', 'get', 'status', 'inspect', 'kill'";
  assert.ok(
    headBlock.includes(expectedKnownActions),
    `case 'party': block must contain KNOWN_ACTIONS with all 9 actions:\n  ${expectedKnownActions}\n` +
    `Block excerpt: ${headBlock.slice(0, 500)}`
  );
});

// Subtest 8: party_session.py — 8 Phase 50 functions + PartySession class +
//   constants byte-identical; DECISION_TYPES/post_decision/list_decisions/
//   summarize_decisions exist at HEAD. Uses indent-level scanning (WARN-04).
test('canary-party-session-py-phase-50-functions-preserved', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session.py'), 'utf8');
  const baseSrc = gitShowBase('services/party_session.py');

  // 8 Phase 50 function anchors
  const phase50Fns = [
    'def create(',
    'def start(',
    'def pause(',
    'def resume(',
    'def terminate(',
    'def get(',
    'def post_finding(',
    'def list_findings(',
  ];

  for (const fnAnchor of phase50Fns) {
    const headBlock = extractPythonBlock(headSrc, fnAnchor);
    const baseBlock = extractPythonBlock(baseSrc, fnAnchor);
    assert.strictEqual(
      headBlock,
      baseBlock,
      `Function "${fnAnchor}" in party_session.py must be byte-identical to Phase 51 base.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
    );
  }

  // PartySession class body byte-identical
  const headClass = extractPythonBlock(headSrc, 'class PartySession(');
  const baseClass = extractPythonBlock(baseSrc, 'class PartySession(');
  assert.strictEqual(
    headClass,
    baseClass,
    `PartySession class body must be byte-identical to Phase 51 base.\n` +
    `head sha=${sha256(headClass)}, base sha=${sha256(baseClass)}`
  );

  // Phase 50 constants — extract lines containing each constant definition
  const ph50ConstantAnchors = [
    'SCHEMA_VERSION = ',
    'ALLOWED_STATUSES = ',
    'VALID_TRANSITIONS = ',
  ];
  for (const anchor of ph50ConstantAnchors) {
    // For frozenset-style multi-line constants, use extractPythonBlock
    const headConst = extractPythonBlock(headSrc, anchor);
    const baseConst = extractPythonBlock(baseSrc, anchor);
    assert.strictEqual(
      headConst,
      baseConst,
      `Constant "${anchor}" in party_session.py must be byte-identical to Phase 51 base.\n` +
      `head sha=${sha256(headConst)}, base sha=${sha256(baseConst)}`
    );
  }

  // Positively assert NEW additions EXIST at HEAD (Phase 51 additions)
  assert.ok(
    headSrc.includes('DECISION_TYPES'),
    'party_session.py at HEAD must define DECISION_TYPES (Phase 51 addition)'
  );
  assert.ok(
    headSrc.includes('def post_decision('),
    'party_session.py at HEAD must define post_decision (Phase 51 addition)'
  );
  assert.ok(
    headSrc.includes('def list_decisions('),
    'party_session.py at HEAD must define list_decisions (Phase 51 addition)'
  );
  assert.ok(
    headSrc.includes('def summarize_decisions('),
    'party_session.py at HEAD must define summarize_decisions (Phase 51 addition)'
  );
});

// Subtest 9: party_session_cli.py — 6 Phase 50 subparsers + 6 action handlers
//   byte-identical; status/inspect/kill subparsers exist at HEAD.
test('canary-party-session-cli-phase-50-subparsers-preserved', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session_cli.py'), 'utf8');
  const baseSrc = gitShowBase('services/party_session_cli.py');

  // 6 Phase 50 subparser block anchors (add_parser lines)
  const subparserAnchors = [
    'p_create = sub.add_parser("create"',
    'p_start = sub.add_parser("start"',
    'p_pause = sub.add_parser("pause"',
    'p_resume = sub.add_parser("resume"',
    'p_terminate = sub.add_parser("terminate"',
    'p_get = sub.add_parser("get"',
  ];

  for (const anchor of subparserAnchors) {
    const headBlock = extractPythonBlock(headSrc, anchor);
    const baseBlock = extractPythonBlock(baseSrc, anchor);
    assert.strictEqual(
      headBlock,
      baseBlock,
      `Subparser block "${anchor}" in party_session_cli.py must be byte-identical to Phase 51 base.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
    );
  }

  // 6 Phase 50 action handler anchors (if/elif args.action == lines)
  const handlerAnchors = [
    'if args.action == "create":',
    'elif args.action == "start":',
    'elif args.action == "pause":',
    'elif args.action == "resume":',
    'elif args.action == "terminate":',
    'elif args.action == "get":',
  ];

  for (const anchor of handlerAnchors) {
    const headBlock = extractPythonBlock(headSrc, anchor);
    const baseBlock = extractPythonBlock(baseSrc, anchor);
    assert.strictEqual(
      headBlock,
      baseBlock,
      `Action handler block "${anchor}" in party_session_cli.py must be byte-identical to Phase 51 base.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
    );
  }

  // Positively assert 3 new Phase 51 subparsers EXIST at HEAD
  assert.ok(
    headSrc.includes('sub.add_parser("status"'),
    'party_session_cli.py at HEAD must have status subparser (Phase 51 addition)'
  );
  assert.ok(
    headSrc.includes('sub.add_parser("inspect"'),
    'party_session_cli.py at HEAD must have inspect subparser (Phase 51 addition)'
  );
  assert.ok(
    headSrc.includes('sub.add_parser("kill"'),
    'party_session_cli.py at HEAD must have kill subparser (Phase 51 addition)'
  );
});
