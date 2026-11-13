'use strict';
/**
 * CANARY POLICY (plan 88-12): a PR that changes a path this file pins re-baselines this canary
 * IN THE SAME PR and names the change in its description. This canary exists to make such
 * a change deliberate, not to forbid it. Never skip, retire or weaken an assertion to go
 * green. Worked example: PR #24 changed the pinned bin/init.cjs without re-baselining and
 * left master red on four cells until plan 88-12 moved the bases.
 *
 * tests/phase-53-canary.test.cjs — Phase 53 (v3.1 Carry-Forwards) milestone-wide
 * byte-preservation canary.
 *
 * Verifies that Phase 53 POLISH work added ONLY the expected surfaces and did NOT
 * silently mutate any v3.2 prior-phase outputs (Phases 48-52) or v3.1 protected paths.
 *
 * PHASE_53_BASE: cbed3c82dcf1d536a1bb765f6ab5814df6e03521 (re-baselined; the constant below is the authority)
 *   = HEAD captured 2026-05-14 at Phase 53 Wave 1 dispatch.
 *   Commit subject: "plan(53): author 5 PLANs directly after 2 planner stream timeouts"
 *
 * PROTECTED PATHS (groups):
 *
 *   Group A — v3.2 Phase 48 outputs (full diff empty):
 *     services/module_schema.py
 *     services/module_resolver.py
 *     services/module_validator_cli.py
 *
 *   Group B — v3.2 Phase 49 outputs (full diff empty):
 *     services/module_lifecycle.py
 *     services/install_record_store.py
 *     services/module_lifecycle_cli.py
 *
 *   Group C — v3.2 Phase 50 outputs (full diff empty for migration; indent-scan for py):
 *     migrations/021-party-sessions.sql + DOWN
 *     services/party_session.py — the 6 Phase 50 functions plan 89-13 left, via indent-level scan
 *     services/party_session_cli.py — the 4 Phase 50 subparser blocks plan 89-13 left, via indent-level scan
 *     (pause and resume were removed by plan 89-13, ORC-02 part 2, and are asserted ABSENT)
 *
 *   Group D — v3.2 Phase 51 outputs:
 *     migrations/023-party-decisions.sql + DOWN (full diff empty)
 *     services/party_session.py post_decision/list_decisions/summarize_decisions (indent-scan)
 *
 *   Group E — v3.2 Phase 52 outputs (full diff empty):
 *     services/agent_schema.py
 *     scripts/agent-compiler.cjs
 *     scripts/agent-md-to-yaml.cjs
 *     get-shit-done/agents/[name]/AGENT.yaml (17 files)
 *
 *   Group F — agents/*.md SC1 lock (all 17 files byte-identical to PHASE_53_BASE):
 *     agents/*.md — SC1 canonical claude-code compiled outputs
 *
 *   Group G — v3.1 protected paths (POLISH-modified files use partial checks):
 *     services/agent_hydrator.py                (full diff empty — not POLISH-modified)
 *     services/agent_hydrate_cli.py             (full diff empty — not POLISH-modified)
 *     services/skill_schema.py                  (POLISH-01 modified — assert first 7 fields at locked positions)
 *     services/amauta-mcp.py                    (POLISH-03+04 modified — assert Phase 46 6-tool names present)
 *     scripts/skill-compiler.cjs                (POLISH-01 modified — assert prior validate() logic present)
 *     bin/init.cjs                              (POLISH-02 modified — assert Phase 44 7-step vocabulary present)
 *
 * CANARY NEVER SKIPS — no PG/Valkey dependency.
 * All assertions are git/filesystem only.
 * EXCEPTION: SC1 sub-test (test 8) may skip ONLY if `node` is not on PATH.
 *
 * If PHASE_53_BASE SHA is wrong (git show fails), the module load throws
 * and the executor MUST surface a divergence report — NOT silently update the SHA.
 *
 * Run: node --test tests/phase-53-canary.test.cjs
 *
 * Mirrors tests/phase-52-canary.test.cjs (Phase 52 precedent).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync, spawnSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

// ─── PHASE_53_BASE constant (FROZEN — update only with operator sign-off; last: 2026-11-11, delegated) ─
//
// HEAD captured 2026-05-14 at Phase 53 Wave 1 dispatch.
// Confirmed: git show --format="%s" -s 32fbdc31527cb9fc5ca81db3036214054c49ae71
//   plan(53): author 5 PLANs directly after 2 planner stream timeouts
// RE-BASELINED 2026-11-11 (plan 88-06, operator sign-off: delegated 2026-11-11). The base used to be
//   32fbdc31527cb9fc5ca81db3036214054c49ae71  plan(53): author 5 PLANs directly after 2 planner stream timeouts
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
// MEASURED, NOT ASSUMED: `git diff --name-only d8a0fdb..HEAD` lists 239 files, and the intersection with the
// pinned list read out of the four canary files is exactly services/agent_hydrator.py (this canary pins services/amauta-mcp.py by CONTENT, not by diff: its
// POLISH-03/POLISH-04 tool names and _MCP_ERROR_CODES are present and green).
// agents/ did not move (`git diff --name-only <base>...HEAD -- agents/` is empty) and
// tests/agents-compile-claude-target-byte-match.test.cjs is green. The four byte-pinned BLOCKS are unchanged,
// re-measured with this file's own extractBlock: gsd-tools `case 'module':` 6735 bytes / 139 lines,
// `case 'party':` 2130 / 43, cli `if (command === 'module')` 877 / 17, `if (command === 'party')` 364 / 9.
// The base is now the last commit of this series that touches a pinned path:
//   cbed3c82dcf1d536a1bb765f6ab5814df6e03521  refactor(89-09): one cache resolver per language, every consumer calls it [89-09-04]
// Every assertion is kept (13/13). The other three bases move in this same PR, each to this commit.
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
// Every assertion is kept (13/13). Test 5 keeps its byte pins on the six surviving functions and four surviving
// subparsers, and its pins on pause and resume are INVERTED: it now fails if either comes back.
// PHASE_50_BASE (party-canary) is deliberately NOT moved: it pins agents/, the v3.1 services, the module outputs and
// the two `module` blocks, none of which this plan touches; party-canary was run green BEFORE this change.
// Plan 89-11 moves PHASE_50_BASE and PHASE_51_BASE once more, from THIS value.
// This PR must be merged with a merge commit (NEVER squash, never rebase-merge) or this SHA stops resolving
// on master. The full list is in
// .planning/phases/89-postgres-primary-orchestration-cleanup/89-13-RECORD.md.
const PHASE_53_BASE = '674cd3aa980a593b7a4cff82a1ea3485f4465efd';  // re-baselined 2026-11-13 by plan 89-13; see the block above

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

const HISTORY = historyAvailable(PHASE_53_BASE);
const SKIP_NO_HISTORY = HISTORY
  ? false
  : `git history for ${PHASE_53_BASE} is not present in this checkout (shallow clone or git archive copy)`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run `git diff <PHASE_53_BASE> -- <path>` and return stdout string.
 * Returns empty string if the path is unchanged. Throws on error.
 */
function gitDiff(targetPath) {
  return execSync(`git diff ${PHASE_53_BASE} -- ${targetPath}`, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
  });
}

/**
 * Retrieve file content at PHASE_53_BASE via `git show <SHA>:<path>`.
 * Throws if the path did not exist at PHASE_53_BASE.
 */
function gitShowBase(filePath) {
  return execSync(`git show ${PHASE_53_BASE}:${filePath}`, {
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
 * Extract a Python function or class body using indent-level scanning (WARN-04
 * compliance — NOT hardcoded line numbers). Mirrors party-decisions-canary.test.cjs.
 *
 * Algorithm:
 *   1. Find the line containing `startMarker`
 *   2. Record anchor line indentation
 *   3. Collect subsequent lines until a non-blank line at the SAME or LESSER indent level
 *   4. Return the full text from anchor through the last included line
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

  // Determine anchor indentation
  const anchorLine = lines[startLine];
  const anchorIndent = anchorLine.length - anchorLine.trimStart().length;

  // Scan forward: block ends when a non-blank, non-comment line is found at same or lesser indent
  let lastSubstantiveLine = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      continue; // blank lines: tentatively included
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= anchorIndent) {
      break; // block ended
    }
    lastSubstantiveLine = i;
  }

  return lines.slice(startLine, lastSubstantiveLine + 1).join('\n');
}

// ─── Sanity: verify BASE SHA resolves at module load ─────────────────────────
//
// If this throws, executor MUST surface a divergence report — NOT update the SHA.
const _baseSubject = HISTORY
  ? execSync(`git show --format="%s" -s ${PHASE_53_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim()
  : '';

if (HISTORY) {
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_53_BASE SHA ${PHASE_53_BASE} must resolve to a commit`
  );
}

// ─── Canary tests — NEVER SKIP (except SC1 sub-test if node unavailable) ─────

// ── Test 1: Base SHA sanity precondition ─────────────────────────────────────

test('phase_53_base_sha_resolves', { skip: SKIP_NO_HISTORY }, () => {
  // _baseSubject was validated at module load; re-assert inside the test.
  assert.ok(
    typeof _baseSubject === 'string' && _baseSubject.length > 0,
    `PHASE_53_BASE ${PHASE_53_BASE} must resolve; subject: ${_baseSubject}`
  );
  // The base commit must precede current HEAD (i.e., ancestors of HEAD include it)
  const mergeBase = execSync(
    `git merge-base ${PHASE_53_BASE} HEAD`,
    { encoding: 'utf8', cwd: ROOT, timeout: 10000 }
  ).trim();
  assert.strictEqual(
    mergeBase,
    PHASE_53_BASE,
    `PHASE_53_BASE must be an ancestor of HEAD`
  );
});

// ── Test 2: v3.1 protected paths (agent_hydrator, agent_hydrate_cli) unchanged ─
//   (skill_schema.py / amauta-mcp.py / skill-compiler.cjs / bin/init.cjs are
//    POLISH-modified and get partial checks in tests 9 + 10)

test('v3_1_protected_paths_unchanged', { skip: SKIP_NO_HISTORY }, () => {
  const targets = [
    'services/agent_hydrator.py',       // Phase 47 — not POLISH-modified
    'services/agent_hydrate_cli.py',    // Phase 47 — not POLISH-modified
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_53_BASE ${PHASE_53_BASE}; diff:\n${diff}`
    );
  }
  // agents/*.md — SC1 canonical claude-code outputs must be byte-identical
  // (note: tested more thoroughly in test 7; here assert directory-level diff empty)
  const agentsDirDiff = gitDiff('agents/');
  assert.strictEqual(
    agentsDirDiff,
    '',
    `agents/ directory must be UNMODIFIED since PHASE_53_BASE (SC1 lock from Phase 52 still holds);\ndiff:\n${agentsDirDiff}`
  );
});

// ── Test 3: v3.2 Phase 48 outputs unchanged ───────────────────────────────────

test('v3_2_phase_48_outputs_unchanged', { skip: SKIP_NO_HISTORY }, () => {
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
      `${t} must be UNMODIFIED since PHASE_53_BASE ${PHASE_53_BASE}; diff:\n${diff}`
    );
  }
});

// ── Test 4: v3.2 Phase 49 outputs unchanged ───────────────────────────────────

test('v3_2_phase_49_outputs_unchanged', { skip: SKIP_NO_HISTORY }, () => {
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
      `${t} must be UNMODIFIED since PHASE_53_BASE ${PHASE_53_BASE}; diff:\n${diff}`
    );
  }
});

// ── Test 5: v3.2 Phase 50 outputs unchanged ───────────────────────────────────
//   migrations byte-diff empty;
//   party_session.py Phase 50 functions (the 6 plan 89-13 left) via indent-scan;
//   party_session_cli.py Phase 50 subparsers (the 4 plan 89-13 left) via indent-scan;
//   pause and resume asserted ABSENT from both (plan 89-13, ORC-02 part 2).

test('v3_2_phase_50_outputs_unchanged', { skip: SKIP_NO_HISTORY }, () => {
  // Migration files — full diff empty
  const migTargets = [
    'migrations/021-party-sessions.sql',
    'migrations/021-party-sessions.down.sql',
  ];
  for (const t of migTargets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_53_BASE; diff:\n${diff}`
    );
  }

  // party_session.py — the 6 Phase 50 functions plan 89-13 left, via indent-level scan
  const headPsSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session.py'), 'utf8');
  const basePsSrc = gitShowBase('services/party_session.py');

  const phase50Fns = [
    'def create(',
    'def start(',
    'def terminate(',
    'def get(',
    'def post_finding(',
    'def list_findings(',
  ];
  for (const fn of phase50Fns) {
    const headBlock = extractPythonBlock(headPsSrc, fn);
    const baseBlock = extractPythonBlock(basePsSrc, fn);
    assert.strictEqual(
      headBlock,
      baseBlock,
      `party_session.py function "${fn}" must be byte-identical to PHASE_53_BASE.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
    );
  }

  // Plan 89-13 (ORC-02 part 2) removed pause() and resume(). They were pinned
  // here; the pin is inverted so their return fails this canary.
  for (const gone of ['def pause(', 'def resume(']) {
    assert.ok(
      !headPsSrc.includes(gone),
      `party_session.py must NOT define ${JSON.stringify(gone)} (removed by plan 89-13)`
    );
  }

  // party_session_cli.py — the 4 Phase 50 subparser blocks plan 89-13 left, via indent-level scan
  const headCliSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session_cli.py'), 'utf8');
  const baseCliSrc = gitShowBase('services/party_session_cli.py');

  const phase50Subparsers = [
    'p_create = sub.add_parser("create"',
    'p_start = sub.add_parser("start"',
    'p_terminate = sub.add_parser("terminate"',
    'p_get = sub.add_parser("get"',
  ];
  for (const anchor of phase50Subparsers) {
    const headBlock = extractPythonBlock(headCliSrc, anchor);
    const baseBlock = extractPythonBlock(baseCliSrc, anchor);
    assert.strictEqual(
      headBlock,
      baseBlock,
      `party_session_cli.py subparser "${anchor}" must be byte-identical to PHASE_53_BASE.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
    );
  }
  for (const gone of ['sub.add_parser("pause"', 'sub.add_parser("resume"']) {
    assert.ok(
      !headCliSrc.includes(gone),
      `party_session_cli.py must NOT define ${JSON.stringify(gone)} (removed by plan 89-13)`
    );
  }
});

// ── Test 6: v3.2 Phase 51 outputs unchanged ───────────────────────────────────
//   migrations byte-diff empty;
//   party_session.py Phase 51 additions (post_decision/list_decisions/summarize_decisions) via indent-scan.

test('v3_2_phase_51_outputs_unchanged', { skip: SKIP_NO_HISTORY }, () => {
  // Migration files — full diff empty
  const migTargets = [
    'migrations/023-party-decisions.sql',
    'migrations/023-party-decisions.down.sql',
  ];
  for (const t of migTargets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_53_BASE; diff:\n${diff}`
    );
  }

  // party_session.py Phase 51 additions — indent-level scan
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session.py'), 'utf8');
  const baseSrc = gitShowBase('services/party_session.py');

  const phase51Fns = [
    'def post_decision(',
    'def list_decisions(',
    'def summarize_decisions(',
  ];
  for (const fn of phase51Fns) {
    const headBlock = extractPythonBlock(headSrc, fn);
    const baseBlock = extractPythonBlock(baseSrc, fn);
    assert.strictEqual(
      headBlock,
      baseBlock,
      `party_session.py function "${fn}" (Phase 51 addition) must be byte-identical to PHASE_53_BASE.\n` +
      `head sha=${sha256(headBlock)}, base sha=${sha256(baseBlock)}`
    );
  }
});

// ── Test 7: v3.2 Phase 52 outputs unchanged ───────────────────────────────────
//   services/agent_schema.py + scripts/agent-compiler.cjs + scripts/agent-md-to-yaml.cjs: full diff empty;
//   17 AGENT.yaml files in get-shit-done/agents/*/AGENT.yaml: byte-identical.

test('v3_2_phase_52_outputs_unchanged', { skip: SKIP_NO_HISTORY }, () => {
  const targets = [
    'services/agent_schema.py',
    'scripts/agent-compiler.cjs',
    'scripts/agent-md-to-yaml.cjs',
  ];
  for (const t of targets) {
    const diff = gitDiff(t);
    assert.strictEqual(
      diff,
      '',
      `${t} must be UNMODIFIED since PHASE_53_BASE; diff:\n${diff}`
    );
  }

  // 17 AGENT.yaml files — byte-identical
  const agentDirs = [
    'gsd-architect', 'gsd-checker', 'gsd-debugger',
    'gsd-executor-backend', 'gsd-executor-data', 'gsd-executor-frontend',
    'gsd-executor-general', 'gsd-executor-infra', 'gsd-operator',
    'gsd-planner', 'gsd-qa', 'gsd-researcher', 'gsd-reviewer',
    'gsd-roadmapper', 'gsd-security', 'gsd-tester', 'gsd-validator',
  ];
  assert.strictEqual(agentDirs.length, 17, 'Must have exactly 17 agent directories');

  for (const dir of agentDirs) {
    const yamlRelPath = `get-shit-done/agents/${dir}/AGENT.yaml`;
    const diff = gitDiff(yamlRelPath);
    assert.strictEqual(
      diff,
      '',
      `${yamlRelPath} must be UNMODIFIED since PHASE_53_BASE (Phase 52 canonical YAML);\ndiff:\n${diff}`
    );
  }
});

// ── Test 8: SC1 byte-match still passes ───────────────────────────────────────
//   Re-run Phase 52's SC1 lock: compile each of the 17 agents with --target=claude-code
//   and verify the output is byte-identical to the committed agents/<name>.md file.
//
//   CANARY NOTE: this test calls `node scripts/agent-compiler.cjs compile ...`
//   (requires node on PATH). If node is not available, the test SKIPS with t.skip.
//   This is the ONLY permitted skip in this canary.
//   All other subtests NEVER SKIP.

test('sc1_byte_match_still_passes', async (t) => {
  // Check if node is on PATH
  const nodeCheck = spawnSync('node', ['--version'], { encoding: 'utf8' });
  if (nodeCheck.status !== 0 || nodeCheck.error) {
    t.skip('node not on PATH — SC1 byte-match sub-test skipped');
    return;
  }

  const agentDirs = [
    'gsd-architect', 'gsd-checker', 'gsd-debugger',
    'gsd-executor-backend', 'gsd-executor-data', 'gsd-executor-frontend',
    'gsd-executor-general', 'gsd-executor-infra', 'gsd-operator',
    'gsd-planner', 'gsd-qa', 'gsd-researcher', 'gsd-reviewer',
    'gsd-roadmapper', 'gsd-security', 'gsd-tester', 'gsd-validator',
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-sc1-'));
  try {
    for (const agentName of agentDirs) {
      // Compile to tmp directory; --out expects a directory (outputs {dir}/{agentname}.md)
      const result = spawnSync(
        'node',
        ['scripts/agent-compiler.cjs', `--target=claude-code`, `--agent=${agentName}`, `--out=${tmpDir}`],
        { encoding: 'utf8', cwd: ROOT, timeout: 30000 }
      );

      // If compile fails (e.g., non-zero exit) — assert it succeeded
      assert.strictEqual(
        result.status,
        0,
        `agent-compiler.cjs compile for ${agentName} must exit 0.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`
      );

      // Read compiled output (written to tmpDir/{agentName}.md)
      // and compare to committed agents/<name>.md
      const outFile = path.join(tmpDir, `${agentName}.md`);
      const compiledContent = fs.readFileSync(outFile, 'utf8');
      const committedContent = fs.readFileSync(path.join(ROOT, 'agents', `${agentName}.md`), 'utf8');

      assert.strictEqual(
        compiledContent,
        committedContent,
        `SC1 byte-match: compiled output for ${agentName} must match agents/${agentName}.md.\n` +
        `compiled sha=${sha256(compiledContent)}, committed sha=${sha256(committedContent)}`
      );
    }
  } finally {
    // Cleanup tmp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 9: POLISH-01 — input_schema + output_schema appended (not inserted) ──
//   Assert first 7 field declarations appear in Phase 43 LOCKED order;
//   input_schema at position 8, output_schema at position 9.

test('polish_01_field_appended_not_inserted', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'skill_schema.py'), 'utf8');

  // Extract only lines inside SkillFrontmatter class body that are field declarations
  // (lines starting with whitespace + field_name: type = ...)
  // We anchor on the class definition and look for field declaration pattern
  const classAnchor = 'class SkillFrontmatter(';
  const classStart = headSrc.indexOf(classAnchor);
  assert.ok(classStart !== -1, 'SkillFrontmatter class must exist in skill_schema.py');

  // Find all `    fieldname:` or `    field_name:` lines in the Pydantic model body
  // by scanning for lines matching the field declaration pattern
  const classSection = headSrc.slice(classStart);
  const fieldLines = classSection.split('\n').filter(line => {
    // Match Pydantic field declarations: "    fieldname: Type = ..."
    // (4 spaces indent, identifier, colon)
    return /^        [a-z][a-z_]*: /.test(line);
  });

  // The first 7 must appear in Phase 43 LOCKED order
  const phase43LockedOrder = [
    'name',
    'description',
    'category',
    'version',
    'security_class',
    'allowed_tools',
    'depends_on',
  ];

  assert.ok(
    fieldLines.length >= 9,
    `SkillFrontmatter must have at least 9 field declarations (7 original + 2 POLISH-01); found ${fieldLines.length}`
  );

  for (let i = 0; i < phase43LockedOrder.length; i++) {
    const expectedFieldName = phase43LockedOrder[i];
    const fieldLine = fieldLines[i];
    assert.ok(
      fieldLine.includes(`${expectedFieldName}:`),
      `Field at position ${i + 1} must be "${expectedFieldName}" (Phase 43 LOCKED order).\n` +
      `Found: ${fieldLine}`
    );
  }

  // Position 8: input_schema
  assert.ok(
    fieldLines[7].includes('input_schema:'),
    `Field at position 8 must be "input_schema" (POLISH-01 addition).\nFound: ${fieldLines[7]}`
  );

  // Position 9: output_schema
  assert.ok(
    fieldLines[8].includes('output_schema:'),
    `Field at position 9 must be "output_schema" (POLISH-01 addition).\nFound: ${fieldLines[8]}`
  );
});

// ── Test 10: POLISH-03+04 — Phase 46 tool names present + 2 new POLISH names ──
//   Assert the 6 Phase 46 tool names are still present in services/amauta-mcp.py
//   (regression lock) + 2 new POLISH-03/04 tool names present.

test('polish_03_04_appended_not_modified', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'services', 'amauta-mcp.py'), 'utf8');

  // Phase 46 frozen 6 tool names (regression lock — must not be removed)
  const phase46ToolNames = [
    'amauta/search-code',
    'amauta/memory-store',
    'amauta/memory-search',
    'amauta/memory-distill',
    'amauta/research',
    'amauta/complexity-score',
  ];

  for (const toolName of phase46ToolNames) {
    assert.ok(
      headSrc.includes(toolName),
      `Phase 46 tool "${toolName}" must still be present in services/amauta-mcp.py (regression lock)`
    );
  }

  // POLISH-03: amauta/bearings tool
  assert.ok(
    headSrc.includes('amauta/bearings'),
    'POLISH-03 tool "amauta/bearings" must be present in services/amauta-mcp.py'
  );

  // POLISH-04: amauta/agent-hydrate tool
  assert.ok(
    headSrc.includes('amauta/agent-hydrate'),
    'POLISH-04 tool "amauta/agent-hydrate" must be present in services/amauta-mcp.py'
  );

  // _MCP_ERROR_CODES 5-tuple must be intact
  assert.ok(
    headSrc.includes('_MCP_ERROR_CODES'),
    '_MCP_ERROR_CODES must be present in services/amauta-mcp.py'
  );

  // Phase 46's 6 tools + 2 POLISH = 8 total; count occurrences of name= pattern
  const allToolNames = [...phase46ToolNames, 'amauta/bearings', 'amauta/agent-hydrate'];
  for (const toolName of allToolNames) {
    assert.ok(
      headSrc.includes(toolName),
      `Tool "${toolName}" must be present in services/amauta-mcp.py`
    );
  }
});

// ── Test 11: POLISH-02 — Phase 44 7-step install vocabulary preserved ─────────
//   Assert bin/init.cjs still contains the Phase 44 7-step install step names.

test('polish_02_phase44_steps_preserved', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'bin', 'init.cjs'), 'utf8');

  // Phase 44 frozen 7-step install vocabulary (from Plans 44-01/02/03)
  // Steps 0/2/3/4/5/6/7 = detect_ides, install_skills, detect_infra, migrations,
  //                         start_daemon, verify, run_assertions
  const phase44StepNames = [
    'detect_ides',
    'install_skills',
    'detect_infra',
    'migrations',
    'start_daemon',
    'verify',
    'run_assertions',
  ];

  for (const stepName of phase44StepNames) {
    assert.ok(
      headSrc.includes(stepName),
      `Phase 44 frozen step name "${stepName}" must still be present in bin/init.cjs (POLISH-02 preservation lock)`
    );
  }

  // POLISH-02 additions: --upgrade and --uninstall flags
  assert.ok(
    headSrc.includes('--upgrade'),
    'bin/init.cjs must contain --upgrade flag (POLISH-02 addition)'
  );
  assert.ok(
    headSrc.includes('--uninstall'),
    'bin/init.cjs must contain --uninstall flag (POLISH-02 addition)'
  );
});

// ── Test 12: POLISH-01 — skill-compiler.cjs prior validate() logic preserved ──

test('polish_01_skill_compiler_validate_preserved', () => {
  const headSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'skill-compiler.cjs'), 'utf8');

  // Phase 43 validate() function must still exist
  assert.ok(
    headSrc.includes('function validate('),
    'scripts/skill-compiler.cjs must still contain validate() function (Phase 43 contract)'
  );

  // POLISH-01 addition: validateJsonSchemaShape
  assert.ok(
    headSrc.includes('validateJsonSchemaShape'),
    'scripts/skill-compiler.cjs must contain validateJsonSchemaShape (POLISH-01 addition)'
  );
});

// ── Test 13: POLISH-05 — hydration hook present in workflow files ─────────────

test('polish_05_hydration_hook_present', () => {
  // execute-phase-legacy.md must contain the GSD_HYDRATE_TASKS kill switch
  const legacySrc = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase-legacy.md'),
    'utf8'
  );
  assert.ok(
    legacySrc.includes('GSD_HYDRATE_TASKS'),
    'execute-phase-legacy.md must contain GSD_HYDRATE_TASKS kill-switch (POLISH-05 hook)'
  );

  // step-03-execute.md must contain the hook
  const step03Src = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase', 'steps', 'step-03-execute.md'),
    'utf8'
  );
  assert.ok(
    step03Src.includes('GSD_HYDRATE_TASKS'),
    'step-03-execute.md must contain GSD_HYDRATE_TASKS kill-switch (POLISH-05 hook)'
  );

  // step-04-verify.md must contain the hook
  const step04Src = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'workflows', 'execute-phase', 'steps', 'step-04-verify.md'),
    'utf8'
  );
  assert.ok(
    step04Src.includes('GSD_HYDRATE_TASKS'),
    'step-04-verify.md must contain GSD_HYDRATE_TASKS kill-switch (POLISH-05 hook)'
  );

  // cli-variables.md must contain HYDRATE_CMD
  const cliVarsSrc = fs.readFileSync(
    path.join(ROOT, 'get-shit-done', 'references', 'cli-variables.md'),
    'utf8'
  );
  assert.ok(
    cliVarsSrc.includes('HYDRATE_CMD'),
    'get-shit-done/references/cli-variables.md must define HYDRATE_CMD (POLISH-05 / LEARN-07)'
  );
});
