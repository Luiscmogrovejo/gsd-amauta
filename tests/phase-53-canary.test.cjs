'use strict';
/**
 * tests/phase-53-canary.test.cjs — Phase 53 (v3.1 Carry-Forwards) milestone-wide
 * byte-preservation canary.
 *
 * Verifies that Phase 53 POLISH work added ONLY the expected surfaces and did NOT
 * silently mutate any v3.2 prior-phase outputs (Phases 48-52) or v3.1 protected paths.
 *
 * PHASE_53_BASE: 32fbdc31527cb9fc5ca81db3036214054c49ae71
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
 *     services/party_session.py — Phase 50's 8 functions via indent-level scan
 *     services/party_session_cli.py — Phase 50's 6 subparser blocks via indent-level scan
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
const { execSync, spawnSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

// ─── PHASE_53_BASE constant (FROZEN — NEVER update without operator sign-off) ─
//
// HEAD captured 2026-05-14 at Phase 53 Wave 1 dispatch.
// Confirmed: git show --format="%s" -s 32fbdc31527cb9fc5ca81db3036214054c49ae71
//   plan(53): author 5 PLANs directly after 2 planner stream timeouts
const PHASE_53_BASE = '32fbdc31527cb9fc5ca81db3036214054c49ae71';  // HEAD captured 2026-05-14 at Phase 53 Wave 1 dispatch

const ROOT = path.resolve(__dirname, '..');

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
const _baseSubject = execSync(`git show --format="%s" -s ${PHASE_53_BASE}`, {
  encoding: 'utf8',
  cwd: ROOT,
  timeout: 10000,
}).trim();

assert.ok(
  typeof _baseSubject === 'string' && _baseSubject.length > 0,
  `PHASE_53_BASE SHA ${PHASE_53_BASE} must resolve to a commit`
);

// ─── Canary tests — NEVER SKIP (except SC1 sub-test if node unavailable) ─────

// ── Test 1: Base SHA sanity precondition ─────────────────────────────────────

test('phase_53_base_sha_resolves', () => {
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

test('v3_1_protected_paths_unchanged', () => {
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

test('v3_2_phase_48_outputs_unchanged', () => {
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

test('v3_2_phase_49_outputs_unchanged', () => {
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
//   party_session.py Phase 50 functions (8 funcs) via indent-scan;
//   party_session_cli.py Phase 50 subparsers (6 blocks) via indent-scan.

test('v3_2_phase_50_outputs_unchanged', () => {
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

  // party_session.py — Phase 50's 8 functions via indent-level scan
  const headPsSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session.py'), 'utf8');
  const basePsSrc = gitShowBase('services/party_session.py');

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

  // party_session_cli.py — Phase 50's 6 subparser blocks via indent-level scan
  const headCliSrc = fs.readFileSync(path.join(ROOT, 'services', 'party_session_cli.py'), 'utf8');
  const baseCliSrc = gitShowBase('services/party_session_cli.py');

  const phase50Subparsers = [
    'p_create = sub.add_parser("create"',
    'p_start = sub.add_parser("start"',
    'p_pause = sub.add_parser("pause"',
    'p_resume = sub.add_parser("resume"',
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
});

// ── Test 6: v3.2 Phase 51 outputs unchanged ───────────────────────────────────
//   migrations byte-diff empty;
//   party_session.py Phase 51 additions (post_decision/list_decisions/summarize_decisions) via indent-scan.

test('v3_2_phase_51_outputs_unchanged', () => {
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

test('v3_2_phase_52_outputs_unchanged', () => {
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
