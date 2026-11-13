'use strict';
/**
 * CANARY POLICY (plan 88-12): a PR that changes a path this file pins re-baselines this canary
 * IN THE SAME PR and names the change in its description. This canary exists to make such
 * a change deliberate, not to forbid it. Never skip, retire or weaken an assertion to go
 * green. Worked example: PR #24 changed the pinned bin/init.cjs without re-baselining and
 * left master red on four cells until plan 88-12 moved the bases.
 *
 * Plan 51-04-02: Phase 51 cross-surface canary.
 *
 * Verifies Phase 50 byte-preservation + v3.1 + Phase 48 + Phase 49 untouched
 * at PHASE_51_BASE (dd404b7ee48ad2c4a9fc46d55b14f1cf3eac2671).
 *
 * Protected surfaces verified:
 *   a. services/party_session.py: the 6 container/blackboard functions plan
 *      89-13 left (create/start/terminate/get/post_finding/list_findings),
 *      PartySession class body and the constants SCHEMA_VERSION/ALLOWED_STATUSES
 *      are byte-identical to PHASE_51_BASE. DECISION_TYPES, post_decision,
 *      list_decisions, summarize_decisions must EXIST at HEAD. pause, resume,
 *      VALID_TRANSITIONS and InvalidTransitionError must NOT (plan 89-13,
 *      ORC-02 part 2 removed them; the assertion is inverted, not dropped).
 *   b. services/party_session_cli.py: the 4 Phase 50 subparser blocks + 4
 *      action handlers that survive are byte-identical to PHASE_51_BASE.
 *      status/inspect subparsers must EXIST at HEAD; pause/resume/kill must NOT.
 *   c. gsd-tools.cjs case 'party': dispatch-contract lines (args[1],
 *      args.slice(2), spawnPython, partyCli path, exit-code passthrough) are
 *      byte-identical. KNOWN_ACTIONS Set is the 6 surviving actions.
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
const { execSync, execFileSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Phase 51 base SHA (FROZEN — update only with operator sign-off; last: 2026-11-11, delegated) ─────
//
// This is the commit immediately preceding Phase 51 execution start.
// From .planning/ROADMAP.md §Phase 51 + git log confirmation:
//   dd404b7ee48ad2c4a9fc46d55b14f1cf3eac2671  docs(51): capture Phase 51 context
//
// If this SHA is wrong (i.e., git show fails), the test will throw and the
// executor MUST surface a divergence report — NOT silently update the SHA.
// RE-BASELINED 2026-11-11 (plan 88-06, operator sign-off: delegated 2026-11-11). The base used to be
//   dd404b7ee48ad2c4a9fc46d55b14f1cf3eac2671  docs(51): capture Phase 51 context
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
// Every assertion is kept (21/21). PHASE_52_BASE and PHASE_53_BASE are deliberately NOT moved: neither of
// their pinned sets changed (phase-53-canary does not pin amauta-mcp.py by diff, and its partial checks on the
// six Phase 46 tool names are green). This PR must be merged with a merge commit (NEVER squash, never
// rebase-merge) or this SHA stops resolving on master. The full list is in 88-11-DOTENV-RECORD.md.
// RE-BASELINED AGAIN 2026-11-12 (plan 88-11 tasks 06-07 close-out, operator sign-off: delegated in the task
// brief). ONE pinned path changed on purpose since the base above:
//   bin/init.cjs                     a real --files-only mode (fresh install and --upgrade), unknown
//                                    arguments are exit 2 from ONE flag table shared by the parser and
//                                    --help, `shouldStartPostgres` keeps an install recorded as sqlite on
//                                    sqlite, `daemonRestartPlan` kickstarts a launchd-managed daemon instead
//                                    of replacing it with a detached one, and the shipped-set exclusion list
//                                    drops runtime artefacts (*.pid, *.log, data/, …) (37ee48f)
// MEASURED, NOT ASSUMED: `git diff --name-only 33191d5..HEAD` lists 12 files, and the intersection with the
// pinned list read out of the four canary files is exactly bin/init.cjs. (The only other hit,
// tests/phase-52-canary.test.cjs, is that canary's own file name inside an EXISTENCE check against
// PHASE_52_BASE, not a byte-diff pin — the same artefact 88-15-RECORD.md and 88-11-DOTENV-RECORD.md saw.)
// agents/ did not move (`git diff --name-only <base>...HEAD -- agents/` is empty) and the byte-match test is
// green. The base is now the one commit of this series that touches a pinned path:
//   37ee48f2fa59a87fd663d9844b6dc5a35752fc3b  fix(installer): a real --files-only mode, unknown flags are errors, and pid files are not shipped content
// Every assertion is kept (21/21). CANARY_BASE, PHASE_52_BASE and PHASE_53_BASE are deliberately NOT moved:
// none of their pinned sets changed (bin/init.cjs is not pinned by diff in phase-52-canary, and
// phase-53-canary's partial checks on it — the seven Phase 44 step names plus --upgrade and --uninstall —
// are present and green). This PR must be merged with a merge commit (NEVER squash, never rebase-merge) or
// this SHA stops resolving on master. The full list is in 88-11-INSTALLER-RECORD.md.
// RE-BASELINED AGAIN 2026-11-12 (plan 89-09 "pinned-file surgery", operator sign-off: delegated in the task
// brief). TWO pinned paths changed on purpose since the base above:
//   services/amauta-mcp.py          89-09-03 its forty-line copy of the .env loader became a six-line prelude
//                                   that loads services/_dotenv.py by path (ONE definition, four importers);
//                                   89-09-04 MCPValkey takes its URL from services/cache_url.py, the ONE
//                                   resolver, and its error text names the canonical variable and the name
//                                   that actually supplied the value. Its 0.0.0.0 bind and hostname lookup
//                                   are DELIBERATELY untouched — those are Phase 90's (SEC-06), and mixing a
//                                   security change into a canary re-baseline is how one hides in the other.
//   services/agent_hydrator.py      89-09-04 _fetch_valkey takes its URL from the same resolver; it read one
//                                   legacy name only, so a cache exported under the canonical name never
//                                   reached it.
// MEASURED, NOT ASSUMED: `git diff --name-only 37ee48f..HEAD` lists 47 files, and the intersection with the
// pinned list read out of the four canary files is exactly services/agent_hydrator.py and services/amauta-mcp.py.
// agents/ did not move (`git diff --name-only <base>...HEAD -- agents/` is empty) and
// tests/agents-compile-claude-target-byte-match.test.cjs is green. The four byte-pinned BLOCKS are unchanged,
// re-measured with this file's own extractBlock: gsd-tools `case 'module':` 6735 bytes / 139 lines,
// `case 'party':` 2130 / 43, cli `if (command === 'module')` 877 / 17, `if (command === 'party')` 364 / 9.
// The base is now the last commit of this series that touches a pinned path:
//   cbed3c82dcf1d536a1bb765f6ab5814df6e03521  refactor(89-09): one cache resolver per language, every consumer calls it [89-09-04]
// Every assertion is kept (9/9). PHASE_52_BASE is deliberately NOT moved: it is FROZEN, and none of 89-09's files is pinned against it.
// This PR must be merged with a merge commit (NEVER squash, never rebase-merge) or this SHA stops resolving
// on master. The full list is in
// .planning/phases/89-postgres-primary-orchestration-cleanup/89-09-RECORD.md.
// RE-BASELINED AGAIN 2026-11-13 (plan 89-13 "party sessions keep only recorded decisions", ORC-02 part 2,
// decision D2; operator sign-off: delegated in the task brief). THREE pinned paths changed on purpose since the
// base above (cbed3c8), each in this PR:
//   services/party_session.py       89-13-02 (59f95ef) VALID_TRANSITIONS, InvalidTransitionError, pause() and
//                                   resume() (with its finding replay) are removed; start() and terminate() write
//                                   a status LABEL and are never refused because of the label a row carries.
//                                   post_finding / list_findings and the four decision members are untouched.
//   services/party_session_cli.py   89-13-03 (674cd3a) the pause, resume and kill subparsers and handlers are
//                                   removed; a removed verb answers a typed party_verb_removed; no PostgreSQL
//                                   answers a typed requires_postgres.
//   get-shit-done/bin/gsd-tools.cjs 89-13-03 (674cd3a) INSIDE the `case 'party':` block only: KNOWN_ACTIONS is
//                                   the six surviving actions, the usage text follows, and REMOVED_ACTIONS answers
//                                   the three removed verbs. The five dispatch-contract lines are byte-identical.
// MEASURED, NOT ASSUMED: this PR's own diff (`git diff --name-only origin/master...HEAD`, 22 files) intersected
// with the pinned list read out of the four canary files is exactly services/party_session.py,
// services/party_session_cli.py and get-shit-done/bin/gsd-tools.cjs. Against the old base
// (`git diff --name-only cbed3c8..HEAD`, 130 files, which includes plans 89-00..89-07 already on master) the
// intersection adds only bin/cli.cjs — plan 89-05 removed its `a2a` branch, OUTSIDE both pinned blocks, which are
// byte-identical (measured below) — and tests/phase-52-canary.test.cjs, that canary's own file name inside an
// EXISTENCE check, the artefact every record since 88-15 has noted. agents/ did not move
// (`git diff --name-only <base>...HEAD -- agents/` is empty) and tests/agents-compile-claude-target-byte-match.test.cjs
// is green. The four byte-pinned BLOCKS, re-measured with this file's own extractBlock, before -> after:
// gsd-tools `case 'module':` 6743 bytes / 139 lines -> the same; `case 'party':` 2130 / 43 -> 3565 / 62;
// cli `if (command === 'module')` 877 / 17 -> the same; `if (command === 'party')` 364 / 9 -> the same
// (bin/cli.cjs is not in this PR's diff).
// The base is now the last commit of this series that touches a pinned path:
//   674cd3aa980a593b7a4cff82a1ea3485f4465efd  refactor(89-13)!: the party CLI and dispatch shrink together, and a removed verb says what replaced it [89-13-03]
// Every assertion is kept (9/9). The assertions about pause, resume, kill and VALID_TRANSITIONS are INVERTED, not dropped:
// subtests 7, 8 and 9 now fail if any of them comes back.
// PHASE_50_BASE (party-canary) is deliberately NOT moved: it pins agents/, the v3.1 services, the module outputs and
// the two `module` blocks, none of which this plan touches; party-canary was run green BEFORE this change.
// Plan 89-11 moves PHASE_50_BASE and PHASE_51_BASE once more, from THIS value.
// This PR must be merged with a merge commit (NEVER squash, never rebase-merge) or this SHA stops resolving
// on master. The full list is in
// .planning/phases/89-postgres-primary-orchestration-cleanup/89-13-RECORD.md.
const PHASE_51_BASE = '674cd3aa980a593b7a4cff82a1ea3485f4465efd';

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

const HISTORY = historyAvailable(PHASE_51_BASE);
const SKIP_NO_HISTORY = HISTORY
  ? false
  : `git history for ${PHASE_51_BASE} is not present in this checkout (shallow clone or git archive copy)`;

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
const _baseSubject = HISTORY
  ? execSync(`git show --format="%s" -s ${PHASE_51_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim()
  : '';

if (HISTORY) {
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_51_BASE SHA ${PHASE_51_BASE} must resolve to a commit`
  );
}

// ─── Canary tests (9 subtests — NEVER SKIPS) ─────────────────────────────────

// Subtest 1: BASE SHA sanity precondition
test('canary-phase-51-base-resolves', { skip: SKIP_NO_HISTORY }, () => {
  // _baseSubject was asserted at module load. Re-assert inside the test.
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_51_BASE ${PHASE_51_BASE} must resolve; subject: ${_baseSubject}`
  );
});

// Subtest 2: agents/ directory glob
test('canary-agents-untouched', { skip: SKIP_NO_HISTORY }, () => {
  const diff = gitDiff('agents/');
  assert.strictEqual(
    diff,
    '',
    `agents/ must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
  );
});

// Subtest 3: v3.1 carry-forward services + scripts + bin/init.cjs
test('canary-v31-services-untouched', { skip: SKIP_NO_HISTORY }, () => {
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
      `${t} must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
    );
  }
});

// Subtest 5: Phase 49 outputs
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
      `${t} must be UNMODIFIED since Phase 51 base; diff:\n${diff}`
    );
  }
});

// Subtest 6: bin/cli.cjs party branch — Phase 51 contract: zero edits
test('canary-bin-cli-party-branch-byte-preserved', { skip: SKIP_NO_HISTORY }, () => {
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

// Subtest 7: gsd-tools.cjs case 'party': dispatch-contract + KNOWN_ACTIONS reduced to 6 (plan 89-13)
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
    // Phase 88 plan 88-15 changed this one line inside the pinned block: the
    // dispatch now resolves the Python launcher instead of spawning a literal
    // `python3`, which on a python.org Windows install is a Microsoft Store
    // stub. The assertion is kept and re-pointed at the new contract, and the
    // block's byte-identity moves with the canary re-baseline in the same PR.
    "platform.spawnPython(subprocArgs, { encoding: 'utf8', cwd: repoRoot });",
    "process.exit(result.status === null ? 1 : result.status);",
  ];

  for (const sub of requiredSubstrings) {
    assert.ok(
      headBlock.includes(sub),
      `case 'party': block must contain dispatch-contract substring:\n  ${sub}\n` +
      `Block length: ${headBlock.length}`
    );
  }

  // KNOWN_ACTIONS Set must be exactly the 6 actions plan 89-13 left (frozen order).
  // It held 9 until then; pause, resume and kill were removed by ORC-02 part 2.
  const expectedKnownActions = "const KNOWN_ACTIONS = new Set(['create', 'start', 'terminate', 'get', 'status', 'inspect']);";
  assert.ok(
    headBlock.includes(expectedKnownActions),
    `case 'party': block must contain KNOWN_ACTIONS with exactly the 6 actions:\n  ${expectedKnownActions}\n` +
    `Block excerpt: ${headBlock.slice(0, 500)}`
  );
  // The removed verbs answer by name (REMOVED_ACTIONS) and are not dispatched.
  assert.ok(
    headBlock.includes('const REMOVED_ACTIONS = {') && headBlock.includes("error: 'party_verb_removed'"),
    `case 'party': block must answer the removed verbs with a typed party_verb_removed`
  );
  for (const verb of ['pause', 'resume', 'kill']) {
    assert.ok(
      !new RegExp(`gsd-tools party ${verb}\\b`).test(headBlock) && !new RegExp(`\\|${verb}\\b`).test(headBlock),
      `case 'party': block must not offer the removed verb "${verb}" in its usage text`
    );
  }
});

// Subtest 8: party_session.py — the 6 surviving Phase 50 functions + PartySession
//   class + constants byte-identical; DECISION_TYPES/post_decision/list_decisions/
//   summarize_decisions exist at HEAD; pause/resume/VALID_TRANSITIONS/
//   InvalidTransitionError do NOT (plan 89-13). Uses indent-level scanning (WARN-04).
test('canary-party-session-py-phase-50-functions-preserved', { skip: SKIP_NO_HISTORY }, () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session.py'), 'utf8');
  const baseSrc = gitShowBase('services/party_session.py');

  // The 6 Phase 50 function anchors plan 89-13 left (pause and resume are
  // asserted ABSENT below)
  const phase50Fns = [
    'def create(',
    'def start(',
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

  // Plan 89-13 (ORC-02 part 2): the transition machine is REMOVED. These were
  // byte-pinned until then; the pin is inverted so their return fails here.
  for (const gone of ['def pause(', 'def resume(', 'VALID_TRANSITIONS', 'InvalidTransitionError']) {
    assert.ok(
      !headSrc.includes(gone),
      `party_session.py at HEAD must NOT contain ${JSON.stringify(gone)} (removed by plan 89-13)`
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

// Subtest 9: party_session_cli.py — the 4 surviving Phase 50 subparsers + 4 action
//   handlers byte-identical; status/inspect subparsers exist at HEAD; pause/resume/
//   kill do NOT, and answer as removed verbs (plan 89-13).
test('canary-party-session-cli-phase-50-subparsers-preserved', { skip: SKIP_NO_HISTORY }, () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session_cli.py'), 'utf8');
  const baseSrc = gitShowBase('services/party_session_cli.py');

  // The 4 Phase 50 subparser block anchors plan 89-13 left (add_parser lines)
  const subparserAnchors = [
    'p_create = sub.add_parser("create"',
    'p_start = sub.add_parser("start"',
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

  // The 4 Phase 50 action handler anchors plan 89-13 left (if/elif args.action == lines)
  const handlerAnchors = [
    'if args.action == "create":',
    'elif args.action == "start":',
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

  // Positively assert the 2 Phase 51 read subparsers EXIST at HEAD
  assert.ok(
    headSrc.includes('sub.add_parser("status"'),
    'party_session_cli.py at HEAD must have status subparser (Phase 51 addition)'
  );
  assert.ok(
    headSrc.includes('sub.add_parser("inspect"'),
    'party_session_cli.py at HEAD must have inspect subparser (Phase 51 addition)'
  );
  // Plan 89-13 (ORC-02 part 2): pause, resume and kill are REMOVED verbs. No
  // subparser and no handler may come back, and each must be answered by name.
  for (const verb of ['pause', 'resume', 'kill']) {
    assert.ok(
      !headSrc.includes(`sub.add_parser("${verb}"`) && !headSrc.includes(`args.action == "${verb}"`),
      `party_session_cli.py at HEAD must NOT dispatch the removed verb "${verb}" (plan 89-13)`
    );
    assert.ok(
      new RegExp(`^    "${verb}": \\($`, 'm').test(headSrc),
      `party_session_cli.py REMOVED_ACTIONS must answer the removed verb "${verb}"`
    );
  }
});
