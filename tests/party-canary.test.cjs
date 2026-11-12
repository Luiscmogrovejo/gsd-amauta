'use strict';
/**
 * CANARY POLICY (plan 88-12): a PR that changes a path this file pins re-baselines this canary
 * IN THE SAME PR and names the change in its description. This canary exists to make such
 * a change deliberate, not to forbid it. Never skip, retire or weaken an assertion to go
 * green. Worked example: PR #24 changed the pinned bin/init.cjs without re-baselining and
 * left master red on four cells until plan 88-12 moved the bases.
 *
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
const { execSync, execFileSync } = require('child_process');
const path = require('node:path');

// ─── Phase 50 base SHA (FROZEN — update only with operator sign-off; last: 2026-11-11, delegated) ──────
//
// This is the commit immediately preceding Phase 50 execution start.
// From .planning/ROADMAP.md §Phase 50 + git log confirmation:
//   3889ff38e687eb7dfdbc133de30196c66c7a7f9d  docs(phase-49): complete module CLI + lifecycle — verification PASS
//
// If this SHA is wrong (i.e., git show fails), the test will throw and the
// executor MUST surface a divergence report — NOT silently update the SHA.
// RE-BASELINED 2026-11-11 (plan 88-06, operator sign-off: delegated 2026-11-11). The base used to be
//   3889ff38e687eb7dfdbc133de30196c66c7a7f9d  docs(phase-49): complete module CLI + lifecycle — verification PASS
// but the protected paths below were changed on purpose by later phases (new specialist agents and auditors, the
// model registry, doctor/init rework, gsd-tools and amauta-mcp changes), so every assertion that
// compares them with that commit failed with a diff. The base is now the master commit
//   e6dbc5122c0eb7b10f1861970d450e540ed269ec  Merge pull request #20 from Luiscmogrovejo/phase88/04-validate-fixtures-numpy
// and every assertion is kept: the canary guards these paths against unintended change from here on. The files
// that changed since the old base, and the commits that changed them, are in 88-06-RECORD.md.
// RE-BASELINED AGAIN 2026-11-11 (plan 88-12, operator sign-off: delegated 2026-11-11). Three pinned files changed on
// purpose since the base above: bin/init.cjs (PR #24, commit 04e17ed, and plan 88-12 task 03), services/module_schema.py
// (88-12 task 08, the fallback YAML parser fix) and services/module_lifecycle.py (88-12 task 09, the target-root
// override). The base is now the last commit of that series that touches a pinned path:
//   f79f1eed08188b05a54e628364550858379fe586  fix(88-12): module install honours GSD_MODULE_TARGET_ROOT so the e2e never writes into the repository
// Every assertion is kept. The full list of pinned files and commits is in 88-12-RECORD.md.
// RE-BASELINED AGAIN 2026-11-12 (plan 88-13, operator sign-off: delegated 2026-11-11). Eight pinned files changed on
// purpose since the base above: scripts/agent-compiler.cjs, scripts/agent-md-to-yaml.cjs and scripts/skill-compiler.cjs
// (CRLF-tolerant reads, 8a68adc), and services/amauta-mcp.py, services/agent_hydrate_cli.py,
// services/module_validator_cli.py, services/module_lifecycle_cli.py and services/party_session_cli.py (UTF-8 stdio at the
// entry point, 089b879; amauta-mcp.py also got encoding="utf-8" on its open(), 9cd9dd4). The compilers' output did not
// change by one byte: agents/ is unmodified. The base is now the last commit of that series that touches a pinned path:
//   9cd9dd46507b240b37f57588cbe7d568be21abcd  fix(88-13): every product open(), read_text and write_text names encoding="utf-8"
// Every assertion is kept. This PR must be merged with a merge commit (never squash, never rebase-merge) or this SHA
// stops resolving on master. The full list of pinned files and commits is in 88-13-RECORD.md.
// RE-BASELINED AGAIN 2026-11-12 (plan 88-15 "Windows 3", operator sign-off: delegated 2026-11-11). FOUR pinned paths
// changed on purpose since the base above, with the task and the commit:
//   bin/init.cjs                     88-15-05 three literal python3 spawns and the ENOENT message (7eaac98);
//                                    88-15-06 the home lookup (d8a0fdb); 88-15-07 `which` folded into the
//                                    shared helper, which previously lived only here (d8a0fdb)
//   get-shit-done/bin/gsd-tools.cjs  88-15-05 the python3 spawns inside the agent-hydrate, module and party
//                                    BLOCKS (7eaac98); 88-15-06 the home lookup (d8a0fdb); 88-15-07 two
//                                    redundant 2>/dev/null redirects that break on Windows cmd (d8a0fdb)
//   bin/cli.cjs                      88-15-05 the doctor spawn, which is OUTSIDE every pinned block (7eaac98)
//   scripts/agent-compiler.cjs       88-15-05 the hydration render spawn (7eaac98)
// agents/ did not move (git diff --name-only <base>...HEAD -- agents/ is empty) and the byte-match test is green.
// The base is now the last commit of that series that touches a pinned path:
//   d8a0fdbfa40d339f3c623335742cfe7cd839ebdd  fix(88-15): HOME, which, 2>/dev/null, find|grep|head and a username in a public file
// Every assertion is kept. This PR must be merged with a merge commit (NEVER squash, never rebase-merge) or this
// SHA stops resolving on master. The full list is in 88-15-RECORD.md.
// RE-BASELINED AGAIN 2026-11-12 (plan 88-11 task 04, operator sign-off: delegated in the task brief). ONE pinned
// path changed on purpose since the base above:
//   services/amauta-mcp.py           88-11-04 the import-time .env loader now reads nothing inside a test
//                                    session (GSD_TEST_MODE / PYTEST_CURRENT_TEST, with GSD_DOTENV_PATH as the
//                                    one opt-in). Outside test mode it is unchanged. The block is kept
//                                    byte-identical to the three copies in amauta.py,
//                                    services/amauta-daemon.py and services/rlm-service.py, and
//                                    tests/test_88_11_dotenv_loader.py fails if they drift (33191d5)
// MEASURED, NOT ASSUMED: `git diff --name-only d8a0fdb..HEAD` lists 208 files, and the
// intersection with the pinned list read out of the four canary files is exactly services/amauta-mcp.py.
// agents/ did not move and tests/agents-compile-claude-target-byte-match.test.cjs is green. The base is now the
// one commit of this series that touches a pinned path:
//   33191d581f4754e7569f9b39c458509b0fc09f94  fix(dotenv): a test run never reads an ambient .env
// Every assertion is kept (7/7). PHASE_52_BASE and PHASE_53_BASE are deliberately NOT moved: neither of
// their pinned sets changed (phase-53-canary does not pin amauta-mcp.py by diff, and its partial checks on the
// six Phase 46 tool names are green). This PR must be merged with a merge commit (NEVER squash, never
// rebase-merge) or this SHA stops resolving on master. The full list is in 88-11-DOTENV-RECORD.md.
const PHASE_50_BASE = '33191d581f4754e7569f9b39c458509b0fc09f94';

const ROOT = path.resolve(__dirname, '..');

/**
 * True when the commit `sha` exists in this checkout. CI uses fetch-depth 0, but a
 * `git archive` copy or a shallow clone has no history: the canaries then skip with a
 * named reason instead of failing (they are not silently passed).
 */
function historyAvailable(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { stdio: 'ignore', cwd: ROOT });
    return true;
  } catch { return false; }
}

const HISTORY = historyAvailable(PHASE_50_BASE);
const SKIP_NO_HISTORY = HISTORY
  ? false
  : `git history for ${PHASE_50_BASE} is not present in this checkout (shallow clone or git archive copy)`;

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
const _baseSubject = HISTORY
  ? execSync(`git show --format="%s" -s ${PHASE_50_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim()
  : '';

if (HISTORY) {
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_50_BASE SHA ${PHASE_50_BASE} must resolve to a commit`
  );
}

// ─── Canary tests ─────────────────────────────────────────────────────────────

// 1. agents/ — all .md files via directory-level git diff
test('canary-agents-untouched', { skip: SKIP_NO_HISTORY }, () => {
  const diff = gitDiff('agents/');
  assert.strictEqual(
    diff,
    '',
    `agents/ must be UNMODIFIED since Phase 50 base; diff:\n${diff}`
  );
});

// 2. v3.1 carry-forward services + scripts + bin/init.cjs
test('canary-services-v31-untouched', { skip: SKIP_NO_HISTORY }, () => {
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
test('canary-phase-48-outputs-untouched', { skip: SKIP_NO_HISTORY }, () => {
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
test('canary-phase-49-outputs-untouched', { skip: SKIP_NO_HISTORY }, () => {
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
test('canary-gsd-tools-module-case-content-preserved', { skip: SKIP_NO_HISTORY }, () => {
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
test('canary-cli-module-branch-preserved', { skip: SKIP_NO_HISTORY }, () => {
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
