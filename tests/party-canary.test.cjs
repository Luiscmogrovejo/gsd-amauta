'use strict';
/**
 * Plan 50-04-02: Phase 50 cross-surface canary.
 *
 * Verifies via git diff that Phase 50 did NOT touch protected surfaces:
 *   - v3.1 carry-forward (Phases 41-47): agents/ dir, services/amauta-mcp.py,
 *     services/skill_schema.py, services/agent_hydrator.py,
 *     services/agent_hydrate_cli.py, scripts/skill-compiler.cjs, bin/init.cjs
 *   - Phase 48 outputs: services/module_schema.py, services/module_resolver.py,
 *     services/module_validator_cli.py
 *   - Phase 49 outputs: services/module_lifecycle.py,
 *     services/install_record_store.py, services/module_lifecycle_cli.py
 *
 * Additionally, for get-shit-done/bin/gsd-tools.cjs and bin/cli.cjs (which
 * ARE modified by Phase 50), verify that the case 'module': / if (command === 'module')
 * blocks are byte-identical to the Phase 50 base commit.
 *
 * NEVER SKIPS. This test has no PG dependency and no runtime prerequisite.
 * If any protected path is modified, the test fails with the diff output.
 *
 * Run:
 *   node --test tests/party-canary.test.cjs
 *
 * Phase 50 PARTY-01 + PARTY-02 canary. 6 subtests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('node:path');

// ─── Phase 50 base SHA (FROZEN — NEVER update without operator sign-off) ──────
//
// This is the commit immediately preceding Phase 50 execution start.
// From .planning/ROADMAP.md §Phase 50 + git log confirmation:
//   3889ff38e687eb7dfdbc133de30196c66c7a7f9d  docs(phase-49): complete module CLI + lifecycle — verification PASS
//
// If this SHA is wrong (i.e., git show fails), the test will throw and the
// executor MUST surface a divergence report — NOT silently update the SHA.
const PHASE_50_BASE = '3889ff38e687eb7dfdbc133de30196c66c7a7f9d';

const ROOT = path.resolve(__dirname, '..');

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Run `git diff <base> -- <path>` and return the stdout string.
 * Returns empty string if the path is unchanged.
 * Throws if git errors (e.g., bad SHA).
 */
function gitDiff(targetPath) {
  return execSync(`git diff ${PHASE_50_BASE} -- ${targetPath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

/**
 * Extract a block from source text starting with `startMarker` and ending
 * at the closing `}` that balances the first `{` encountered after the marker.
 * Returns the extracted substring (inclusive of start marker) or throws if not found.
 */
function extractBlock(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`startMarker not found: ${JSON.stringify(startMarker)}`);
  }
  // Find the first opening brace after the start marker
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
 * Retrieve file content at the BASE commit via `git show <SHA>:<path>`.
 */
function gitShowBase(filePath) {
  return execSync(`git show ${PHASE_50_BASE}:${filePath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

// ─── Sanity: verify the BASE SHA resolves ─────────────────────────────────────

// If this throws, the Phase 50 base SHA has drifted — executor MUST surface
// a divergence report rather than silently updating the constant.
const _baseSubject = execSync(`git show --format="%s" -s ${PHASE_50_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim();

assert.ok(
  typeof _baseSubject === 'string' && _baseSubject.length > 0,
  `PHASE_50_BASE SHA ${PHASE_50_BASE} must resolve to a commit`
);

// ─── Canary tests ─────────────────────────────────────────────────────────────

// 1. agents/ — all .md files via directory-level git diff
test('canary-agents-untouched', () => {
  const diff = gitDiff('agents/');
  assert.strictEqual(
    diff,
    '',
    `agents/ must be UNMODIFIED since Phase 50 base; diff:\n${diff}`
  );
});

// 2. v3.1 carry-forward services + scripts + bin/init.cjs
test('canary-services-v31-untouched', () => {
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
      `${t} must be UNMODIFIED since Phase 50 base; diff:\n${diff}`
    );
  }
});

// 3. Phase 48 outputs — 3 module_*.py files
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
      `${t} must be UNMODIFIED since Phase 50 base; diff:\n${diff}`
    );
  }
});

// 4. Phase 49 outputs
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
      `${t} must be UNMODIFIED since Phase 50 base; diff:\n${diff}`
    );
  }
});

// 5. gsd-tools.cjs: case 'module': block byte-equal to BASE
//
// gsd-tools.cjs IS modified by Phase 50 (adds case 'party':). But the
// case 'module': block must be byte-identical to the BASE version.
test('canary-gsd-tools-module-case-content-preserved', () => {
  const currentSrc = require('node:fs').readFileSync(
    path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs'),
    'utf8'
  );
  const baseSrc = gitShowBase('get-shit-done/bin/gsd-tools.cjs');

  const currentBlock = extractBlock(currentSrc, "case 'module':");
  const baseBlock = extractBlock(baseSrc, "case 'module':");

  assert.strictEqual(
    currentBlock,
    baseBlock,
    `case 'module': block in gsd-tools.cjs must be byte-identical to Phase 50 base.\n` +
    `Diff length: current=${currentBlock.length}, base=${baseBlock.length}`
  );
});

// 6. bin/cli.cjs: `if (command === 'module')` block byte-equal to BASE
//
// bin/cli.cjs IS modified by Phase 50 (adds party branch). But the
// `if (command === 'module')` block must be byte-identical to the BASE version.
test('canary-cli-module-branch-preserved', () => {
  const currentSrc = require('node:fs').readFileSync(
    path.join(ROOT, 'bin', 'cli.cjs'),
    'utf8'
  );
  const baseSrc = gitShowBase('bin/cli.cjs');

  const currentBlock = extractBlock(currentSrc, "if (command === 'module')");
  const baseBlock = extractBlock(baseSrc, "if (command === 'module')");

  assert.strictEqual(
    currentBlock,
    baseBlock,
    `if (command === 'module') block in bin/cli.cjs must be byte-identical to Phase 50 base.\n` +
    `Diff length: current=${currentBlock.length}, base=${baseBlock.length}`
  );
});
